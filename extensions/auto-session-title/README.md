# auto-session-title

Generates and maintains short, descriptive titles for your pi sessions.

As soon as the first prompt is accepted, it asks a cheap model for a provisional
3-word title while the main agent turn runs. After each completed turn, one
bounded request summarizes the user intent and final assistant outcome, updates
a durable session-level focus summary, and refreshes the title. Component-level
discussions stay under the main project title, even across several turns. The
title changes only when the session establishes a different primary objective.

```
before:  untitled
after:   Compact Pi Footer
```

## Herdr labels

When Pi is running inside a Herdr-managed pane (`HERDR_ENV=1`), each applied title
is also pushed to Herdr:

- **Sole pane in the tab** → renames the **tab** (`herdr tab rename`)
- **Multiple panes in the tab** → renames this **pane** (`herdr pane rename`)
- **Agents sidebar** → `display_agent` + `title` = session name, token `kind` = `pi`

On session start/resume, an existing Pi session name is restored to the same
targets so labels match without waiting for another turn. Sync is best-effort and
never interrupts the agent if Herdr is unavailable.

Recommended Agents sidebar layout (session title highlighted, kind on the next
line; no workspace/cwd/tab duplication):

```toml
[ui.sidebar.agents]
rows = [
  ["state_icon", { token = "agent", bold = true, dim = false, fg = "#7aa2f7" }],
  [{ token = "$kind", dim = true }],
]
```

Herdr paints agent/custom tokens dim by default. You must set `dim = false` on the
session-title token or the accent color stays washed out.

Reload Herdr config after editing: `herdr server reload-config`.

## Context and persistence

The title request never receives reasoning, tool calls, tool results, logs, or
raw diffs. Its 8,000-character context budget contains:

- current user request: up to 2,000 characters
- final assistant outcome: up to 2,000 characters
- original session focus anchor: up to 600 characters
- latest durable focus summary: up to 600 characters
- latest 8 turn summaries: up to 300 characters each
- legacy bootstrap only: 2 prior turn pairs, up to 700 characters per message

The same model call returns the turn summary, focus summary, and title. Completed
summary state is stored as hidden session metadata, stays out of agent context,
and is restored from the active branch after reloads, resumes, forks, and tree
navigation. The first completed focus is retained as an anchor so later questions
about protocols, tools, or architecture components do not replace the session's
main subject. Existing sessions without compatible summary state bootstrap from
their latest 3 completed turns: the latest turn uses the normal current-turn
budget, while the prior 2 are bounded migration context.

## Config

Defaults to Mistral Medium 3.5. Override the title-generation model via
`$PI_CODING_AGENT_DIR/auto-session-title.json` (defaults to
`~/.pi/agent/auto-session-title.json`). Any model available through Pi works,
including OAuth-backed providers such as OpenAI Codex:

```json
{ "provider": "openai-codex", "model": "gpt-5.6-luna" }
```

## Commands

- `/title-refresh` — regenerate the title now
- `/title-status` — show current title, summaries, last attempt, and skip reason

## Dependencies

- **Runtime:** [Pi](https://github.com/earendil-works/pi-coding-agent) extension API.
- **Depends on extensions:** None.
- **Used by extensions:** None.
