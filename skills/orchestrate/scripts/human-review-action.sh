#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  human-review-action.sh --task-id <id> [--task-file <path>] (--approve | --request-changes <text> | --request-changes-file <path>)

Records human review decisions for an orchestrated task.

Actions:
- --approve                 Mark human review as approved (orchestrator can merge when AI gates pass)
- --request-changes <text>  Request changes and queue follow-up prompt for subagent
- --request-changes-file    Same as above, read feedback from file

Examples:
  human-review-action.sh --task-id feat-custom-templates --approve
  human-review-action.sh --task-id feat-custom-templates --request-changes "Please simplify API payload mapping and update tests."
EOF
}

require_command() {
  local cmd="$1"
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "Missing required command: $cmd" >&2
    exit 1
  fi
}

TASK_ID=""
TASK_FILE=".pi/active-tasks.json"
ACTION=""
FEEDBACK=""
FEEDBACK_FILE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --task-id)
      TASK_ID="${2:-}"
      shift 2
      ;;
    --task-file)
      TASK_FILE="${2:-}"
      shift 2
      ;;
    --approve)
      ACTION="approve"
      shift 1
      ;;
    --request-changes)
      ACTION="request-changes"
      FEEDBACK="${2:-}"
      shift 2
      ;;
    --request-changes-file)
      ACTION="request-changes"
      FEEDBACK_FILE="${2:-}"
      shift 2
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

if [[ -z "$TASK_ID" ]]; then
  echo "--task-id is required" >&2
  exit 1
fi

if [[ -z "$ACTION" ]]; then
  echo "Provide one action: --approve or --request-changes" >&2
  exit 1
fi

if [[ "$ACTION" == "request-changes" ]]; then
  if [[ -n "$FEEDBACK_FILE" ]]; then
    if [[ ! -f "$FEEDBACK_FILE" ]]; then
      echo "Feedback file not found: $FEEDBACK_FILE" >&2
      exit 1
    fi
    FEEDBACK="$(<"$FEEDBACK_FILE")"
  fi

  if [[ -z "$FEEDBACK" ]]; then
    echo "Request changes action requires non-empty feedback" >&2
    exit 1
  fi
fi

require_command jq
require_command git

ROOT_DIR="$(git rev-parse --show-toplevel 2>/dev/null || true)"
if [[ -z "$ROOT_DIR" ]]; then
  echo "human-review-action.sh must run inside a git repository" >&2
  exit 1
fi

if [[ "$TASK_FILE" = /* ]]; then
  TASK_FILE_ABS="$TASK_FILE"
else
  TASK_FILE_ABS="$ROOT_DIR/$TASK_FILE"
fi

if [[ ! -f "$TASK_FILE_ABS" ]]; then
  echo "Task file not found: $TASK_FILE_ABS" >&2
  exit 1
fi

if ! jq -e . "$TASK_FILE_ABS" >/dev/null 2>&1; then
  echo "Invalid JSON in $TASK_FILE_ABS" >&2
  exit 1
fi

if [[ "$ACTION" == "approve" ]]; then
  state="approved"
  pending_followup="false"
  feedback=""
else
  state="changes-requested"
  pending_followup="true"
  feedback="$FEEDBACK"
fi

NOW_MS="$(( $(date +%s) * 1000 ))"

exists="$(jq -r --arg id "$TASK_ID" 'if type == "array" then . else [.] end | any(.id == $id)' "$TASK_FILE_ABS")"
if [[ "$exists" != "true" ]]; then
  echo "Task not found: $TASK_ID" >&2
  exit 1
fi

tmp_out="$(mktemp)"
jq \
  --arg id "$TASK_ID" \
  --arg state "$state" \
  --arg feedback "$feedback" \
  --argjson pendingFollowup "$pending_followup" \
  --argjson now "$NOW_MS" \
  'if type == "array" then . else [.] end
   | map(
      if .id == $id then
        .humanReviewState = $state
        | .humanReviewFeedback = $feedback
        | .pendingHumanFollowup = $pendingFollowup
        | .lastHumanReviewActionAt = $now
        | if $state == "changes-requested" then .humanReviewRequestedAt = null else . end
      else
        .
      end
    )' "$TASK_FILE_ABS" > "$tmp_out"
mv "$tmp_out" "$TASK_FILE_ABS"

if [[ "$ACTION" == "approve" ]]; then
  echo "Recorded human approval for task: $TASK_ID"
else
  echo "Recorded human requested changes for task: $TASK_ID"
fi
