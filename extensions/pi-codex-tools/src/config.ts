export type AllProvidersMode = "off" | "on";

export interface CodexToolsConfig {
	/** off = only Codex-like models; on = every model/provider */
	scope: { allProviders: AllProvidersMode };
	tools: { customRustBinariesDir: string };
	ui: { statusLine: boolean };
}

export const DEFAULT_CODEX_TOOLS_CONFIG: CodexToolsConfig = {
	scope: { allProviders: "off" },
	tools: { customRustBinariesDir: "" },
	ui: { statusLine: true },
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

export function normalizeCodexToolsConfig(value: unknown): CodexToolsConfig {
	const raw = isRecord(value) ? value : {};
	const scope = isRecord(raw["scope"]) ? raw["scope"] : {};
	const tools = isRecord(raw["tools"]) ? raw["tools"] : {};
	const ui = isRecord(raw["ui"]) ? raw["ui"] : {};
	const allProviders = scope["allProviders"] === "on" ? "on" : "off";
	return {
		scope: { allProviders },
		tools: {
			customRustBinariesDir: typeof tools["customRustBinariesDir"] === "string" ? tools["customRustBinariesDir"] : "",
		},
		ui: {
			statusLine: ui["statusLine"] === false ? false : true,
		},
	};
}
