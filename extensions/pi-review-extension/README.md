# Pi Review Extension

A lightweight plan review and diff review extension for Pi.

This directory contains the extension logic plus the shipped single-file UIs (`plan-review.html` and `diff-review.html`).

The `plan-review-ui/` and `diff-review-ui/` source trees are leftover upstream sources that depend on packages not present in this repo. For this extension package, the checked-in bundled HTML files are the runtime assets and the build step simply stages them into `dist-*`.

## Commands

- `/plan-review [path]` — start or stop the plan review loop explicitly; optionally provide a plan file path to use for the current review loop
- `/diff-review` — open the current uncommitted git diff in the browser review UI for line-by-line feedback

## Commands and tools used

- `/submit-plan [path]` — opens the browser review UI for the current plan file
- `execute_command` — used by the agent to queue `/submit-plan ...` at turn end without exposing a plan-review-specific tool

## Behavior

When the user says things like “make a plan”, “draft a plan”, or similar planning requests, the extension automatically enters the plan review loop (this can be disabled with `--auto-plan-review=false`).

When the plan review loop is active, the agent is instructed to:

1. explore and draft a plan
2. write it to a task-specific plan file (or a path explicitly provided to `/plan-review`)
3. submit the plan for review with `execute_command({ command: "/submit-plan <filepath>" })`
4. revise the same file if feedback is requested
5. stop once the plan is approved

This extension does **not** switch into implementation mode after approval.
