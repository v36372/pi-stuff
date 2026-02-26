---
name: orchestrate
description: Orchestrates end-to-end execution of detailed engineering plans by rescoping to small/medium tasks, running low-concurrency subagent waves with user-selected models, and managing autonomous PR-to-merge loops with monitor-driven follow-up control.
compatibility: Requires git, tmux, gh, jq, br
---

# Orchestrate

Use this skill for end-to-end delivery of a complete idea (not a single feature).

## References (read on demand)

- `references/preflight.md` — **mandatory** preflight (script discovery + br init)
- `references/interview.md` — interview flow + /answer usage + model selection prompt
- `references/tasks-and-br.md` — rescope plan, task schema, br issue creation
- `references/execution-and-spawn.md` — scheduling, prompt rendering, spawning
- `references/monitoring.md` — monitor loop, review actions, dashboards
- `references/active-task-record.md` — active task record schema
- `references/orchestrator-operations.md` — detailed monitor behavior
- `references/definition-of-done.md` — strict done gate
- `references/br-field-mapping.md` — br label/status mapping

## Inputs

- A plan/PRD markdown file path (required)
- Project context files (README, architecture/docs)
- User preferences (deadline, quality bar)
- **Maximum subagent concurrency** (required before spawning)
- **Allowed subagent model pool** (required before spawning, must be from logged-in providers)

## Non-negotiables (short list)

1. Break work into **small/medium** tasks only (no “big”).
2. Every task includes success criteria + validation steps.
3. Get one user sign-off on rescoped plan + execution policy, then proceed autonomously.
4. Ask for `maxConcurrency` and allowed models **before** any spawn.
5. Use **waves** capped by `maxConcurrency` (never one subagent per task by default).
6. Use only user-approved models; never bypass helper scripts.
7. Keep `.pi/orchestrate/tasks.json` as the machine source of truth.
8. Keep tmux sessions alive until PRs are merged.

## Workflow (high level)

0. **Preflight (mandatory):** read `references/preflight.md` and run the checks.
1. **Intake:** read PRD + key context, summarize scope/risks/unknowns.
2. **Interview:** read `references/interview.md` and collect answers (use `/answer` in TUI).
3. **Rescope:** write `.pi/orchestrate/rescoped-plan.md`.
4. **Decompose:** create tasks + br issues (see `references/tasks-and-br.md`).
5. **Plan execution:** create `.pi/orchestrate/execution-plan.md` and schedule waves.
6. **Approval gate:** get one go/no-go, then proceed autonomously.
7. **Prepare prompts:** render task prompts (see `references/execution-and-spawn.md`).
8. **Spawn wave(s):** use helper scripts only; pass br issue IDs.
9. **Monitor:** use periodic monitor loop (see `references/monitoring.md`).
10. **Done gate:** enforce definition-of-done (see `references/definition-of-done.md`).

## Output behavior

- Keep updates concise and status-driven.
- Escalate only actionable blockers.
- Report concurrency usage and follow-up actions on each checkpoint.
