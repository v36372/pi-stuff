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
KAUSH_REPO="https://github.com/kaushikgopal/pi-kaush.git"
KAUSH_REF="main"
KAUSH_EXTENSIONS=(
	pi-welcome-screen
)
NO_ANSI_REPO="https://github.com/baggiiiie/pi-stuff.git"
NO_ANSI_REF="main"
NO_ANSI_PACKAGES=(
	no-ansi
)
RICHARD_REPO="https://github.com/richardgill/pi-extensions.git"
RICHARD_REF="main"
RICHARD_EXTENSIONS=(
	pi-up-history
	preset
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
for extension in "${KAUSH_EXTENSIONS[@]}"; do
	targets+=("extensions/$extension")
done
for package in "${NO_ANSI_PACKAGES[@]}"; do
	targets+=("extensions/$package")
done
for extension in "${RICHARD_EXTENSIONS[@]}"; do
	targets+=("extensions/$extension")
done
targets+=("extensions/inspect-diagnostics")

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
git clone --quiet --depth 1 --branch "$KAUSH_REF" "$KAUSH_REPO" "$temp_dir/kaush"
git clone --quiet --depth 1 --branch "$NO_ANSI_REF" "$NO_ANSI_REPO" "$temp_dir/no-ansi"
git clone --quiet --depth 1 --branch "$RICHARD_REF" "$RICHARD_REPO" "$temp_dir/richard"
git clone --quiet --depth 1 --branch "$LOVELY_REF" "$LOVELY_REPO" "$temp_dir/lovely"
angristan_commit="$(git -C "$temp_dir/angristan" rev-parse --short HEAD)"
kaush_commit="$(git -C "$temp_dir/kaush" rev-parse --short HEAD)"
no_ansi_commit="$(git -C "$temp_dir/no-ansi" rev-parse --short HEAD)"
richard_commit="$(git -C "$temp_dir/richard" rev-parse --short HEAD)"
lovely_commit="$(git -C "$temp_dir/lovely" rev-parse --short HEAD)"

for extension in "${ANGRISTAN_EXTENSIONS[@]}"; do
	source_dir="$temp_dir/angristan/extensions/$extension"
	if [[ ! -d "$source_dir" ]]; then
		printf 'Missing upstream extension: extensions/%s\n' "$extension" >&2
		exit 1
	fi
done
for extension in "${KAUSH_EXTENSIONS[@]}"; do
	source_dir="$temp_dir/kaush/extensions/$extension"
	if [[ ! -d "$source_dir" ]]; then
		printf 'Missing upstream extension: extensions/%s\n' "$extension" >&2
		exit 1
	fi
done
for package in "${NO_ANSI_PACKAGES[@]}"; do
	source_dir="$temp_dir/no-ansi/packages/$package"
	if [[ ! -d "$source_dir" ]]; then
		printf 'Missing upstream package: packages/%s\n' "$package" >&2
		exit 1
	fi
done
for extension in "${RICHARD_EXTENSIONS[@]}"; do
	source_dir="$temp_dir/richard/extensions/$extension"
	if [[ ! -d "$source_dir" ]]; then
		printf 'Missing upstream extension: extensions/%s\n' "$extension" >&2
		exit 1
	fi
done
preset_config_version="$(node -p "require('$temp_dir/richard/packages/pi-config/package.json').version")"
preset_zod_version="$(node -p "require('$temp_dir/richard/extensions/preset/package.json').dependencies.zod")"
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

printf '\n%s@%s\n' "$KAUSH_REPO" "$kaush_commit"
for extension in "${KAUSH_EXTENSIONS[@]}"; do
	printf '\n[%s]\n' "$extension"
	rsync "${rsync_args[@]}" \
		"$temp_dir/kaush/extensions/$extension/" \
		"$repo_root/extensions/$extension/"
done

printf '\n%s@%s\n' "$NO_ANSI_REPO" "$no_ansi_commit"
for package in "${NO_ANSI_PACKAGES[@]}"; do
	printf '\n[%s]\n' "$package"
	rsync "${rsync_args[@]}" \
		"$temp_dir/no-ansi/packages/$package/" \
		"$repo_root/extensions/$package/"
done

printf '\n%s@%s\n' "$RICHARD_REPO" "$richard_commit"
for extension in "${RICHARD_EXTENSIONS[@]}"; do
	printf '\n[%s]\n' "$extension"
	rsync "${rsync_args[@]}" \
		"$temp_dir/richard/extensions/$extension/" \
		"$repo_root/extensions/$extension/"
done
if [[ "$dry_run" == false ]]; then
	npm install --prefix "$repo_root/extensions/preset" \
		--no-save --omit=dev --omit=peer --ignore-scripts --package-lock=false --no-audit --no-fund \
		"@richardgill/pi-config@$preset_config_version" "zod@$preset_zod_version"
fi

printf '\n%s@%s\n\n[inspect-diagnostics]\n' "$LOVELY_REPO" "$lovely_commit"
for file in "${LOVELY_FILES[@]}"; do
	rsync "${rsync_args[@]}" \
		"$temp_dir/lovely/extensions/lovely-dev-tools/$file" \
		"$repo_root/extensions/inspect-diagnostics/$file"
done
rsync "${rsync_args[@]}" "$temp_dir/lovely/LICENSE" "$repo_root/extensions/inspect-diagnostics/LICENSE"

if [[ "$dry_run" == false ]]; then
	printf '\nUpdated files:\n'
	git -C "$repo_root" diff --stat -- "${targets[@]}"
fi
