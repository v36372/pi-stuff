# pi-codex-tools

Lightweight local fork of [`@howaboua/pi-codex-conversion`](https://github.com/IgorWarzocha/howaboua-pi-stuff/tree/main/packages/pi-codex-conversion) that only provides the Codex shell/patch tool surface:

- `exec_command`
- `write_stdin`
- `apply_patch`

No voice, compaction, code mode, web_run, view_image, imagegen, custom providers, or prompt rewrites.

Tool implementations and native binaries are copied from that MIT-licensed package (see `LICENSE`).

## Install (local only)

This package is **repository-local** (`private: true`, scoped as `@local/pi-codex-tools`). It is **not** published to npm — the unscoped name `pi-codex-tools` is already taken by unrelated software.

Pi auto-discovers packages under `~/.pi/agent/extensions/`. Place/keep this directory there, then restart or `/reload`.

Do **not** load alongside full `pi-codex-conversion`. Both register the same tool names; Pi keeps the first registration per name and both extensions’ event handlers can still run, producing a load-order-dependent mixed runtime.

## Scope

When active, replaces Pi's built-in tools (`read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`) with the three Codex tools above. Other extension tools stay.

| `scope.allProviders` | When tools activate |
|----------------------|---------------------|
| `"off"` (default) | Codex-like models only (`openai-codex`, GPT via openai/copilot, ids containing `codex`) |
| `"on"` | All models/providers |

Config: `~/.pi/agent/pi-codex-tools.json`

```json
{
  "scope": { "allProviders": "off" },
  "tools": { "customRustBinariesDir": "" },
  "ui": { "statusLine": true }
}
```

Commands:

```
/codex-tools status
/codex-tools codex-only
/codex-tools all
/codex-tools edit
```

## Native binaries

Bundled under:

```
src/tools/apply-patch/bin/<platform>-<arch>/apply_patch
src/tools/exec/bin/<platform>-<arch>/exec_bridge
```

Supported matrix (copied from upstream): `linux-x64`, `linux-arm64`, `darwin-x64`, `darwin-arm64`, `win32-x64`, `win32-arm64`.

Override with `tools.customRustBinariesDir` pointing at a directory that contains both executables (`apply_patch` / `exec_bridge`, or `.exe` on Windows).

### Missing / wrong-platform binary

If the error is “binary is not bundled for …” or you replaced files by accident, reinstall matching **prebuilts** for your `platform-arch` from the upstream package version these binaries were copied from (currently aligned with the vendored `pi-codex-conversion` tree in this agent repo — check that package’s `package.json` `version` field, do **not** blindly use `@latest`):

```bash
# pin VERSION to the vendored pi-codex-conversion package.json version
npm pack @howaboua/pi-codex-conversion@VERSION
tar -xzf howaboua-pi-codex-conversion-*.tgz
# copy package/src/tools/{apply-patch,exec}/bin/<platform-arch>/{apply_patch,exec_bridge}
```

Or copy the same paths from a local checkout of  
https://github.com/IgorWarzocha/howaboua-pi-stuff/tree/main/packages/pi-codex-conversion

Put both executables in one directory, set `tools.customRustBinariesDir`, `/reload`.

### ABI / loader failure (NixOS, old GLIBC, etc.)

Upstream **prebuilts will not help** — they are the same dynamically linked artifacts. You need a **target-compatible rebuild** of `apply_patch` and `exec_bridge` (or run under a compatible FHS/userland). This fork does **not** ship Rust sources or build scripts. Build from the upstream package sources in howaboua-pi-stuff at the same VERSION, place the resulting binaries in a directory, set `tools.customRustBinariesDir`, `/reload`. There is no supported path that “downloads a different prebuilt” for NixOS/GLIBC mismatches.

## Check

```bash
node --experimental-strip-types check.mjs
```
