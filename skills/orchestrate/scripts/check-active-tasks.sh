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
    [--dry-run]

Checks active orchestrator tasks deterministically:
- tmux session health
- PR existence and merge state
- CI/check status
- required review approvals (Codex, Gemini, Copilot)
- UI screenshot evidence (when UI files changed)

Loop behavior after PR creation:
- Keep tmux session alive until PR is merged
- Wait for automated reviews/checks
- Send follow-up prompt to subagent when CI fails or critical AI review feedback appears
- Notify human review only after CI + AI review gates pass
- Merge only after human approval, then close tmux session
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
    --dry-run)
      DRY_RUN="true"
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

case "$MAX_RESPAWNS" in
  ''|*[!0-9]*)
    echo "--max-respawns must be a non-negative integer" >&2
    exit 1
    ;;
esac

case "$MERGE_METHOD" in
  merge|squash|rebase) ;;
  *)
    echo "--merge-method must be merge, squash, or rebase" >&2
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
NOW_MS="$(( $(date +%s) * 1000 ))"

alerts=()

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

for (( i=0; i<TASK_COUNT; i++ )); do
  task="$(jq -c ".[$i]" <<<"$TASKS_JSON")"

  id="$(jq -r '.id // ""' <<<"$task")"
  status="$(jq -r '.status // "running"' <<<"$task")"
  tmux_session="$(jq -r '.tmuxSession // ""' <<<"$task")"
  branch="$(jq -r '.branch // ""' <<<"$task")"
  repo="$(jq -r '.repo // ""' <<<"$task")"
  respawn_attempts="$(jq -r '.respawnAttempts // 0' <<<"$task")"
  max_attempts="$(jq -r '.maxRespawnAttempts // empty' <<<"$task")"
  respawn_command="$(jq -r '.respawnCommand // ""' <<<"$task")"
  notify_on_complete="$(jq -r '.notifyOnComplete // false' <<<"$task")"
  human_review_state="$(jq -r '.humanReviewState // "pending"' <<<"$task")"
  human_review_feedback="$(jq -r '.humanReviewFeedback // ""' <<<"$task")"
  pending_human_followup="$(jq -r '.pendingHumanFollowup // false' <<<"$task")"
  followup_count="$(jq -r '.followupCount // 0' <<<"$task")"
  last_followup_message="$(jq -r '.lastFollowupMessage // ""' <<<"$task")"
  close_session_on_merge="$(jq -r '.closeSessionOnMerge // true' <<<"$task")"
  task_merge_method="$(jq -r '.mergeMethod // ""' <<<"$task")"

  last_followup_at_json="$(jq '.lastFollowupAt // null' <<<"$task")"
  completed_at_json="$(jq '.completedAt // null' <<<"$task")"
  last_respawn_at_json="$(jq '.lastRespawnAt // null' <<<"$task")"
  last_heartbeat_json="$(jq '.lastHeartbeatAt // null' <<<"$task")"
  human_review_requested_at_json="$(jq '.humanReviewRequestedAt // null' <<<"$task")"
  last_human_review_action_at_json="$(jq '.lastHumanReviewActionAt // null' <<<"$task")"
  merged_at_json="$(jq '.mergedAt // null' <<<"$task")"

  last_human_review_action_ms="$(jq -r '.lastHumanReviewActionAt // 0' <<<"$task")"
  case "$last_human_review_action_ms" in
    ''|*[!0-9]*) last_human_review_action_ms="0" ;;
  esac

  case "$followup_count" in
    ''|*[!0-9]*) followup_count="0" ;;
  esac

  if [[ -z "$max_attempts" ]]; then
    max_attempts="$MAX_RESPAWNS"
  fi

  case "$max_attempts" in
    ''|*[!0-9]*) max_attempts="$MAX_RESPAWNS" ;;
  esac

  effective_merge_method="$MERGE_METHOD"
  case "$task_merge_method" in
    merge|squash|rebase)
      effective_merge_method="$task_merge_method"
      ;;
  esac

  if [[ -z "$id" || -z "$tmux_session" || -z "$branch" ]]; then
    alerts+=("$id: invalid task record (missing id/tmuxSession/branch)")
    continue
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
      ''|*[!0-9]*) pr_updated_at_ms="0" ;;
    esac

    merge_state="$(jq -r '.mergeStateStatus // "UNKNOWN"' <<<"$pr_detail")"
    case "$merge_state" in
      CLEAN|HAS_HOOKS|UNSTABLE)
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
    if [[ "$codex_latest_state" == "CHANGES_REQUESTED" ]]; then
      critical_sources+=("Codex")
      codex_comment_clean="$(normalize_prompt_text "$codex_latest_comment")"
      if [[ -n "$codex_comment_clean" ]]; then
        critical_details+=("- Codex: $codex_comment_clean")
      else
        critical_details+=("- Codex: changes requested (no review body provided)")
      fi
    fi
    if [[ "$gemini_latest_state" == "CHANGES_REQUESTED" ]]; then
      critical_sources+=("Gemini")
      gemini_comment_clean="$(normalize_prompt_text "$gemini_latest_comment")"
      if [[ -n "$gemini_comment_clean" ]]; then
        critical_details+=("- Gemini: $gemini_comment_clean")
      else
        critical_details+=("- Gemini: changes requested (no review body provided)")
      fi
    fi
    if [[ "$copilot_latest_state" == "CHANGES_REQUESTED" ]]; then
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
      critical_review_sources="$(IFS=', '; echo "${critical_sources[*]}")"
      critical_review_details="$(printf '%s\n' "${critical_details[@]}")"
    fi

    if [[ -z "$codex_latest_state" && -z "$gemini_latest_state" && -z "$copilot_latest_state" ]]; then
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
  fi

  ai_reviews_passed="false"
  if [[ "$codex_review_passed" == "true" && "$gemini_review_passed" == "true" && "$copilot_review_passed" == "true" ]]; then
    ai_reviews_passed="true"
  fi

  ai_gate_ready="false"
  if [[ "$has_open_pr" == "true" && "$branch_mergeable" == "true" && "$ci_passing" == "true" && "$ai_reviews_passed" == "true" && "$screenshots_included" == "true" ]]; then
    ai_gate_ready="true"
  fi

  if [[ "$ai_gate_ready" != "true" ]]; then
    human_review_requested_at_json="null"
  fi

  if [[ "$has_open_pr" == "true" && "$human_review_state" == "changes-requested" ]]; then
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
    followup_issue_lines+=("- AI review request missing; run ./scripts/request-ai-reviews.sh --reviewers \"github-copilot[bot],codex,gemini\"")
  fi

  if [[ "$has_open_pr" == "true" && "$human_review_state" == "changes-requested" ]]; then
    followup_issue_lines+=("- Human review requested changes")
  fi

  if [[ ${#followup_issue_lines[@]} -gt 0 ]]; then
    followup_issue_summary="$(printf '%s\n' "${followup_issue_lines[@]}")"
  fi

  combined_followup_message=""
  requires_followup="false"
  if [[ "$has_open_pr" == "true" && ( "$ci_failing" == "true" || "$critical_review_feedback" == "true" || "$pending_human_followup" == "true" || "$ai_review_request_needed" == "true" ) ]]; then
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
  fi

  followup_sent="false"
  if [[ -n "$combined_followup_message" && "$tmux_alive" == "true" ]]; then
    should_send_followup="false"
    if [[ "$pending_human_followup" == "true" || "$combined_followup_message" != "$last_followup_message" ]]; then
      should_send_followup="true"
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

        if [[ "$pending_human_followup" == "true" ]]; then
          pending_human_followup="false"
          human_review_state="changes-requested"
          human_review_requested_at_json="null"
        fi

        alerts+=("$id: sent structured follow-up prompt to subagent")
      fi
    fi
  fi

  reasons=()
  if [[ "$tmux_alive" != "true" ]]; then
    reasons+=("tmux session not running")
  fi
  if [[ "$has_open_pr" != "true" && "$has_merged_pr" != "true" ]]; then
    reasons+=("no PR yet")
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
  if [[ "$codex_review_passed" != "true" && "$has_open_pr" == "true" ]]; then
    reasons+=("Codex review pending")
  fi
  if [[ "$gemini_review_passed" != "true" && "$has_open_pr" == "true" ]]; then
    reasons+=("Gemini review pending")
  fi
  if [[ "$copilot_review_passed" != "true" && "$has_open_pr" == "true" ]]; then
    reasons+=("Copilot review pending")
  fi
  if [[ "$ai_review_request_needed" == "true" ]]; then
    reasons+=("AI review request not submitted yet")
  fi
  if [[ "$has_open_pr" == "true" && "$human_review_state" == "changes-requested" ]]; then
    reasons+=("human review requested changes")
  fi
  if [[ "$screenshots_included" != "true" ]]; then
    reasons+=("UI screenshots missing")
  fi

  blocking_reason=""
  if [[ ${#reasons[@]} -gt 0 ]]; then
    blocking_reason="$(IFS='; '; echo "${reasons[*]}")"
  fi

  new_status="$status"

  if [[ "$has_open_pr" == "true" ]]; then
    if [[ "$ai_gate_ready" == "true" ]]; then
      if [[ "$human_review_state" == "approved" ]]; then
        if [[ "$DRY_RUN" == "true" ]]; then
          new_status="waiting-human-review"
          alerts+=("$id: human approved; would merge PR on non-dry-run")
        else
          if merge_pr "$repo" "$(jq -r '.number' <<<"$open_pr_item")" "$effective_merge_method"; then
            merged_at_json="$NOW_MS"
            completed_at_json="$NOW_MS"
            new_status="complete"
            blocking_reason=""

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
    if [[ "$tmux_alive" == "true" ]]; then
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
    --arg lastFollowupMessage "$last_followup_message" \
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
    --argjson respawnAttempts "$respawn_attempts" \
    --argjson pendingHumanFollowup "$pending_human_followup" \
    --argjson followupCount "$followup_count" \
    --argjson closeSessionOnMerge "$close_session_on_merge" \
    --argjson lastCheckedAt "$NOW_MS" \
    --argjson lastHeartbeatAt "$last_heartbeat_json" \
    --argjson lastRespawnAt "$last_respawn_at_json" \
    --argjson lastFollowupAt "$last_followup_at_json" \
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
      | .respawnAttempts = $respawnAttempts
      | .mergeMethod = $mergeMethod
      | .closeSessionOnMerge = $closeSessionOnMerge
      | .humanReviewState = $humanReviewState
      | .humanReviewFeedback = $humanReviewFeedback
      | .pendingHumanFollowup = $pendingHumanFollowup
      | .followupCount = $followupCount
      | .lastFollowupAt = $lastFollowupAt
      | .lastFollowupMessage = $lastFollowupMessage
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
  printf '%s\n' "$TASKS_JSON" > "$tmp_out"
  mv "$tmp_out" "$TASK_FILE_ABS"
  echo "Updated task file: $TASK_FILE_ABS"
fi

if [[ ${#alerts[@]} -gt 0 ]]; then
  printf '%s\n' "${alerts[@]}"
else
  echo "No alerts"
fi
