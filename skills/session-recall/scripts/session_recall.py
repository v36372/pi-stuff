#!/usr/bin/env python3
"""Search and prepare Pi sessions for recall without registering agent tools."""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path
from typing import Any

STOP_WORDS = {
    "a", "about", "after", "all", "an", "and", "any", "are", "as", "at",
    "be", "because", "been", "before", "being", "between", "both", "but", "by",
    "can", "could", "did", "do", "does", "during", "each", "either", "every",
    "few", "for", "from", "had", "has", "have", "he", "her", "him", "his",
    "how", "i", "if", "in", "into", "is", "it", "its", "just", "like", "may",
    "me", "might", "more", "most", "my", "neither", "no", "nor", "not", "of",
    "on", "only", "or", "other", "our", "out", "over", "own", "same", "shall",
    "she", "should", "so", "some", "such", "than", "that", "the", "their", "them",
    "these", "they", "this", "those", "through", "to", "too", "under", "us", "very",
    "was", "we", "were", "what", "when", "where", "which", "who", "whom", "will",
    "with", "without", "would", "yet", "you", "your",
}


def default_sessions_dir() -> Path:
    return Path.home() / ".pi" / "agent" / "sessions"


def parse_json_line(line: str) -> dict[str, Any] | None:
    try:
        value = json.loads(line)
    except (json.JSONDecodeError, UnicodeDecodeError):
        return None
    return value if isinstance(value, dict) else None


def load_entries(path: Path) -> list[dict[str, Any]]:
    entries: list[dict[str, Any]] = []
    with path.open(encoding="utf-8") as session_file:
        for line in session_file:
            entry = parse_json_line(line)
            if entry is not None:
                entries.append(entry)
    return entries


