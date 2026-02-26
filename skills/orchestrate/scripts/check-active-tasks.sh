#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  check-active-tasks.sh \
    [--task-file <path>] \
    [--base-branch <main>] \
    [--max-respawns <n>] \
    [--merge-method <merge|squash|rebase>] \
    [--pr-open-sla-minutes <n>] \
    [--pr-open-max-nudges <n>] \
    [--followup-cooldown-minutes <n>] \
    [--capture-pane-lines <n>] \
    [--require-human-review <true|false>] \
    [--dry-run]

Checks active orchestrator tasks deterministically:
- tmux session health
- latest tmux pane snapshot (for status context, without relying on log files)
- PR existence and merge state
- CI/check status
- required review approvals (Codex, Gemini, Copilot)
- UI screenshot evidence (when UI files changed)

Loop behavior after PR creation:
- Keep tmux session alive until PR is merged
- Wait for automated reviews/checks
- Send follow-up prompt to subagent when CI fails or critical AI review feedback appears
- If --require-human-review=true, notify human review only after CI + AI review gates pass
- Otherwise merge automatically after CI + AI gates pass
- Escalate when PR is not created within SLA and nudge subagent before human escalation
- Deduplicate/cooldown follow-up prompts to avoid spam
EOF
}

require_command() {
  local cmd="$1"
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "Missing required command: $cmd" >&2
    exit 1
  fi
}

send_prompt_to_tmux() {
  local session="$1"
  local message="$2"
  local buffer_name="orchestrate-followup-${session//[^a-zA-Z0-9]/_}-$$"

  local compact_message
  compact_message="$(printf '%s' "$message" | tr '\r\n' '  ' | tr -s '[:space:]' ' ' | sed -e 's/^ *//' -e 's/ *$//')"

  if [[ -z "$compact_message" ]]; then
    return 0
  fi

  if [[ "${#compact_message}" -gt 12000 ]]; then
    compact_message="${compact_message:0:12000} ... [truncated by orchestrate to avoid tmux input flood]"
  fi

  printf '%s' "$compact_message" | tmux load-buffer -b "$buffer_name" -
  tmux paste-buffer -b "$buffer_name" -t "$session"
  tmux send-keys -t "$session" Enter
  tmux delete-buffer -b "$buffer_name" || true
}

hash_message() {
  local message="$1"

  if command -v sha256sum >/dev/null 2>&1; then
    printf '%s' "$message" | sha256sum | awk '{print $1}'
  else
    printf '%s' "$message" | shasum -a 256 | awk '{print $1}'
  fi
}

build_pr_creation_nudge_prompt() {
  local task_id="$1"
  local elapsed_minutes="$2"

  cat <<EOF
[ORCHESTRATOR FOLLOW-UP]
Task: ${task_id}
Goal: Open the PR now. Continue on the same branch.

No PR detected after ${elapsed_minutes} minutes.

Do this next:
1. Push current branch state.
2. Open a non-draft PR immediately with current scope.
3. Include assumptions + validation commands/results in PR description.
4. Reply with: PR URL, what is done, what remains.
EOF
}

is_fully_qualified_model_ref() {
  local model_ref="$1"
  [[ "$model_ref" == */* ]] && [[ -n "${model_ref%%/*}" ]] && [[ -n "${model_ref#*/}" ]]
}

build_respawn_command() {
  local session="$1"
  local width="$2"
  local height="$3"
  local worktree_abs="$4"
  local run_agent_script="$5"
  local agent="$6"
  local model="$7"
  local thinking="$8"

  local run_agent_command
  run_agent_command="$(printf '%q %q %q %q' "$run_agent_script" "$agent" "$model" "$thinking")"
  printf 'tmux new-session -d -s %q -x %q -y %q -c %q %q' "$session" "$width" "$height" "$worktree_abs" "$run_agent_command"
}

merge_pr() {
  local repo="$1"
  local pr_number="$2"
  local merge_method="$3"
  local method_flag=""

  case "$merge_method" in
  merge)
    method_flag="--merge"
    ;;
  squash)
    method_flag="--squash"
    ;;
  rebase)
    method_flag="--rebase"
    ;;
  *)
    return 1
    ;;
  esac

  if [[ -n "$repo" ]]; then
    gh -R "$repo" pr merge "$pr_number" "$method_flag" --delete-branch
  else
    gh pr merge "$pr_number" "$method_flag" --delete-branch
  fi
}

normalize_prompt_text() {
  local text="$1"

  text="${text//$'\r'/ }"
  text="${text//$'\n'/ }"

  while [[ "$text" == *"  "* ]]; do
    text="${text//  / }"
  done

  text="${text#"${text%%[![:space:]]*}"}"
  text="${text%"${text##*[![:space:]]}"}"

  printf '%s' "$text"
}

normalize_reviewers_csv() {
  local csv="$1"
  printf '%s' "$csv" | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]' | sed 's/,,*/,/g; s/^,//; s/,$//'
}

reviewer_required() {
  local reviewer="$1"
  local csv="$2"
  [[ ",${csv}," == *",${reviewer},"* ]]
}

capture_pane_snapshot() {
  local session="$1"
  local lines="$2"

  if [[ "$lines" -eq 0 ]]; then
    return 0
  fi

  tmux capture-pane -p -t "$session" -S "-$lines" 2>/dev/null || true
}

build_structured_followup_prompt() {
  local task_id="$1"
  local pr_url="$2"
  local issue_summary="$3"
  local ci_details="$4"
  local ai_review_details="$5"
  local human_review_details="$6"

  cat <<EOF
[ORCHESTRATOR FOLLOW-UP]
Task: ${task_id}
PR: ${pr_url}
Goal: Unblock the current PR branch. Keep scope unchanged and continue on the same branch.

Blocking summary:
${issue_summary}

CI failing checks (with links):
${ci_details}

Critical AI review feedback:
${ai_review_details}

Human review feedback:
${human_review_details}

Required execution order:
1. Fix CI failures first.
2. Address AI and human review feedback.
3. Re-run relevant local validation for touched areas.
4. Push commits to the same branch and update the same PR.

Reply in this exact format after pushing:
- Root cause(s):
- Changes made (files/modules):
- Validation run (commands + outcomes):
- Remaining blockers (if any):
EOF
}

TASK_FILE=".pi/active-tasks.json"
BASE_BRANCH="main"
MAX_RESPAWNS="3"
MERGE_METHOD="squash"
PR_OPEN_SLA_MINUTES="45"
PR_OPEN_MAX_NUDGES="3"
FOLLOWUP_COOLDOWN_MINUTES="15"
CAPTURE_PANE_LINES="80"
REQUIRE_HUMAN_REVIEW="false"
DRY_RUN="false"

