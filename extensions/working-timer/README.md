# working-timer

Shows a whimsical phrase plus a live elapsed timer on pi's built-in working row,
keeping Pi's native accent spinner by default (compatible with `cat.ts` / RunCat):

```
Noodling... (2m 17s • escape to interrupt)
```

The phrase is picked once per user-visible run from `../whimsical.ts` and stays
stable while the dimmed elapsed/interrupt suffix ticks. The interrupt hint
follows pi's configured keybinding. The timer covers the complete user-visible
run. It keeps counting across provider retries, automatic compaction and retry,
and queued continuations, then resets when pi fully settles.

Pi's dedicated retry and compaction loaders keep their native messages. The
elapsed timer resumes when the normal working row returns.

`whimsical.ts` is only the phrase library now — it no longer writes the working
message itself.

## Config

Optional `$PI_CODING_AGENT_DIR/working-timer.json` (defaults to
`~/.pi/agent/working-timer.json`):

```json
{
  "spinner": "native"
}
```

Supported spinner styles:

- `native` — leave Pi's current indicator alone (default). Compatible with
  custom indicators such as `cat.ts` / RunCat.
- `rail-3` — compact three-cell rail (replaces any custom indicator)
- `rail-3-eased` — compact rail with tiny edge holds (replaces any custom indicator)

## Dependencies

- **Runtime:** [Pi](https://github.com/earendil-works/pi-coding-agent) extension API.
- **Depends on extensions:** `whimsical.ts` (phrase source).
- **Used by extensions:** None.
