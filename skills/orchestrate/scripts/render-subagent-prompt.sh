#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  render-subagent-prompt.sh \
    --template <path> \
    --output <path> \
    [--var KEY=VALUE ...] \
    [--var-file <json-file>] \
    [--allow-missing]

Renders {{PLACEHOLDER}} tokens in a prompt template.

Examples:
  render-subagent-prompt.sh \
    --template templates/subagent-initial-prompt.md \
    --output .pi/orchestrate/prompts/feat-x.md \
    --var TASK_ID=feat-x \
    --var TASK_DESCRIPTION="Implement X"

  render-subagent-prompt.sh \
    --template templates/subagent-followup-prompt.md \
    --output /tmp/followup.md \
    --var-file .pi/orchestrate/prompt-vars.json
EOF
}

TEMPLATE=""
OUTPUT=""
ALLOW_MISSING="false"
VAR_ARGS=()
VAR_FILE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --template)
      TEMPLATE="${2:-}"
      shift 2
      ;;
    --output)
      OUTPUT="${2:-}"
      shift 2
      ;;
    --var)
      VAR_ARGS+=("${2:-}")
      shift 2
      ;;
    --var-file)
      VAR_FILE="${2:-}"
      shift 2
      ;;
    --allow-missing)
      ALLOW_MISSING="true"
      shift 1
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage
      exit 1
      ;;
  esac
done

if [[ -z "$TEMPLATE" || -z "$OUTPUT" ]]; then
  echo "--template and --output are required" >&2
  usage
  exit 1
fi

if [[ ! -f "$TEMPLATE" ]]; then
  echo "Template not found: $TEMPLATE" >&2
  exit 1
fi

if [[ -n "$VAR_FILE" && ! -f "$VAR_FILE" ]]; then
  echo "Var file not found: $VAR_FILE" >&2
  exit 1
fi

mkdir -p "$(dirname "$OUTPUT")"

python3 - "$TEMPLATE" "$OUTPUT" "$ALLOW_MISSING" "$VAR_FILE" "${VAR_ARGS[@]}" <<'PY'
import json
import re
import sys
from pathlib import Path

if len(sys.argv) < 5:
    print("internal error: missing argv", file=sys.stderr)
    sys.exit(1)

template_path = Path(sys.argv[1])
output_path = Path(sys.argv[2])
allow_missing = sys.argv[3] == "true"
var_file = sys.argv[4]
var_items = sys.argv[5:]

mapping = {}

if var_file:
    data = json.loads(Path(var_file).read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        print("--var-file must contain a JSON object", file=sys.stderr)
        sys.exit(1)
    for k, v in data.items():
        mapping[str(k)] = "" if v is None else str(v)

for item in var_items:
    if "=" not in item:
        print(f"Invalid --var (expected KEY=VALUE): {item}", file=sys.stderr)
        sys.exit(1)
    k, v = item.split("=", 1)
    k = k.strip()
    if not k:
        print(f"Invalid --var key: {item}", file=sys.stderr)
        sys.exit(1)
    mapping[k] = v

text = template_path.read_text(encoding="utf-8")
pattern = re.compile(r"\{\{([A-Z0-9_]+)\}\}")
missing = sorted(set(m.group(1) for m in pattern.finditer(text) if m.group(1) not in mapping))

if missing and not allow_missing:
    print("Missing template vars: " + ", ".join(missing), file=sys.stderr)
    sys.exit(1)


def replace(match: re.Match[str]) -> str:
    key = match.group(1)
    if key in mapping:
        return mapping[key]
    return match.group(0)

rendered = pattern.sub(replace, text)
output_path.write_text(rendered, encoding="utf-8")
print(f"Rendered {template_path} -> {output_path}")
PY