while [[ $# -gt 0 ]]; do
  case "$1" in
  --task-file)
    TASK_FILE="${2:-}"
    shift 2
    ;;
  --base-branch)
    BASE_BRANCH="${2:-}"
    shift 2
    ;;
  --max-respawns)
    MAX_RESPAWNS="${2:-}"
    shift 2
    ;;
  --merge-method)
    MERGE_METHOD="${2:-}"
    shift 2
    ;;
  --pr-open-sla-minutes)
    PR_OPEN_SLA_MINUTES="${2:-}"
    shift 2
    ;;
  --pr-open-max-nudges)
    PR_OPEN_MAX_NUDGES="${2:-}"
    shift 2
    ;;
  --followup-cooldown-minutes)
    FOLLOWUP_COOLDOWN_MINUTES="${2:-}"
    shift 2
    ;;
  --capture-pane-lines)
    CAPTURE_PANE_LINES="${2:-}"
    shift 2
    ;;
  --require-human-review)
    REQUIRE_HUMAN_REVIEW="${2:-}"
    shift 2
    ;;
  --dry-run)
    DRY_RUN="true"
    shift 1
    ;;
  -h | --help)
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

case "$MAX_RESPAWNS" in
'' | *[!0-9]*)
  echo "--max-respawns must be a non-negative integer" >&2
  exit 1
  ;;
esac

case "$MERGE_METHOD" in
merge | squash | rebase) ;;
*)
  echo "--merge-method must be merge, squash, or rebase" >&2
  exit 1
  ;;
esac

case "$PR_OPEN_SLA_MINUTES" in
'' | *[!0-9]*)
  echo "--pr-open-sla-minutes must be a non-negative integer" >&2
  exit 1
  ;;
esac

case "$PR_OPEN_MAX_NUDGES" in
'' | *[!0-9]*)
  echo "--pr-open-max-nudges must be a non-negative integer" >&2
  exit 1
  ;;
esac

case "$FOLLOWUP_COOLDOWN_MINUTES" in
'' | *[!0-9]*)
  echo "--followup-cooldown-minutes must be a non-negative integer" >&2
  exit 1
  ;;
esac

case "$CAPTURE_PANE_LINES" in
'' | *[!0-9]*)
  echo "--capture-pane-lines must be a non-negative integer" >&2
  exit 1
  ;;
esac

case "$REQUIRE_HUMAN_REVIEW" in
true | false) ;;
*)
  echo "--require-human-review must be true or false" >&2
  exit 1
  ;;
esac

require_command jq
require_command tmux
require_command gh
require_command git

ROOT_DIR="$(git rev-parse --show-toplevel 2>/dev/null || true)"
if [[ -z "$ROOT_DIR" ]]; then
  echo "check-active-tasks.sh must run inside a git repository" >&2
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

if ! jq -e . "$TASK_FILE_ABS" >/dev/null 2>&1; then
  echo "Invalid JSON in $TASK_FILE_ABS" >&2
  exit 1
fi

TASKS_JSON="$(jq 'if type == "array" then . elif type == "object" then [.] else [] end' "$TASK_FILE_ABS")"
TASK_COUNT="$(jq 'length' <<<"$TASKS_JSON")"
NOW_MS="$(($(date +%s) * 1000))"

alerts=()

# Supplemental br signals (non-fatal; enrich alerts when br is available)
if command -v br >/dev/null 2>&1 && [[ -d ".beads" ]]; then
  br_blocked_json="$(br blocked --json 2>/dev/null || echo "[]")"
  br_blocked_count="$(jq 'length' <<<"$br_blocked_json" 2>/dev/null || echo "0")"
  if [[ "$br_blocked_count" -gt 0 ]]; then
    blocked_titles="$(jq -r '.[].title' <<<"$br_blocked_json" | head -5 | paste -sd ', ')"
    alerts+=("br: ${br_blocked_count} blocked issue(s): ${blocked_titles}")
  fi

  br_stale_json="$(br stale --days 1 --json 2>/dev/null || echo "[]")"
  br_stale_count="$(jq 'length' <<<"$br_stale_json" 2>/dev/null || echo "0")"
  if [[ "$br_stale_count" -gt 0 ]]; then
    stale_titles="$(jq -r '.[].title' <<<"$br_stale_json" | head -5 | paste -sd ', ')"
    alerts+=("br: ${br_stale_count} stale issue(s) (>24h no update): ${stale_titles}")
  fi
fi

pr_list_json() {
  local repo="$1"
  local branch="$2"

  if [[ -n "$repo" ]]; then
    gh -R "$repo" pr list --head "$branch" --state all --json number,url,isDraft,headRefName,baseRefName,mergeStateStatus,state,mergedAt 2>/dev/null || echo "[]"
  else
    gh pr list --head "$branch" --state all --json number,url,isDraft,headRefName,baseRefName,mergeStateStatus,state,mergedAt 2>/dev/null || echo "[]"
  fi
}

pr_view_json() {
  local repo="$1"
  local pr_number="$2"

  if [[ -n "$repo" ]]; then
    gh -R "$repo" pr view "$pr_number" --json number,url,isDraft,state,mergedAt,updatedAt,mergeStateStatus,statusCheckRollup,reviews,files,body 2>/dev/null || echo '{}'
  else
    gh pr view "$pr_number" --json number,url,isDraft,state,mergedAt,updatedAt,mergeStateStatus,statusCheckRollup,reviews,files,body 2>/dev/null || echo '{}'
  fi
}

