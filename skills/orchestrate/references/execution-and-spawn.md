# Execution planning + spawning

## Capacity planning

Create `.pi/orchestrate/execution-plan.md` with:
- `maxConcurrency` confirmed
- user-approved model pool
- model assignment policy by task difficulty
- wave plan (`wave-1`, `wave-2`, ...)
- active vs queued tasks

### Scheduling (with br)

```bash
"$ORCHESTRATE_SCRIPTS_DIR/schedule-wave.sh" \
  --tasks-file .pi/orchestrate/tasks.json \
  --active-task-file .pi/active-tasks.json \
  --max-concurrency 2 \
  --wave-label wave-1 \
  --output .pi/orchestrate/next-wave.json \
  --use-br
```

Without `--use-br`, the scheduler uses dependency logic in `tasks.json`.

## Single approval gate

Before spawning, present a concise approval packet:
- rescoped summary
- task table (id/size/model/deps)
- execution policy (`maxConcurrency`, model pool, merge behavior)

After go/no-go, proceed autonomously unless blocked.

## Prompt rendering

Render task prompts via:

```bash
"$ORCHESTRATE_SCRIPTS_DIR/render-subagent-prompt.sh" \
  --template "$ORCHESTRATE_SCRIPTS_DIR/../templates/subagent-initial-prompt.md" \
  --output .pi/orchestrate/prompts/<task-id>.md \
  --var TASK_ID=<task-id> \
  --var TASK_DESCRIPTION="<description>" \
  --var AI_REVIEWERS_CSV="<aiReviewers-csv>"
```

## Spawn subagents (wave-based)

```bash
"$ORCHESTRATE_SCRIPTS_DIR/spawn-subagent.sh" \
  --id feat-custom-templates \
  --repo owner/repo \
  --description "Custom email templates for agency customers" \
  --worktree ../feat-custom-templates \
  --branch feat/custom-templates \
  --tmux-session codex-templates \
  --agent templates \
  --model openai/gpt-5.3-codex \
  --fallback-model google/gemini-2.5-pro \
  --ai-reviewers "copilot,codex,gemini" \
  --thinking high \
  --initial-prompt-file .pi/orchestrate/prompts/feat-custom-templates.md \
  --br-issue-id bd-a1b2c3
```

After PR creation, request AI reviews:

```bash
"$ORCHESTRATE_SCRIPTS_DIR/request-ai-reviews.sh" --reviewers "<aiReviewers-csv>"
```
