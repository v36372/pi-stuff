# Orchestrate Skill Example

A reusable skill template for running end-to-end implementation plans with:

- PRD/plan intake + clarification interview
- rescoping into small/medium tasks
- low-concurrency execution planning with user-selected subagent models as fully-qualified `provider/model` IDs (from logged-in providers only)
- interview Q&A via `answer.ts` interactive TUI (`/answer` or `Ctrl+.`)
- subagent spawning via git worktree + tmux + pi
- initial prompt injection per subagent
- deterministic monitor loop for PR/CI/AI-review lifecycle with optional human review
- structured follow-up prompts to subagents when CI or critical AI review feedback fails (with check links and response format)
- automatic respawn only when a session is unexpectedly down (capped retries)
- autonomous merge after CI+AI gates (or human-reviewed mode when enabled) and tmux close-on-merge
- strict definition-of-done gating

## Files

- `SKILL.md` - skill instructions and workflow
- `scripts/spawn-subagent.sh` - creates worktree/branch, starts tmux subagent, injects initial prompt with newline-safe compaction (prevents multi-send spam), updates `.pi/active-tasks.json`
- `scripts/check-active-tasks.sh` - checks tmux/PR/CI/reviews, captures tmux pane snapshots for status context, sends deduped follow-up prompts, enforces PR-first SLA escalation, handles merge + session close
- `scripts/request-ai-reviews.sh` - requests configured automated AI reviewers on an open PR via gh CLI (default: `copilot,codex,gemini`)
- `scripts/human-review-action.sh` - records human approval or human requested changes
- `scripts/list-logged-in-models.sh` - lists models for currently logged-in providers (used for model selection prompts)
- `scripts/render-subagent-prompt.sh` - renders prompt templates with placeholder variables
- `scripts/schedule-wave.sh` - computes next runnable wave from tasks and concurrency limits
- `scripts/orchestrate-status.sh` - compact dashboard for active orchestrated tasks
- `scripts/verify-done-gate.sh` - automated definition-of-done verification for one task
- `templates/subagent-initial-prompt.md` - initial prompt template for spawned subagents (Ralph loop until PR is created)
- `templates/subagent-followup-prompt.md` - structured follow-up prompt template for CI/review/human feedback loops
- `templates/interview-model-selection-prompt.md` - copy/paste snippet for asking model selection with numbered logged-in models
- `templates/active-task.example.json` - active task record shape
- `templates/tasks.example.json` - machine-readable task plan schema for wave scheduling
- `references/definition-of-done.md` - completion gate
- `references/orchestrator-operations.md` - PR-first escalation, fallback model failover, and follow-up cooldown policy

## Setup

```bash
cd packages/coding-agent/examples/skills/orchestrate
chmod +x scripts/*.sh
```

Copy this directory into your loaded skills location if you want to use it directly:

```bash
mkdir -p ~/.pi/agent/skills
cp -R packages/coding-agent/examples/skills/orchestrate ~/.pi/agent/skills/
```

## Usage

### Preflight (do this first in each new session)

```bash
if [[ -x ./scripts/spawn-subagent.sh ]]; then
  export ORCHESTRATE_SCRIPTS_DIR="$(cd ./scripts && pwd)"
elif [[ -x "$HOME/.pi/agent/skills/orchestrate/scripts/spawn-subagent.sh" ]]; then
  export ORCHESTRATE_SCRIPTS_DIR="$HOME/.pi/agent/skills/orchestrate/scripts"
else
  export ORCHESTRATE_SCRIPTS_DIR="$(find "$HOME/.pi/agent/skills" -maxdepth 4 -type f -path "*/orchestrate/scripts/spawn-subagent.sh" -print -quit | xargs -r dirname)"
fi

test -x "$ORCHESTRATE_SCRIPTS_DIR/spawn-subagent.sh"
```

Use `$ORCHESTRATE_SCRIPTS_DIR/<script>.sh` for all helper calls.

In pi:

```bash
/skill:orchestrate path/to/prd.md
```

During interview, if `answer.ts` extension is loaded, answer questions with interactive TUI. The orchestrator will ask for AI code reviewers to use (default: `copilot,codex,gemini`).

```bash
/answer
# or Ctrl+.
```

List only logged-in models before model-selection question (numbered `provider/model` options):

```bash
"$ORCHESTRATE_SCRIPTS_DIR/list-logged-in-models.sh" --ids | nl -w2 -s') '
```

Then use `templates/interview-model-selection-prompt.md` as the ask format.

Render an initial prompt from template:

```bash
"$ORCHESTRATE_SCRIPTS_DIR/render-subagent-prompt.sh" \
  --template templates/subagent-initial-prompt.md \
  --output .pi/orchestrate/prompts/feat-custom-templates.md \
  --var TASK_ID=feat-custom-templates \
  --var TASK_DESCRIPTION="Custom email templates" \
  --var AI_REVIEWERS_CSV="copilot,codex,gemini"
```

Select the next wave deterministically:

```bash
"$ORCHESTRATE_SCRIPTS_DIR/schedule-wave.sh" \
  --tasks-file .pi/orchestrate/tasks.json \
  --active-task-file .pi/active-tasks.json \
  --max-concurrency 2 \
  --wave-label wave-1 \
  --output .pi/orchestrate/next-wave.json
```

Spawn with task prompt:

```bash
"$ORCHESTRATE_SCRIPTS_DIR/spawn-subagent.sh" \
  --id feat-custom-templates \
  --repo owner/repo \
  --description "Custom email templates" \
  --worktree ../feat-custom-templates \
  --branch feat/custom-templates \
  --tmux-session codex-templates \
  --agent templates \
  --model openai/gpt-5.3-codex \
  --fallback-model google/gemini-2.5-pro \
  --ai-reviewers "copilot,codex,gemini" \
  --thinking high \
  --initial-prompt-file .pi/orchestrate/prompts/feat-custom-templates.md
```

Request AI reviewers after PR creation:

```bash
"$ORCHESTRATE_SCRIPTS_DIR/request-ai-reviews.sh" --reviewers "<aiReviewers-csv>"
```

Monitor task health:

```bash
"$ORCHESTRATE_SCRIPTS_DIR/check-active-tasks.sh" \
  --task-file .pi/active-tasks.json \
  --pr-open-sla-minutes 45 \
  --pr-open-max-nudges 3 \
  --followup-cooldown-minutes 15 \
  --capture-pane-lines 80 \
  --require-human-review false
```

Set `--require-human-review true` if you want explicit human PR approvals before merge.

Dashboard:

```bash
"$ORCHESTRATE_SCRIPTS_DIR/orchestrate-status.sh" --task-file .pi/active-tasks.json
```

Verify done gate before final completion:

```bash
"$ORCHESTRATE_SCRIPTS_DIR/verify-done-gate.sh" --task-id feat-custom-templates --task-file .pi/active-tasks.json
```

Human review actions (only needed when running with `--require-human-review true`):

```bash
"$ORCHESTRATE_SCRIPTS_DIR/human-review-action.sh" --task-id feat-custom-templates --approve
"$ORCHESTRATE_SCRIPTS_DIR/human-review-action.sh" --task-id feat-custom-templates --request-changes "Please fix API payload shape and update tests."
```
