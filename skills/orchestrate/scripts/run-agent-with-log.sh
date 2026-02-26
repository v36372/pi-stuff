#!/usr/bin/env bash
set -euo pipefail

# Usage: run-agent-with-log.sh <agent-label> <provider/model> <thinking>
# Example: run-agent-with-log.sh T01 openai/gpt-5.3-codex high

AGENT="${1:-agent}"
MODEL_REF="${2:-openai/gpt-5.3-codex}"
THINKING="${3:-medium}"

if [[ "$MODEL_REF" != */* ]]; then
  echo "Model must be fully-qualified as <provider>/<model>, got: $MODEL_REF" >&2
  exit 1
fi

PROVIDER="${MODEL_REF%%/*}"
MODEL="${MODEL_REF#*/}"

if [[ -z "$PROVIDER" || -z "$MODEL" ]]; then
  echo "Invalid model reference: $MODEL_REF" >&2
  exit 1
fi

# Log file in the current working directory
LOG_DIR=".pi/logs"
mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/${AGENT}-$(date +%Y%m%d-%H%M%S).log"

echo "Starting agent: $AGENT"
echo "Model: $MODEL_REF (provider: $PROVIDER)"
echo "Thinking: $THINKING"
echo "Log: $LOG_FILE"
echo "Working directory: $(pwd)"
echo "---"

# Run pi interactively (no --print since subagent needs to stay alive)
# The thinking level is appended to model as :thinking
exec pi \
  --provider "$PROVIDER" \
  --model "${MODEL}:${THINKING}" \
  2>&1 | tee -a "$LOG_FILE"
