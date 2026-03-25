---
name: cmux
description: |
  Manage terminal sessions and browser surfaces via cmux — spawn workspaces
  for dev servers, test runners, background tasks, and embedded browsers.
  Read output, send commands, interact with web pages, and orchestrate
  multi-terminal workflows.
---

# cmux Terminal & Browser Management

Use this skill when you need to run processes in separate terminals you can
observe and control — dev servers, test watchers, build processes, or any
long-running task. Also use it to open browser surfaces for testing web pages,
taking screenshots, clicking elements, and reading page content.

**Prerequisite:** You must be running inside cmux (check for `CMUX_SOCKET_PATH`
in the environment). If it's not set, these commands won't work.

**Default approach:** Prefer creating **surfaces (tabs)** in the current
workspace over spawning new workspaces. Tabs keep everything grouped together
and are less disruptive. Only use `new-workspace` when you need full isolation
(e.g., a completely separate project).

---

## Environment Variables

cmux auto-sets these in every shell it spawns:

| Variable | Purpose |
|----------|---------|
| `CMUX_WORKSPACE_ID` | UUID of the current workspace |
| `CMUX_SURFACE_ID` | UUID of the current surface/panel |
| `CMUX_SOCKET_PATH` | Unix socket path (usually `/tmp/cmux.sock`) |

Commands run inside a cmux shell automatically target the right workspace
without needing `--workspace`.

---

## Core Commands

### Create a new tab (surface) in the current workspace

```bash
cmux new-surface --type terminal
# Returns: OK surface:<n> pane:<n> workspace:<n>
```

This is the **preferred way** to spawn a new shell. It creates a tab next to
the current terminal in the same workspace.

### Create a new split pane

```bash
cmux new-split <left|right|up|down>
cmux new-pane --direction <left|right|up|down> [--type terminal]
```

### Spawn a new workspace (for full isolation)

```bash
cmux new-workspace [--cwd <path>] [--command "<text>"]
# Returns: OK workspace:<n>
```

### Send commands

```bash
cmux send --surface <ref> '<command>\n'
```

The `\n` sends Enter. Without it, text is typed but not executed.

### Read terminal output

```bash
cmux read-screen --surface <ref> [--lines <n>] [--scrollback]
```

- Default: visible screen only
- `--scrollback`: include scrollback buffer
- `--lines <n>`: limit to last N lines (implies scrollback)

### Close a surface / workspace

```bash
cmux close-surface --surface <ref>
cmux close-workspace --workspace <ref>
```

### List workspaces and surfaces

```bash
cmux list-workspaces --json
cmux list-panels                   # List surfaces in current workspace
cmux tree --json                   # Full layout with all details
```

### Notifications

```bash
cmux notify --title "<text>" --body "<text>"
```

### Send special keys

```bash
cmux send-key --surface <ref> ctrl+c    # Interrupt
cmux send-key --surface <ref> ctrl+d    # EOF
cmux send-key --surface <ref> escape    # Escape
```

---

## Patterns

### Pattern 1: Start a dev server in a new tab

```bash
# Create a tab and capture its surface ref
SURFACE=$(cmux new-surface --type terminal | awk '{print $2}')
sleep 0.5

# Send the command
cmux send --surface $SURFACE 'cd /path/to/project && npm run dev\n'

# Poll until ready
for i in $(seq 1 30); do
  OUTPUT=$(cmux read-screen --surface $SURFACE --lines 20)
  if echo "$OUTPUT" | grep -qi "ready\|listening\|started\|compiled"; then
    echo "Server is ready"
    break
  fi
  sleep 1
done

# ... do work against the server ...

# Clean up when done
cmux close-surface --surface $SURFACE
```

### Pattern 2: Run tests in a tab and read results

```bash
SURFACE=$(cmux new-surface --type terminal | awk '{print $2}')
sleep 0.5
cmux send --surface $SURFACE 'cd /path/to/project && npm test\n'
sleep 10
cmux read-screen --surface $SURFACE --scrollback --lines 200
cmux close-surface --surface $SURFACE
```

### Pattern 3: Interactive session — send multiple commands

```bash
SURFACE=$(cmux new-surface --type terminal | awk '{print $2}')
sleep 0.5

cmux send --surface $SURFACE 'git status\n'
sleep 1
cmux read-screen --surface $SURFACE --lines 30

cmux send --surface $SURFACE 'git log --oneline -5\n'
sleep 1
cmux read-screen --surface $SURFACE --lines 30

cmux close-surface --surface $SURFACE
```

### Pattern 4: Monitor multiple processes

