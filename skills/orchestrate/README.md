# Orchestrate Skill Example

A reusable skill template for running end-to-end implementation plans with:

- PRD/plan intake + clarification interview
- rescoping into small/medium tasks
- low-concurrency execution planning with user-selected subagent models (from logged-in providers only)
- interview Q&A via `answer.ts` interactive TUI (`/answer` or `Ctrl+.`)
- subagent spawning via git worktree + tmux + pi
- initial prompt injection per subagent
- deterministic monitor loop for PR/CI/AI-review/human-review lifecycle
- structured follow-up prompts to subagents when CI or critical AI review feedback fails (with check links and response format)
- automatic respawn only when a session is unexpectedly down (capped retries)
- merge-on-human-approval and tmux close-on-merge
- strict definition-of-done gating

## Files

- `SKILL.md` - skill instructions and workflow
- `scripts/spawn-subagent.sh` - creates worktree/branch, starts tmux subagent, injects initial prompt with newline-safe compaction (prevents multi-send spam), updates `.pi/active-tasks.json`
- `scripts/check-active-tasks.sh` - checks tmux/PR/CI/reviews, sends deduped follow-up prompts, enforces PR-first SLA escalation, handles merge + session close
- `scripts/request-ai-reviews.sh` - requests automated AI reviewers (Copilot/Codex/Gemini) on an open PR via gh CLI
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

In pi:

```bash
/skill:orchestrate path/to/prd.md
```

During interview, if `answer.ts` extension is loaded, answer questions with interactive TUI:

```bash
/answer
# or Ctrl+.
```

List only logged-in models before model-selection question (numbered options):

```bash
./scripts/list-logged-in-models.sh --ids | nl -w2 -s') '
```

Then use `templates/interview-model-selection-prompt.md` as the ask format.

Render an initial prompt from template:

```bash
./scripts/render-subagent-prompt.sh \
  --template templates/subagent-initial-prompt.md \
  --output .pi/orchestrate/prompts/feat-custom-templates.md \
  --var TASK_ID=feat-custom-templates \
  --var TASK_DESCRIPTION="Custom email templates"
```

Select the next wave deterministically:

```bash
./scripts/schedule-wave.sh \
  --tasks-file .pi/orchestrate/tasks.json \
  --active-task-file .pi/active-tasks.json \
  --max-concurrency 2 \
  --wave-label wave-1 \
  --output .pi/orchestrate/next-wave.json
```

Spawn with task prompt:

```bash
./scripts/spawn-subagent.sh \
  --id feat-custom-templates \
  --repo owner/repo \
  --description "Custom email templates" \
  --worktree ../feat-custom-templates \
  --branch feat/custom-templates \
  --tmux-session codex-templates \
  --agent templates \
  --model gpt-5.3-codex \
  --fallback-model gemini-2.5-pro \
  --thinking high \
  --initial-prompt-file .pi/orchestrate/prompts/feat-custom-templates.md
```

Request AI reviewers after PR creation:

```bash
./scripts/request-ai-reviews.sh --reviewers "github-copilot[bot],codex,gemini"
```

Monitor task health:

```bash
./scripts/check-active-tasks.sh \
  --task-file .pi/active-tasks.json \
  --pr-open-sla-minutes 45 \
  --pr-open-max-nudges 3 \
  --followup-cooldown-minutes 15
```

Dashboard:

```bash
./scripts/orchestrate-status.sh --task-file .pi/active-tasks.json
```

Verify done gate before final completion:

```bash
./scripts/verify-done-gate.sh --task-id feat-custom-templates --task-file .pi/active-tasks.json
```

Human review actions:

```bash
./scripts/human-review-action.sh --task-id feat-custom-templates --approve
./scripts/human-review-action.sh --task-id feat-custom-templates --request-changes "Please fix API payload shape and update tests."
```
