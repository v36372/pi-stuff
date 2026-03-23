# Pi Review Extension

A lightweight plan review and diff review extension for Pi.

This directory now contains the extension logic plus both UI apps (`plan-review-ui/` and `diff-review-ui/`).

## Commands

- `/plan-review [path]` — start or stop the plan review loop explicitly; optionally provide a plan file path to use for the current review loop
- `/diff-review` — open the current uncommitted git diff in the browser review UI for line-by-line feedback

## Tool

- `submit_plan_review` — opens the browser review UI and waits for approval or requested changes

## Behavior

When the user says things like “make a plan”, “draft a plan”, or similar planning requests, the extension automatically enters the plan review loop (this can be disabled with `--auto-plan-review=false`).

When the plan review loop is active, the agent is instructed to:

1. explore and draft a plan
2. write it to a task-specific plan file (or a path explicitly provided to `/plan-review`)
3. submit the plan for review with `submit_plan_review` and `filePath`
4. revise the same file if feedback is requested
5. stop once the plan is approved

This extension does **not** switch into implementation mode after approval.
