import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import workingTimer, { formatWorkingMessage, loadWorkingTimerConfig, normalizeWorkingTimerConfig, workingTimerConfigPath } from "./index";

const testTheme = {
	fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
};
const stripTestStyles = (text: string | undefined) => text?.replace(/\x1b\[39m|<\/?(?:accent|dim)>/g, "") ?? "";

const realSetInterval = globalThis.setInterval;
const realClearInterval = globalThis.clearInterval;
const originalAgentDirectory = process.env.PI_CODING_AGENT_DIR;
let agentDirectory: string;

beforeEach(() => {
	agentDirectory = mkdtempSync(join(tmpdir(), "pi-working-timer-test-"));
	process.env.PI_CODING_AGENT_DIR = agentDirectory;
});

afterEach(() => {
	globalThis.setInterval = realSetInterval;
	globalThis.clearInterval = realClearInterval;
	if (originalAgentDirectory === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = originalAgentDirectory;
	rmSync(agentDirectory, { recursive: true, force: true });
});

test("reads spinner config from the configured Pi agent directory", () => {
	writeFileSync(join(agentDirectory, "working-timer.json"), JSON.stringify({ spinner: "rail-3" }));

	expect(workingTimerConfigPath()).toBe(join(agentDirectory, "working-timer.json"));
	expect(loadWorkingTimerConfig()).toEqual({ spinner: "rail-3" });
});

test("normalizes spinner config with native as the safe default", () => {
	expect(normalizeWorkingTimerConfig(undefined)).toEqual({ spinner: "native" });
	expect(normalizeWorkingTimerConfig({ spinner: "rail-3" })).toEqual({ spinner: "rail-3" });
	expect(normalizeWorkingTimerConfig({ spinner: "rail-3-eased" })).toEqual({ spinner: "rail-3-eased" });
	expect(normalizeWorkingTimerConfig({ spinner: "wat" })).toEqual({ spinner: "native" });
});

test("leaves an existing custom indicator alone when using the native spinner", () => {
	const handlers = new Map<string, (...args: any[]) => any>();
	workingTimer({ on: (name: string, handler: any) => handlers.set(name, handler) } as any, {
		loadConfig: () => ({ spinner: "native" }),
	});
	const indicators: any[] = [];
	const ctx = {
		mode: "tui",
		ui: {
			theme: testTheme,
			setWorkingIndicator: (indicator?: any) => indicators.push(indicator),
			setWorkingMessage() {},
		},
	};

	handlers.get("session_start")?.({}, ctx);
	handlers.get("session_shutdown")?.({}, ctx);
	expect(indicators).toEqual([]);
});

test("can use the optional eased rail spinner", () => {
	const handlers = new Map<string, (...args: any[]) => any>();
	workingTimer({ on: (name: string, handler: any) => handlers.set(name, handler) } as any, {
		loadConfig: () => ({ spinner: "rail-3-eased" }),
	});
	const indicators: any[] = [];
	const ctx = {
		mode: "tui",
		ui: {
			theme: testTheme,
			setWorkingIndicator: (indicator?: any) => indicators.push(indicator),
			setWorkingMessage() {},
		},
	};

	handlers.get("session_start")?.({}, ctx);
	expect(indicators[0]).toEqual({
		frames: [
			"<dim>[</dim><accent>•</accent><dim>·</dim><dim>·</dim><dim>]</dim>",
			"<dim>[</dim><accent>•</accent><dim>·</dim><dim>·</dim><dim>]</dim>",
			"<dim>[</dim><dim>·</dim><accent>•</accent><dim>·</dim><dim>]</dim>",
			"<dim>[</dim><dim>·</dim><dim>·</dim><accent>•</accent><dim>]</dim>",
			"<dim>[</dim><dim>·</dim><dim>·</dim><accent>•</accent><dim>]</dim>",
			"<dim>[</dim><dim>·</dim><accent>•</accent><dim>·</dim><dim>]</dim>",
		],
		intervalMs: 260,
	});

	handlers.get("session_shutdown")?.({}, ctx);
	expect(indicators[1]).toBeUndefined();
});

test("keeps a whimsical phrase stable across the run and restores the message when settled", () => {
	const handlers = new Map<string, (...args: any[]) => any>();
	const intervalTicks: Array<() => void> = [];
	let picks = 0;
	globalThis.setInterval = ((callback: () => void, ms?: number) => {
		expect(ms).toBe(1_000);
		intervalTicks.push(callback);
		return { unref() {} } as any;
	}) as any;
	globalThis.clearInterval = (() => {}) as any;

	workingTimer({ on: (name: string, handler: any) => handlers.set(name, handler) } as any, {
		pickMessage: () => {
			picks += 1;
			return picks === 1 ? "Noodling..." : "Should not appear";
		},
	});
	const messages: Array<string | undefined> = [];
	const ctx = {
		mode: "tui",
		ui: {
			theme: testTheme,
			setWorkingMessage: (message?: string) => messages.push(message),
		},
	};

	handlers.get("agent_start")?.({}, ctx);
	expect(stripTestStyles(messages.at(-1))).toStartWith("Noodling... (0s");
	for (let i = 0; i < 6; i++) intervalTicks[0]?.();
	expect(stripTestStyles(messages.at(-1))).toStartWith("Noodling... (0s");

	// Retries / continuations keep the same phrase and timer anchor.
	handlers.get("agent_start")?.({}, ctx);
	expect(picks).toBe(1);
	expect(stripTestStyles(messages.at(-1))).toStartWith("Noodling... (0s");

	handlers.get("agent_settled")?.({}, ctx);
	expect(messages.at(-1)).toBeUndefined();

	handlers.get("agent_start")?.({}, ctx);
	expect(picks).toBe(2);
	expect(stripTestStyles(messages.at(-1))).toStartWith("Should not appear (0s");
});

test("formats working messages with stable visible text and interrupt hints", () => {
	expect(formatWorkingMessage("Noodling...", 65_000, "escape")).toBe("Noodling... (1m 05s • escape to interrupt)");
	expect(formatWorkingMessage("Pontificating...", 3_723_000, undefined)).toBe("Pontificating... (1h 02m 03s)");
});

test("keeps phrase text stable and dims the elapsed suffix", () => {
	const first = formatWorkingMessage("Noodling...", 65_000, "escape", testTheme);
	const next = formatWorkingMessage("Noodling...", 65_000, "escape", 8, testTheme);

	expect(stripTestStyles(first)).toBe("Noodling... (1m 05s • escape to interrupt)");
	expect(first).toContain("<dim>(1m 05s • escape to interrupt)</dim>");
	expect(next).toBe(first);
});
