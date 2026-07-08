# plannotator-annotate-last

A standalone Pi extension that forks only the "annotate last assistant message" feature from the Plannotator Pi extension (`apps/pi-extension/` in the Plannotator monorepo).

It registers `/annotate-last`, opens the agent's most recent response in the same Plannotator browser annotation UI used by `/plannotator-annotate`, and posts the resulting feedback back into the Pi session as a follow-up user message.

## What was vendored

To keep the UI functionality without reimplementing it, this extension copies the reusable server and built UI asset from the Plannotator source:

- `plannotator.html` — the single-file React annotation UI built from `apps/hook/dist/index.html`
- `generated/` — the runtime-agnostic shared modules vendored by `apps/pi-extension/vendor.sh`
- `server/` — the Node HTTP annotate server (`serverAnnotate.ts`) and its direct dependencies
- `assistant-message.ts` — helpers for reading the last assistant message from the Pi session branch

The only new code is `src/index.ts`, which is the Pi extension glue: register the command, extract the last message, start the annotate server, open the browser, and forward feedback.

## Install

```bash
cd ~/.pi/agent/extensions/plannotator-annotate-last
npm install
```

Then start Pi and run `/annotate-last`.

## Rebuild from source

If you update the Plannotator source and want to refresh the vendored assets:

```bash
cd /path/to/plannotator
bun run build:pi
cp apps/pi-extension/plannotator.html ~/.pi/agent/extensions/plannotator-annotate-last/
rm -rf ~/.pi/agent/extensions/plannotator-annotate-last/generated
rm -rf ~/.pi/agent/extensions/plannotator-annotate-last/server
cp -R apps/pi-extension/generated ~/.pi/agent/extensions/plannotator-annotate-last/
cp -R apps/pi-extension/server ~/.pi/agent/extensions/plannotator-annotate-last/
cp apps/pi-extension/assistant-message.ts ~/.pi/agent/extensions/plannotator-annotate-last/
```

## Environment variables

The same Plannotator environment variables are respected:

- `PLANNOTATOR_REMOTE` / `PLANNOTATOR_PORT` — remote mode and port
- `PLANNOTATOR_BROWSER` / `BROWSER` — browser override
- `PLANNOTATOR_SHARE` / `PLANNOTATOR_SHARE_URL` / `PLANNOTATOR_PASTE_URL` — URL sharing
- `PLANNOTATOR_DATA_DIR` — data directory override
