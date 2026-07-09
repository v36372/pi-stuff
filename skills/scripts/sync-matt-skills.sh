#!/usr/bin/env bash
set -euo pipefail

# Syncs a curated set of Matt Pocock's agent skills
# (https://github.com/mattpocock/skills) into this repository as top-level
# skills, alongside our own. This makes our skills self-contained for
# consumers: upstream workflows are vendored here rather than assumed to be
# installed separately.
#
# Run from anywhere:
#   scripts/sync-matt-skills.sh            # sync from upstream main
#   MATT_SKILLS_REF=<sha|tag|branch> scripts/sync-matt-skills.sh
#
# Each synced skill directory is copied wholesale (including any sibling .md
# files it links to), so internal relative file links keep working. The skills
# are flattened to the repo root, so any `/slash-command` references between
# them resolve the same way once installed.
#
# After copying, we apply our own overrides (see apply_overrides below) so the
# vendored skills agree with our coding standards instead of contradicting
# them.

REPO="$(cd "$(dirname "$0")/.." && pwd)"
UPSTREAM_URL="${MATT_SKILLS_URL:-https://github.com/mattpocock/skills.git}"
UPSTREAM_REF="${MATT_SKILLS_REF:-main}"

# Map of upstream skill paths (relative to the upstream `skills/` dir) that we
# vendor as top-level skills here. The destination name is the basename.
SKILLS=(
  "productivity/grill-me"
  "productivity/grilling"
  "engineering/code-review"
  "engineering/domain-modeling"
  "engineering/grill-with-docs"
  "engineering/tdd"
)

# Append a local override block to a file. Idempotent because each sync
# re-copies the file fresh before patching.
append_override() {
  printf '\n%s\n' "$2" >> "$1"
  echo "  appended override to $1"
}

# All local divergences from upstream live here, one place to review.
apply_overrides() {
  echo
  echo "Applying local overrides..."

  # tdd: upstream mocking.md permits boundary mocking and never bans spies/module
  # mocks. Our coding standards forbid them. Make our standards win.
  append_override "$REPO/tdd/SKILL.md" "$TDD_OVERRIDE"
}

read -r -d '' TDD_OVERRIDE <<'MD' || true
## Local overrides (dmmulroy/skills)

This skill is vendored from mattpocock/skills. In this repository,
`../coding-standards/SKILL.md` is the source of truth and **supersedes
`mocking.md`** wherever they disagree:

- Do not use module-patching APIs (`vi.mock`, `jest.mock`) or method-spy APIs
  (`vi.spyOn`, `jest.spyOn`). Replace behavior through a real seam instead
  (constructor-injected dependency, Effect service/layer, recording fake adapter,
  local database, runtime binding).
- Prefer recording fakes supplied through production seams over mocks, even at
  system boundaries.
- Match evidence to risk and use representative databases or runtimes for claims that depend on them.
MD

tmp="$(mktemp -d)"
cleanup() { rm -rf "$tmp"; }
trap cleanup EXIT

echo "Cloning $UPSTREAM_URL ($UPSTREAM_REF)..."
git clone --quiet --depth 1 --branch "$UPSTREAM_REF" "$UPSTREAM_URL" "$tmp/upstream" 2>/dev/null \
  || git clone --quiet "$UPSTREAM_URL" "$tmp/upstream"

if [ "$UPSTREAM_REF" != "main" ]; then
  git -C "$tmp/upstream" checkout --quiet "$UPSTREAM_REF"
fi

synced_sha="$(git -C "$tmp/upstream" rev-parse --short HEAD)"

for entry in "${SKILLS[@]}"; do
  src="$tmp/upstream/skills/$entry"
  name="$(basename "$entry")"
  dest="$REPO/$name"

  if [ ! -f "$src/SKILL.md" ]; then
    echo "error: upstream skill not found: skills/$entry" >&2
    exit 1
  fi

  rm -rf "$dest"
  mkdir -p "$dest"
  # Copy contents (including sibling docs), excluding any VCS noise.
  cp -R "$src/." "$dest/"
  rm -rf "$dest/.git"

  echo "synced $entry -> $name/"
done

apply_overrides

echo
echo "Done. Vendored from mattpocock/skills@$synced_sha (with local overrides)"
echo "Review changes with: git -C \"$REPO\" status"
