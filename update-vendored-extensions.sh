#!/usr/bin/env bash
set -euo pipefail

ANGRISTAN_REPO="https://github.com/angristan/pi-extensions.git"
ANGRISTAN_REF="main"
ANGRISTAN_EXTENSIONS=(
	accent-color
	background-jobs
	better-native-pi
	code-blocks
	hyperlinks
	image-store
	overlay-stack
	turn-separator
	turn-stats
	working-timer
)
LOVELY_REPO="https://github.com/xl0/pi-lovely-dev-tools.git"
LOVELY_REF="master"
LOVELY_FILES=(
	entries.ts
	llm-stats.ts
	schema.ts
	show-context.ts
	show-sysprompt.ts
)
CODEX_PACKAGE="@howaboua/pi-codex-conversion"

usage() {
	printf 'Usage: %s [--dry-run]\n' "$(basename "$0")"
}

dry_run=false
case "${1:-}" in
	"") ;;
	--dry-run) dry_run=true ;;
	-h|--help)
		usage
		exit 0
		;;
	*)
		usage >&2
		exit 2
		;;
esac

script_dir="$(cd "$(dirname "$0")" && pwd)"
repo_root="$(git -C "$script_dir" rev-parse --show-toplevel)"
targets=()
for extension in "${ANGRISTAN_EXTENSIONS[@]}"; do
	targets+=("extensions/$extension")
done
targets+=("extensions/inspect-diagnostics")
targets+=("extensions/pi-codex-conversion")

if [[ "$dry_run" == false ]]; then
	changes="$(git -C "$repo_root" status --short -- "${targets[@]}")"
	if [[ -n "$changes" ]]; then
	printf 'Refusing to overwrite uncommitted vendored-extension changes:\n%s\n' "$changes" >&2
	exit 1
	fi
fi

temp_dir="$(mktemp -d "${TMPDIR:-/tmp}/pi-extensions.XXXXXX")"
trap 'rm -rf "$temp_dir"' EXIT

git clone --quiet --depth 1 --branch "$ANGRISTAN_REF" "$ANGRISTAN_REPO" "$temp_dir/angristan"
git clone --quiet --depth 1 --branch "$LOVELY_REF" "$LOVELY_REPO" "$temp_dir/lovely"
angristan_commit="$(git -C "$temp_dir/angristan" rev-parse --short HEAD)"
lovely_commit="$(git -C "$temp_dir/lovely" rev-parse --short HEAD)"
codex_tarball="$(npm pack --silent --pack-destination "$temp_dir" "$CODEX_PACKAGE@latest" | tail -1)"
mkdir "$temp_dir/codex"
tar -xzf "$temp_dir/$codex_tarball" -C "$temp_dir/codex" --strip-components=1
codex_version="$(node -p "require('$temp_dir/codex/package.json').version")"

for extension in "${ANGRISTAN_EXTENSIONS[@]}"; do
	source_dir="$temp_dir/angristan/extensions/$extension"
	if [[ ! -d "$source_dir" ]]; then
		printf 'Missing upstream extension: extensions/%s\n' "$extension" >&2
		exit 1
	fi
done
if [[ ! -f "$temp_dir/codex/dist/index.js" ]]; then
	printf 'Missing extension artifact: %s@%s dist/index.js\n' "$CODEX_PACKAGE" "$codex_version" >&2
	exit 1
fi
for file in "${LOVELY_FILES[@]}"; do
	if [[ ! -f "$temp_dir/lovely/extensions/lovely-dev-tools/$file" ]]; then
		printf 'Missing lovely-dev-tools file: %s\n' "$file" >&2
		exit 1
	fi
done

rsync_args=(-rlpc --delete --exclude node_modules --itemize-changes)
if [[ "$dry_run" == true ]]; then
	rsync_args+=(--dry-run)
	printf 'Dry run\n'
else
	printf 'Updating vendored extensions\n'
fi

printf '\n%s@%s\n' "$ANGRISTAN_REPO" "$angristan_commit"
for extension in "${ANGRISTAN_EXTENSIONS[@]}"; do
	printf '\n[%s]\n' "$extension"
	rsync "${rsync_args[@]}" \
		"$temp_dir/angristan/extensions/$extension/" \
		"$repo_root/extensions/$extension/"
done

printf '\n%s@%s\n\n[inspect-diagnostics]\n' "$LOVELY_REPO" "$lovely_commit"
for file in "${LOVELY_FILES[@]}"; do
	rsync "${rsync_args[@]}" \
		"$temp_dir/lovely/extensions/lovely-dev-tools/$file" \
		"$repo_root/extensions/inspect-diagnostics/$file"
done
rsync "${rsync_args[@]}" "$temp_dir/lovely/LICENSE" "$repo_root/extensions/inspect-diagnostics/LICENSE"

printf '\n%s@%s\n\n[pi-codex-conversion]\n' "$CODEX_PACKAGE" "$codex_version"
rsync "${rsync_args[@]}" "$temp_dir/codex/" "$repo_root/extensions/pi-codex-conversion/"

# Re-apply local patches that live outside the rsync target so they
# survive upstream refreshes (e.g. strip grep/find/ls with the adapter).
# Dry-run checks the freshly packed upstream tree, not the live (already
# patched) checkout.
local_patches_dir="$repo_root/local-patches/pi-codex-conversion"
if [[ -d "$local_patches_dir" ]]; then
	shopt -s nullglob
	local_patches=("$local_patches_dir"/*.patch)
	shopt -u nullglob
	if ((${#local_patches[@]} > 0)); then
		printf '\n[pi-codex-conversion local patches]\n'
		patch_target="$repo_root/extensions/pi-codex-conversion"
		[[ "$dry_run" == true ]] && patch_target="$temp_dir/codex"
		for patch_file in "${local_patches[@]}"; do
			printf '  %s %s\n' "$([[ "$dry_run" == true ]] && echo dry-run || echo apply)" "$(basename "$patch_file")"
			if [[ "$dry_run" == true ]]; then
				patch --dry-run -d "$patch_target" -p1 < "$patch_file"
			else
				patch -d "$patch_target" -p1 < "$patch_file"
			fi
		done
	fi
fi

if [[ "$dry_run" == false ]]; then
	npm install --prefix "$repo_root/extensions/pi-codex-conversion" \
		--omit=dev --omit=peer --ignore-scripts --package-lock=false --no-audit --no-fund
fi

if [[ "$dry_run" == false ]]; then
	printf '\nUpdated files:\n'
	git -C "$repo_root" diff --stat -- "${targets[@]}"
fi
