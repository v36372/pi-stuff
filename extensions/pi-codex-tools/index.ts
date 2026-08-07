import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { restoreBaseline, STATUS_KEY, syncAdapter, type AdapterState } from "./src/activation.ts";
import { getCodexToolsConfigPath, readCodexToolsConfig, writeCodexToolsConfig } from "./src/config-store.ts";
import { normalizeCodexToolsConfig, type AllProvidersMode, type CodexToolsConfig } from "./src/config.ts";
import { initializeBashParser } from "./src/shell/bash.ts";
import { createExecCommandTracker } from "./src/tools/exec/command-state.ts";
import { registerExecCommandTool } from "./src/tools/exec/command-tool.ts";
import { createExecSessionManager } from "./src/tools/exec/session-manager.ts";
import { registerWriteStdinTool } from "./src/tools/exec/write-stdin-tool.ts";
import { getBundledToolBinaryPath } from "./src/tools/native/binary.ts";
import {
	clearApplyPatchRenderState,
	registerApplyPatchResultEvent,
	registerApplyPatchTool,
} from "./src/tools/apply-patch/tool.ts";

function registerCoreTools(
	pi: ExtensionAPI,
	state: AdapterState,
	tracker: ReturnType<typeof createExecCommandTracker>,
	sessions: ReturnType<typeof createExecSessionManager>,
): void {
	registerApplyPatchResultEvent(pi);
	registerApplyPatchTool(pi, {
		customRustBinariesDir: () => state.config.tools.customRustBinariesDir,
		showDiffWhenCollapsed: true,
	});
	registerExecCommandTool(pi, tracker, sessions, {
		customRendering: true,
		showOutputWhenCollapsed: true,
	});
	registerWriteStdinTool(pi, sessions, { showOutputWhenCollapsed: true });
}

function reloadConfig(state: AdapterState, sessions: ReturnType<typeof createExecSessionManager>): CodexToolsConfig {
	state.config = readCodexToolsConfig();
	sessions.setBaseEnv({ ...process.env });
	return state.config;
}

function formatScope(mode: AllProvidersMode): string {
	return mode === "on" ? "all providers" : "codex-like models only";
}

function persistConfig(state: AdapterState, config: CodexToolsConfig, path = getCodexToolsConfigPath()): void {
	writeCodexToolsConfig(config, path);
	state.config = config;
}

export default function piCodexTools(pi: ExtensionAPI): void {
	const state: AdapterState = {
		enabled: false,
		config: readCodexToolsConfig(),
	};
	const tracker = createExecCommandTracker();
	const sessions = createExecSessionManager({
		env: { ...process.env },
		bridgeBinaryPath: () => getBundledToolBinaryPath("exec_bridge", {}, state.config.tools.customRustBinariesDir),
	});

	registerCoreTools(pi, state, tracker, sessions);
	sessions.onSessionExit((sessionId) => tracker.recordSessionFinished(sessionId));

	const refresh = (ctx: ExtensionContext) => {
		reloadConfig(state, sessions);
		clearApplyPatchRenderState();
		syncAdapter(pi, ctx, state);
	};

	pi.on("session_start", async (_event, ctx) => {
		initializeBashParser();
		tracker.clear();
		sessions.setBaseEnv({ ...process.env });
		refresh(ctx);
	});

	pi.on("model_select", async (_event, ctx) => {
		refresh(ctx);
	});

	pi.on("message_start", async (event) => {
		if (event.message.role !== "toolResult") tracker.resetExplorationGroup();
	});

	pi.on("tool_execution_start", async (event) => {
		if (event.toolName !== "exec_command") {
			tracker.resetExplorationGroup();
			return;
		}
		const args = event.args;
		const cmd = args && typeof args === "object" && "cmd" in args && typeof args.cmd === "string" ? args.cmd : undefined;
		if (cmd) tracker.recordStart(event.toolCallId, cmd);
	});

	pi.on("tool_execution_end", async (event) => {
		if (event.toolName === "exec_command") tracker.recordEnd(event.toolCallId);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		restoreBaseline(pi, state);
		if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
		await sessions.shutdown();
	});

	pi.registerCommand("codex-tools", {
		description: "Codex tools scope: codex-only | all | status | edit",
		handler: async (args, ctx) => {
			const cmd = (args ?? "").trim().toLowerCase();
			if (cmd === "status" || cmd === "") {
				ctx.ui.notify(
					`Codex tools: ${state.enabled ? "active" : "inactive"} · scope=${formatScope(state.config.scope.allProviders)} · config ${getCodexToolsConfigPath()}`,
					"info",
				);
				return;
			}
			if (cmd === "codex-only" || cmd === "off" || cmd === "codex") {
				const next = { ...state.config, scope: { ...state.config.scope, allProviders: "off" as const } };
				try {
					persistConfig(state, next);
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					ctx.ui.notify(`Failed to save config: ${message}`, "error");
					return;
				}
				syncAdapter(pi, ctx, state);
				ctx.ui.notify(`Codex tools scope: ${formatScope("off")}`, "info");
				return;
			}
			if (cmd === "all" || cmd === "on") {
				const next = { ...state.config, scope: { ...state.config.scope, allProviders: "on" as const } };
				try {
					persistConfig(state, next);
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					ctx.ui.notify(`Failed to save config: ${message}`, "error");
					return;
				}
				syncAdapter(pi, ctx, state);
				ctx.ui.notify(`Codex tools scope: ${formatScope("on")}`, "info");
				return;
			}
			if (cmd === "edit") {
				const path = getCodexToolsConfigPath();
				const current = `${JSON.stringify(state.config, null, "\t")}\n`;
				const edited = await ctx.ui.editor(`Edit ${path}`, current);
				if (edited === undefined) return;
				let parsed: unknown;
				try {
					parsed = JSON.parse(edited);
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					ctx.ui.notify(`Invalid config JSON: ${message}`, "error");
					return;
				}
				const next = normalizeCodexToolsConfig(parsed);
				try {
					persistConfig(state, next, path);
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					ctx.ui.notify(`Failed to save config: ${message}`, "error");
					return;
				}
				syncAdapter(pi, ctx, state);
				ctx.ui.notify(`Saved ${path}`, "info");
				return;
			}
			ctx.ui.notify("Usage: /codex-tools [status|codex-only|all|edit]", "warning");
		},
	});
}
