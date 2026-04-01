---
name: session-reader
description: Efficiently read and analyze pi agent session JSONL files. Use when asked to "read a session", "review a session", "analyze a session", "what happened in this session", "load session", "parse session", "session history", "go through sessions", or given a .jsonl session file path.
---

# Read Pi Sessions

Parse pi session JSONL files into readable output. Sessions live in `~/.pi/agent/sessions/<project>/` as `.jsonl` files.

## Step 1: Find the Session

```bash
ls -t ~/.pi/agent/sessions/*<project>*/*.jsonl | head -10
```

## Step 2: Start with Table of Contents

Always start with `toc` to get a numbered map of the session:

```bash
uv run ${CLAUDE_SKILL_ROOT}/scripts/read_session.py <path> --mode toc
```

This prints a compact numbered list of every user exchange with timestamps and tools used.

## Step 3: Read the Conversation

Default mode — shows only user messages and assistant text responses. Tool calls are hidden but hinted at with `[used: tool1, tool2]`.

```bash
# Full conversation (default mode)
uv run ${CLAUDE_SKILL_ROOT}/scripts/read_session.py <path>

# Specific range
uv run ${CLAUDE_SKILL_ROOT}/scripts/read_session.py <path> --offset 5 --limit 3

# Search for specific topic
uv run ${CLAUDE_SKILL_ROOT}/scripts/read_session.py <path> --search "error"
```

## Step 4: Drill Into a Turn

See everything about a specific exchange — thinking, tool calls, tool results, costs:

```bash
uv run ${CLAUDE_SKILL_ROOT}/scripts/read_session.py <path> --mode turn --turn 7
```

## Mode Reference

| Mode | Shows | Use for |
|------|-------|---------|
| `conversation` | User + assistant text only (default) | Reading what happened |
| `toc` | Numbered exchange list | Navigation, finding the right turn |
| `turn` | Full detail for one exchange | Drilling into specifics |
| `issues` | Errors, failures, retries, user complaints | Finding what broke |
| `overview` | Metadata + exchange summaries | Quick session assessment |
| `full` | Everything including tool I/O | Deep debugging |
| `tools` | Tool calls and results only | Understanding agent actions |
| `costs` | Token usage and cost per turn | Cost analysis |
| `subagents` | Subagent task/status/cost/paths | Reviewing delegated work |

## Flags

| Flag | Effect |
|------|--------|
| `--offset N` | Skip first N exchanges |
| `--limit N` | Show at most N exchanges |
| `--turn N` | Exchange number to drill into (with `--mode turn`) |
| `--search TERM` | Filter exchanges containing TERM (case-insensitive) |
| `--max-content N` | Max chars per block (default: 3000, 0=unlimited) |

## Typical Workflow

1. `--mode toc` → scan the session, find interesting exchanges
2. Default (conversation) → read the human-readable flow
3. `--mode turn --turn N` → drill into specific exchanges
4. `--mode subagents` → review delegated work and follow subagent session paths

## Subagent Drill-Down

Subagent session files can be read with the same script:

```bash
# From --mode subagents output, grab the JSONL path
uv run ${CLAUDE_SKILL_ROOT}/scripts/read_session.py <subagent-jsonl-path> --mode toc
```

## Session Format Reference

Read `${CLAUDE_SKILL_ROOT}/references/session-format.md` only if custom parsing is needed.
