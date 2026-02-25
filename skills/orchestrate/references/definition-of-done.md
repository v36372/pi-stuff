# Definition of Done (Orchestrate)

A task is complete only if all checks below pass.

## 1) Pull Request

- PR exists for the task branch.
- PR is not draft.
- PR description includes task success criteria and validation evidence.

## 2) Branch health

- Branch is up to date with `main`.
- No merge conflicts (`mergeStateStatus` is clean/mergeable).

## 3) CI quality gates

All required checks are green:

- lint
- typecheck
- unit tests
- E2E tests

## 4) AI review gates

Required review approvals:

- Codex review approved
- Gemini review approved
- Copilot review approved

If any of these request changes, the task is not done.

## 5) Human review gate

- Human reviewer explicitly approves the PR.
- If human requests changes, subagent addresses feedback and re-enters CI + AI review loop.

## 6) Merge + session closure

- PR is merged.
- Subagent tmux session is closed after merge.

## 7) UI evidence

If the PR changes UI files/components:

- screenshots (or recording) are attached in PR description/comments

## 8) Final task state

- `.pi/active-tasks.json` task status = `complete`
- completion timestamp is recorded
- optional user notification is sent when `notifyOnComplete = true`
