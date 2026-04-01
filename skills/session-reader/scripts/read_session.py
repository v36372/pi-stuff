# /// script
# requires-python = ">=3.12"
# dependencies = []
# ///
"""
Parse pi session JSONL files into readable formats.

Usage:
    uv run read_session.py <session_path> [--mode MODE] [--turn N] [--offset N] [--limit N] [--max-content N] [--search TERM]

Modes:
    conversation  User and assistant text only — no tool calls (default)
    toc           Compact table of contents with numbered turns
    turn          Deep dive into a specific turn (use --turn N)
    issues        Errors, failures, retries — everything that went wrong
    overview      Session metadata + turn summary
    full          Everything including tool calls and results
    tools         Tool calls and results only
    costs         Cost breakdown per assistant turn
    subagents     Subagent calls: task, agent, model, cost, status, session paths
"""

import json
import sys
import argparse
import re
from pathlib import Path
from datetime import datetime


def parse_args():
    parser = argparse.ArgumentParser(description="Read pi session JSONL files")
    parser.add_argument("session_path", help="Path to the .jsonl session file")
    parser.add_argument(
        "--mode",
        choices=["conversation", "toc", "turn", "issues", "overview", "full", "tools", "costs", "subagents"],
        default="conversation",
        help="Output mode (default: conversation)",
    )
    parser.add_argument("--turn", type=int, default=0, help="Turn number to drill into (for --mode turn)")
    parser.add_argument("--offset", type=int, default=0, help="Skip first N user turns")
    parser.add_argument("--limit", type=int, default=0, help="Show at most N user turns (0=all)")
    parser.add_argument(
        "--max-content",
        type=int,
        default=3000,
        help="Max chars per content block (default: 3000, 0=unlimited)",
    )
    parser.add_argument("--search", type=str, default="", help="Filter turns containing this text (case-insensitive)")
    return parser.parse_args()


def truncate(text: str, max_len: int) -> str:
    if max_len <= 0 or len(text) <= max_len:
        return text
    return text[:max_len] + f"\n... [truncated, {len(text):,} chars total]"


def format_timestamp(ts) -> str:
    if not ts:
        return "?"
    try:
        if isinstance(ts, (int, float)):
            dt = datetime.fromtimestamp(ts / 1000)
            return dt.strftime("%H:%M:%S")
        dt = datetime.fromisoformat(str(ts).replace("Z", "+00:00"))
        return dt.strftime("%H:%M:%S")
    except (ValueError, AttributeError, OSError):
        return str(ts)[:8]


def format_duration(ms: int | float) -> str:
    secs = int(ms / 1000)
    if secs < 60:
        return f"{secs}s"
    mins = secs // 60
    secs = secs % 60
    return f"{mins}m{secs}s"


def parse_session(path: str) -> tuple[dict, list[dict], list[dict]]:
    """Parse a session file into (metadata, events, messages)."""
    metadata = {}
    events = []
    messages = []

    with open(path) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            obj = json.loads(line)
            t = obj.get("type")

            if t == "session":
                metadata = obj
            elif t in ("model_change", "thinking_level_change"):
                events.append(obj)
            elif t == "message":
                messages.append(obj)

    return metadata, events, messages


def extract_subagent_details(msg: dict) -> dict | None:
    if msg.get("role") != "toolResult" or msg.get("toolName") != "subagent":
        return None
    return msg.get("details")


