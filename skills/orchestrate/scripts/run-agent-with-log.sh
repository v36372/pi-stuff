#!/usr/bin/env bash
set -euo pipefail

# Usage: run-agent-with-log.sh <agent-label> <model> <thinking>
# Example: run-agent-with-log.sh T01 gpt-5.3-codex high

AGENT="${1:-agent}"
MODEL="${2:-gpt-5.3-codex}"
THINKING="${3:-medium}"

# Map model to provider
case "$MODEL" in
  gpt-*|o1-*|o3-*|o4-*)
    PROVIDER="openai"
    ;;
  claude-*|anthropic/*)
    PROVIDER="anthropic"
    ;;
  gemini-*|google/*)
    PROVIDER="google"
    ;;
  *)
    # Default to openai for codex models
    PROVIDER="openai"
    ;;
esac

# Log file in the current working directory
LOG_DIR=".pi/logs"
mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/${AGENT}-$(date +%Y%m%d-%H%M%S).log"

echo "Starting agent: $AGENT"
echo "Model: $MODEL (provider: $PROVIDER)"
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
