#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  verify-done-gate.sh --task-id <id> [--task-file <path>] [--base-branch <main>] [--require-human-review <true|false>]

Verifies orchestrate definition-of-done gates for one task.
Exits non-zero when any required gate fails.
EOF
}

TASK_ID=""
TASK_FILE=".pi/active-tasks.json"
BASE_BRANCH="main"
REQUIRE_HUMAN_REVIEW="false"

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
    --base-branch)
      BASE_BRANCH="${2:-}"
      shift 2
      ;;
    --require-human-review)
      REQUIRE_HUMAN_REVIEW="${2:-}"
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

case "$REQUIRE_HUMAN_REVIEW" in
  true|false) ;;
  *)
    echo "--require-human-review must be true or false" >&2
    exit 1
    ;;
esac

if ! command -v jq >/dev/null 2>&1; then
  echo "Missing command: jq" >&2
  exit 1
fi
if ! command -v gh >/dev/null 2>&1; then
  echo "Missing command: gh" >&2
  exit 1
fi
if ! command -v git >/dev/null 2>&1; then
  echo "Missing command: git" >&2
  exit 1
fi

ROOT_DIR="$(git rev-parse --show-toplevel 2>/dev/null || true)"
if [[ -z "$ROOT_DIR" ]]; then
  echo "verify-done-gate.sh must run inside a git repository" >&2
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

task="$(jq -c --arg id "$TASK_ID" 'if type == "array" then . else [.] end | map(select(.id == $id)) | .[0] // empty' "$TASK_FILE_ABS")"
if [[ -z "$task" ]]; then
  echo "Task not found: $TASK_ID" >&2
  exit 1
fi

repo="$(jq -r '.repo // ""' <<<"$task")"
pr_number="$(jq -r '.prNumber // empty' <<<"$task")"
pr_url="$(jq -r '.prUrl // ""' <<<"$task")"
human_review_state="$(jq -r '.humanReviewState // "pending"' <<<"$task")"
ai_reviewers_csv="$(jq -r '.aiReviewers // "copilot,codex,gemini"' <<<"$task" | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]' | sed 's/,,*/,/g; s/^,//; s/,$//')"
if [[ -z "$ai_reviewers_csv" ]]; then
  ai_reviewers_csv="copilot,codex,gemini"
fi
for reviewer in ${ai_reviewers_csv//,/ }; do
  case "$reviewer" in
    copilot|codex|gemini) ;;
    *)
      echo "Unsupported aiReviewers entry in task: $reviewer" >&2
      exit 1
      ;;
  esac
done
status="$(jq -r '.status // "running"' <<<"$task")"

if [[ -z "$pr_number" && -n "$pr_url" ]]; then
  pr_number="$(sed -E 's#^.*/pull/([0-9]+).*$#\1#' <<<"$pr_url")"
fi

if [[ -z "$pr_number" ]]; then
  echo "FAIL: no PR linked for task"
  exit 1
fi

if [[ -n "$repo" ]]; then
  pr="$(gh -R "$repo" pr view "$pr_number" --json number,url,isDraft,state,mergedAt,mergeStateStatus,statusCheckRollup,reviews,files,body)"
else
  pr="$(gh pr view "$pr_number" --json number,url,isDraft,state,mergedAt,mergeStateStatus,statusCheckRollup,reviews,files,body)"
fi

failures=()

is_draft="$(jq -r '.isDraft // false' <<<"$pr")"
if [[ "$is_draft" == "true" ]]; then
  failures+=("PR is draft")
fi

pr_state="$(jq -r '.state // ""' <<<"$pr")"
if [[ "$pr_state" != "OPEN" && "$pr_state" != "MERGED" ]]; then
  failures+=("PR state is $pr_state (expected OPEN or MERGED)")
fi

merge_state="$(jq -r '.mergeStateStatus // "UNKNOWN"' <<<"$pr")"
case "$merge_state" in
  CLEAN|HAS_HOOKS|UNSTABLE) ;;
  *) failures+=("Branch not mergeable with ${BASE_BRANCH} (mergeStateStatus=$merge_state)") ;;
esac

checks_failed="$(jq '[.statusCheckRollup[]? | ((.conclusion // .state // "") | ascii_upcase) | select(test("FAILURE|ERROR|TIMED_OUT|CANCELLED|ACTION_REQUIRED"))] | length' <<<"$pr")"
checks_pending="$(jq '[.statusCheckRollup[]? | ((.conclusion // .state // "") | ascii_upcase) | select(test("PENDING|QUEUED|IN_PROGRESS|EXPECTED|WAITING"))] | length' <<<"$pr")"
if [[ "$checks_failed" -gt 0 ]]; then
  failures+=("CI has failing checks")
fi
if [[ "$checks_pending" -gt 0 ]]; then
  failures+=("CI checks still pending")
fi

reviewer_required() {
  local reviewer="$1"
  local csv="$2"
  [[ ",${csv}," == *",${reviewer},"* ]]
}

latest_state_for() {
  local key="$1"
  jq -r --arg key "$key" '[.reviews[]? | select((.author.login // "" | ascii_downcase | contains($key))) | {s:(.state // ""), t:(.submittedAt // .submitted_at // "")}] | sort_by(.t) | (last | .s) // ""' <<<"$pr"
}

codex_state="$(latest_state_for codex)"
gemini_state="$(latest_state_for gemini)"
copilot_state="$(latest_state_for copilot)"

if reviewer_required "codex" "$ai_reviewers_csv"; then
  [[ "$codex_state" == "APPROVED" ]] || failures+=("Codex review not approved")
fi
if reviewer_required "gemini" "$ai_reviewers_csv"; then
  [[ "$gemini_state" == "APPROVED" ]] || failures+=("Gemini review not approved")
fi
if reviewer_required "copilot" "$ai_reviewers_csv"; then
  [[ "$copilot_state" == "APPROVED" ]] || failures+=("Copilot review not approved")
fi

if [[ "$REQUIRE_HUMAN_REVIEW" == "true" ]]; then
  if [[ "$human_review_state" != "approved" ]]; then
    failures+=("Human review state is '$human_review_state' (expected approved)")
  fi
fi

ui_changed="$(jq -r '[.files[]?.path | ascii_downcase | select(test("\\.(css|scss|sass|less|html|jsx|tsx|vue|svelte)$") or test("(^|/)(ui|components|pages|screens|frontend|web)(/|$)"))] | length > 0' <<<"$pr")"
if [[ "$ui_changed" == "true" ]]; then
  screenshots_included="$(jq -r '(.body // "" | ascii_downcase | test("screenshot|screen recording|loom|video"))' <<<"$pr")"
  task_screenshots="$(jq -r '.uiScreenshotsProvided // false' <<<"$task")"
  if [[ "$screenshots_included" != "true" && "$task_screenshots" != "true" ]]; then
    failures+=("UI changed but screenshot/recording evidence not found")
  fi
fi

if [[ "$status" == "complete" ]]; then
  :
elif [[ "$pr_state" == "MERGED" ]]; then
  failures+=("Task status is '$status' but PR is merged; task record not finalized")
fi

if [[ ${#failures[@]} -gt 0 ]]; then
  echo "FAIL: ${#failures[@]} done-gate check(s) failed for task $TASK_ID"
  for f in "${failures[@]}"; do
    echo "- $f"
  done
  exit 1
fi

echo "PASS: task $TASK_ID satisfies done gates"
