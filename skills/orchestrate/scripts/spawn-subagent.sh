#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  spawn-subagent.sh \
    --id <task-id> \
    --repo <owner/repo> \
    --description <text> \
    --worktree <path> \
    --branch <branch> \
    --tmux-session <name> \
    --agent <label> \
    --model <model-id> \
    [--thinking <low|medium|high>] \
    [--base-ref <ref>] \
    [--install-command <command>] \
    [--no-install] \
    [--task-file <path>] \
    [--max-respawns <n>] \
    [--notify-on-complete <true|false>] \
    [--merge-method <merge|squash|rebase>] \
    [--log-path <path>] \
    [--tmux-width <n>] \
    [--tmux-height <n>] \
    [--initial-prompt-file <path>] \
    [--initial-prompt-delay <seconds>]

Environment:
  RUN_AGENT_SCRIPT  Path to run-agent-with-log.sh (default: scripts/run-agent-with-log.sh)
EOF
}

require_command() {
  local cmd="$1"
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "Missing required command: $cmd" >&2
    exit 1
  fi
}

compact_prompt_for_tmux() {
  local file_path="$1"

  awk '
    {
      gsub(/\r/, "")
      gsub(/[[:space:]]+/, " ")
      sub(/^ /, "")
      sub(/ $/, "")
      if (length($0) > 0) {
        if (out != "") {
          out = out " | "
        }
        out = out $0
      }
    }
    END {
      print out
    }
  ' "$file_path"
}

ID=""
REPO=""
DESCRIPTION=""
WORKTREE=""
BRANCH=""
TMUX_SESSION=""
AGENT=""
MODEL=""
THINKING="medium"
BASE_REF="origin/main"
INSTALL_COMMAND="pnpm install"
SKIP_INSTALL="false"
TASK_FILE=".pi/active-tasks.json"
MAX_RESPAWN_ATTEMPTS="3"
NOTIFY_ON_COMPLETE="true"
MERGE_METHOD="squash"
LOG_PATH=""
TMUX_WIDTH="80"
TMUX_HEIGHT="24"
INITIAL_PROMPT_FILE=""
INITIAL_PROMPT_DELAY="3"

while [[ $# -gt 0 ]]; do
  case "$1" in
  --id)
    ID="${2:-}"
    shift 2
    ;;
  --repo)
    REPO="${2:-}"
    shift 2
    ;;
  --description)
    DESCRIPTION="${2:-}"
    shift 2
    ;;
  --worktree)
    WORKTREE="${2:-}"
    shift 2
    ;;
  --branch)
    BRANCH="${2:-}"
    shift 2
    ;;
  --tmux-session)
    TMUX_SESSION="${2:-}"
    shift 2
    ;;
  --agent)
    AGENT="${2:-}"
    shift 2
    ;;
  --model)
    MODEL="${2:-}"
    shift 2
    ;;
  --thinking)
    THINKING="${2:-}"
    shift 2
    ;;
  --base-ref)
    BASE_REF="${2:-}"
    shift 2
    ;;
  --install-command)
    INSTALL_COMMAND="${2:-}"
    shift 2
    ;;
  --no-install)
    SKIP_INSTALL="true"
    shift 1
    ;;
  --task-file)
    TASK_FILE="${2:-}"
    shift 2
    ;;
  --max-respawns)
    MAX_RESPAWN_ATTEMPTS="${2:-}"
    shift 2
    ;;
  --notify-on-complete)
    NOTIFY_ON_COMPLETE="${2:-}"
    shift 2
    ;;
  --merge-method)
    MERGE_METHOD="${2:-}"
    shift 2
    ;;
  --log-path)
    LOG_PATH="${2:-}"
    shift 2
    ;;
  --tmux-width)
    TMUX_WIDTH="${2:-}"
    shift 2
    ;;
  --tmux-height)
    TMUX_HEIGHT="${2:-}"
    shift 2
    ;;
  --initial-prompt-file)
    INITIAL_PROMPT_FILE="${2:-}"
    shift 2
    ;;
  --initial-prompt-delay)
    INITIAL_PROMPT_DELAY="${2:-}"
    shift 2
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

if [[ -z "$ID" || -z "$REPO" || -z "$DESCRIPTION" || -z "$WORKTREE" || -z "$BRANCH" || -z "$TMUX_SESSION" || -z "$AGENT" || -z "$MODEL" ]]; then
  echo "Missing required arguments" >&2
  usage
  exit 1
