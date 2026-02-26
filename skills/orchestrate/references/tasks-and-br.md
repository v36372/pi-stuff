# Rescope + task decomposition + br

## Rescoped plan

Create `.pi/orchestrate/rescoped-plan.md` with:
- In-scope / out-of-scope
- Milestones
- Updated success criteria
- Risks + mitigations

## Task decomposition outputs

Produce both:
- `.pi/orchestrate/tasks.md` (human-readable)
- `.pi/orchestrate/tasks.json` (machine source of truth)
- **`br` issues** (one per task — dependency-aware source of truth)

Each task must contain:
- `id`
- `brIssueId` (e.g. `bd-a1b2c3`)
- `size`: `small | medium`
- `difficulty`: `low | medium | high`
- `dependencies`
- `ownerModel` (user-approved)
- `fallbackModel` (optional, user-approved)
- `expectedSuccessCriteria`
- `validation`
- `aiReviewers` (CSV; default `copilot,codex,gemini`)
- `priority`
- `status`: `queued | running | complete | cancelled`

## Create each task in br during decomposition

```bash
BR_JSON=$(br create "Task title" \
  --type task \
  --priority 1 \
  --description "$(printf '%s\n\nSuccess criteria:\n%s\n\nValidation:\n%s' \
      "$TASK_DESCRIPTION" "$SUCCESS_CRITERIA" "$VALIDATION_CMDS")" \
  --json)
BR_ISSUE_ID=$(echo "$BR_JSON" | jq -r '.id')

br label add "$BR_ISSUE_ID" \
  "size:medium" \
  "difficulty:high" \
  "model:openai/gpt-5.3-codex" \
  "fallback-model:google/gemini-2.5-pro" \
  "reviewers:copilot,codex,gemini" \
  "orch-id:$TASK_ID"

# Wire dependencies (child depends on parent)
br dep add "$BR_ISSUE_ID" "$PARENT_BR_ISSUE_ID"
```

Store `$BR_ISSUE_ID` as `brIssueId` in both `tasks.json` and the active-task record.

See `references/br-field-mapping.md` for the priority/status/label mapping table.
