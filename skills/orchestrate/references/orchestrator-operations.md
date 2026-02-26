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