def active_branch(entries: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Match SessionManager.getBranch(): follow parentId from the final entry."""
    identified = [entry for entry in entries if isinstance(entry.get("id"), str)]
    if not identified:
        return []

    by_id = {entry["id"]: entry for entry in identified}
    current: dict[str, Any] | None = identified[-1]
    branch: list[dict[str, Any]] = []
    seen: set[str] = set()

    while current is not None:
        entry_id = current["id"]
        if entry_id in seen:
            raise ValueError(f"cycle in session parent chain at {entry_id}")
        seen.add(entry_id)
        branch.append(current)
        parent_id = current.get("parentId")
        current = by_id.get(parent_id) if isinstance(parent_id, str) else None

    branch.reverse()
    return branch


def compact_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True)


def message_text(entry: dict[str, Any]) -> tuple[str, str] | None:
    if entry.get("type") != "message":
        return None
    message = entry.get("message")
    if not isinstance(message, dict):
        return None
    role = message.get("role")
    if not isinstance(role, str) or role == "toolResult":
        return None

    content = message.get("content", [])
    if isinstance(content, str):
        return (role, content) if content else None
    if not isinstance(content, list):
        return None

    parts: list[str] = []
    for block in content:
        if not isinstance(block, dict):
            continue
        block_type = block.get("type")
        if block_type == "text" and isinstance(block.get("text"), str):
            parts.append(block["text"])
        elif block_type == "toolCall" and isinstance(block.get("name"), str):
            parts.append(f"[tool] {block['name']}({compact_json(block.get('arguments', {}))})")

    text = "\n".join(part for part in parts if part)
    return (role, text) if text else None


def session_messages(entries: list[dict[str, Any]]) -> list[tuple[str, str]]:
    return [message for entry in active_branch(entries) if (message := message_text(entry))]


def keywords(question: str) -> list[str]:
    words = "".join(character if character.isalnum() or character in "-_" else " " for character in question.lower())
    return [word for word in words.split() if len(word) > 2 and word not in STOP_WORDS]


def clip_around(text: str, needles: list[str], limit: int) -> str:
    if len(text) <= limit:
        return text
    lowered = text.lower()
    positions = [lowered.find(needle) for needle in needles]
    positions = [position for position in positions if position >= 0]
    body_limit = max(200, limit - 100)
    if not positions:
        head_length = body_limit // 2
        tail_length = body_limit - head_length
        omitted = len(text) - head_length - tail_length
        return text[:head_length] + f"\n[... {omitted} chars omitted ...]\n" + text[-tail_length:]

    center = min(positions)
    start = max(0, min(center - body_limit // 2, len(text) - body_limit))
    end = min(len(text), start + body_limit)
    prefix = f"[... {start} chars omitted ...]\n" if start else ""
    suffix = f"\n[... {len(text) - end} chars omitted ...]" if end < len(text) else ""
    return prefix + text[start:end] + suffix


def window_conversation(messages: list[tuple[str, str]], question: str, max_chars: int) -> str:
    needles = keywords(question)
    # Keep enough room for three-message bookends plus several relevant messages.
    per_message_limit = max(250, min(12_000, max_chars // 12))
    parts = [f"[{role}]\n{clip_around(text, needles, per_message_limit)}" for role, text in messages]
    full_text = "\n\n".join(parts)
    if len(full_text) <= max_chars:
        return full_text

    scores = [sum(needle in part.lower() for needle in needles) for part in parts]
    selected: set[int] = set()
    used_chars = 0

    def add(index: int) -> bool:
        nonlocal used_chars
        if index in selected:
            return True
        cost = len(parts[index]) + 80
        if selected and used_chars + cost > max_chars:
            return False
        selected.add(index)
        used_chars += cost
        return True

    total = len(parts)
    for index in list(range(min(3, total))) + list(range(max(0, total - 3), total)):
        add(index)

    ranked = sorted(range(total), key=lambda index: (-scores[index], index))
    relevant: list[int] = []
    for index in ranked:
        if scores[index] > 0 and add(index):
            relevant.append(index)

    for radius in (1, 2):
        for index in relevant:
            for neighbor in (index - radius, index + radius):
                if 0 <= neighbor < total:
                    add(neighbor)

    if not relevant:
        for index in range(total):
            if not add(index):
                break

    output: list[str] = []
    previous = -1
    for index in sorted(selected):
        if previous >= 0 and index > previous + 1:
            omitted = index - previous - 1
            output.append(f"[... {omitted} active-branch message{'s' if omitted != 1 else ''} omitted ...]")
        output.append(parts[index])
        previous = index
    return "\n\n".join(output)


def session_metadata(path: Path, entries: list[dict[str, Any]]) -> tuple[str, str]:
    header = next((entry for entry in entries if entry.get("type") == "session"), {})
    cwd = header.get("cwd") if isinstance(header.get("cwd"), str) else "unknown"
    try:
        project = "~/" + str(Path(cwd).relative_to(Path.home()))
    except ValueError:
        project = cwd
    date = path.name[:10] if len(path.name) >= 10 else "unknown"
    return date, project


def snippet_around(text: str, query: str, radius: int = 120) -> str:
    compact = " ".join(text.split())
    index = compact.lower().find(query.lower())
    if index < 0:
        return compact[: radius * 2]
    start = max(0, index - radius)
    end = min(len(compact), index + len(query) + radius)
    return ("..." if start else "") + compact[start:end] + ("..." if end < len(compact) else "")


def rg_matches(query: str, sessions_dir: Path) -> list[tuple[Path, int]]:
    try:
        result = subprocess.run(
            ["rg", "--no-ignore", "-i", "-c", "-F", "--glob", "*.jsonl", "--", query, str(sessions_dir)],
            check=False,
            capture_output=True,
            text=True,
            timeout=15,
        )
    except FileNotFoundError as error:
        raise RuntimeError("ripgrep (rg) is required for session recall") from error
    except subprocess.TimeoutExpired as error:
        raise RuntimeError("session search timed out after 15 seconds") from error

    if result.returncode == 1:
        return []
    if result.returncode != 0:
        detail = result.stderr.strip() or f"rg exited {result.returncode}"
        raise RuntimeError(f"session search failed: {detail}")

    matches: list[tuple[Path, int]] = []
    for line in result.stdout.splitlines():
        raw_path, separator, raw_count = line.rpartition(":")
        if separator and raw_count.isdigit():
            matches.append((Path(raw_path).resolve(), int(raw_count)))
    return sorted(matches, key=lambda match: (-match[1], str(match[0])))


def current_session_path() -> Path | None:
    value = os.environ.get("PI_SESSION_FILE")
    return Path(value).resolve() if value else None


def search_sessions(
    query: str,
    sessions_dir: Path,
    limit: int,
    snippet_limit: int,
    include_current: bool,
) -> list[tuple[Path, int, str, str, list[tuple[str, str]]]]:
    current = current_session_path()
    results: list[tuple[Path, int, str, str, list[tuple[str, str]]]] = []

    for path, count in rg_matches(query, sessions_dir):
        if not include_current and current == path:
            continue
        try:
            entries = load_entries(path)
        except (OSError, UnicodeError):
            continue
        snippets: list[tuple[str, str]] = []
        for entry in entries:
            readable = message_text(entry)
            if readable is None:
                continue
            role, text = readable
            if query.lower() in text.lower():
                snippets.append((role, snippet_around(text, query)))
                if len(snippets) >= snippet_limit:
                    break
        if not snippets:
            continue
        date, project = session_metadata(path, entries)
        results.append((path, count, date, project, snippets))
        if len(results) >= limit:
            break
    return results


def validate_session_path(path: Path, sessions_dir: Path) -> Path:
    resolved_path = path.expanduser().resolve()
    resolved_root = sessions_dir.expanduser().resolve()
    if resolved_path.suffix != ".jsonl":
        raise ValueError(f"expected a .jsonl session file: {resolved_path}")
    if not resolved_path.is_relative_to(resolved_root):
        raise ValueError(f"session must be under {resolved_root}: {resolved_path}")
    if not resolved_path.is_file():
        raise ValueError(f"session file not found: {resolved_path}")
    return resolved_path


def command_search(args: argparse.Namespace) -> int:
    sessions_dir = args.sessions_dir.expanduser().resolve()
    if not sessions_dir.is_dir():
        raise ValueError(f"sessions directory not found: {sessions_dir}")
    results = search_sessions(args.query, sessions_dir, args.limit, args.snippets, args.include_current)
    if not results:
        print(f'No readable past sessions matched the literal phrase "{args.query}".')
        print("Retry with one distinctive filename, function, package, error fragment, issue ID, or exact phrase.")
        return 1

    print(f'Found {len(results)} past session(s) matching "{args.query}":')
    for index, (path, count, date, project, snippets) in enumerate(results, start=1):
        print(f"\n{index}. {date} · {project} · {count} raw match{'es' if count != 1 else ''}")
        print(f"Session: {path}")
        for role, snippet in snippets:
            print(f"  [{role}] {snippet}")
    return 0


def command_query(args: argparse.Namespace) -> int:
    sessions_dir = args.sessions_dir.expanduser().resolve()
    path = validate_session_path(args.session, sessions_dir)
    entries = load_entries(path)
    messages = session_messages(entries)
    if not messages:
        raise ValueError(f"session has no readable messages on its active branch: {path}")
    date, project = session_metadata(path, entries)
    conversation = window_conversation(messages, args.question, args.max_chars)
    print(f"Session: {path}")
    print(f"Date: {date}")
    print(f"Project: {project}")
    print(f"Focused question: {args.question}")
    print("\nActive-branch conversation (assistant thinking and tool results omitted):\n")
    print(conversation)
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)

    search = subparsers.add_parser("search", help="find sessions by literal text")
    search.add_argument("query", help="one literal token or exact phrase")
    search.add_argument("--sessions-dir", type=Path, default=default_sessions_dir())
    search.add_argument("--limit", type=int, default=10)
    search.add_argument("--snippets", type=int, default=3)
    search.add_argument("--include-current", action="store_true")
    search.set_defaults(handler=command_search)

    query = subparsers.add_parser("query", help="prepare one session for focused analysis")
    query.add_argument("session", type=Path)
    query.add_argument("question", help="focused question to answer from this session")
    query.add_argument("--sessions-dir", type=Path, default=default_sessions_dir())
    query.add_argument("--max-chars", type=int, default=40_000)
    query.set_defaults(handler=command_query)
    return parser


def main() -> int:
    args = build_parser().parse_args()
    query_text = args.query if args.command == "search" else args.question
    if not query_text.strip():
        raise ValueError("query text must not be empty")
    if getattr(args, "limit", 1) < 1 or getattr(args, "snippets", 1) < 1:
        raise ValueError("limits must be positive")
    if getattr(args, "max_chars", 2_000) < 2_000:
        raise ValueError("--max-chars must be at least 2000")
    return args.handler(args)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, RuntimeError, ValueError) as error:
        print(f"session-recall: {error}", file=sys.stderr)
        raise SystemExit(2)