for ((i = 0; i < TASK_COUNT; i++)); do
  task="$(jq -c ".[$i]" <<<"$TASKS_JSON")"

  id="$(jq -r '.id // ""' <<<"$task")"
  status="$(jq -r '.status // "running"' <<<"$task")"
  tmux_session="$(jq -r '.tmuxSession // ""' <<<"$task")"
  branch="$(jq -r '.branch // ""' <<<"$task")"
  repo="$(jq -r '.repo // ""' <<<"$task")"
  worktree="$(jq -r '.worktree // ""' <<<"$task")"
  agent="$(jq -r '.agent // "agent"' <<<"$task")"
  model="$(jq -r '.model // ""' <<<"$task")"
  fallback_model="$(jq -r '.fallbackModel // ""' <<<"$task")"
  thinking="$(jq -r '.thinking // "medium"' <<<"$task")"
  run_agent_script="$(jq -r '.runAgentScript // "scripts/run-agent-with-log.sh"' <<<"$task")"
  tmux_width="$(jq -r '.tmuxWidth // 80' <<<"$task")"
  tmux_height="$(jq -r '.tmuxHeight // 24' <<<"$task")"
  fallback_activated="$(jq -r '.fallbackActivated // false' <<<"$task")"
  fallback_activated_at_json="$(jq '.fallbackActivatedAt // null' <<<"$task")"
  respawn_attempts="$(jq -r '.respawnAttempts // 0' <<<"$task")"
  max_attempts="$(jq -r '.maxRespawnAttempts // empty' <<<"$task")"
  respawn_command="$(jq -r '.respawnCommand // ""' <<<"$task")"
  notify_on_complete="$(jq -r '.notifyOnComplete // false' <<<"$task")"
  human_review_state="$(jq -r '.humanReviewState // "pending"' <<<"$task")"
  human_review_feedback="$(jq -r '.humanReviewFeedback // ""' <<<"$task")"
  ai_reviewers_csv="$(jq -r '.aiReviewers // "copilot,codex,gemini"' <<<"$task")"
  pending_human_followup="$(jq -r '.pendingHumanFollowup // false' <<<"$task")"
  followup_count="$(jq -r '.followupCount // 0' <<<"$task")"
  last_followup_message="$(jq -r '.lastFollowupMessage // ""' <<<"$task")"
  close_session_on_merge="$(jq -r '.closeSessionOnMerge // true' <<<"$task")"
  task_merge_method="$(jq -r '.mergeMethod // ""' <<<"$task")"

  started_at_ms="$(jq -r '.startedAt // 0' <<<"$task")"
  pr_open_nudge_count="$(jq -r '.prOpenNudgeCount // 0' <<<"$task")"
  last_pr_open_nudge_at_json="$(jq '.lastPrOpenNudgeAt // null' <<<"$task")"
  last_followup_hash="$(jq -r '.lastFollowupHash // ""' <<<"$task")"
  last_pane_snippet="$(jq -r '.lastPaneSnippet // ""' <<<"$task")"
  last_pane_captured_at_json="$(jq '.lastPaneCapturedAt // null' <<<"$task")"
  last_followup_at_json="$(jq '.lastFollowupAt // null' <<<"$task")"
  completed_at_json="$(jq '.completedAt // null' <<<"$task")"
  last_respawn_at_json="$(jq '.lastRespawnAt // null' <<<"$task")"
  last_heartbeat_json="$(jq '.lastHeartbeatAt // null' <<<"$task")"
  human_review_requested_at_json="$(jq '.humanReviewRequestedAt // null' <<<"$task")"
  last_human_review_action_at_json="$(jq '.lastHumanReviewActionAt // null' <<<"$task")"
  merged_at_json="$(jq '.mergedAt // null' <<<"$task")"

  last_human_review_action_ms="$(jq -r '.lastHumanReviewActionAt // 0' <<<"$task")"
  case "$last_human_review_action_ms" in
  '' | *[!0-9]*) last_human_review_action_ms="0" ;;
  esac

  case "$followup_count" in
  '' | *[!0-9]*) followup_count="0" ;;
  esac

  case "$pr_open_nudge_count" in
  '' | *[!0-9]*) pr_open_nudge_count="0" ;;
  esac

  case "$started_at_ms" in
  '' | *[!0-9]*) started_at_ms="0" ;;
  esac

  ai_reviewers_csv="$(normalize_reviewers_csv "$ai_reviewers_csv")"
  if [[ -z "$ai_reviewers_csv" ]]; then
    ai_reviewers_csv="copilot,codex,gemini"
  fi

  for reviewer in ${ai_reviewers_csv//,/ }; do
    case "$reviewer" in
      copilot|codex|gemini) ;;
      *)
        alerts+=("$id: unsupported aiReviewers entry '$reviewer'; reverting to default copilot,codex,gemini")
        ai_reviewers_csv="copilot,codex,gemini"
        break
        ;;
    esac
  done

  case "$tmux_width" in
  '' | *[!0-9]*) tmux_width="80" ;;
  esac

  case "$tmux_height" in
  '' | *[!0-9]*) tmux_height="24" ;;
  esac

  if [[ -z "$max_attempts" ]]; then
    max_attempts="$MAX_RESPAWNS"
  fi

  case "$max_attempts" in
  '' | *[!0-9]*) max_attempts="$MAX_RESPAWNS" ;;
  esac

  effective_merge_method="$MERGE_METHOD"
  case "$task_merge_method" in
  merge | squash | rebase)
    effective_merge_method="$task_merge_method"
    ;;
  esac

  if [[ -z "$id" || -z "$tmux_session" || -z "$branch" ]]; then
    alerts+=("$id: invalid task record (missing id/tmuxSession/branch)")
    continue
  fi

  if ! is_fully_qualified_model_ref "$model"; then
    alerts+=("$id: invalid model '$model' (expected provider/model). Marking needs-human.")
    updated_task="$(jq --arg status "needs-human" --arg blockingReason "invalid model format: expected provider/model" --argjson lastCheckedAt "$NOW_MS" '.status=$status | .blockingReason=$blockingReason | .lastCheckedAt=$lastCheckedAt' <<<"$task")"
    TASKS_JSON="$(jq --argjson task "$updated_task" ".[$i] = \$task" <<<"$TASKS_JSON")"
    continue
  fi

  if [[ -n "$fallback_model" ]] && ! is_fully_qualified_model_ref "$fallback_model"; then
    alerts+=("$id: ignoring invalid fallback model '$fallback_model' (expected provider/model)")
    fallback_model=""
  fi

  if [[ "$status" == "complete" || "$status" == "cancelled" ]]; then
    continue
  fi

  tmux_alive="false"
  if tmux has-session -t "$tmux_session" 2>/dev/null; then
    tmux_alive="true"
  fi

  has_open_pr="false"
  has_merged_pr="false"
  pr_number_json="null"
  pr_url=""
  pr_state="NONE"
  pr_updated_at_ms="0"

  ci_failing="false"
  ci_pending="false"
  ci_passing="false"
  branch_mergeable="false"
  codex_review_passed="false"
  gemini_review_passed="false"
  copilot_review_passed="false"
  codex_latest_state=""
  gemini_latest_state=""
  copilot_latest_state=""
  ai_review_request_needed="false"
  critical_review_feedback="false"
  ui_changed="false"
  screenshots_included="true"

  checks_failed_names=""
  checks_failed_details="- none"
  critical_review_sources=""
  critical_review_details="- none"
  human_review_details="- none"

  pr_list="$(pr_list_json "$repo" "$branch")"
  open_pr_item="$(jq '[.[] | select((.state // "" | ascii_upcase) == "OPEN")] | .[0] // null' <<<"$pr_list")"
  merged_pr_item="$(jq '[.[] | select((.state // "" | ascii_upcase) == "MERGED")] | .[0] // null' <<<"$pr_list")"

  if [[ "$open_pr_item" != "null" ]]; then
    has_open_pr="true"
    pr_number_json="$(jq '.number' <<<"$open_pr_item")"
    pr_url="$(jq -r '.url // ""' <<<"$open_pr_item")"
    pr_state="OPEN"

    pr_detail="$(pr_view_json "$repo" "$(jq -r '.number' <<<"$open_pr_item")")"
    pr_updated_at_ms="$(jq -r 'try ((.updatedAt // "" | if . == "" then 0 else (fromdateiso8601 * 1000 | floor) end)) catch 0' <<<"$pr_detail")"
    case "$pr_updated_at_ms" in
    '' | *[!0-9]*) pr_updated_at_ms="0" ;;
    esac

    merge_state="$(jq -r '.mergeStateStatus // "UNKNOWN"' <<<"$pr_detail")"
    case "$merge_state" in
    CLEAN | HAS_HOOKS | UNSTABLE)
      branch_mergeable="true"
      ;;
    *)
      branch_mergeable="false"
      ;;
    esac

    checks_total="$(jq '[.statusCheckRollup[]?] | length' <<<"$pr_detail")"
    checks_failed="$(jq '[.statusCheckRollup[]? | ((.conclusion // .state // "") | ascii_upcase) | select(. == "FAILURE" or . == "ERROR" or . == "TIMED_OUT" or . == "CANCELLED" or . == "ACTION_REQUIRED")] | length' <<<"$pr_detail")"
    checks_pending="$(jq '[.statusCheckRollup[]? | ((.conclusion // .state // "") | ascii_upcase) | select(. == "PENDING" or . == "QUEUED" or . == "IN_PROGRESS" or . == "EXPECTED" or . == "WAITING")] | length' <<<"$pr_detail")"

    checks_failed_names="$(jq -r '[.statusCheckRollup[]? | select(((.conclusion // .state // "") | ascii_upcase) | test("FAILURE|ERROR|TIMED_OUT|CANCELLED|ACTION_REQUIRED")) | (.name // .context // .workflowName // "unknown-check")] | unique | join(", ")' <<<"$pr_detail")"
    checks_failed_details="$(jq -r '[.statusCheckRollup[]? | select(((.conclusion // .state // "") | ascii_upcase) | test("FAILURE|ERROR|TIMED_OUT|CANCELLED|ACTION_REQUIRED")) | "- \((.name // .context // .workflowName // "unknown-check"))\n  \((.detailsUrl // .targetUrl // .url // "no-details-url"))"] | if length == 0 then "- none" else join("\n") end' <<<"$pr_detail")"

    if [[ "$checks_failed" -gt 0 ]]; then
      ci_failing="true"
    fi

    if [[ "$checks_pending" -gt 0 || "$checks_total" -eq 0 ]]; then
      ci_pending="true"
    fi

    if [[ "$checks_total" -gt 0 && "$ci_failing" == "false" && "$ci_pending" == "false" ]]; then
      ci_passing="true"
    fi

    codex_latest_state="$(jq -r '[.reviews[]? | select((.author.login // "" | ascii_downcase | contains("codex"))) | {state: (.state // ""), submittedAt: (.submittedAt // .submitted_at // "")} ] | sort_by(.submittedAt) | (last | .state) // ""' <<<"$pr_detail")"
    gemini_latest_state="$(jq -r '[.reviews[]? | select((.author.login // "" | ascii_downcase | contains("gemini"))) | {state: (.state // ""), submittedAt: (.submittedAt // .submitted_at // "")} ] | sort_by(.submittedAt) | (last | .state) // ""' <<<"$pr_detail")"
    copilot_latest_state="$(jq -r '[.reviews[]? | select((.author.login // "" | ascii_downcase | contains("copilot"))) | {state: (.state // ""), submittedAt: (.submittedAt // .submitted_at // "")} ] | sort_by(.submittedAt) | (last | .state) // ""' <<<"$pr_detail")"

    codex_latest_comment="$(jq -r '[.reviews[]? | select((.author.login // "" | ascii_downcase | contains("codex"))) | {body: (.body // ""), submittedAt: (.submittedAt // .submitted_at // "")} ] | sort_by(.submittedAt) | (last | .body) // ""' <<<"$pr_detail")"
    gemini_latest_comment="$(jq -r '[.reviews[]? | select((.author.login // "" | ascii_downcase | contains("gemini"))) | {body: (.body // ""), submittedAt: (.submittedAt // .submitted_at // "")} ] | sort_by(.submittedAt) | (last | .body) // ""' <<<"$pr_detail")"
    copilot_latest_comment="$(jq -r '[.reviews[]? | select((.author.login // "" | ascii_downcase | contains("copilot"))) | {body: (.body // ""), submittedAt: (.submittedAt // .submitted_at // "")} ] | sort_by(.submittedAt) | (last | .body) // ""' <<<"$pr_detail")"

    if [[ "$codex_latest_state" == "APPROVED" ]]; then
      codex_review_passed="true"
    fi
    if [[ "$gemini_latest_state" == "APPROVED" ]]; then
      gemini_review_passed="true"
    fi
    if [[ "$copilot_latest_state" == "APPROVED" ]]; then
      copilot_review_passed="true"
    fi

    critical_sources=()
    critical_details=()
    if reviewer_required "codex" "$ai_reviewers_csv" && [[ "$codex_latest_state" == "CHANGES_REQUESTED" ]]; then
      critical_sources+=("Codex")
      codex_comment_clean="$(normalize_prompt_text "$codex_latest_comment")"
      if [[ -n "$codex_comment_clean" ]]; then
        critical_details+=("- Codex: $codex_comment_clean")
      else
        critical_details+=("- Codex: changes requested (no review body provided)")
      fi
    fi
    if reviewer_required "gemini" "$ai_reviewers_csv" && [[ "$gemini_latest_state" == "CHANGES_REQUESTED" ]]; then
      critical_sources+=("Gemini")
      gemini_comment_clean="$(normalize_prompt_text "$gemini_latest_comment")"
      if [[ -n "$gemini_comment_clean" ]]; then
        critical_details+=("- Gemini: $gemini_comment_clean")
      else
        critical_details+=("- Gemini: changes requested (no review body provided)")
      fi
    fi
    if reviewer_required "copilot" "$ai_reviewers_csv" && [[ "$copilot_latest_state" == "CHANGES_REQUESTED" ]]; then
      critical_sources+=("Copilot")
      copilot_comment_clean="$(normalize_prompt_text "$copilot_latest_comment")"
      if [[ -n "$copilot_comment_clean" ]]; then
        critical_details+=("- Copilot: $copilot_comment_clean")
      else
        critical_details+=("- Copilot: changes requested (no review body provided)")
      fi
    fi

    if [[ ${#critical_sources[@]} -gt 0 ]]; then
      critical_review_feedback="true"
      critical_review_sources="$(
        IFS=', '
        echo "${critical_sources[*]}"
      )"
      critical_review_details="$(printf '%s\n' "${critical_details[@]}")"
    fi

    ai_review_request_needed="false"
    if reviewer_required "codex" "$ai_reviewers_csv" && [[ -z "$codex_latest_state" ]]; then
      ai_review_request_needed="true"
    fi
    if reviewer_required "gemini" "$ai_reviewers_csv" && [[ -z "$gemini_latest_state" ]]; then
      ai_review_request_needed="true"
    fi
    if reviewer_required "copilot" "$ai_reviewers_csv" && [[ -z "$copilot_latest_state" ]]; then
      ai_review_request_needed="true"
    fi

    ui_changed="$(jq -r '[.files[]?.path | ascii_downcase | select(test("\\.(css|scss|sass|less|html|jsx|tsx|vue|svelte)$") or test("(^|/)(ui|components|pages|screens|frontend|web)(/|$)"))] | length > 0' <<<"$pr_detail")"

    task_screenshots="$(jq -r '.uiScreenshotsProvided // false' <<<"$task")"
    pr_mentions_screenshots="$(jq -r '(.body // "" | ascii_downcase | test("screenshot|screen recording|loom|video"))' <<<"$pr_detail")"
    if [[ "$ui_changed" == "true" ]]; then
      if [[ "$task_screenshots" == "true" || "$pr_mentions_screenshots" == "true" ]]; then
        screenshots_included="true"
      else
        screenshots_included="false"
      fi
    fi
  elif [[ "$merged_pr_item" != "null" ]]; then
    has_merged_pr="true"
    pr_number_json="$(jq '.number' <<<"$merged_pr_item")"
    pr_url="$(jq -r '.url // ""' <<<"$merged_pr_item")"
    pr_state="MERGED"
  fi

  if [[ "$has_open_pr" != "true" && "$has_merged_pr" == "true" ]]; then
    if [[ "$DRY_RUN" != "true" && "$close_session_on_merge" == "true" ]]; then
      if tmux has-session -t "$tmux_session" 2>/dev/null; then
        tmux kill-session -t "$tmux_session" || true
      fi
      tmux_alive="false"
    fi

    merged_at_json="$NOW_MS"
    completed_at_json="$NOW_MS"
    new_status="complete"
    blocking_reason=""

    # Close the br issue when the PR is merged
    br_issue_id="$(jq -r '.brIssueId // ""' <<<"$task")"
    if [[ -n "$br_issue_id" && "$DRY_RUN" != "true" ]]; then
      if command -v br >/dev/null 2>&1; then
        pr_number_val="$(jq -r '.number // ""' <<<"$open_pr_item" 2>/dev/null || jq -r '.number // ""' <<<"$merged_pr_item" 2>/dev/null || echo "")"
        close_reason="PR #${pr_number_val:-merged} merged. CI: pass. AI reviews: pass."
        if br close "$br_issue_id" --reason "$close_reason" 2>/dev/null; then
          alerts+=("$id: br issue ${br_issue_id} closed")
        else
          alerts+=("$id: Warning: could not close br issue ${br_issue_id}")
        fi
      fi
    fi

    if [[ "$notify_on_complete" == "true" ]]; then
      alerts+=("$id: PR already merged; task marked complete")
    fi

    updated_task="$(jq \
      --arg status "$new_status" \
      --arg blockingReason "$blocking_reason" \
      --arg prUrl "$pr_url" \
      --arg prState "$pr_state" \
      --arg baseBranch "$BASE_BRANCH" \
      --arg mergeMethod "$effective_merge_method" \
      --argjson hasPr true \
      --argjson prNumber "$pr_number_json" \
      --argjson tmuxAlive "$tmux_alive" \
      --argjson prUpdatedAt "$pr_updated_at_ms" \
      --argjson mergedAt "$merged_at_json" \
      --argjson completedAt "$completed_at_json" \
      --argjson lastCheckedAt "$NOW_MS" \
      '.status = $status
        | .blockingReason = $blockingReason
        | .prUrl = $prUrl
        | .prState = $prState
        | .baseBranch = $baseBranch
        | .hasPr = $hasPr
        | .prNumber = $prNumber
        | .tmuxAlive = $tmuxAlive
        | .prUpdatedAt = $prUpdatedAt
        | .mergeMethod = $mergeMethod
        | .mergedAt = $mergedAt
        | .completedAt = $completedAt
        | .lastCheckedAt = $lastCheckedAt' <<<"$task")"

    TASKS_JSON="$(jq --argjson task "$updated_task" ".[$i] = \$task" <<<"$TASKS_JSON")"
    continue
  fi

  if [[ "$worktree" = /* ]]; then
    worktree_abs="$worktree"
  else
    worktree_abs="$ROOT_DIR/$worktree"
  fi

  if [[ -z "$respawn_command" && -n "$model" && -n "$agent" && -n "$run_agent_script" ]]; then
    respawn_command="$(build_respawn_command "$tmux_session" "$tmux_width" "$tmux_height" "$worktree_abs" "$run_agent_script" "$agent" "$model" "$thinking")"
  fi

  # Keep sessions alive. If down unexpectedly, try respawn.
  if [[ "$tmux_alive" != "true" ]]; then
    if [[ "$respawn_attempts" -lt "$max_attempts" && -n "$respawn_command" ]]; then
      if [[ "$DRY_RUN" != "true" ]]; then
        bash -lc "$respawn_command"
      fi
      respawn_attempts="$((respawn_attempts + 1))"
      last_respawn_at_json="$NOW_MS"

      if [[ "$DRY_RUN" != "true" ]]; then
        if tmux has-session -t "$tmux_session" 2>/dev/null; then
          tmux_alive="true"
        fi
      else
        tmux_alive="true"
      fi

      alerts+=("$id: respawned attempt ${respawn_attempts}/${max_attempts} (session was down)")
    fi

    if [[ "$tmux_alive" != "true" && "$respawn_attempts" -ge "$max_attempts" && -n "$fallback_model" && "$model" != "$fallback_model" ]]; then
      model="$fallback_model"
      fallback_activated="true"
      fallback_activated_at_json="$NOW_MS"
      respawn_attempts="0"
      respawn_command="$(build_respawn_command "$tmux_session" "$tmux_width" "$tmux_height" "$worktree_abs" "$run_agent_script" "$agent" "$model" "$thinking")"
      alerts+=("$id: switching to fallback model: $fallback_model")

      if [[ "$DRY_RUN" != "true" ]]; then
        bash -lc "$respawn_command"
      fi
      respawn_attempts="$((respawn_attempts + 1))"
      last_respawn_at_json="$NOW_MS"

      if [[ "$DRY_RUN" != "true" ]]; then
        if tmux has-session -t "$tmux_session" 2>/dev/null; then
          tmux_alive="true"
        fi
      else
        tmux_alive="true"
      fi
    fi
  fi

  if [[ "$tmux_alive" == "true" ]]; then
    pane_snapshot_raw="$(capture_pane_snapshot "$tmux_session" "$CAPTURE_PANE_LINES")"
    pane_snapshot_norm="$(normalize_prompt_text "$pane_snapshot_raw")"
    if [[ "${#pane_snapshot_norm}" -gt 1500 ]]; then
      pane_snapshot_norm="${pane_snapshot_norm:0:1500} ... [truncated pane snapshot]"
    fi
    if [[ -n "$pane_snapshot_norm" ]]; then
      last_pane_snippet="$pane_snapshot_norm"
      last_pane_captured_at_json="$NOW_MS"
    fi
  fi

  ai_reviews_passed="true"
  if reviewer_required "codex" "$ai_reviewers_csv" && [[ "$codex_review_passed" != "true" ]]; then
    ai_reviews_passed="false"
  fi
  if reviewer_required "gemini" "$ai_reviewers_csv" && [[ "$gemini_review_passed" != "true" ]]; then
    ai_reviews_passed="false"
  fi
  if reviewer_required "copilot" "$ai_reviewers_csv" && [[ "$copilot_review_passed" != "true" ]]; then
    ai_reviews_passed="false"
  fi

  ai_gate_ready="false"
  if [[ "$has_open_pr" == "true" && "$branch_mergeable" == "true" && "$ci_passing" == "true" && "$ai_reviews_passed" == "true" && "$screenshots_included" == "true" ]]; then
    ai_gate_ready="true"
  fi

  if [[ "$ai_gate_ready" != "true" || "$REQUIRE_HUMAN_REVIEW" != "true" ]]; then
    human_review_requested_at_json="null"
  fi

  if [[ "$REQUIRE_HUMAN_REVIEW" == "true" && "$has_open_pr" == "true" && "$human_review_state" == "changes-requested" ]]; then
    human_feedback_clean="$(normalize_prompt_text "$human_review_feedback")"
    if [[ -n "$human_feedback_clean" ]]; then
      human_review_details="- ${human_feedback_clean}"
    else
      human_review_details="- Human reviewer requested changes (no feedback text provided)."
    fi
  else
    human_review_details="- none"
  fi

  followup_issue_summary="- none"
  followup_issue_lines=()

  if [[ "$ci_failing" == "true" ]]; then
    if [[ -n "$checks_failed_names" ]]; then
      followup_issue_lines+=("- CI failing checks: $checks_failed_names")
    else
      followup_issue_lines+=("- CI checks are failing")
    fi
  fi

  if [[ "$critical_review_feedback" == "true" ]]; then
    if [[ -n "$critical_review_sources" ]]; then
      followup_issue_lines+=("- Critical AI review requested changes: $critical_review_sources")
    else
      followup_issue_lines+=("- Critical AI review requested changes")
    fi
  fi

  if [[ "$ai_review_request_needed" == "true" ]]; then
    followup_issue_lines+=("- AI review request missing; run ./scripts/request-ai-reviews.sh --reviewers \"${ai_reviewers_csv}\"")
  fi

  if [[ "$REQUIRE_HUMAN_REVIEW" == "true" && "$has_open_pr" == "true" && "$human_review_state" == "changes-requested" ]]; then
    followup_issue_lines+=("- Human review requested changes")
  fi

  if [[ ${#followup_issue_lines[@]} -gt 0 ]]; then
    followup_issue_summary="$(printf '%s\n' "${followup_issue_lines[@]}")"
  fi

  combined_followup_message=""
  followup_kind=""
  requires_followup="false"
  if [[ "$has_open_pr" == "true" && ("$ci_failing" == "true" || "$critical_review_feedback" == "true" || "$ai_review_request_needed" == "true" || ("$REQUIRE_HUMAN_REVIEW" == "true" && "$pending_human_followup" == "true")) ]]; then
    requires_followup="true"
  fi

  if [[ "$requires_followup" == "true" ]]; then
    prompt_pr_url="$pr_url"
    if [[ -z "$prompt_pr_url" ]]; then
      prompt_pr_url="(not available)"
    fi

    combined_followup_message="$(build_structured_followup_prompt \
      "$id" \
      "$prompt_pr_url" \
      "$followup_issue_summary" \
      "$checks_failed_details" \
      "$critical_review_details" \
      "$human_review_details")"
    followup_kind="review"
  fi

  if [[ "$has_open_pr" != "true" && "$has_merged_pr" != "true" && "$started_at_ms" -gt 0 ]]; then
    elapsed_minutes="$(((NOW_MS - started_at_ms) / 60000))"
    if [[ "$elapsed_minutes" -ge "$PR_OPEN_SLA_MINUTES" ]]; then
      if [[ "$pr_open_nudge_count" -lt "$PR_OPEN_MAX_NUDGES" ]]; then
        combined_followup_message="$(build_pr_creation_nudge_prompt "$id" "$elapsed_minutes")"
        followup_kind="pr-open"
      else
        alerts+=("$id: no PR after ${elapsed_minutes}m and ${pr_open_nudge_count} nudges; escalate to human")
      fi
    fi
  fi

  followup_sent="false"
  if [[ -n "$combined_followup_message" && "$tmux_alive" == "true" ]]; then
    now_ms="$NOW_MS"
    last_followup_at_ms="$(jq -r 'if . == null then 0 else . end' <<<"$last_followup_at_json")"
    case "$last_followup_at_ms" in
    '' | *[!0-9]*) last_followup_at_ms="0" ;;
    esac

    followup_cooldown_ms="$((FOLLOWUP_COOLDOWN_MINUTES * 60 * 1000))"
    followup_hash="$(hash_message "$combined_followup_message")"

    should_send_followup="false"
    if [[ "$REQUIRE_HUMAN_REVIEW" == "true" && "$pending_human_followup" == "true" ]]; then
      should_send_followup="true"
    elif [[ "$followup_hash" != "$last_followup_hash" ]]; then
      if [[ "$last_followup_at_ms" -eq 0 || $((now_ms - last_followup_at_ms)) -ge "$followup_cooldown_ms" ]]; then
        should_send_followup="true"
      fi
    fi

    if [[ "$followup_kind" == "pr-open" && "$pr_open_nudge_count" -lt "$PR_OPEN_MAX_NUDGES" ]]; then
      if [[ "$last_followup_at_ms" -eq 0 || $((now_ms - last_followup_at_ms)) -ge "$followup_cooldown_ms" ]]; then
        should_send_followup="true"
      fi
    fi

    if [[ "$should_send_followup" == "true" ]]; then
      if [[ "$DRY_RUN" != "true" ]]; then
        if send_prompt_to_tmux "$tmux_session" "$combined_followup_message"; then
          followup_sent="true"
        fi
      else
        followup_sent="true"
      fi

      if [[ "$followup_sent" == "true" ]]; then
        followup_count="$((followup_count + 1))"
        last_followup_at_json="$NOW_MS"
        last_followup_message="$combined_followup_message"
        last_followup_hash="$followup_hash"

        if [[ "$followup_kind" == "pr-open" ]]; then
          pr_open_nudge_count="$((pr_open_nudge_count + 1))"
          last_pr_open_nudge_at_json="$NOW_MS"
          alerts+=("$id: nudged subagent to create PR (${pr_open_nudge_count}/${PR_OPEN_MAX_NUDGES})")
        else
          alerts+=("$id: sent structured follow-up prompt to subagent")
        fi

        if [[ "$REQUIRE_HUMAN_REVIEW" == "true" && "$pending_human_followup" == "true" ]]; then
          pending_human_followup="false"
          human_review_state="changes-requested"
          human_review_requested_at_json="null"
        fi
      fi
    fi
  fi

  reasons=()
  if [[ "$tmux_alive" != "true" ]]; then
    reasons+=("tmux session not running")
  fi
  if [[ "$has_open_pr" != "true" && "$has_merged_pr" != "true" ]]; then
    reasons+=("no PR yet")
    if [[ "$started_at_ms" -gt 0 ]]; then
      elapsed_no_pr_minutes="$(((NOW_MS - started_at_ms) / 60000))"
      if [[ "$elapsed_no_pr_minutes" -ge "$PR_OPEN_SLA_MINUTES" ]]; then
        reasons+=("PR overdue (${elapsed_no_pr_minutes}m >= ${PR_OPEN_SLA_MINUTES}m SLA)")
      fi
      if [[ "$pr_open_nudge_count" -ge "$PR_OPEN_MAX_NUDGES" ]]; then
        reasons+=("PR open nudges exhausted (${pr_open_nudge_count}/${PR_OPEN_MAX_NUDGES})")
      fi
    fi
  fi
  if [[ "$branch_mergeable" != "true" && "$has_open_pr" == "true" ]]; then
    reasons+=("branch is not mergeable with ${BASE_BRANCH}")
  fi
  if [[ "$ci_failing" == "true" ]]; then
    reasons+=("CI checks failing")
  fi
  if [[ "$ci_pending" == "true" ]]; then
    reasons+=("CI checks pending")
  fi
  if reviewer_required "codex" "$ai_reviewers_csv" && [[ "$codex_review_passed" != "true" && "$has_open_pr" == "true" ]]; then
    reasons+=("Codex review pending")
  fi
  if reviewer_required "gemini" "$ai_reviewers_csv" && [[ "$gemini_review_passed" != "true" && "$has_open_pr" == "true" ]]; then
    reasons+=("Gemini review pending")
  fi
  if reviewer_required "copilot" "$ai_reviewers_csv" && [[ "$copilot_review_passed" != "true" && "$has_open_pr" == "true" ]]; then
    reasons+=("Copilot review pending")
  fi
  if [[ "$ai_review_request_needed" == "true" ]]; then
    reasons+=("AI review request not submitted yet")
  fi
  if [[ "$REQUIRE_HUMAN_REVIEW" == "true" && "$has_open_pr" == "true" && "$human_review_state" == "changes-requested" ]]; then
    reasons+=("human review requested changes")
  fi
  if [[ "$screenshots_included" != "true" ]]; then
    reasons+=("UI screenshots missing")
  fi

  blocking_reason=""
  if [[ ${#reasons[@]} -gt 0 ]]; then
    blocking_reason="$(
      IFS='; '
      echo "${reasons[*]}"
    )"
  fi

  new_status="$status"

  if [[ "$has_open_pr" == "true" ]]; then
    if [[ "$ai_gate_ready" == "true" ]]; then
      if [[ "$REQUIRE_HUMAN_REVIEW" != "true" ]]; then
        human_review_state="skipped"
        pending_human_followup="false"
        human_review_feedback=""
        if [[ "$DRY_RUN" == "true" ]]; then
          new_status="running"
          alerts+=("$id: CI+AI gates passed; would auto-merge on non-dry-run")
        else
          if merge_pr "$repo" "$(jq -r '.number' <<<"$open_pr_item")" "$effective_merge_method"; then
            merged_at_json="$NOW_MS"
            completed_at_json="$NOW_MS"
            new_status="complete"
            blocking_reason=""

            # Close the br issue on auto-merge
            br_issue_id_merge="$(jq -r '.brIssueId // ""' <<<"$task")"
            if [[ -n "$br_issue_id_merge" ]] && command -v br >/dev/null 2>&1; then
              close_reason_merge="PR #$(jq -r '.number' <<<"$open_pr_item") auto-merged. CI: pass. AI reviews: pass."
              br close "$br_issue_id_merge" --reason "$close_reason_merge" 2>/dev/null || true
            fi

            if [[ "$close_session_on_merge" == "true" ]]; then
              if tmux has-session -t "$tmux_session" 2>/dev/null; then
                tmux kill-session -t "$tmux_session" || true
              fi
              tmux_alive="false"
            fi

            alerts+=("$id: auto-merged PR after CI+AI gates and closed session")
            if [[ "$notify_on_complete" == "true" ]]; then
              alerts+=("$id: complete (${pr_url:-no-pr-url})")
            fi
          else
            new_status="needs-human"
            blocking_reason="failed to auto-merge PR after CI+AI gates"
            alerts+=("$id: failed to auto-merge PR; human intervention required")
          fi
        fi
      elif [[ "$human_review_state" == "approved" ]]; then
        if [[ "$DRY_RUN" == "true" ]]; then
          new_status="waiting-human-review"
          alerts+=("$id: human approved; would merge PR on non-dry-run")
        else
          if merge_pr "$repo" "$(jq -r '.number' <<<"$open_pr_item")" "$effective_merge_method"; then
            merged_at_json="$NOW_MS"
            completed_at_json="$NOW_MS"
            new_status="complete"
            blocking_reason=""

            # Close the br issue on human-approved merge
            br_issue_id_hr="$(jq -r '.brIssueId // ""' <<<"$task")"
            if [[ -n "$br_issue_id_hr" ]] && command -v br >/dev/null 2>&1; then
              close_reason_hr="PR #$(jq -r '.number' <<<"$open_pr_item") merged after human approval. CI: pass. AI reviews: pass."
              br close "$br_issue_id_hr" --reason "$close_reason_hr" 2>/dev/null || true
            fi

            if [[ "$close_session_on_merge" == "true" ]]; then
              if tmux has-session -t "$tmux_session" 2>/dev/null; then
                tmux kill-session -t "$tmux_session" || true
              fi
              tmux_alive="false"
            fi

            alerts+=("$id: merged PR after human approval and closed session")
            if [[ "$notify_on_complete" == "true" ]]; then
              alerts+=("$id: complete (${pr_url:-no-pr-url})")
            fi
          else
            new_status="needs-human"
            blocking_reason="failed to merge PR after human approval"
            alerts+=("$id: failed to merge PR automatically; human intervention required")
          fi
        fi
      elif [[ "$human_review_state" == "changes-requested" ]]; then
        if [[ "$pending_human_followup" == "true" || "$followup_sent" == "true" ]]; then
          new_status="running"
          if [[ -z "$blocking_reason" ]]; then
            blocking_reason="human requested changes"
          fi
        elif [[ "$pr_updated_at_ms" -gt "$last_human_review_action_ms" ]]; then
          human_review_state="pending"
          new_status="waiting-human-review"
          human_review_requested_at_json="$NOW_MS"
          alerts+=("$id: updates detected after human feedback. Awaiting renewed human approval for PR ${pr_url}")
        else
          new_status="running"
          if [[ -z "$blocking_reason" ]]; then
            blocking_reason="awaiting subagent updates for human requested changes"
          fi
        fi
      else
        new_status="waiting-human-review"
        if [[ "$human_review_requested_at_json" == "null" ]]; then
          human_review_requested_at_json="$NOW_MS"
          alerts+=("$id: AI checks/reviews passed. Awaiting human review input for PR ${pr_url}")
        fi
      fi
    else
      if [[ "$ci_pending" == "true" ]]; then
        new_status="waiting-ci"
      elif [[ "$ci_failing" == "true" || "$critical_review_feedback" == "true" ]]; then
        if [[ "$tmux_alive" == "true" ]]; then
          new_status="running"
        else
          new_status="needs-human"
        fi
      elif [[ "$ai_reviews_passed" != "true" ]]; then
        new_status="waiting-review"
      elif [[ "$screenshots_included" != "true" ]]; then
        new_status="waiting-artifacts"
      else
        new_status="running"
      fi
    fi
  else
    elapsed_no_pr_minutes="0"
    if [[ "$started_at_ms" -gt 0 ]]; then
      elapsed_no_pr_minutes="$(((NOW_MS - started_at_ms) / 60000))"
    fi

    if [[ "$pr_open_nudge_count" -ge "$PR_OPEN_MAX_NUDGES" && "$elapsed_no_pr_minutes" -ge "$PR_OPEN_SLA_MINUTES" ]]; then
      new_status="needs-human"
      alerts+=("$id: no PR created after SLA and max nudges; needs human intervention")
    elif [[ "$tmux_alive" == "true" ]]; then
      new_status="running"
    else
      if [[ "$respawn_attempts" -ge "$max_attempts" ]]; then
        new_status="needs-human"
        alerts+=("$id: needs human attention (respawn limit reached)")
      else
        new_status="running"
      fi
    fi
  fi

  if [[ "$tmux_alive" == "true" ]]; then
    last_heartbeat_json="$NOW_MS"
  fi

  updated_task="$(jq \
    --arg status "$new_status" \
    --arg blockingReason "$blocking_reason" \
    --arg prUrl "$pr_url" \
    --arg prState "$pr_state" \
    --arg baseBranch "$BASE_BRANCH" \
    --arg mergeMethod "$effective_merge_method" \
    --arg humanReviewState "$human_review_state" \
    --arg humanReviewFeedback "$human_review_feedback" \
    --arg aiReviewers "$ai_reviewers_csv" \
    --arg model "$model" \
    --arg fallbackModel "$fallback_model" \
    --arg respawnCommand "$respawn_command" \
    --arg lastPaneSnippet "$last_pane_snippet" \
    --arg lastFollowupMessage "$last_followup_message" \
    --arg lastFollowupHash "$last_followup_hash" \
    --argjson hasPr "$has_open_pr" \
    --argjson prNumber "$pr_number_json" \
    --argjson prUpdatedAt "$pr_updated_at_ms" \
    --argjson ciPassing "$ci_passing" \
    --argjson ciPending "$ci_pending" \
    --argjson ciFailing "$ci_failing" \
    --argjson branchMergeable "$branch_mergeable" \
    --argjson codexReviewPassed "$codex_review_passed" \
    --argjson geminiReviewPassed "$gemini_review_passed" \
    --argjson copilotReviewPassed "$copilot_review_passed" \
    --argjson criticalReviewFeedback "$critical_review_feedback" \
    --argjson uiChanged "$ui_changed" \
    --argjson screenshotsIncluded "$screenshots_included" \
    --argjson tmuxAlive "$tmux_alive" \
    --argjson aiReviewsPassed "$ai_reviews_passed" \
    --argjson aiGateReady "$ai_gate_ready" \
    --argjson requireHumanReview "$REQUIRE_HUMAN_REVIEW" \
    --argjson respawnAttempts "$respawn_attempts" \
    --argjson pendingHumanFollowup "$pending_human_followup" \
    --argjson fallbackActivated "$fallback_activated" \
    --argjson followupCount "$followup_count" \
    --argjson prOpenNudgeCount "$pr_open_nudge_count" \
    --argjson closeSessionOnMerge "$close_session_on_merge" \
    --argjson lastCheckedAt "$NOW_MS" \
    --argjson lastHeartbeatAt "$last_heartbeat_json" \
    --argjson lastRespawnAt "$last_respawn_at_json" \
    --argjson fallbackActivatedAt "$fallback_activated_at_json" \
    --argjson lastPaneCapturedAt "$last_pane_captured_at_json" \
    --argjson lastFollowupAt "$last_followup_at_json" \
    --argjson lastPrOpenNudgeAt "$last_pr_open_nudge_at_json" \
    --argjson humanReviewRequestedAt "$human_review_requested_at_json" \
    --argjson lastHumanReviewActionAt "$last_human_review_action_at_json" \
    --argjson completedAt "$completed_at_json" \
    --argjson mergedAt "$merged_at_json" \
    '.status = $status
      | .blockingReason = $blockingReason
      | .baseBranch = $baseBranch
      | .hasPr = $hasPr
      | .prNumber = $prNumber
      | .prUpdatedAt = $prUpdatedAt
      | .prUrl = $prUrl
      | .prState = $prState
      | .ciPassing = $ciPassing
      | .ciPending = $ciPending
      | .ciFailing = $ciFailing
      | .branchMergeable = $branchMergeable
      | .codexReviewPassed = $codexReviewPassed
      | .geminiReviewPassed = $geminiReviewPassed
      | .copilotReviewPassed = $copilotReviewPassed
      | .criticalReviewFeedback = $criticalReviewFeedback
      | .uiChanged = $uiChanged
      | .screenshotsIncluded = $screenshotsIncluded
      | .tmuxAlive = $tmuxAlive
      | .aiReviewsPassed = $aiReviewsPassed
      | .aiGateReady = $aiGateReady
      | .requireHumanReview = $requireHumanReview
      | .respawnAttempts = $respawnAttempts
      | .mergeMethod = $mergeMethod
      | .closeSessionOnMerge = $closeSessionOnMerge
      | .aiReviewers = $aiReviewers
      | .model = $model
      | .fallbackModel = $fallbackModel
      | .respawnCommand = $respawnCommand
      | .lastPaneSnippet = $lastPaneSnippet
      | .lastPaneCapturedAt = $lastPaneCapturedAt
      | .humanReviewState = $humanReviewState
      | .humanReviewFeedback = $humanReviewFeedback
      | .pendingHumanFollowup = $pendingHumanFollowup
      | .fallbackActivated = $fallbackActivated
      | .fallbackActivatedAt = $fallbackActivatedAt
      | .followupCount = $followupCount
      | .prOpenNudgeCount = $prOpenNudgeCount
      | .lastFollowupAt = $lastFollowupAt
      | .lastPrOpenNudgeAt = $lastPrOpenNudgeAt
      | .lastFollowupMessage = $lastFollowupMessage
      | .lastFollowupHash = $lastFollowupHash
      | .humanReviewRequestedAt = $humanReviewRequestedAt
      | .lastHumanReviewActionAt = $lastHumanReviewActionAt
      | .lastCheckedAt = $lastCheckedAt
      | .lastHeartbeatAt = $lastHeartbeatAt
      | .lastRespawnAt = $lastRespawnAt
      | .completedAt = $completedAt
      | .mergedAt = $mergedAt' <<<"$task")"

  TASKS_JSON="$(jq --argjson task "$updated_task" ".[$i] = \$task" <<<"$TASKS_JSON")"
done

if [[ "$DRY_RUN" == "true" ]]; then
  echo "Dry run: task file not modified"
else
  tmp_out="$(mktemp)"
  printf '%s\n' "$TASKS_JSON" >"$tmp_out"
  mv "$tmp_out" "$TASK_FILE_ABS"
  echo "Updated task file: $TASK_FILE_ABS"
fi

if [[ ${#alerts[@]} -gt 0 ]]; then
  printf '%s\n' "${alerts[@]}"
else
  echo "No alerts"
fi
