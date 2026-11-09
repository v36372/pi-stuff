# herdr-notes

Receive passive `hc note` messages in a Pi session running inside Herdr Core.
Inspired by the separation of context notes from inputs that start work.

## Usage

Installed at `~/.pi/agent/extensions/herdr-notes/`, this adapter is automatically
discovered by Pi. Run `/reload` in existing recipient sessions; new sessions
load it on startup. Any agent, shell, or script can send through Core's native
command; the sender needs no Pi extension:

```sh
hc note review "The parser already handles empty input; see src/parser.ts."
```

The destination is a local Core terminal ID or name (`hc ls` lists them).
This extension registers no model-facing tool or slash command. Core's
`hc --skill` documents sending; use `hc send` only for an explicit task that
should start or steer work.

A note is stored immediately, but **does not steer, interrupt, wake, or request
an answer from the recipient**. It joins the recipient's context with its next
input, as a visible, expandable note. Notes arriving during a run wait for the
next input; they do not change the current run. Sending a note cannot start
work or resume an idle coordinator.

The adapter advertises its mailbox through the neutral `note-mailbox` terminal
label. Core resolves the terminal and atomically appends to that document using
`terminal.note`. Missing readers, finished terminals, and remote destinations
are rejected rather than falling back to typing. Outside a Core terminal
(`HC_TERMINAL_ID` unset), the adapter is inactive.

## Persistence and limits

- Each Pi session uses a separate Core document named by a hash of its session
  ID. Notes survive reloads and Core restarts while Core state is retained.
  New sessions get different mailboxes; resuming the original reconnects it.
- Notes leave the queue only after their context entry is found in the active
  persisted Pi branch. Version-checked acknowledgements preserve concurrent
  sends; a reload after persistence does not redeliver the same note.
- Core trims note text and permits 1–4000 UTF-16 code units. A mailbox permits
  128 pending notes and 256 KiB of serialized JSON. Full or malformed mailboxes
  reject new notes without dropping existing ones. Senders outside a Core
  terminal are identified as `external`.
- Each input receives at most 16 KiB of note context, oldest first. Excess
  notes wait for a later input. Delivery does not imply the model acted on or
  answered a note; persisted notes follow normal compaction and branching.

There is no background polling, listener, or model call. The adapter reads at
input/start and settled-run boundaries, with up to eight retries for conflicting
acknowledgements. It never types, sends keys, or schedules a continuation.
RPC uses `hc connect` with the current session/endpoint and a five-second timeout.

## Reducing Core's own messages

This does not change automatic Core notifications or explicit `hc send` calls.
To suppress automatic prompt notes, set `notes = false` in
`~/.config/herdr-core/config.toml` (Windows:
`%APPDATA%\herdr-core\config.toml`). For one child, `hc run --no-notify ...`
suppresses its parent notes. Explicit prompts remain separate from passive notes.

## Dependencies

- **Runtime:** Pi 1.5+ and a Core build exposing `terminal.note` / `hc note`,
  plus `doc.get` / `doc.set`. Stock hc 0.1.18 does not include `note`; both the
  CLI and running Core need a build with this method. Both sides must reach
  the same local Core; remote delivery is not implemented.
- **Runtime npm packages:** None; uses Pi's bundled `@earendil-works/pi-tui`
  and Node built-ins.
- **Internal extensions:** None.