```bash
S_API=$(cmux new-surface --type terminal | awk '{print $2}')
S_WEB=$(cmux new-surface --type terminal | awk '{print $2}')
sleep 0.5

cmux send --surface $S_API 'cd ./api && npm run dev\n'
cmux send --surface $S_WEB 'cd ./web && npm run dev\n'

# Check on any of them
sleep 3
cmux read-screen --surface $S_API --lines 20
cmux read-screen --surface $S_WEB --lines 20

# Clean up
cmux close-surface --surface $S_API
cmux close-surface --surface $S_WEB
```

### Pattern 5: Split pane for side-by-side view

```bash
cmux new-split right   # Terminal split to the right
cmux new-split down    # Terminal split below
```

---

## Browser Surfaces

cmux has a built-in browser powered by Playwright. You can open web pages,
interact with them, take screenshots, and read content — all from the CLI.

**Key rule:** Browser commands require `--surface <ref>` to target the right
browser surface. The surface ref comes from the `browser open` command output.
Without it, commands may fail or target the wrong surface.

### Opening a Browser

```bash
# Open a URL — creates a browser split in the current workspace
cmux browser open "http://localhost:3000"
# Returns: OK surface=surface:42 pane=pane:7 placement=split

# Capture the surface ref for subsequent commands
BROWSER=$(cmux browser open "http://localhost:3000" | grep -oP 'surface=\Ksurface:\d+')
```

You can also create a browser as a tab or pane:

```bash
cmux new-surface --type browser --url "http://localhost:3000"
cmux new-pane --type browser --url "http://localhost:3000" --direction right
```

### Navigation

```bash
cmux browser --surface $BROWSER navigate "http://localhost:3000/page"
cmux browser --surface $BROWSER back
cmux browser --surface $BROWSER forward
cmux browser --surface $BROWSER reload
cmux browser --surface $BROWSER url        # Get current URL
```

### Screenshots (visual verification)

```bash
# Save to file, then read the image
cmux browser --surface $BROWSER screenshot --out /tmp/page.png
# Then use: read /tmp/page.png
```

### Snapshots (DOM tree — lightweight alternative to screenshots)

```bash
# Compact accessibility tree — great for understanding page structure
cmux browser --surface $BROWSER snapshot --compact
# Output: - document "Page Title"
#           - button "Submit" [ref=e1]
#           - input [ref=e2]

# Interactive snapshot (includes ref= attributes for click targets)
cmux browser --surface $BROWSER snapshot --interactive

# Scoped to a specific element
cmux browser --surface $BROWSER snapshot --selector "#main" --compact
```

### Clicking & Interacting

**Selectors use standard CSS syntax.** Playwright-style text selectors
(`text=`, `:has-text()`) do NOT work — they cause JS exceptions.

```bash
# Click by CSS selector (this works)
cmux browser --surface $BROWSER click "button"
cmux browser --surface $BROWSER click "#submit-btn"
cmux browser --surface $BROWSER click ".btn-primary"
cmux browser --surface $BROWSER click "button[type='submit']"
cmux browser --surface $BROWSER click "nav a:first-child"

# ⚠️ These DO NOT work — they throw JS exceptions:
# cmux browser --surface $BROWSER click "text=Submit"        # ❌
# cmux browser --surface $BROWSER click "button:has-text('Submit')"  # ❌
```

**To click a button by its text content,** use a snapshot first to find
the right CSS selector, or use `eval`:

```bash
# Option 1: Use snapshot to find the element, then click by CSS
cmux browser --surface $BROWSER snapshot --compact
# Shows: - button "Generate" [ref=e3]
# Then click by position or more specific CSS selector

# Option 2: Use eval for text-based matching
cmux browser --surface $BROWSER eval "document.querySelector('button').click()"
cmux browser --surface $BROWSER eval "
  Array.from(document.querySelectorAll('button'))
    .find(b => b.textContent.trim() === 'Generate')
    ?.click()
"
```

### Other interactions

```bash
cmux browser --surface $BROWSER type "input#name" "John"
cmux browser --surface $BROWSER fill "input#email" "a@b.com"
cmux browser --surface $BROWSER fill "input#email"           # empty = clear
cmux browser --surface $BROWSER check "input[type='checkbox']"
cmux browser --surface $BROWSER uncheck "input[type='checkbox']"
cmux browser --surface $BROWSER select "select#country" "US"
cmux browser --surface $BROWSER press "Enter"
cmux browser --surface $BROWSER scroll --dy 500              # scroll down
cmux browser --surface $BROWSER hover ".menu-item"
cmux browser --surface $BROWSER focus "#search"
```

