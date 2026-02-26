# Monitoring + review actions

## Periodic monitor loop (every ~10 minutes)

```bash
"$ORCHESTRATE_SCRIPTS_DIR/check-active-tasks.sh" \
  --task-file .pi/active-tasks.json \
  --capture-pane-lines 80 \
  --require-human-review false
```

Suggested cron:

```cron
*/10 * * * * cd /path/to/repo && "$ORCHESTRATE_SCRIPTS_DIR/check-active-tasks.sh" --task-file .pi/active-tasks.json >> .pi/orchestrate-monitor.log 2>&1
```

Monitor behavior is documented in `references/orchestrator-operations.md`.

## Human review actions (optional)

```bash
"$ORCHESTRATE_SCRIPTS_DIR/human-review-action.sh" --task-id feat-custom-templates --approve
"$ORCHESTRATE_SCRIPTS_DIR/human-review-action.sh" --task-id feat-custom-templates --request-changes "Please address API contract mismatch and add tests."
```

## Status dashboard + done gate

```bash
"$ORCHESTRATE_SCRIPTS_DIR/orchestrate-status.sh" --task-file .pi/active-tasks.json
```

Verify done gate for a task:

```bash
"$ORCHESTRATE_SCRIPTS_DIR/verify-done-gate.sh" --task-id feat-custom-templates --task-file .pi/active-tasks.json
```

When the gate passes and `brIssueId` is set, `verify-done-gate.sh` automatically:
1. calls `br close <brIssueId> --reason "PR merged. Done gate passed."`
2. calls `br sync --flush-only` to export `.beads/issues.jsonl`
3. prints a reminder to `git add .beads/ && git commit`
