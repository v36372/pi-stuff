---
name: orchestrate
description: Orchestrates end-to-end execution of detailed engineering plans by rescoping to small/medium tasks, running low-concurrency subagent waves with user-selected models, and managing PR-to-merge loops with automated follow-up prompts and human approval gates.
compatibility: Requires git, tmux, gh, jq, and scripts/run-agent-with-log.sh.
---

# Orchestrate

Use this skill for end-to-end delivery of a complete idea (not just a single feature).

## Inputs

- A plan or PRD markdown file path (required)
- Project context files (README, package docs, architecture docs)
- User preferences (deadline, quality bar)
- Maximum subagent concurrency (required before spawning)
- User-approved model set for subagents (required before spawning, must be chosen from currently logged-in models)

## Non-negotiable constraints

1. Never keep tasks as **big**. Split until each task is **small** or **medium**.
2. Every task must have explicit success criteria and validation steps.
3. Get user sign-off on rescoped plan before spawning subagents.
4. PR creation is necessary but not sufficient for completion.
5. Explicitly ask user for `maxConcurrency` before any spawn.
6. Explicitly ask user which models are allowed before any spawn.
7. Never spawn one subagent per task by default. Execute in waves capped by `maxConcurrency`.
8. Prefer low concurrency for end-to-end initiatives (typically 1-3 unless user requests higher).
9. Do not assign models outside the user-approved model set.
10. During the interview, use interactive Q&A via the `answer.ts` extension when TUI is available; if unavailable, ask user to load it before proceeding.
11. When asking user to pick subagent models, display only models from currently logged-in providers.
12. After PR creation, keep tmux session alive until PR is merged.

## Workflow

### 1) Intake + context

1. Read the PRD/plan markdown file.
2. Read key project context (README + relevant package docs).
3. Summarize scope, assumptions, risks, and unknowns.

### 2) Clarifying interview (short)

Ask 4-7 high-impact questions only, then proceed with best-guess defaults if user is unsure. Prioritize:

- Success outcomes and exclusions
- UX/acceptance constraints
- Performance/security constraints
- Rollout and migration expectations
- Review policy (Codex/Gemini/Copilot expectations)
- **Maximum allowed parallel subagents (`maxConcurrency`)**
- **Allowed model pool for subagents + model preference by task difficulty**

Interview flow:

1. Ask all interview questions in one concise batch message.
2. If interactive TUI is available, require answers through `answer.ts` via `/answer` (or `Ctrl+.`). If `answer.ts` is not loaded, ask the user to load it, then continue the interview.
3. Before asking the model-selection question, run:
   ```bash
   ./scripts/list-logged-in-models.sh --ids | nl -w2 -s') '
   ```
   Then show only those numbered model IDs as selectable options (use `templates/interview-model-selection-prompt.md`).
4. If no logged-in models are found, stop and ask the user to run `/login`, then continue.

If concurrency or allowed models are missing, do not plan execution yet.

### 3) Rescope plan

Produce `.pi/orchestrate/rescoped-plan.md` with:

- In-scope / out-of-scope
- Milestones
- Updated success criteria
- Risks + mitigations

### 4) Task decomposition

Produce `.pi/orchestrate/tasks.md` where every task contains:

- `id`
- `size`: `small | medium` (never `big`)
- `difficulty`: `low | medium | high`
- `dependencies`
- `ownerModel` (from user-approved model pool)
- `fallbackModel` (optional, also user-approved)
- `expectedSuccessCriteria`
- `validation` (lint/type/tests/e2e/review requirements)
- `priority`

### 5) Capacity planning (low concurrency + model allocation)

Produce `.pi/orchestrate/execution-plan.md` with:

- `maxConcurrency` confirmed from user
- user-approved model pool
- model assignment policy by task type/difficulty
- wave plan (`wave-1`, `wave-2`, ...)
- active vs queued tasks

Scheduling rules:

- Running tasks must be `<= maxConcurrency`.
- Keep non-active tasks in `queued` state.
- Prioritize dependency-unblocked tasks.
- Assign only models approved by the user.
- Ensure approved models are a subset of `./scripts/list-logged-in-models.sh --ids` output.