def extract_turns(messages: list[dict]) -> list[dict]:
    """Convert raw message entries into structured turns."""
    turns = []

    for entry in messages:
        msg = entry.get("message", {})
        role = msg.get("role", "")
        content = msg.get("content", "")
        timestamp = entry.get("timestamp", msg.get("timestamp", ""))

        turn = {
            "role": role,
            "timestamp": timestamp,
            "texts": [],
            "tool_calls": [],
            "thinking": [],
            "is_error": msg.get("isError", False),
        }

        if role == "assistant":
            usage = msg.get("usage", {})
            if usage:
                turn["model"] = msg.get("model", "")
                turn["provider"] = msg.get("provider", "")
                turn["usage"] = usage
                turn["stop_reason"] = msg.get("stopReason", "")

        if isinstance(content, str):
            if content.strip():
                turn["texts"].append(content)
        elif isinstance(content, list):
            for item in content:
                if not isinstance(item, dict):
                    continue
                item_type = item.get("type", "")

                if item_type == "text" and item.get("text", "").strip():
                    turn["texts"].append(item["text"])
                elif item_type == "toolCall":
                    turn["tool_calls"].append(
                        {
                            "id": item.get("id", ""),
                            "name": item.get("name", ""),
                            "arguments": item.get("arguments", {}),
                        }
                    )
                elif item_type == "thinking":
                    thinking_text = item.get("thinking", "")
                    if thinking_text:
                        turn["thinking"].append(thinking_text)

        if role == "toolResult":
            turn["tool_call_id"] = msg.get("toolCallId", "")
            turn["tool_name"] = msg.get("toolName", "")
            turn["texts"] = []
            result_content = msg.get("content", "")
            if isinstance(result_content, list):
                for item in result_content:
                    if isinstance(item, dict) and item.get("type") == "text":
                        turn["texts"].append(item.get("text", ""))
            elif isinstance(result_content, str) and result_content.strip():
                turn["texts"].append(result_content)

            subagent_details = extract_subagent_details(msg)
            if subagent_details:
                turn["subagent_details"] = subagent_details

        turns.append(turn)

    return turns


def group_into_exchanges(turns: list[dict]) -> list[dict]:
    """Group turns into user exchanges. Each exchange = one user message + all
    assistant responses and tool results until the next user message."""
    exchanges = []
    current = None

    for turn in turns:
        if turn["role"] == "user":
            if current:
                exchanges.append(current)
            current = {
                "number": len(exchanges) + 1,
                "user": turn,
                "responses": [],
            }
        elif current:
            current["responses"].append(turn)

    if current:
        exchanges.append(current)

    return exchanges


def exchange_matches_search(exchange: dict, search: str) -> bool:
    if not search:
        return True
    search_lower = search.lower()
    # Check user text
    for t in exchange["user"]["texts"]:
        if search_lower in t.lower():
            return True
    # Check assistant texts
    for resp in exchange["responses"]:
        if resp["role"] == "assistant":
            for t in resp["texts"]:
                if search_lower in t.lower():
                    return True
    return False


def apply_filters(exchanges: list[dict], args) -> list[dict]:
    """Apply search, offset, and limit filters."""
    if args.search:
        exchanges = [e for e in exchanges if exchange_matches_search(e, args.search)]
    if args.offset:
        exchanges = exchanges[args.offset:]
    if args.limit:
        exchanges = exchanges[:args.limit]
    return exchanges


def format_subagent_summary(details: dict) -> str:
    mode = details.get("mode", "?")
    results = details.get("results", [])
    parts = []
    total_cost = 0
    total_duration = 0

    for r in results:
        agent = r.get("agent", "?")
        exit_code = r.get("exitCode", -1)
        status_icon = "✓" if exit_code == 0 else "❌"
        model = r.get("model", "")
        usage = r.get("usage", {})
        cost = usage.get("cost", 0)
        total_cost += cost
        progress = r.get("progressSummary", {})
        duration = progress.get("durationMs", 0)
        total_duration += duration
        tool_count = progress.get("toolCount", 0)
        task = r.get("task", "")[:100].replace("\n", " ")
        parts.append(f"  {status_icon} {agent} ({model}): {task}")
        if cost or duration:
            parts.append(f"    ${cost:.4f} | {format_duration(duration)} | {tool_count} tools")

    header = f"🔀 SUBAGENT [{mode}] — {len(results)} run(s), ${total_cost:.4f}, {format_duration(total_duration)}"
    return header + "\n" + "\n".join(parts)


# ─── Modes ───────────────────────────────────────────────────────────────────