fi

case "$NOTIFY_ON_COMPLETE" in
true | false) ;;
*)
  echo "--notify-on-complete must be true or false" >&2
  exit 1
  ;;
esac

case "$MAX_RESPAWN_ATTEMPTS" in
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

if [[ ! "$INITIAL_PROMPT_DELAY" =~ ^[0-9]+([.][0-9]+)?$ ]]; then
  echo "--initial-prompt-delay must be a positive number" >&2
  exit 1
fi

require_command git
require_command tmux
require_command jq

ROOT_DIR="$(git rev-parse --show-toplevel 2>/dev/null || true)"
if [[ -z "$ROOT_DIR" ]]; then
  echo "spawn-subagent.sh must run inside a git repository" >&2
  exit 1
fi

RUN_AGENT_SCRIPT="${RUN_AGENT_SCRIPT:-scripts/run-agent-with-log.sh}"
if [[ ! -x "$RUN_AGENT_SCRIPT" ]]; then
  echo "RUN_AGENT_SCRIPT is missing or not executable: $RUN_AGENT_SCRIPT" >&2
  exit 1
fi

if [[ "$WORKTREE" = /* ]]; then
  WORKTREE_ABS="$WORKTREE"
else
  WORKTREE_ABS="$ROOT_DIR/$WORKTREE"
fi

if [[ "$TASK_FILE" = /* ]]; then
  TASK_FILE_ABS="$TASK_FILE"
else
  TASK_FILE_ABS="$ROOT_DIR/$TASK_FILE"
fi

if [[ -z "$LOG_PATH" ]]; then
  LOG_PATH=".pi/logs/${ID}.log"
fi

if [[ "$LOG_PATH" = /* ]]; then
  LOG_PATH_ABS="$LOG_PATH"
else
  LOG_PATH_ABS="$ROOT_DIR/$LOG_PATH"
fi

INITIAL_PROMPT_FILE_ABS=""
if [[ -n "$INITIAL_PROMPT_FILE" ]]; then
  if [[ "$INITIAL_PROMPT_FILE" = /* ]]; then
    INITIAL_PROMPT_FILE_ABS="$INITIAL_PROMPT_FILE"
  else
    INITIAL_PROMPT_FILE_ABS="$ROOT_DIR/$INITIAL_PROMPT_FILE"
  fi

  if [[ ! -f "$INITIAL_PROMPT_FILE_ABS" ]]; then
    echo "Initial prompt file not found: $INITIAL_PROMPT_FILE_ABS" >&2
    exit 1
  fi
fi

mkdir -p "$(dirname "$TASK_FILE_ABS")"
mkdir -p "$(dirname "$LOG_PATH_ABS")"

if [[ ! -d "$WORKTREE_ABS" ]]; then
  mkdir -p "$(dirname "$WORKTREE_ABS")"
  if git show-ref --verify --quiet "refs/heads/$BRANCH"; then
    git worktree add "$WORKTREE_ABS" "$BRANCH"
  else
    git worktree add "$WORKTREE_ABS" -b "$BRANCH" "$BASE_REF"
  fi
else
  echo "Worktree already exists: $WORKTREE_ABS"
fi

if [[ "$SKIP_INSTALL" != "true" && -n "$INSTALL_COMMAND" ]]; then
  echo "Running install command in $WORKTREE_ABS: $INSTALL_COMMAND"
  (
    cd "$WORKTREE_ABS"
    eval "$INSTALL_COMMAND"
  )
fi

if tmux has-session -t "$TMUX_SESSION" 2>/dev/null; then
  echo "tmux session already exists: $TMUX_SESSION" >&2
  exit 1
fi

RUN_AGENT_COMMAND="$(printf '%q %q %q %q' "$RUN_AGENT_SCRIPT" "$AGENT" "$MODEL" "$THINKING")"
RESPAWN_COMMAND="$(printf 'tmux new-session -d -s %q -x %q -y %q -c %q %q' "$TMUX_SESSION" "$TMUX_WIDTH" "$TMUX_HEIGHT" "$WORKTREE_ABS" "$RUN_AGENT_COMMAND")"

tmux new-session -d -s "$TMUX_SESSION" -x "$TMUX_WIDTH" -y "$TMUX_HEIGHT" -c "$WORKTREE_ABS" "$RUN_AGENT_COMMAND"

if [[ -n "$INITIAL_PROMPT_FILE_ABS" ]]; then
  sleep "$INITIAL_PROMPT_DELAY"

  prompt_payload="$(compact_prompt_for_tmux "$INITIAL_PROMPT_FILE_ABS")"
  if [[ -n "$prompt_payload" ]]; then
    if [[ "${#prompt_payload}" -gt 12000 ]]; then
      prompt_payload="${prompt_payload:0:12000} ... [truncated by orchestrate to avoid tmux input flood]"
    fi

    PROMPT_BUFFER="orchestrate-init-${TMUX_SESSION//[^a-zA-Z0-9]/_}-$$"
    printf '%s' "$prompt_payload" | tmux load-buffer -b "$PROMPT_BUFFER" -
    tmux paste-buffer -b "$PROMPT_BUFFER" -t "$TMUX_SESSION"
    tmux send-keys -t "$TMUX_SESSION" Enter
    tmux delete-buffer -b "$PROMPT_BUFFER" || true
  fi
fi

if [[ ! -f "$TASK_FILE_ABS" ]]; then
  echo "[]" >"$TASK_FILE_ABS"
fi

if ! jq -e . "$TASK_FILE_ABS" >/dev/null 2>&1; then
  echo "Invalid JSON in $TASK_FILE_ABS" >&2
  exit 1
fi

normalize_tmp="$(mktemp)"
jq 'if type == "array" then . elif type == "object" then [.] else [] end' "$TASK_FILE_ABS" >"$normalize_tmp"
mv "$normalize_tmp" "$TASK_FILE_ABS"

NOW_MS="$(($(date +%s) * 1000))"

TASK_JSON="$(jq -n \
  --arg id "$ID" \
  --arg tmuxSession "$TMUX_SESSION" \
  --arg agent "$AGENT" \
  --arg model "$MODEL" \
  --arg thinking "$THINKING" \
  --arg description "$DESCRIPTION" \
  --arg repo "$REPO" \
  --arg worktree "$WORKTREE" \
  --arg branch "$BRANCH" \
  --arg status "running" \
  --arg respawnCommand "$RESPAWN_COMMAND" \
  --arg logPath "$LOG_PATH" \
  --arg blockingReason "" \
  --arg initialPromptFile "$INITIAL_PROMPT_FILE" \
  --arg mergeMethod "$MERGE_METHOD" \
  --argjson startedAt "$NOW_MS" \
  --argjson lastHeartbeatAt "$NOW_MS" \
  --argjson respawnAttempts 0 \
  --argjson maxRespawnAttempts "$MAX_RESPAWN_ATTEMPTS" \
  --argjson notifyOnComplete "$NOTIFY_ON_COMPLETE" \
  '{
    id: $id,
    tmuxSession: $tmuxSession,
    agent: $agent,
    model: $model,
    thinking: $thinking,
    description: $description,
    repo: $repo,
    worktree: $worktree,
    branch: $branch,
    startedAt: $startedAt,
    status: $status,
    respawnAttempts: $respawnAttempts,
    maxRespawnAttempts: $maxRespawnAttempts,
    notifyOnComplete: $notifyOnComplete,
    respawnCommand: $respawnCommand,
    logPath: $logPath,
    blockingReason: $blockingReason,
    lastHeartbeatAt: $lastHeartbeatAt,
    initialPromptFile: $initialPromptFile,
    mergeMethod: $mergeMethod,
    closeSessionOnMerge: true,
    followupCount: 0,
    lastFollowupAt: null,
    lastFollowupMessage: "",
    humanReviewState: "pending",
    humanReviewFeedback: "",
    pendingHumanFollowup: false,
    humanReviewRequestedAt: null,
    lastHumanReviewActionAt: null,
    mergedAt: null
  }')"

update_tmp="$(mktemp)"
jq --argjson task "$TASK_JSON" 'map(select(.id != $task.id)) + [$task]' "$TASK_FILE_ABS" >"$update_tmp"
mv "$update_tmp" "$TASK_FILE_ABS"

echo "Spawned task: $ID"
echo "  worktree: $WORKTREE_ABS"
echo "  tmux session: $TMUX_SESSION"
echo "  task file: $TASK_FILE_ABS"
if [[ -n "$INITIAL_PROMPT_FILE" ]]; then
  echo "  initial prompt: $INITIAL_PROMPT_FILE"
fi
