---
name: orchestrate
description: Orchestrates end-to-end execution of detailed engineering plans by rescoping to small/medium tasks, running low-concurrency subagent waves with user-selected models, and managing autonomous PR-to-merge loops with monitor-driven follow-up control.
compatibility: Requires git, tmux, gh, jq, and scripts/run-agent-with-log.sh.
---

# Orchestrate

Use this skill for end-to-end delivery of a complete idea (not just a single feature).

For detailed ops/playbooks, read references on demand:

- `references/orchestrator-operations.md`
- `references/definition-of-done.md`

## Inputs

- A plan or PRD markdown file path (required)
- Project context files (README, package docs, architecture docs)
- User preferences (deadline, quality bar)
- Maximum subagent concurrency (required before spawning)
- User-approved model set for subagents (required before spawning, must be chosen from currently logged-in models as fully-qualified `provider/model` IDs)

## Non-negotiable constraints

1. Never keep tasks as **big**. Split until each task is **small** or **medium**.
2. Every task must have explicit success criteria and validation steps.
3. Get a single user sign-off on the rescoped + execution plan, then continue autonomously.
4. PR creation is necessary but not sufficient for completion.
5. Explicitly ask user for `maxConcurrency` before any spawn.
6. Explicitly ask user which models are allowed before any spawn.
7. Never spawn one subagent per task by default. Execute in waves capped by `maxConcurrency`.
8. Prefer low concurrency for end-to-end initiatives (typically 1-3 unless user requests higher).
9. Do not assign models outside the user-approved model set.
10. During the interview, use interactive Q&A via the `answer.ts` extension when TUI is available; if unavailable, ask user to load it before proceeding.
11. When asking user to pick subagent models, display only models from currently logged-in providers.
12. After PR creation, keep tmux session alive until PR is merged.
13. Maintain `.pi/orchestrate/tasks.json` as the machine source of truth for scheduling.
14. Do not ask for repeated confirmation after startup approval unless blocked (`needs-human`) or user explicitly changes policy.
15. Never bypass helper scripts for orchestration mechanics. If helper scripts are unavailable, stop and ask user to fix skill loading/path.

## Workflow

### 0) Skill script preflight (mandatory, run once per session)

Before planning/spawning, resolve the helper script directory and verify it exists. Never proceed without this.

```bash
if [[ -x ./scripts/spawn-subagent.sh ]]; then
  ORCHESTRATE_SCRIPTS_DIR="$(cd ./scripts && pwd)"
elif [[ -x "$HOME/.pi/agent/skills/orchestrate/scripts/spawn-subagent.sh" ]]; then
  ORCHESTRATE_SCRIPTS_DIR="$HOME/.pi/agent/skills/orchestrate/scripts"
else
  ORCHESTRATE_SCRIPTS_DIR="$(find "$HOME/.pi/agent/skills" -maxdepth 4 -type f -path "*/orchestrate/scripts/spawn-subagent.sh" -print -quit | xargs -r dirname)"
fi

if [[ -z "${ORCHESTRATE_SCRIPTS_DIR:-}" || ! -x "$ORCHESTRATE_SCRIPTS_DIR/spawn-subagent.sh" ]]; then
  echo "Could not locate orchestrate helper scripts. Stop and ask user to load/install the skill path."
  exit 1
fi
```

After preflight, call helpers via `$ORCHESTRATE_SCRIPTS_DIR/<script>.sh` (absolute path), not `./scripts/...`.

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
- Review policy (AI reviewer set; default `copilot,codex,gemini`)
- **Maximum allowed parallel subagents (`maxConcurrency`)**
- **Allowed model pool for subagents + model preference by task difficulty**
- **AI code reviewers (`aiReviewers`) as CSV; default `copilot,codex,gemini`**

Interview flow:

1. Ask all interview questions in one concise batch message.
2. If interactive TUI is available, require answers through `answer.ts` via `/answer` (or `Ctrl+.`). If `answer.ts` is not loaded, ask the user to load it, then continue the interview.
3. Before asking the model-selection question, run:
   ```bash
   "$ORCHESTRATE_SCRIPTS_DIR/list-logged-in-models.sh" --ids | nl -w2 -s') '
   ```
   Then show only those numbered model IDs (formatted as `provider/model`) as selectable options (use `templates/interview-model-selection-prompt.md`).
4. Ask which AI code reviewers to use (`aiReviewers` CSV). Default is `copilot,codex,gemini` if user does not specify.
5. If no logged-in models are found, stop and ask the user to run `/login`, then continue.

If concurrency or allowed models are missing, do not plan execution yet. If `aiReviewers` is missing, default to `copilot,codex,gemini` and continue.

### 3) Rescope plan

Produce `.pi/orchestrate/rescoped-plan.md` with:

- In-scope / out-of-scope
- Milestones
- Updated success criteria
- Risks + mitigations

### 4) Task decomposition

Produce both:

- `.pi/orchestrate/tasks.md` (human-readable)
- `.pi/orchestrate/tasks.json` (machine source of truth used by scripts)

Each task must contain:

- `id`
- `size`: `small | medium` (never `big`)
- `difficulty`: `low | medium | high`
- `dependencies`
- `ownerModel` (from user-approved model pool)
- `fallbackModel` (optional, also user-approved)
- `expectedSuccessCriteria`
- `validation` (lint/type/tests/e2e/review requirements)
- `aiReviewers` (CSV, default `copilot,codex,gemini`)
- `priority`
- `status`: `queued | running | complete | cancelled`

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
- Ensure approved models are a subset of `"$ORCHESTRATE_SCRIPTS_DIR/list-logged-in-models.sh" --ids` output.

Use scheduler for deterministic wave picks:

```bash
"$ORCHESTRATE_SCRIPTS_DIR/schedule-wave.sh" \
  --tasks-file .pi/orchestrate/tasks.json \
  --active-task-file .pi/active-tasks.json \
  --max-concurrency 2 \
  --wave-label wave-1 \
  --output .pi/orchestrate/next-wave.json
```

### 5.5) Single approval gate then autonomous mode

Before spawning, show one concise approval packet containing:

- rescoped summary
- task table (id/size/model/deps)
- execution policy (`maxConcurrency`, model pool, merge behavior)

Ask for a single go/no-go. After go:

- do not ask for recurring confirmations
- continue execution + monitor loops until completion or hard blocker

### 6) Prepare subagent prompt templates

Create prompts from:

- `templates/subagent-initial-prompt.md`
- `templates/subagent-followup-prompt.md`

Write task-specific initial prompts to:

- `.pi/orchestrate/prompts/<task-id>.md`

Use renderer to avoid placeholder mistakes:

```bash
"$ORCHESTRATE_SCRIPTS_DIR/render-subagent-prompt.sh" \
  --template "$ORCHESTRATE_SCRIPTS_DIR/../templates/subagent-initial-prompt.md" \
  --output .pi/orchestrate/prompts/<task-id>.md \
  --var TASK_ID=<task-id> \
  --var TASK_DESCRIPTION="<description>" \
  --var AI_REVIEWERS_CSV="<aiReviewers-csv>"
```

Include concrete paths, constraints, and current initiative context.

The initial template requires the subagent to run a Ralph loop (`task-<id>-to-pr`) until a non-draft PR is opened.

### 7) Spawn subagents (wave-based)

Spawn only active-wave tasks, never all tasks at once.

Use helper script:

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
  --initial-prompt-file .pi/orchestrate/prompts/feat-custom-templates.md