def print_conversation(exchanges: list[dict], args):
    """Default mode: just user and assistant text. Clean, readable, no noise."""
    total = len(exchanges)
    print(f"{'═' * 70}")
    print(f"CONVERSATION — {total} exchanges")
    print(f"{'═' * 70}")

    filtered = apply_filters(exchanges, args)

    for ex in filtered:
        n = ex["number"]
        ts = format_timestamp(ex["user"]["timestamp"])
        print(f"\n{'─' * 70}")
        print(f"#{n}  👤 USER  [{ts}]")
        print(f"{'─' * 70}")
        for text in ex["user"]["texts"]:
            print(truncate(text, args.max_content))

        # Collect all assistant text blocks for this exchange
        assistant_texts = []
        has_tools = False
        tool_names = set()
        subagent_summaries = []
        for resp in ex["responses"]:
            if resp["role"] == "assistant":
                assistant_texts.extend(resp["texts"])
                if resp["tool_calls"]:
                    has_tools = True
                    for tc in resp["tool_calls"]:
                        tool_names.add(tc["name"])
            elif resp["role"] == "toolResult" and resp.get("subagent_details"):
                subagent_summaries.append(format_subagent_summary(resp["subagent_details"]))

        if assistant_texts:
            # Show tool usage as a compact hint
            hint = ""
            if has_tools:
                hint = f"  [used: {', '.join(sorted(tool_names))}]"
            print(f"\n🤖 ASSISTANT{hint}")
            for text in assistant_texts:
                print(truncate(text, args.max_content))

        for summary in subagent_summaries:
            print(f"\n{summary}")

        if not assistant_texts and not subagent_summaries:
            if has_tools:
                print(f"\n🤖 ASSISTANT  [tools only: {', '.join(sorted(tool_names))}]")
            else:
                print("\n🤖 ASSISTANT  (no text response)")


def print_toc(metadata: dict, events: list[dict], exchanges: list[dict], turns: list[dict], args):
    """Compact table of contents — numbered exchanges for navigation."""
    # Header
    print(f"{'═' * 70}")
    print(f"TABLE OF CONTENTS")
    print(f"{'═' * 70}")
    print(f"  Session:  {metadata.get('id', 'N/A')[:12]}...")
    print(f"  CWD:      {metadata.get('cwd', 'N/A')}")
    print(f"  Started:  {metadata.get('timestamp', 'N/A')}")

    for evt in events:
        if evt["type"] == "model_change":
            print(f"  Model:    {evt.get('provider', '')}/{evt.get('modelId', '')}")

    # Cost summary
    total_cost = sum(t.get("usage", {}).get("cost", {}).get("total", 0) for t in turns if t.get("usage"))
    subagent_cost = sum(
        r.get("usage", {}).get("cost", 0)
        for t in turns if t.get("subagent_details")
        for r in t["subagent_details"].get("results", [])
    )
    if total_cost > 0:
        cost_str = f"${total_cost:.4f}"
        if subagent_cost > 0:
            cost_str += f" + ${subagent_cost:.4f} subagents = ${total_cost + subagent_cost:.4f}"
        print(f"  Cost:     {cost_str}")

    print(f"  Exchanges: {len(exchanges)}")
    print()

    # Table
    print(f"{'#':<5} {'Time':<9} {'User message':<42} {'Tools':<14}")
    print(f"{'─' * 5} {'─' * 9} {'─' * 42} {'─' * 14}")

    filtered = apply_filters(exchanges, args)

    for ex in filtered:
        n = ex["number"]
        ts = format_timestamp(ex["user"]["timestamp"])
        user_text = " ".join(ex["user"]["texts"])[:40].replace("\n", " ")

        tool_names = set()
        for resp in ex["responses"]:
            if resp["role"] == "assistant":
                for tc in resp["tool_calls"]:
                    tool_names.add(tc["name"])
            if resp.get("subagent_details"):
                tool_names.add("subagent")

        tools_str = ", ".join(sorted(tool_names))[:14] if tool_names else "—"
        print(f"{n:<5} {ts:<9} {user_text:<42} {tools_str:<14}")

    print(f"\nUse --mode turn --turn N to drill into a specific exchange.")


