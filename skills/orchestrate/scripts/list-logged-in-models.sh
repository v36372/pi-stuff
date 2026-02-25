#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  list-logged-in-models.sh [--ids] [search]

Options:
  --ids     Print only model IDs (one per line, no header)

Description:
  Lists models only for providers that are currently logged in in ~/.pi/agent/auth.json.
  Uses `pi --list-models` as the model source and filters by logged-in providers.
EOF
}

IDS_ONLY="false"
SEARCH=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --ids)
      IDS_ONLY="true"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      SEARCH="$1"
      shift
      ;;
  esac
done

if ! command -v pi >/dev/null 2>&1; then
  echo "Missing required command: pi" >&2
  exit 1
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "Missing required command: jq" >&2
  exit 1
fi

AUTH_FILE="${PI_AUTH_FILE:-$HOME/.pi/agent/auth.json}"
if [[ ! -f "$AUTH_FILE" ]]; then
  echo "Auth file not found: $AUTH_FILE" >&2
  echo "Run /login in pi first." >&2
  exit 1
fi

if ! jq -e . "$AUTH_FILE" >/dev/null 2>&1; then
  echo "Invalid JSON in auth file: $AUTH_FILE" >&2
  exit 1
fi

NOW_MS="$(( $(date +%s) * 1000 ))"
PROVIDERS_CSV="$(jq -r --argjson now "$NOW_MS" '
  to_entries
  | map(select(
      (.value.type == "oauth" and ((.value.expires? // ($now + 1)) > $now))
      or (.value.type == "api-key")
    ))
  | map(.key)
  | join(",")
' "$AUTH_FILE")"

if [[ -z "$PROVIDERS_CSV" ]]; then
  echo "No logged-in providers found in $AUTH_FILE" >&2
  echo "Run /login in pi first." >&2
  exit 1
fi

LIST_CMD=(pi --list-models)
if [[ -n "$SEARCH" ]]; then
  LIST_CMD+=("$SEARCH")
fi

if [[ "$IDS_ONLY" == "true" ]]; then
  "${LIST_CMD[@]}" | awk -v providers="$PROVIDERS_CSV" '
    BEGIN {
      split(providers, p, ",");
      for (i in p) allowed[p[i]] = 1;
    }
    NR == 1 { next }
    allowed[$1] { print $2 }
  '
else
  "${LIST_CMD[@]}" | awk -v providers="$PROVIDERS_CSV" '
    BEGIN {
      split(providers, p, ",");
      for (i in p) allowed[p[i]] = 1;
    }
    NR == 1 || allowed[$1] { print }
  '
fi
