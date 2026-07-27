import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const NATIVE_TOOL_NAMES = new Set(["read", "write", "edit", "bash", "grep", "find", "ls"]);
const CODEX_EXECUTION_TOOL_NAMES = new Set(["exec_command", "exec"]);

/**
 * pi-codex-conversion-lite replaces Pi's four default active tools, but it
 * preserves grep/find/ls when better-native-pi overrides them because they then
 * look like third-party extension tools. Remove all native-name overrides while
 * the Codex adapter's normal or Code Mode execution tool is active.
 */
export function scopeCodexTools(pi: Pick<ExtensionAPI, "getActiveTools" | "setActiveTools">): boolean {
	const activeTools = pi.getActiveTools();
	if (!activeTools.some((name) => CODEX_EXECUTION_TOOL_NAMES.has(name))) return false;

	const scopedTools = activeTools.filter((name) => !NATIVE_TOOL_NAMES.has(name));
	if (scopedTools.length === activeTools.length) return false;

	pi.setActiveTools(scopedTools);
	return true;
}

export default function codexToolScope(pi: ExtensionAPI) {
	// This extension is loaded as a local package after pi-codex-conversion-lite,
	// so lifecycle synchronization observes the adapter's final tool selection.
	pi.on("session_start", () => { scopeCodexTools(pi); });
	pi.on("model_select", () => { scopeCodexTools(pi); });

	// /codex can change adapter mode without selecting another model. Input runs
	// before Pi snapshots the system prompt, keeping both prompt and tool schemas
	// free of native tools on the very next request.
	pi.on("input", () => { scopeCodexTools(pi); });
}
