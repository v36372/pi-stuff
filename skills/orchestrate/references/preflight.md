# Preflight (mandatory)

Run once per session **before planning or spawning**.

## Script directory resolution

```bash
if [[ -x ./scripts/spawn-subagent.sh ]]; then
  ORCHESTRATE_SCRIPTS_DIR="$(cd ./scripts && pwd)"
elif [[ -x "$HOME/.pi/agent/skills/orchestrate/scripts/spawn-subagent.sh" ]]; then
  ORCHESTRATE_SCRIPTS_DIR="$HOME/.pi/agent/skills/orchestrate/scripts"
else
  ORCHESTRATE_SCRIPTS_DIR="$(find "$HOME/.pi/agent/skills" -maxdepth 4 -type f -path "*/orchestrate/scripts/spawn-subagent.sh" -print -quit | xargs -r dirname)"
fi

if [[ -z "${ORCHESTRATE_SCRIPTS_DIR:-}" || ! -x "$ORCHESTRATE_SCRIPTS_DIR/spawn-subagent.sh" ]]; then
  echo "Could not locate orchestrate helper scripts. Stop and ask user to load/install the skill path."
  exit 1
fi
```

After preflight, **call helpers via `$ORCHESTRATE_SCRIPTS_DIR/<script>.sh`** (absolute path), not `./scripts/...`.

## br preflight (required)

```bash
if ! command -v br >/dev/null 2>&1; then
  echo "br not found. Install with:"
  echo '  curl -fsSL "https://raw.githubusercontent.com/Dicklesworthstone/beads_rust/main/install.sh" | bash'
  echo "Then re-run. br is required for task tracking."
  exit 1
fi

# Initialize br workspace if not present
if [[ ! -d .beads ]]; then
  br init
  # Use a short prefix for issue IDs (change to match initiative slug)
  br config --set id.prefix=orch
  echo "br workspace initialized in .beads/"
fi
```

See `references/br-field-mapping.md` for field/label mapping.