```

The script:

- creates git worktree and branch
- optionally installs dependencies
- launches pi in tmux via `scripts/run-agent-with-log.sh`
- injects initial task prompt into the session (newline-safe compaction to avoid multi-send spam in tmux)
- stores fallback model metadata for automatic model failover when respawns are exhausted
- records task metadata in `.pi/active-tasks.json`
- monitor uses `tmux capture-pane` snapshots for live context instead of reading subagent logs

After PR creation, subagent should request AI reviews with:

```bash
"$ORCHESTRATE_SCRIPTS_DIR/request-ai-reviews.sh" --reviewers "<aiReviewers-csv>"
```

### 8) Periodic monitor loop (every 10 minutes)

Use deterministic monitor:

```bash
"$ORCHESTRATE_SCRIPTS_DIR/check-active-tasks.sh" \
  --task-file .pi/active-tasks.json \
  --capture-pane-lines 80 \
  --require-human-review false
```

Suggested cron job:

```cron
*/10 * * * * cd /path/to/repo && "$ORCHESTRATE_SCRIPTS_DIR/check-active-tasks.sh" --task-file .pi/active-tasks.json >> .pi/orchestrate-monitor.log 2>&1
```

Monitor behavior is implemented by `scripts/check-active-tasks.sh` and documented in `references/orchestrator-operations.md`.

Key outcomes:

- session resilience with fallback model failover
- PR-first escalation if no PR is opened within SLA
- deduped/cooldown follow-up prompts
- autonomous merge after CI + AI gates (unless `--require-human-review true`)

### 9) Human review actions (optional)

Record human review decisions with:

```bash
"$ORCHESTRATE_SCRIPTS_DIR/human-review-action.sh" --task-id feat-custom-templates --approve
"$ORCHESTRATE_SCRIPTS_DIR/human-review-action.sh" --task-id feat-custom-templates --request-changes "Please address API contract mismatch and add tests."
```

### 10) Status dashboard + done gate automation

Use dashboard for quick monitoring:

```bash
"$ORCHESTRATE_SCRIPTS_DIR/orchestrate-status.sh" --task-file .pi/active-tasks.json
```

Verify done gate for a specific task before marking complete:

```bash
"$ORCHESTRATE_SCRIPTS_DIR/verify-done-gate.sh" --task-id feat-custom-templates --task-file .pi/active-tasks.json
```

### 11) Definition of done gate (strict)

A task is complete only when all are true:

- PR created
- branch mergeable/synced with `main` (no conflicts)
- CI passing (lint, typecheck, unit tests, E2E)
- Codex review passed
- Gemini review passed
- Copilot review passed
- human review approved (only when running with `--require-human-review true`)
- PR merged
- tmux session closed after merge
- UI screenshots included when UI changes are present

See `references/definition-of-done.md` for details.

## Active task record

Use the shape from `templates/active-task.example.json` and include at least:

- `id`, `tmuxSession`, `agent`, `model`, `fallbackModel`, `aiReviewers`, `thinking`
- `description`, `repo`, `worktree`, `branch`
- `startedAt`, `status`, `respawnAttempts`, `maxRespawnAttempts`
- `notifyOnComplete`, `respawnCommand`, `logPath`
- `initialPromptFile`, `wave`, `priority`
- `humanReviewState`, `humanReviewFeedback`, `pendingHumanFollowup`
- `lastPaneSnippet`, `lastPaneCapturedAt` (from `tmux capture-pane`)
- `followupCount`, `lastFollowupAt`, `lastFollowupMessage`, `lastFollowupHash`, `prUpdatedAt`
- `requireHumanReview` (set by monitor policy)
- `prOpenNudgeCount`, `lastPrOpenNudgeAt`, `fallbackActivated`, `fallbackActivatedAt`

Recommended status values:

- `queued`, `running`, `waiting-ci`, `waiting-review`, `waiting-artifacts`, `waiting-human-review`, `needs-human`, `complete`, `cancelled`

## Output behavior

- Keep updates concise and status-driven.
- Escalate only actionable blockers.
- Reconcile task list against rescoped success criteria.
- Report concurrency usage and follow-up actions on each checkpoint.