### 6) Prepare subagent prompt templates

Create prompts from:

- `templates/subagent-initial-prompt.md`
- `templates/subagent-followup-prompt.md`

Write task-specific initial prompts to:

- `.pi/orchestrate/prompts/<task-id>.md`

Include concrete paths, constraints, and current initiative context.

### 7) Spawn subagents (wave-based)

Spawn only active-wave tasks, never all tasks at once.

Use helper script:

```bash
./scripts/spawn-subagent.sh \
  --id feat-custom-templates \
  --repo owner/repo \
  --description "Custom email templates for agency customers" \
  --worktree ../feat-custom-templates \
  --branch feat/custom-templates \
  --tmux-session codex-templates \
  --agent templates \
  --model gpt-5.3-codex \
  --thinking high \
  --initial-prompt-file .pi/orchestrate/prompts/feat-custom-templates.md
```

The script:

- creates git worktree and branch
- optionally installs dependencies
- launches pi in tmux via `scripts/run-agent-with-log.sh`
- injects initial task prompt into the session
- records task metadata in `.pi/active-tasks.json`

After PR creation, subagent should request AI reviews with:

```bash
./scripts/request-ai-reviews.sh --reviewers "github-copilot[bot],codex,gemini"
```

### 8) Periodic monitor loop (every 10 minutes)

Use deterministic monitor:

```bash
./scripts/check-active-tasks.sh --task-file .pi/active-tasks.json
```

Suggested cron job:

```cron
*/10 * * * * cd /path/to/repo && ./packages/coding-agent/examples/skills/orchestrate/scripts/check-active-tasks.sh --task-file .pi/active-tasks.json >> .pi/orchestrate-monitor.log 2>&1
```

Monitor responsibilities:

- keep tmux sessions alive while PR is open
- verify PR exists for tracked branch
- wait for automated reviews from Copilot/Codex/Gemini
- if automated reviews were not requested, prompt subagent to run `./scripts/request-ai-reviews.sh`
- check CI/check runs via `gh`
- on CI failures or critical AI review feedback, send a structured follow-up prompt (failing checks + links, review summaries, required response format) to subagent tmux session
- if a session is unexpectedly down, respawn it (max attempts)
- notify user for human review only after CI + AI review gates pass
- merge PR after human approval, then close tmux session
- if human requests changes, send follow-up prompt to subagent and continue the loop

### 9) Human review actions

Record human review decisions with:

```bash
./scripts/human-review-action.sh --task-id feat-custom-templates --approve
./scripts/human-review-action.sh --task-id feat-custom-templates --request-changes "Please address API contract mismatch and add tests."
```

### 10) Definition of done gate (strict)

A task is complete only when all are true:

- PR created
- branch mergeable/synced with `main` (no conflicts)
- CI passing (lint, typecheck, unit tests, E2E)
- Codex review passed
- Gemini review passed
- Copilot review passed
- human review approved
- PR merged
- tmux session closed after merge
- UI screenshots included when UI changes are present

See `references/definition-of-done.md` for details.

## Active task record

Use the shape from `templates/active-task.example.json` and include at least:

- `id`, `tmuxSession`, `agent`, `model`, `thinking`
- `description`, `repo`, `worktree`, `branch`
- `startedAt`, `status`, `respawnAttempts`, `maxRespawnAttempts`
- `notifyOnComplete`, `respawnCommand`, `logPath`
- `initialPromptFile`, `wave`, `priority`
- `humanReviewState`, `humanReviewFeedback`, `pendingHumanFollowup`
- `followupCount`, `lastFollowupAt`, `lastFollowupMessage`, `prUpdatedAt`

Recommended status values:

- `queued`, `running`, `waiting-ci`, `waiting-review`, `waiting-artifacts`, `waiting-human-review`, `needs-human`, `complete`, `cancelled`

## Output behavior

- Keep updates concise and status-driven.
- Escalate only actionable blockers.
- Reconcile task list against rescoped success criteria.
- Report concurrency usage and follow-up actions on each checkpoint.