def print_turn_detail(exchanges: list[dict], turns: list[dict], args):
    """Deep dive into a specific exchange — everything visible."""
    turn_num = args.turn
    if turn_num < 1 or turn_num > len(exchanges):
        print(f"Error: Turn {turn_num} out of range (1-{len(exchanges)})", file=sys.stderr)
        sys.exit(1)

    ex = exchanges[turn_num - 1]
    ts = format_timestamp(ex["user"]["timestamp"])

    print(f"{'═' * 70}")
    print(f"TURN #{turn_num} DETAIL")
    print(f"{'═' * 70}")

    # User message
    print(f"\n{'─' * 50}")
    print(f"👤 USER [{ts}]")
    print(f"{'─' * 50}")
    for text in ex["user"]["texts"]:
        print(truncate(text, args.max_content))

    # All responses in order
    step = 0
    for resp in ex["responses"]:
        if resp["role"] == "assistant":
            step += 1
            ts = format_timestamp(resp["timestamp"])
            model = resp.get("model", "")
            usage = resp.get("usage", {})
            cost = usage.get("cost", {})
            cost_str = f" ${cost.get('total', 0):.4f}" if cost.get("total") else ""

            print(f"\n{'─' * 50}")
            print(f"🤖 STEP {step} [{ts}]{f'  model:{model}' if model else ''}{cost_str}")
            print(f"{'─' * 50}")

            if resp["thinking"]:
                for thought in resp["thinking"]:
                    print(f"\n💭 THINKING:")
                    print(truncate(thought, args.max_content))

            for text in resp["texts"]:
                print(truncate(text, args.max_content))

            for tc in resp["tool_calls"]:
                args_str = json.dumps(tc["arguments"], indent=2)
                print(f"\n  🔧 {tc['name']}")
                print(f"  {truncate(args_str, args.max_content)}")

        elif resp["role"] == "toolResult":
            details = resp.get("subagent_details")
            if details:
                print(f"\n  {format_subagent_summary(details)}")
                for r in details.get("results", []):
                    sf = r.get("sessionFile", "")
                    ap = r.get("artifactPaths", {})
                    if sf:
                        exists = Path(sf).exists()
                        print(f"    📁 session: {sf}{'' if exists else ' (deleted)'}")
                    if ap.get("jsonlPath"):
                        exists = Path(ap["jsonlPath"]).exists()
                        print(f"    📁 jsonl: {ap['jsonlPath']}{'' if exists else ' (deleted)'}")
            else:
                err = " ❌" if resp["is_error"] else ""
                tool = resp.get("tool_name", "?")
                text = " ".join(resp["texts"])
                print(f"\n  ↳ {tool}{err}:")
                print(f"  {truncate(text, args.max_content)}")


def print_overview(metadata: dict, events: list[dict], exchanges: list[dict], turns: list[dict], args):
    """Session metadata and exchange-level summary."""
    print(f"{'═' * 70}")
    print("SESSION OVERVIEW")
    print(f"{'═' * 70}")
    print(f"  ID:       {metadata.get('id', 'N/A')}")
    print(f"  CWD:      {metadata.get('cwd', 'N/A')}")
    print(f"  Started:  {metadata.get('timestamp', 'N/A')}")
    print(f"  Version:  {metadata.get('version', 'N/A')}")

    for evt in events:
        if evt["type"] == "model_change":
            print(f"  Model:    {evt.get('provider', '')}/{evt.get('modelId', '')}")
        elif evt["type"] == "thinking_level_change":
            print(f"  Thinking: {evt.get('thinkingLevel', '')}")

    total_cost = sum(t.get("usage", {}).get("cost", {}).get("total", 0) for t in turns if t.get("usage"))
    total_input = sum(t.get("usage", {}).get("input", 0) for t in turns if t.get("usage"))
    total_output = sum(t.get("usage", {}).get("output", 0) for t in turns if t.get("usage"))

    subagent_cost = sum(
        r.get("usage", {}).get("cost", 0)
        for t in turns if t.get("subagent_details")
        for r in t["subagent_details"].get("results", [])
    )
    subagent_count = sum(1 for t in turns if t.get("subagent_details"))

    if total_cost > 0:
        print(f"  Cost:     ${total_cost:.4f}  ({total_input + total_output:,} tokens)")
    if subagent_cost > 0:
        print(f"  +Subagents: ${subagent_cost:.4f} ({subagent_count} invocations)")
        print(f"  =Total:   ${total_cost + subagent_cost:.4f}")

    print(f"  Exchanges: {len(exchanges)}")
    print()

    # Exchange summary
    print(f"{'─' * 70}")
    print("EXCHANGES")
    print(f"{'─' * 70}")

    filtered = apply_filters(exchanges, args)

    for ex in filtered:
        n = ex["number"]
        ts = format_timestamp(ex["user"]["timestamp"])
        user_text = " ".join(ex["user"]["texts"])[:200].replace("\n", " ")
        print(f"\n[{ts}] #{n} 👤 {user_text}")

        for resp in ex["responses"]:
            ts2 = format_timestamp(resp["timestamp"])
            if resp["role"] == "assistant":
                parts = []
                if resp["texts"]:
                    preview = resp["texts"][0][:120].replace("\n", " ")
                    parts.append(f'"{preview}"')
                if resp["tool_calls"]:
                    tool_names = [tc["name"] for tc in resp["tool_calls"]]
                    parts.append(f"tools:[{','.join(tool_names)}]")
                cost = resp.get("usage", {}).get("cost", {})
                cost_str = f" ${cost.get('total', 0):.4f}" if cost.get("total") else ""
                summary = " | ".join(parts) if parts else "(empty)"
                print(f"  [{ts2}] 🤖 {summary}{cost_str}")
            elif resp["role"] == "toolResult":
                details = resp.get("subagent_details")
                if details:
                    print(f"  [{ts2}] {format_subagent_summary(details)}")
                else:
                    text = " ".join(resp["texts"])[:80].replace("\n", " ")
                    err = " ❌" if resp["is_error"] else ""
                    print(f"  [{ts2}]   ↳ {resp.get('tool_name', '?')}{err}: {text}")


