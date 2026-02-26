#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  schedule-wave.sh \
    --tasks-file <path> \
    [--active-task-file <path>] \
    --max-concurrency <n> \
    [--wave-label <wave-n>] \
    [--output <path>] \
    [--apply] \
    [--use-br]

Selects next runnable tasks by dependency, priority, and model availability.

Rules:
- Keep running tasks <= max concurrency
- Only select tasks with status=queued
- Task dependencies must be complete
- Higher priority first (critical > high > medium > low)
- Tie-break by difficulty (high > medium > low), then id

If --use-br is set, task candidates come from `br ready --json` instead of --tasks-file.
br must be installed and a .beads/ workspace must exist in the repo root.
The --tasks-file is still used (and updated when --apply is set) as the scheduling record.

If --apply is set, selected tasks are marked status=running with wave=<wave-label>.
EOF
}

TASKS_FILE=""
ACTIVE_TASK_FILE=".pi/active-tasks.json"
MAX_CONCURRENCY=""
WAVE_LABEL=""
OUTPUT=""
APPLY="false"
USE_BR="false"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --tasks-file)
      TASKS_FILE="${2:-}"
      shift 2
      ;;
    --active-task-file)
      ACTIVE_TASK_FILE="${2:-}"
      shift 2
      ;;
    --max-concurrency)
      MAX_CONCURRENCY="${2:-}"
      shift 2
      ;;
    --wave-label)
      WAVE_LABEL="${2:-}"
      shift 2
      ;;
    --output)
      OUTPUT="${2:-}"
      shift 2
      ;;
    --apply)
      APPLY="true"
      shift 1
      ;;
    --use-br)
      USE_BR="true"
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

if [[ -z "$TASKS_FILE" || -z "$MAX_CONCURRENCY" ]]; then
  echo "--tasks-file and --max-concurrency are required" >&2
  usage
  exit 1
fi

case "$MAX_CONCURRENCY" in
  ''|*[!0-9]*)
    echo "--max-concurrency must be a non-negative integer" >&2
    exit 1
    ;;
esac

if [[ ! -f "$TASKS_FILE" ]]; then
  echo "Tasks file not found: $TASKS_FILE" >&2
  exit 1
fi

if [[ ! -f "$ACTIVE_TASK_FILE" ]]; then
  ACTIVE_TASK_JSON='[]'
else
  ACTIVE_TASK_JSON="$(jq 'if type == "array" then . else [.] end' "$ACTIVE_TASK_FILE")"
fi

TASKS_JSON="$(jq 'if type == "array" then . else [.] end' "$TASKS_FILE")"

# When --use-br is set, replace the candidate pool with `br ready --json`.
# br respects the full dependency graph automatically, so we only need to
# filter by available concurrency slots — no manual dep-walking required.
if [[ "$USE_BR" == "true" ]]; then
  if ! command -v br >/dev/null 2>&1; then
    echo "--use-br requested but br is not installed" >&2
    exit 1
  fi
  BR_READY_JSON="$(br ready --json 2>/dev/null || echo "[]")"
  # Map br issues back to orchestrate task records using the orch-id label.
  # For each ready br issue, find the matching task in TASKS_JSON by brIssueId
  # or by the orch-id label, then use those task records as the candidate pool.
  TASKS_JSON="$(jq -n \
    --argjson br_ready "$BR_READY_JSON" \
    --argjson all_tasks "$TASKS_JSON" '
    # Build a set of br IDs that are ready
    ($br_ready | map(.id) | unique) as $ready_ids |
    # Keep only tasks whose brIssueId is in the ready set, OR tasks with no
    # brIssueId that are still queued (backward-compat with non-br tasks).
    $all_tasks | map(
      if .brIssueId != null and .brIssueId != "" then
        select(.brIssueId as $bid | ($ready_ids | index($bid)) != null)
      else
        select((.status // "queued") == "queued")
      end
    )
  ')"
fi

running_count="$(jq '[.[] | select((.status // "") == "running")] | length' <<<"$ACTIVE_TASK_JSON")"
case "$running_count" in
  ''|*[!0-9]*) running_count="0" ;;
esac

available_slots=$((MAX_CONCURRENCY - running_count))
if [[ "$available_slots" -lt 0 ]]; then
  available_slots=0
fi

selected='[]'
if [[ "$available_slots" -gt 0 ]]; then
  selected="$(jq --argjson slots "$available_slots" '
    def prio(p):
      if p == "critical" then 4
      elif p == "high" then 3
      elif p == "medium" then 2
      elif p == "low" then 1
      else 0 end;
    def diff(d):
      if d == "high" then 3
      elif d == "medium" then 2
      elif d == "low" then 1
      else 0 end;

    . as $all
    | [ $all[]
        | select((.status // "queued") == "queued")
        | . as $t
        | ($t.dependencies // []) as $deps
        | select(($deps | type) == "array")
        | select(all($deps[]; . as $dep | (($all[] | select(.id == $dep) | .status) // "") == "complete"))
      ]
    | sort_by(-prio(.priority // "medium"), -diff(.difficulty // "medium"), .id)
    | .[:$slots]
  ' <<<"$TASKS_JSON")"
fi

if [[ "$APPLY" == "true" ]]; then
  if [[ -z "$WAVE_LABEL" ]]; then
    WAVE_LABEL="wave-$(date +%Y%m%d-%H%M%S)"
  fi

  selected_ids_json="$(jq '[.[].id]' <<<"$selected")"
  tmp_file="$(mktemp)"
  jq --arg wave "$WAVE_LABEL" --argjson ids "$selected_ids_json" '
    if type == "array" then . else [.] end
    | map(
        if (.id as $id | ($ids | index($id)) != null) then
          .status = "running" | .wave = $wave
        else . end
      )
  ' "$TASKS_FILE" > "$tmp_file"
  mv "$tmp_file" "$TASKS_FILE"
fi

result="$(jq -n \
  --argjson maxConcurrency "$MAX_CONCURRENCY" \
  --argjson runningCount "$running_count" \
  --argjson availableSlots "$available_slots" \
  --arg waveLabel "$WAVE_LABEL" \
  --argjson selected "$selected" \
  '{
    maxConcurrency: $maxConcurrency,
    runningCount: $runningCount,
    availableSlots: $availableSlots,
    waveLabel: (if $waveLabel == "" then null else $waveLabel end),
    selected: $selected
  }')"

if [[ -n "$OUTPUT" ]]; then
  mkdir -p "$(dirname "$OUTPUT")"
  printf '%s\n' "$result" > "$OUTPUT"
  echo "Wrote wave plan: $OUTPUT"
else
  printf '%s\n' "$result"
fi
