import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
	DEFAULT_CODEX_TOOLS_CONFIG,
	normalizeCodexToolsConfig,
	type CodexToolsConfig,
} from "./config.ts";

export const CODEX_TOOLS_CONFIG_BASENAME = "pi-codex-tools.json";

export function getCodexToolsConfigPath(agentDir: string = getAgentDir()): string {
	return join(agentDir, CODEX_TOOLS_CONFIG_BASENAME);
}

export function readCodexToolsConfig(configPath: string = getCodexToolsConfigPath()): CodexToolsConfig {
	if (!existsSync(configPath)) return structuredClone(DEFAULT_CODEX_TOOLS_CONFIG);
	try {
		return normalizeCodexToolsConfig(JSON.parse(readFileSync(configPath, "utf-8")));
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.warn(`[pi-codex-tools] Failed to read ${configPath}: ${message}`);
		return structuredClone(DEFAULT_CODEX_TOOLS_CONFIG);
	}
}

export function writeCodexToolsConfig(config: CodexToolsConfig, configPath: string = getCodexToolsConfigPath()): void {
	const dir = dirname(configPath);
	mkdirSync(dir, { recursive: true });
	const tmp = `${configPath}.${process.pid}.tmp`;
	try {
		writeFileSync(tmp, `${JSON.stringify(config, null, "\t")}\n`, "utf-8");
		renameSync(tmp, configPath);
	} catch (error) {
		try {
			rmSync(tmp, { force: true });
		} catch {
			// ignore cleanup failure
		}
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Failed to write ${configPath}: ${message}`, { cause: error });
	}
}
