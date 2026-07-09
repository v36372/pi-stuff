#!/usr/bin/env bash
set -euo pipefail

# Installs all skills in this repository into the dotfiles-managed Agent Skills
# directory:
#   ~/.dotfiles/home/.agents/skills
# Each skill is copied as a real directory (not symlinked), so the installed
# copies are self-contained and survive even if this repo is moved or removed.
# Re-run after a `git pull` (or after scripts/sync-matt-skills.sh) to refresh.

REPO="$(cd "$(dirname "$0")/.." && pwd)"
DEST="${SKILLS_DEST:-$HOME/.dotfiles/home/.agents/skills}"

mkdir -p "$DEST"

installed=0
for skill_md in "$REPO"/*/SKILL.md; do
  [[ -f "$skill_md" ]] || continue

  src="$(dirname "$skill_md")"
  name="$(basename "$src")"
  target="$DEST/$name"

  rm -rf "$target"
  cp -R "$src" "$target"
  rm -rf "$target/.git"
  echo "installed $name -> $target"
  ((installed += 1))
done

if ((installed == 0)); then
  echo "No skills found in $REPO" >&2
  exit 1
fi