def print_full(exchanges: list[dict], args):
    """Everything including tool calls and results."""
    print(f"{'═' * 70}")
    print("FULL SESSION")
    print(f"{'═' * 70}")

    filtered = apply_filters(exchanges, args)

    for ex in filtered:
        n = ex["number"]
        ts = format_timestamp(ex["user"]["timestamp"])
        print(f"\n{'═' * 60}")
        print(f"#{n}  👤 USER [{ts}]")
        print(f"{'═' * 60}")
        for text in ex["user"]["texts"]:
            print(truncate(text, args.max_content))

        for resp in ex["responses"]:
            ts2 = format_timestamp(resp["timestamp"])
            if resp["role"] == "assistant":
                model = resp.get("model", "")
                print(f"\n🤖 ASSISTANT [{ts2}]{f' ({model})' if model else ''}")
                if resp["thinking"]:
                    for thought in resp["thinking"]:
                        print(f"\n  💭 THINKING: {truncate(thought, args.max_content)}")
                for text in resp["texts"]:
                    print(truncate(text, args.max_content))
                for tc in resp["tool_calls"]:
                    args_str = json.dumps(tc["arguments"])
                    print(f"\n  🔧 {tc['name']}")
                    print(f"     {truncate(args_str, args.max_content)}")
            elif resp["role"] == "toolResult":
                details = resp.get("subagent_details")
                if details:
                    print(f"\n  {format_subagent_summary(details)}")
                    for r in details.get("results", []):
                        sf = r.get("sessionFile", "")
                        ap = r.get("artifactPaths", {})
                        if sf:
                            print(f"    📁 session: {sf}")
                        if ap.get("jsonlPath"):
                            print(f"    📁 jsonl: {ap['jsonlPath']}")
                else:
                    err = " ❌" if resp["is_error"] else ""
                    print(f"\n  ↳ {resp.get('tool_name', '?')}{err}:")
                    for text in resp["texts"]:
                        print(f"     {truncate(text, args.max_content)}")


