import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { CodexToolsConfig } from "./config.ts";
import { isCodexLikeModel } from "./model.ts";

export const STATUS_KEY = "codex-tools";

/** Pi built-ins replaced by the Codex shell/patch tools. */
export const DEFAULT_TOOL_NAMES = ["read", "bash", "edit", "write", "grep", "find", "ls"];

export const CODEX_TOOL_NAMES = ["exec_command", "write_stdin", "apply_patch"] as const;
export type CodexToolName = (typeof CODEX_TOOL_NAMES)[number];

export interface AdapterState {
	enabled: boolean;
	/** Baseline to restore while the adapter is active. Cleared when inactive. */
	previousToolNames?: string[] | undefined;
	config: CodexToolsConfig;
}

export function shouldActivate(ctx: Pick<ExtensionContext, "model">, config: CodexToolsConfig): boolean {
	if (config.scope.allProviders === "on") return true;
	return isCodexLikeModel(ctx.model);
}

export function mergeAdapterTools(activeTools: string[], adapterTools: readonly string[] = CODEX_TOOL_NAMES): string[] {
	const owned = new Set(adapterTools);
	const preserved = activeTools.filter((name) => !DEFAULT_TOOL_NAMES.includes(name) && !owned.has(name));
	return [...adapterTools, ...preserved];
}

export function stripAdapterTools(toolNames: string[], adapterTools: readonly string[] = CODEX_TOOL_NAMES): string[] {
	return toolNames.filter((name) => !adapterTools.includes(name as CodexToolName));
}

export function restoreTools(
	previousTools: string[],
	activeTools: string[],
	adapterTools: readonly string[] = CODEX_TOOL_NAMES,
): string[] {
	const restored = stripAdapterTools(previousTools, adapterTools);
	for (const name of activeTools) {
		if (!adapterTools.includes(name as CodexToolName) && !restored.includes(name)) restored.push(name);
	}
	return restored;
}

function statusText(config: CodexToolsConfig, theme?: { fg(role: string, text: string): string }): string {
	const label = "Codex tools";
	const suffix = config.scope.allProviders === "on" ? " • all providers" : "";
	if (!theme) return `${label}${suffix}`;
	return `${theme.fg("accent", label)}${suffix ? theme.fg("dim", suffix) : ""}`;
}

function hasCodexTools(activeTools: string[]): boolean {
	return activeTools.some((name) => (CODEX_TOOL_NAMES as readonly string[]).includes(name));
}

/** Capture baseline only while transitioning into active (or first restore). */
export function captureBaseline(activeTools: string[]): string[] {
	return stripAdapterTools(activeTools);
}

export function restoreBaseline(pi: ExtensionAPI, state: AdapterState): void {
	const activeTools = pi.getActiveTools();
	if (!state.enabled && !hasCodexTools(activeTools) && state.previousToolNames === undefined) return;
	const previous = state.previousToolNames ?? stripAdapterTools(activeTools);
	pi.setActiveTools(restoreTools(previous, activeTools));
	state.enabled = false;
	delete state.previousToolNames;
}

export function syncAdapter(pi: ExtensionAPI, ctx: ExtensionContext, state: AdapterState): void {
	const activeTools = pi.getActiveTools();
	const active = shouldActivate(ctx, state.config);

	if (active) {
		// Recapture whenever entering active from inactive so /tools changes stick.
		if (!state.enabled) {
			state.previousToolNames = captureBaseline(activeTools);
		}
		state.enabled = true;
		pi.setActiveTools(mergeAdapterTools(activeTools));
		if (ctx.hasUI) {
			ctx.ui.setStatus(STATUS_KEY, state.config.ui.statusLine ? statusText(state.config, ctx.ui.theme) : undefined);
		}
		return;
	}

	// Inactive: strip our tools if present, then drop the saved baseline so the
	// next activation recaptures whatever the user has configured in the meantime.
	if (state.enabled || hasCodexTools(activeTools)) {
		const previous = state.previousToolNames ?? stripAdapterTools(activeTools);
		pi.setActiveTools(restoreTools(previous, activeTools));
	}
	state.enabled = false;
	delete state.previousToolNames;
	if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
}
