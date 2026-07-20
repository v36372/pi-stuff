# code-blocks

Renders fenced code blocks as bordered, syntax-highlighted boxes instead of
pi's default plain code.

```
╭ python ───────────────────────────╮
│ def greet(name):                  │
│     return f"hi {name}"           │
╰───────────────────────────────────╯
```

- Language label in the top border (truncated to fit)
- Syntax highlighting via the active theme
- Wrapped to the pane width with `│` borders
- Inside **thinking/reasoning** blocks: code is dimmed and italicized to match
  the surrounding trace, so it reads as part of the reasoning, not as output

Patches `Markdown.prototype.renderToken` (reference-counted, restored cleanly
on session end).

## Copy code blocks

| Binding / command | Action |
|-------------------|--------|
| `super+x` (Cmd+X on macOS) | Copy raw contents of all fenced code blocks in the last agent message |
| `/copy-code` | Same as above |

This copies the **source** code only — no markdown fences and no UI box borders
(those borders are render-only and never part of the message text).

Multiple blocks are joined with a blank line.

> Pi uses the key id `super` for the Command/Windows/Super key. There is no
> `cmd+…` alias. Super/Cmd chords need a terminal that reports the Super
> modifier (Kitty protocol / modifyOtherKeys).

Built-in comparison: `ctrl+x` / `/copy` copies the **entire** last assistant
message (`app.message.copy`).

## Dependencies

- **Runtime:** [Pi](https://github.com/earendil-works/pi-coding-agent) extension API.
- **Depends on extensions:** None.
- **Used by extensions:** [`better-native-pi`](../better-native-pi/).
