#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  orchestrate-status.sh [--task-file <path>] [--json]

Shows orchestrate task dashboard:
- task id
- wave
- model
- status
- PR
- CI
- AI reviews
- human review
- blocker
EOF
}

TASK_FILE=".pi/active-tasks.json"
AS_JSON="false"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --task-file)
      TASK_FILE="${2:-}"
      shift 2
      ;;
    --json)
      AS_JSON="true"
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

if ! command -v jq >/dev/null 2>&1; then
  echo "Missing command: jq" >&2
  exit 1
fi
if ! command -v git >/dev/null 2>&1; then
  echo "Missing command: git" >&2
  exit 1
fi

ROOT_DIR="$(git rev-parse --show-toplevel 2>/dev/null || true)"
if [[ -z "$ROOT_DIR" ]]; then
  echo "orchestrate-status.sh must run inside a git repository" >&2
  exit 1
fi

if [[ "$TASK_FILE" = /* ]]; then
  TASK_FILE_ABS="$TASK_FILE"
else
  TASK_FILE_ABS="$ROOT_DIR/$TASK_FILE"
fi

if [[ ! -f "$TASK_FILE_ABS" ]]; then
  echo "No task file found: $TASK_FILE_ABS"
  exit 0
fi

json="$(jq 'if type == "array" then . else [.] end' "$TASK_FILE_ABS")"

if [[ "$AS_JSON" == "true" ]]; then
  jq '.' <<<"$json"
  exit 0
fi

# br summary (shown when br is available and a .beads/ workspace exists)
if command -v br >/dev/null 2>&1 && [[ -d "$ROOT_DIR/.beads" ]]; then
  echo "=== br task summary ==="
  br count --by status 2>/dev/null || true
  echo ""
  echo "Ready to schedule:"
  br ready --no-color 2>/dev/null | head -10 || true
  echo ""
fi

echo "=== Active task dashboard ==="

printf '%s\n' "TASK_ID|WAVE|MODEL|STATUS|PR|CI|AI|HUMAN|BLOCKER"

jq -r '
  .[]
  | {
      id: (.id // "-"),
      wave: (.wave // "-"),
      model: (.model // "-"),
      status: (.status // "-"),
      pr: (if (.prUrl // "") == "" then "-" else .prUrl end),
      ci: (
        if (.ciFailing // false) then "failing"
        elif (.ciPending // false) then "pending"
        elif (.ciPassing // false) then "passing"
        else "-" end
      ),
      ai: (
        if (.aiReviewsPassed // false) then "passed"
        else ([
          (if (.codexReviewPassed // false) then empty else "codex" end),
          (if (.geminiReviewPassed // false) then empty else "gemini" end),
          (if (.copilotReviewPassed // false) then empty else "copilot" end)
        ] | map(select(. != null)) | if length == 0 then "pending" else ("waiting:" + (join(","))) end)
        end
      ),
      human: (.humanReviewState // "pending"),
      blocker: (.blockingReason // "")
    }
  | "\(.id)|\(.wave)|\(.model)|\(.status)|\(.pr)|\(.ci)|\(.ai)|\(.human)|\(.blocker)"
' <<<"$json" | column -t -s '|'
