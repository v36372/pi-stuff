# Orchestrator Operations Playbook

Use this reference when running live orchestration loops.

## 0) Interview decision capture

During interview, capture:
- allowed subagent models (`provider/model`)
- AI reviewers CSV (`aiReviewers`), default `copilot,codex,gemini`

Persist reviewer choice into task records so monitor and done-gate checks use the same reviewer policy.

## 1) PR-first escalation policy

Goal: avoid long-running implementation without a reviewable PR.

`check-active-tasks.sh` supports:

- `--pr-open-sla-minutes <n>`: allowed minutes before first PR must exist
- `--pr-open-max-nudges <n>`: how many PR-open nudges before human escalation

Behavior:
1. If no PR exists beyond SLA, orchestrator sends a focused PR-open nudge.
2. Nudges are capped.
3. If cap is exhausted and PR still missing, task becomes `needs-human`.

## 2) Session resilience and fallback model

Use `spawn-subagent.sh --fallback-model <provider/model>` for each task when possible.

When tmux session is down:
1. Monitor attempts respawn up to `maxRespawnAttempts`.
2. If respawn budget is exhausted and fallback model exists, switch model.
3. Respawn using fallback model and continue same task/branch.

Task record fields involved:
- `fallbackModel`
- `fallbackActivated`
- `fallbackActivatedAt`

## 3) Live context source

Monitor context should come from `tmux capture-pane`, PR status, and review metadata. Do not depend on parsing subagent log files for orchestration decisions.

## 4) Follow-up prompt dedupe/cooldown

To reduce spam, monitor tracks:
- `lastFollowupHash`
- `lastFollowupAt`

A follow-up is sent when:
- message hash changed and cooldown elapsed, or
- human requested changes (`pendingHumanFollowup = true`, only in human-review mode)

Use `--followup-cooldown-minutes <n>` to tune cadence.

## 5) Recommended monitor command

Continuous autonomous mode (default):

```bash
"$ORCHESTRATE_SCRIPTS_DIR/check-active-tasks.sh" \
  --task-file .pi/active-tasks.json \
  --pr-open-sla-minutes 45 \
  --pr-open-max-nudges 3 \
  --followup-cooldown-minutes 15 \
  --capture-pane-lines 80 \
  --require-human-review false
```

Human-reviewed mode:

```bash
"$ORCHESTRATE_SCRIPTS_DIR/check-active-tasks.sh" \
  --task-file .pi/active-tasks.json \
  --require-human-review true
```

## 6) Daily operator checklist

- Run dashboard: `"$ORCHESTRATE_SCRIPTS_DIR/orchestrate-status.sh"`
- Resolve `needs-human` tasks first.
- Confirm each running task has exactly one open PR.
- Confirm AI review request happened immediately after PR creation.
- Verify done gate before final completion update.

## 7) br task store workflow

The orchestrate skill uses `br` (beads_rust) as the dependency-aware task store alongside
`.pi/active-tasks.json` (which holds runtime/tmux metadata). See `references/br-field-mapping.md`
for the full field mapping.

### Initialization (once per initiative)

```bash
# br is checked during Step 0 preflight; if .beads/ is absent it is created automatically.
# To initialize manually:
br init
br config --set id.prefix=orch   # optional: prefix all issue IDs with "orch-"
```

### Task decomposition (Step 4)

For each task, create a `br` issue and store the returned ID in the active-task record:

```bash
BR_JSON=$(br create "Task title" --type task --priority 1 --description "..." --json)
BR_ID=$(echo "$BR_JSON" | jq -r '.id')

br label add "$BR_ID" "size:medium" "difficulty:high" \
  "model:openai/gpt-5.3-codex" "reviewers:copilot,codex,gemini" "wave:wave-1"

# Add dependency: this task depends on another br issue
br dep add "$BR_ID" "$PARENT_BR_ID"
```

### Scheduling (Step 5)

Use `br ready --json` as the source of truth for wave picks — it automatically
excludes any task whose dependencies are not yet closed:

```bash
br ready --json | jq --argjson n "$AVAILABLE_SLOTS" '.[:$n]'
```

### Claiming (Step 7 — inside spawn-subagent.sh)

Immediately after launching the tmux session, `spawn-subagent.sh` marks the issue in-progress:

```bash
br update "$BR_ISSUE_ID" --status in_progress
```

### Monitoring (Step 8)

Supplement tmux pane snapshots with `br` signals:

```bash
br blocked --json          # Tasks whose deps are not closed — escalation candidates
br stale --days 1 --json   # Tasks with no update in >24h
br count --by status       # Quick summary
```

### Completion (Steps 10-11 — inside verify-done-gate.sh)

When all done-gate checks pass and the PR is merged:

```bash
br close "$BR_ISSUE_ID" --reason "PR #${PR_NUMBER} merged. CI: pass. AI reviews: pass."
br sync --flush-only
git add .beads/
git commit -m "chore: close ${BR_ISSUE_ID} [orchestrate]"
```

### Session end checklist (mandatory)

Before ending any orchestrate session:

```bash
br sync --flush-only       # Export SQLite → JSONL
git add .beads/            # Stage beads changes
git commit -m "chore: sync task state [orchestrate]"
git push
```
