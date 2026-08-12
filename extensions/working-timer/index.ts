/**
 * working-timer — whimsical phrase + elapsed timer on Pi's working row.
 *
 * Picks one phrase from `whimsical.ts` at the start of a user-visible run and
 * keeps it stable while the dimmed elapsed/interrupt suffix ticks. The timer
 * remains anchored across retries, automatic compaction, and queued
 * continuations, then resets only after agent_settled. Pi's retry and
 * compaction loaders keep their native messages; the elapsed time resumes when
 * the normal working row returns.
 */
import {
	getAgentDir,
	keyText,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pickWhimsicalMessage } from "../whimsical.ts";

const UPDATE_INTERVAL_MS = 1_000;
const RAIL_3_INTERVAL_MS = 300;
const RAIL_3_POSITIONS = [0, 1, 2, 1] as const;
const RAIL_3_EASED_INTERVAL_MS = 260;
const RAIL_3_EASED_POSITIONS = [0, 0, 1, 2, 2, 1] as const;
const NORMAL_FG = "\x1b[39m";

export type SpinnerStyle = "native" | "rail-3" | "rail-3-eased";

export interface WorkingTimerConfig {
	spinner: SpinnerStyle;
}

interface RuntimeDependencies {
	loadConfig?: () => WorkingTimerConfig;
	pickMessage?: () => string;
}

type ThemeColor = "accent" | "dim";
type WorkingMessageTheme = {
	fg(color: ThemeColor, text: string): string;
};

export function workingTimerConfigPath(): string {
	return join(getAgentDir(), "working-timer.json");
}

export function normalizeWorkingTimerConfig(value: unknown): WorkingTimerConfig {
	if (!value || typeof value !== "object") return { spinner: "native" };
	const spinner = (value as Record<string, unknown>).spinner;
	if (spinner === "rail-3" || spinner === "rail-3-eased" || spinner === "native") return { spinner };
	return { spinner: "native" };
}

export function loadWorkingTimerConfig(path = workingTimerConfigPath()): WorkingTimerConfig {
	try {
		return normalizeWorkingTimerConfig(JSON.parse(readFileSync(path, "utf8")));
	} catch {
		return { spinner: "native" };
	}
}

function formatElapsed(elapsedMs: number): string {
	const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1_000));
	const hours = Math.floor(totalSeconds / 3_600);
	const minutes = Math.floor((totalSeconds % 3_600) / 60);
	const seconds = totalSeconds % 60;

	if (hours > 0) {
		return `${hours}h ${String(minutes).padStart(2, "0")}m ${String(seconds).padStart(2, "0")}s`;
	}
	if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
	return `${seconds}s`;
}

function formatRailFrame(activeIndex: number, theme: WorkingMessageTheme): string {
	const cells = [0, 1, 2]
		.map((index) => theme.fg(index === activeIndex ? "accent" : "dim", index === activeIndex ? "•" : "·"))
		.join("");
	return `${theme.fg("dim", "[")}${cells}${theme.fg("dim", "]")}`;
}

function formatRailFrames(positions: readonly number[], theme: WorkingMessageTheme): string[] {
	return positions.map((position) => formatRailFrame(position, theme));
}

function indicatorForStyle(style: SpinnerStyle, theme: WorkingMessageTheme): { frames: string[]; intervalMs: number } | undefined {
	switch (style) {
		case "rail-3":
			return { frames: formatRailFrames(RAIL_3_POSITIONS, theme), intervalMs: RAIL_3_INTERVAL_MS };
		case "rail-3-eased":
			return { frames: formatRailFrames(RAIL_3_EASED_POSITIONS, theme), intervalMs: RAIL_3_EASED_INTERVAL_MS };
		case "native":
			return undefined;
	}
}

export function formatWorkingMessage(
	label: string,
	elapsedMs: number,
	interruptKey: string | undefined,
	frameOrTheme?: number | WorkingMessageTheme,
	maybeTheme?: WorkingMessageTheme,
): string {
	const interruptHint = interruptKey ? ` • ${interruptKey} to interrupt` : "";
	const theme = typeof frameOrTheme === "number" ? maybeTheme : frameOrTheme;
	const header = theme ? `${NORMAL_FG}${label}` : label;
	const suffix = `(${formatElapsed(elapsedMs)}${interruptHint})`;
	return `${header} ${theme ? theme.fg("dim", suffix) : suffix}`;
}

export default function workingTimer(pi: ExtensionAPI, deps: RuntimeDependencies = {}) {
	let startedAt: number | undefined;
	let timer: ReturnType<typeof setInterval> | undefined;
	let label = "";
	let renderCtx: ExtensionContext | undefined;
	let interruptKey: string | undefined;

	const loadConfig = () => deps.loadConfig?.() ?? loadWorkingTimerConfig();
	const pickMessage = () => deps.pickMessage?.() ?? pickWhimsicalMessage();
	let installedCustomIndicator = false;

	const installIndicator = (ctx: ExtensionContext) => {
		if (ctx.mode !== "tui") return;
		const indicator = indicatorForStyle(loadConfig().spinner, ctx.ui.theme);
		// Leave an existing custom indicator (e.g. RunCat) alone when using native.
		if (!indicator) return;
		installedCustomIndicator = true;
		ctx.ui.setWorkingIndicator(indicator);
	};

	const render = (ctx = renderCtx) => {
		if (ctx?.mode !== "tui" || startedAt === undefined) return;
		renderCtx = ctx;
		ctx.ui.setWorkingMessage(formatWorkingMessage(label, Date.now() - startedAt, interruptKey, ctx.ui.theme));
	};

	const stop = (ctx?: ExtensionContext) => {
		if (timer) {
			clearInterval(timer);
			timer = undefined;
		}
		startedAt = undefined;
		renderCtx = undefined;
		if (ctx?.mode === "tui") ctx.ui.setWorkingMessage();
	};

	pi.on("session_start", (_event, ctx) => installIndicator(ctx));

	pi.on("agent_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;

		interruptKey = keyText("app.interrupt") || undefined;

		// Preserve the first start across retries, compaction, and automatic
		// continuations so this measures the complete user-visible run.
		if (startedAt === undefined) {
			startedAt = Date.now();
			label = pickMessage();
		}
		render(ctx);
		if (timer) return;

		timer = setInterval(() => render(), UPDATE_INTERVAL_MS);
		timer.unref?.();
	});

	pi.on("agent_settled", (_event, ctx) => stop(ctx));
	pi.on("session_shutdown", (_event, ctx) => {
		stop(ctx);
		if (ctx.mode === "tui" && installedCustomIndicator) {
			installedCustomIndicator = false;
			ctx.ui.setWorkingIndicator();
		}
	});
}