def print_tools(exchanges: list[dict], args):
    """Tool calls and results only."""
    print(f"{'═' * 70}")
    print("TOOL CALLS")
    print(f"{'═' * 70}")

    filtered = apply_filters(exchanges, args)
    tool_num = 0

    for ex in filtered:
        for resp in ex["responses"]:
            if resp["role"] == "assistant" and resp["tool_calls"]:
                ts = format_timestamp(resp["timestamp"])
                for tc in resp["tool_calls"]:
                    tool_num += 1
                    args_str = json.dumps(tc["arguments"])
                    print(f"\n[{ts}] #{tool_num} {tc['name']}  (exchange #{ex['number']})")
                    print(f"  args: {truncate(args_str, args.max_content)}")
            elif resp["role"] == "toolResult":
                details = resp.get("subagent_details")
                if details:
                    print(f"  {format_subagent_summary(details)}")
                else:
                    err = " ❌" if resp["is_error"] else " ✓"
                    text = " ".join(resp["texts"])
                    print(f"  result{err}: {truncate(text, min(args.max_content, 500))}")


def print_costs(turns: list[dict], args):
    """Cost breakdown per assistant turn."""
    print(f"{'═' * 70}")
    print("COST BREAKDOWN")
    print(f"{'═' * 70}")
    print(f"{'#':<4} {'Time':<10} {'Model':<30} {'In':>8} {'Out':>8} {'Cache':>8} {'Cost':>10}")
    print("─" * 80)

    total_cost = 0
    turn_num = 0
    assistant_num = 0
    for turn in turns:
        if turn["role"] == "user":
            turn_num += 1
        if turn["role"] != "assistant" or not turn.get("usage"):
            continue

        assistant_num += 1
        if args.offset and turn_num <= args.offset:
            continue
        if args.limit and turn_num > args.offset + args.limit:
            break

        usage = turn["usage"]
        cost = usage.get("cost", {})
        total = cost.get("total", 0)
        total_cost += total
        ts = format_timestamp(turn["timestamp"])
        model = turn.get("model", "?")

        print(
            f"{assistant_num:<4} {ts:<10} {model:<30} "
            f"{usage.get('input', 0):>8,} {usage.get('output', 0):>8,} "
            f"{usage.get('cacheRead', 0):>8,} ${total:>9.4f}"
        )

    subagent_cost = 0
    sub_num = 0
    for turn in turns:
        details = turn.get("subagent_details")
        if not details:
            continue
        for r in details.get("results", []):
            sub_num += 1
            usage = r.get("usage", {})
            cost = usage.get("cost", 0)
            subagent_cost += cost
            model = r.get("model", "?")
            agent = r.get("agent", "?")
            tokens_in = usage.get("input", 0)
            tokens_out = usage.get("output", 0)
            cache = usage.get("cacheRead", 0)
            print(
                f"{'S'+str(sub_num):<4} {'subagent':<10} {agent+'/'+model:<30} "
                f"{tokens_in:>8,} {tokens_out:>8,} "
                f"{cache:>8,} ${cost:>9.4f}"
            )

    print("─" * 80)
    grand_total = total_cost + subagent_cost
    if subagent_cost > 0:
        print(f"{'SESSION':<54} ${total_cost:>9.4f}")
        print(f"{'SUBAGENTS':<54} ${subagent_cost:>9.4f}")
    print(f"{'TOTAL':<54} ${grand_total:>9.4f}")


