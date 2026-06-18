# Pi Companion Extension

A cursor-following floating status pill that shows what your pi agents are doing in real-time. Built with Glimpse.

![companion](https://github.com/user-attachments/assets/companion-demo.gif)

## What It Does

- Shows a translucent pill near your cursor with agent status (thinking, reading, editing, running, searching)
- Displays the current file/command being worked on
- Shows elapsed time and context usage percentage
- Supports multiple concurrent pi sessions
- Auto-spawns and auto-exits — no manual process management

## Files

- `index.ts` — Pi extension that hooks into agent lifecycle events and sends status over a Unix socket
- `companion.mjs` — Standalone process that opens a Glimpse window and listens for status updates
- `socket-path.mjs` — Cross-platform socket path helper (Unix sockets on macOS/Linux, named pipes on Windows)

## Setup

To use this as a pi extension, register it manually in your pi settings:

```bash
# Install glimpseui first
npm install glimpseui

# Then register the extension in your pi config
# Add to ~/.pi/settings.json or your project's .pi/settings.json:
```

```json
{
  "extensions": ["node_modules/glimpseui/examples/companion/index.ts"]
}
```

Once registered, use the `/companion` command in pi to toggle the overlay on/off.

## How It Works

1. The extension listens to pi agent events (`agent_start`, `tool_execution_start`, etc.)
2. On each event, it sends a JSON message over a Unix socket to the companion process
3. The companion process maintains a Glimpse window (frameless, transparent, click-through, follow-cursor)
4. The window renders a status pill with live updates via `eval()`
5. When all sessions disconnect and go idle, the companion auto-exits after 5 seconds
