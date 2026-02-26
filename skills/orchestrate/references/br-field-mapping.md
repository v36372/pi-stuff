# br Field Mapping Reference

This document is the canonical mapping between orchestrate task fields and `br` (beads_rust) equivalents.

## Why `br`?

`br` replaces hand-maintained `tasks.json` dependency tracking with a proper SQLite-backed,
dependency-aware, git-syncable issue store. Key benefits:

- `br ready --json` surfaces only dependency-unblocked tasks — no manual dep graph walking
- `br dep add / dep tree` replaces the `dependencies[]` array in `tasks.json`
- `br sync --flush-only` + `git add .beads/` makes task state git-trackable out of the box
- `--json` flag on every command gives scripts stable, parseable output

## Two complementary stores

| Store | File | Purpose |
|---|---|---|
| `br` (SQLite + JSONL) | `.beads/` | Task identity, dependencies, priority, status, success criteria |
| Active task record | `.pi/active-tasks.json` | Runtime/tmux metadata — session, model, respawn, pane snapshots |

The `brIssueId` field in `.pi/active-tasks.json` links the two.

## Field mapping

### Task identity / scheduling

| orchestrate `tasks.json` field | `br` equivalent | Notes |
|---|---|---|
| `id` | stored as `br` label `orch-id:<value>` | The `br` issue gets its own `bd-xxxx` ID; orchestrate ID is a label for cross-reference |
| `size` | label `size:small` or `size:medium` | |
| `difficulty` | label `difficulty:low`, `difficulty:medium`, `difficulty:high` | |
| `priority` | `--priority 0-4` | critical=0, high=1, medium=2, low=3, backlog=4 |
| `dependencies` | `br dep add <child-br-id> <parent-br-id>` | `br ready` automatically respects this graph |
| `status` (queued) | `br` issue `status=open` | Default on creation |
| `status` (running) | `br update <id> --status in_progress` | Set by `spawn-subagent.sh` |
| `status` (complete) | `br close <id> --reason "..."` | Set by `verify-done-gate.sh` on merge |
| `status` (cancelled) | `br update <id> --status cancelled` | |
| `ownerModel` | label `model:<provider/model>` | e.g. `model:openai/gpt-5.3-codex` |
| `fallbackModel` | label `fallback-model:<provider/model>` | |
| `aiReviewers` | label `reviewers:<csv>` | e.g. `reviewers:copilot,codex,gemini` |
| `wave` | label `wave:<wave-label>` | e.g. `wave:wave-1` |
| `expectedSuccessCriteria` | included in `--description` body | Formatted as a checklist |
| `validation` | appended to `--description` body | Formatted as shell commands |

### Priority mapping

| orchestrate `priority` | `br --priority` |
|---|---|
| `critical` | `0` |
| `high` | `1` |
| `medium` | `2` |
| `low` | `3` |
| `backlog` | `4` |

### Status mapping

| orchestrate `status` | `br` status | Notes |
|---|---|---|
| `queued` | `open` | Ready to be picked up |
| `running` | `in_progress` | Claimed by a subagent |
| `waiting-ci` | `in_progress` | Still active; CI gate pending |
| `waiting-review` | `in_progress` | Still active; review gate pending |
| `waiting-artifacts` | `in_progress` | Still active; screenshots pending |
| `waiting-human-review` | `in_progress` | Still active; human gate pending |
| `needs-human` | `in_progress` | Blocked; requires operator action |
| `complete` | `closed` | PR merged; done gate passed |
| `cancelled` | `cancelled` | Abandoned |

## Creating a task in `br`

```bash
# Get the br issue ID back as JSON
BR_ISSUE_JSON=$(br create "Implement user auth" \
  --type task \
  --priority 1 \
  --description "$(cat .pi/orchestrate/task-descriptions/feat-auth.md)" \
  --json)

BR_ISSUE_ID=$(echo "$BR_ISSUE_JSON" | jq -r '.id')

# Apply orchestrate labels
br label add "$BR_ISSUE_ID" \
  "size:medium" \
  "difficulty:high" \
  "model:openai/gpt-5.3-codex" \
  "fallback-model:google/gemini-2.5-pro" \
  "reviewers:copilot,codex,gemini" \
  "orch-id:feat-auth" \
  "wave:wave-1"

# Add dependency (feat-auth depends on feat-db-schema)
br dep add "$BR_ISSUE_ID" "$PARENT_BR_ISSUE_ID"
```

## Querying tasks as orchestrate would

```bash
# What's ready to spawn next? (dependency graph respected automatically)
br ready --json | jq '.[] | {id, title, priority, labels}'

# All open tasks
br list --status open --json

# Blocked tasks (candidates for needs-human escalation)
br blocked --json

# Stale tasks (no update in >24h)
br stale --days 1 --json

# Summary counts by status
br count --by status

# Dependency tree for a task
br dep tree <br-issue-id>

# Export to JSONL for git commit
br sync --flush-only
git add .beads/
git commit -m "chore: sync task state [orchestrate]"
```

## Generating tasks.json from br (compatibility shim)

For scripts that still consume `.pi/orchestrate/tasks.json`, regenerate it from `br`:

```bash
br list --json > .pi/orchestrate/tasks.json
```

## Extracting orchestrate metadata from br issue labels

```bash
# Get the ownerModel for a br issue
br show <br-id> --json | jq -r '.labels[] | select(startswith("model:")) | ltrimstr("model:")'

# Get the orch-id cross-reference
br show <br-id> --json | jq -r '.labels[] | select(startswith("orch-id:")) | ltrimstr("orch-id:")'
```

## brIssueId in active-tasks.json

Every active task record in `.pi/active-tasks.json` carries a `brIssueId` field linking it to the `br` issue:

```json
{
  "id": "feat-auth",
  "brIssueId": "bd-a1b2c3",
  ...
}
```

This allows scripts to call `br update "$brIssueId" --status in_progress` and `br close "$brIssueId"` without re-querying.