def print_subagents(turns: list[dict], messages: list[dict], args):
    """Detailed subagent information."""
    print(f"{'═' * 70}")
    print("SUBAGENT RUNS")
    print(f"{'═' * 70}")

    sub_num = 0
    found_any = False

    for i, entry in enumerate(messages):
        msg = entry.get("message", {})
        details = extract_subagent_details(msg)
        if not details:
            continue

        found_any = True
        mode = details.get("mode", "?")
        results = details.get("results", [])

        call_args = {}
        for j in range(i - 1, max(i - 5, -1), -1):
            prev_msg = messages[j].get("message", {})
            prev_content = prev_msg.get("content", [])
            if isinstance(prev_content, list):
                for item in prev_content:
                    if isinstance(item, dict) and item.get("type") == "toolCall" and item.get("name") == "subagent":
                        call_args = item.get("arguments", {})
                        break

        print(f"\n{'━' * 60}")
        print(f"INVOCATION #{sub_num + 1} — mode: {mode}")
        print(f"{'━' * 60}")

        if call_args.get("chain"):
            print(f"  Chain steps: {len(call_args['chain'])}")
            for step in call_args["chain"]:
                print(f"    → {step.get('agent', '?')}: {str(step.get('task', ''))[:120]}")
        elif call_args.get("tasks"):
            print(f"  Parallel tasks: {len(call_args['tasks'])}")
            for t in call_args["tasks"]:
                print(f"    → {t.get('agent', '?')}: {str(t.get('task', ''))[:120]}")

        total_cost = 0
        total_duration = 0

        for r in results:
            sub_num += 1
            agent = r.get("agent", "?")
            exit_code = r.get("exitCode", -1)
            status = "✓ completed" if exit_code == 0 else "❌ failed"
            model = r.get("model", "")
            usage = r.get("usage", {})
            cost = usage.get("cost", 0)
            total_cost += cost
            turns_count = usage.get("turns", 0)
            progress = r.get("progressSummary", {})
            duration = progress.get("durationMs", 0)
            total_duration += duration
            tool_count = progress.get("toolCount", 0)
            skills = r.get("skills", [])
            task = r.get("task", "")
            session_file = r.get("sessionFile", "")
            artifact_paths = r.get("artifactPaths", {})

            print(f"\n  ── Run #{sub_num}: {agent} ──")
            print(f"  Status:   {status}")
            print(f"  Model:    {model}")
            print(f"  Task:     {truncate(task.replace(chr(10), ' '), 300)}")
            if skills:
                print(f"  Skills:   {', '.join(skills)}")
            print(f"  Cost:     ${cost:.4f}")
            print(f"  Duration: {format_duration(duration)}")
            print(f"  Tokens:   {usage.get('input', 0):,} in / {usage.get('output', 0):,} out / {usage.get('cacheRead', 0):,} cached")
            print(f"  Tools:    {tool_count} calls in {turns_count} turns")

            if session_file:
                exists = Path(session_file).exists()
                print(f"  Session:  {session_file}{'' if exists else ' (deleted)'}")
            if artifact_paths.get("jsonlPath"):
                exists = Path(artifact_paths["jsonlPath"]).exists()
                print(f"  JSONL:    {artifact_paths['jsonlPath']}{'' if exists else ' (deleted)'}")
            if artifact_paths.get("outputPath"):
                exists = Path(artifact_paths["outputPath"]).exists()
                print(f"  Output:   {artifact_paths['outputPath']}{'' if exists else ' (deleted)'}")

        if len(results) > 1:
            print(f"\n  Combined: ${total_cost:.4f} | {format_duration(total_duration)}")

    if not found_any:
        print("\n  No subagent invocations found in this session.")


# Patterns that indicate the assistant is recovering from a failure
RETRY_PATTERNS = [
    r"(?i)let me try",
    r"(?i)try again",
    r"(?i)that didn'?t work",
    r"(?i)that failed",
    r"(?i)doesn'?t work",
    r"(?i)didn'?t work",
    r"(?i)not working",
    r"(?i)something went wrong",
    r"(?i)fix(?:ing)? (?:the|this|that)",
    r"(?i)(?:hmm|oops|ah),? (?:it |the |that |I )",
    r"(?i)error[: ]",
    r"(?i)failed to",
    r"(?i)issue with",
    r"(?i)problem with",
    r"(?i)instead,? (?:let me|I'?ll|we)",
    r"(?i)actually,? (?:let me|I'?ll|we|the)",
    r"(?i)apologi[zs]e",
    r"(?i)my mistake",
    r"(?i)I was wrong",
    r"(?i)that was incorrect",
]


