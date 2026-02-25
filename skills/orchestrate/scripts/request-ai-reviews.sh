#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  request-ai-reviews.sh \
    [--pr <number>] \
    [--branch <branch>] \
    [--repo <owner/repo>] \
    [--reviewers <csv>] \
    [--no-comment] \
    [--dry-run]

Requests automated AI reviewers for an open PR using gh CLI.

Defaults:
- --reviewers: ORCHESTRATE_AI_REVIEWERS env or "github-copilot[bot],codex,gemini"
- --branch: current git branch (when --pr is not provided)

Examples:
  request-ai-reviews.sh --reviewers "github-copilot[bot],codex,gemini"
  request-ai-reviews.sh --pr 123 --repo owner/repo --reviewers "github-copilot[bot],codex,gemini"
EOF
}

require_command() {
  local cmd="$1"
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "Missing required command: $cmd" >&2
    exit 1
  fi
}

trim() {
  local value="$1"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  printf '%s' "$value"
}

PR_NUMBER=""
BRANCH=""
REPO=""
REVIEWERS="${ORCHESTRATE_AI_REVIEWERS:-github-copilot[bot],codex,gemini}"
ADD_COMMENT="true"
DRY_RUN="false"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --pr)
      PR_NUMBER="${2:-}"
      shift 2
      ;;
    --branch)
      BRANCH="${2:-}"
      shift 2
      ;;
    --repo)
      REPO="${2:-}"
      shift 2
      ;;
    --reviewers)
      REVIEWERS="${2:-}"
      shift 2
      ;;
    --no-comment)
      ADD_COMMENT="false"
      shift 1
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

if [[ -z "$REVIEWERS" ]]; then
  echo "--reviewers cannot be empty" >&2
  exit 1
fi

if [[ -z "$PR_NUMBER" ]]; then
  require_command git
fi

require_command gh
require_command jq

if [[ -z "$PR_NUMBER" ]]; then
  if [[ -z "$BRANCH" ]]; then
    BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
    if [[ -z "$BRANCH" || "$BRANCH" == "HEAD" ]]; then
      echo "Could not resolve current branch. Provide --branch or --pr." >&2
      exit 1
    fi
  fi

  if [[ -n "$REPO" ]]; then
    pr_list_json="$(gh -R "$REPO" pr list --head "$BRANCH" --state open --json number,url 2>/dev/null || echo '[]')"
  else
    pr_list_json="$(gh pr list --head "$BRANCH" --state open --json number,url 2>/dev/null || echo '[]')"
  fi

  PR_NUMBER="$(jq -r '.[0].number // ""' <<<"$pr_list_json")"
  PR_URL="$(jq -r '.[0].url // ""' <<<"$pr_list_json")"

  if [[ -z "$PR_NUMBER" ]]; then
    echo "No open PR found for branch: $BRANCH" >&2
    exit 1
  fi
else
  PR_URL=""
fi

IFS=',' read -r -a raw_reviewers <<< "$REVIEWERS"
reviewers=()
for reviewer in "${raw_reviewers[@]}"; do
  reviewer_trimmed="$(trim "$reviewer")"
  if [[ -n "$reviewer_trimmed" ]]; then
    reviewers+=("$reviewer_trimmed")
  fi
done

if [[ ${#reviewers[@]} -eq 0 ]]; then
  echo "No valid reviewers after parsing --reviewers" >&2
  exit 1
fi

echo "Requesting AI reviewers for PR #$PR_NUMBER${PR_URL:+ ($PR_URL)}"

added_reviewers=()
failed_reviewers=()

for reviewer in "${reviewers[@]}"; do
  if [[ "$DRY_RUN" == "true" ]]; then
    echo "[dry-run] gh ${REPO:+-R $REPO }pr edit $PR_NUMBER --add-reviewer $reviewer"
    added_reviewers+=("$reviewer")
    continue
  fi

  if [[ -n "$REPO" ]]; then
    if gh -R "$REPO" pr edit "$PR_NUMBER" --add-reviewer "$reviewer" >/dev/null 2>&1; then
      added_reviewers+=("$reviewer")
    else
      failed_reviewers+=("$reviewer")
    fi
  else
    if gh pr edit "$PR_NUMBER" --add-reviewer "$reviewer" >/dev/null 2>&1; then
      added_reviewers+=("$reviewer")
    else
      failed_reviewers+=("$reviewer")
    fi
  fi
done

if [[ "$ADD_COMMENT" == "true" ]]; then
  comment_lines=()
  comment_lines+=("Automated AI review request from orchestrator.")
  comment_lines+=("")
  comment_lines+=("Requested reviewers:")

  for reviewer in "${reviewers[@]}"; do
    comment_lines+=("- @${reviewer}")
  done

  comment_lines+=("")
  comment_lines+=("Please review this PR and post actionable feedback.")

  comment_body="$(printf '%s\n' "${comment_lines[@]}")"

  if [[ "$DRY_RUN" == "true" ]]; then
    echo "[dry-run] would post PR comment trigger"
  else
    if [[ -n "$REPO" ]]; then
      gh -R "$REPO" pr comment "$PR_NUMBER" --body "$comment_body" >/dev/null 2>&1 || true
    else
      gh pr comment "$PR_NUMBER" --body "$comment_body" >/dev/null 2>&1 || true
    fi
  fi
fi

if [[ ${#added_reviewers[@]} -gt 0 ]]; then
  echo "Requested reviewers: $(IFS=', '; echo "${added_reviewers[*]}")"
fi

if [[ ${#failed_reviewers[@]} -gt 0 ]]; then
  echo "Failed to request reviewers: $(IFS=', '; echo "${failed_reviewers[*]}")" >&2
fi

if [[ ${#added_reviewers[@]} -eq 0 ]]; then
  echo "No reviewer request succeeded" >&2
  exit 1
fi