### Reading Page Content

```bash
cmux browser --surface $BROWSER get url
cmux browser --surface $BROWSER get title
cmux browser --surface $BROWSER get text "h1"           # text of element
cmux browser --surface $BROWSER get html "p"            # innerHTML
cmux browser --surface $BROWSER get count "li"          # number of matches
cmux browser --surface $BROWSER get value "input#name"  # form value
cmux browser --surface $BROWSER get attr "a" "href"     # attribute value
```

### Waiting for Content

```bash
cmux browser --surface $BROWSER wait --selector ".loaded"
cmux browser --surface $BROWSER wait --text "Success"
cmux browser --surface $BROWSER wait --url-contains "/dashboard"
cmux browser --surface $BROWSER wait --load-state complete
cmux browser --surface $BROWSER wait --timeout-ms 10000 --selector "#result"
```

### Console & Errors

```bash
cmux browser --surface $BROWSER console list    # Show console messages
cmux browser --surface $BROWSER console clear
cmux browser --surface $BROWSER errors list     # Show JS errors
cmux browser --surface $BROWSER errors clear
```

### Evaluating JavaScript

```bash
cmux browser --surface $BROWSER eval "document.title"
cmux browser --surface $BROWSER eval "localStorage.getItem('token')"
cmux browser --surface $BROWSER eval "JSON.stringify(performance.timing)"
```

### Injecting Scripts & Styles

```bash
cmux browser --surface $BROWSER addscript "window.DEBUG = true"
cmux browser --surface $BROWSER addstyle "body { outline: 1px solid red; }"
```

### Pattern: Start Dev Server + Verify in Browser

```bash
# 1. Start dev server in a terminal tab
TERMINAL=$(cmux new-surface --type terminal | awk '{print $2}')
sleep 0.5
cmux send --surface $TERMINAL 'cd /path/to/project && npm run dev\n'

# 2. Wait for server to be ready
for i in $(seq 1 30); do
  OUTPUT=$(cmux read-screen --surface $TERMINAL --lines 20)
  if echo "$OUTPUT" | grep -qi "ready\|listening\|started\|compiled"; then
    break
  fi
  sleep 1
done

# 3. Open browser and verify
BROWSER=$(cmux browser open "http://localhost:5173" | grep -oP 'surface=\Ksurface:\d+')
sleep 2

# 4. Take a screenshot to verify visually
cmux browser --surface $BROWSER screenshot --out /tmp/verify.png

# 5. Or use snapshot for quick text-based check
cmux browser --surface $BROWSER snapshot --compact

# 6. Check for JS errors
cmux browser --surface $BROWSER errors list

# 7. Clean up
cmux close-surface --surface $BROWSER
cmux close-surface --surface $TERMINAL
```

### Pattern: Click Through a Flow

```bash
BROWSER=$(cmux browser open "http://localhost:3000" | grep -oP 'surface=\Ksurface:\d+')
sleep 2

# Fill a form
cmux browser --surface $BROWSER fill "input[name='email']" "test@example.com"
cmux browser --surface $BROWSER fill "input[name='password']" "secret123"
cmux browser --surface $BROWSER click "button[type='submit']"

# Wait for navigation
cmux browser --surface $BROWSER wait --url-contains "/dashboard" --timeout-ms 5000

# Verify we landed on the right page
cmux browser --surface $BROWSER get title
cmux browser --surface $BROWSER screenshot --out /tmp/dashboard.png

cmux close-surface --surface $BROWSER
```

---

## Important Notes

- **Prefer tabs over workspaces** — use `new-surface` to keep things grouped
- **Always clean up** surfaces when done — don't leave orphaned terminals
- **Use `--lines`** with read-screen to avoid dumping huge scrollback buffers
- **Surface refs are ephemeral** — `surface:16` may refer to a different
  surface next time. Always capture the ref from command output
- **Poll, don't guess** — there's no "wait for output" command, so poll
  `read-screen` in a loop when waiting for specific output
- **`\n` is literal** — the cmux CLI interprets `\n` as a newline character
  in `send` commands, which presses Enter
- **Browser `--surface` is required** — always pass `--surface <ref>` to
  browser subcommands. Without it, commands fail or target nothing
- **Browser selectors are CSS only** — `text=Foo` and `:has-text()` throw
  JS exceptions. Use standard CSS selectors or `eval` for text matching
- **Use `snapshot --compact`** before interacting — it shows the page
  structure with element refs, so you know what CSS selectors to use
- **Prefer `screenshot --out`** over `snapshot` for visual verification —
  screenshots show exactly what the user would see