def find_issues(exchanges: list[dict]) -> list[dict]:
    """Find exchanges with errors, failures, or retries."""
    issues = []

    for ex in exchanges:
        exchange_issues = []

        # 1. Tool errors
        for resp in ex["responses"]:
            if resp["role"] == "toolResult" and resp["is_error"]:
                tool = resp.get("tool_name", "?")
                text = " ".join(resp["texts"])[:300].replace("\n", " ")
                exchange_issues.append({"type": "tool_error", "tool": tool, "text": text})

        # 2. Failed subagents
        for resp in ex["responses"]:
            details = resp.get("subagent_details")
            if not details:
                continue
            for r in details.get("results", []):
                if r.get("exitCode", 0) != 0:
                    agent = r.get("agent", "?")
                    task = r.get("task", "")[:200].replace("\n", " ")
                    exchange_issues.append({"type": "subagent_failed", "agent": agent, "task": task})

        # 3. Assistant retry/correction language
        for resp in ex["responses"]:
            if resp["role"] != "assistant":
                continue
            for text in resp["texts"]:
                for pattern in RETRY_PATTERNS:
                    if re.search(pattern, text[:500]):
                        snippet = text[:200].replace("\n", " ")
                        exchange_issues.append({"type": "retry", "pattern": pattern, "text": snippet})
                        break  # one match per text block is enough

        # 4. User flagging something broken
        user_text = " ".join(ex["user"]["texts"]).lower()
        user_flags = [
            "doesn't work", "didn't work", "not working", "broken",
            "failed", "error", "bug", "wrong", "issue", "problem",
            "crash", "fix", "still ", "again",
        ]
        for flag in user_flags:
            if flag in user_text:
                exchange_issues.append({"type": "user_flag", "keyword": flag})
                break  # one match is enough

        if exchange_issues:
            issues.append({"exchange": ex, "issues": exchange_issues})

    return issues


def print_issues(exchanges: list[dict], args):
    """Surface everything that went wrong: errors, failures, retries."""
    issues = find_issues(exchanges)

    print(f"{'═' * 70}")
    print(f"ISSUES — {len(issues)} exchanges with problems (out of {len(exchanges)} total)")
    print(f"{'═' * 70}")

    if not issues:
        print("\n  ✅ No issues found — clean session.")
        return

    for item in issues:
        ex = item["exchange"]
        n = ex["number"]
        ts = format_timestamp(ex["user"]["timestamp"])
        user_text = " ".join(ex["user"]["texts"])[:120].replace("\n", " ")

        print(f"\n{'─' * 70}")
        print(f"#{n}  [{ts}]  👤 {user_text}")
        print(f"{'─' * 70}")

        for issue in item["issues"]:
            t = issue["type"]
            if t == "tool_error":
                print(f"  ❌ Tool error: {issue['tool']}")
                print(f"     {issue['text']}")
            elif t == "subagent_failed":
                print(f"  ❌ Subagent failed: {issue['agent']}")
                print(f"     {issue['task']}")
            elif t == "retry":
                print(f"  🔄 Agent retry/correction:")
                print(f"     {issue['text']}")
            elif t == "user_flag":
                print(f"  🚩 User flagged: \"{issue['keyword']}\"")

        # Show assistant's final response for this exchange
        final_texts = []
        for resp in reversed(ex["responses"]):
            if resp["role"] == "assistant" and resp["texts"]:
                final_texts = resp["texts"]
                break
        if final_texts:
            last = final_texts[-1][:300].replace("\n", " ")
            print(f"\n  💬 Final response: {last}")

    print(f"\n{'═' * 70}")
    print(f"Drill into any exchange: --mode turn --turn N")


def main():
    args = parse_args()

    path = Path(args.session_path).expanduser()
    if not path.exists():
        print(f"Error: Session file not found: {path}", file=sys.stderr)
        sys.exit(1)

    metadata, events, messages = parse_session(str(path))
    turns = extract_turns(messages)
    exchanges = group_into_exchanges(turns)

    if args.mode == "conversation":
        print_conversation(exchanges, args)
    elif args.mode == "toc":
        print_toc(metadata, events, exchanges, turns, args)
    elif args.mode == "turn":
        if not args.turn:
            print("Error: --turn N required with --mode turn", file=sys.stderr)
            sys.exit(1)
        print_turn_detail(exchanges, turns, args)
    elif args.mode == "issues":
        print_issues(exchanges, args)
    elif args.mode == "overview":
        print_overview(metadata, events, exchanges, turns, args)
    elif args.mode == "full":
        print_full(exchanges, args)
    elif args.mode == "tools":
        print_tools(exchanges, args)
    elif args.mode == "costs":
        print_costs(turns, args)
    elif args.mode == "subagents":
        print_subagents(turns, messages, args)


if __name__ == "__main__":
    main()
