/**
 * Powerbar — Standalone status bar for Pi
 *
 * Renders a persistent powerline-style widget with left/right segments.
 * Other extensions can emit `powerbar:update` to add segments.
 */

import { type ExtensionAPI, type ExtensionContext, type Theme, type ThemeColor } from "@mariozechner/pi-coding-agent";
import type { Component, TUI } from "@mariozechner/pi-tui";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import type { RateWindow, SubCoreAllState, SubCoreState, UsageSnapshot } from "@marckrenn/pi-sub-shared";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

// ─── Hardcoded defaults (no settings dependency) ───

const ROWS = [
	{
		left: ["cwd", "git-branch", "session-name"],
		right: ["provider", "model", "multi-pass-pool"],
	},
	{
		left: ["tokens", "context-usage"],
		right: ["sub-hourly", "sub-weekly"],
	},
] as const;
const SEPARATOR = " │ ";
const PLACEMENT: "aboveEditor" | "belowEditor" = "belowEditor";

// ─── Types ───

interface Segment {
	id: string;
	text: string;
	suffix?: string;
	icon?: string;
	color?: string;
}

interface PowerbarUpdatePayload {
	id: string;
	text?: string;
	suffix?: string;
	icon?: string;
	color?: string;
}

interface SegmentRegistration {
	id: string;
	label: string;
}

// ─── Rendering ───

function renderSegmentText(segment: Segment, theme: Theme): string {
	const parts: string[] = [];
	const themeColor = (segment.color || "muted") as ThemeColor;

	if (segment.icon) {
		parts.push(theme.fg(themeColor, segment.icon));
	}
	if (segment.text) {
		parts.push(theme.fg(themeColor, segment.text));
	}
	if (segment.suffix) {
		parts.push(theme.fg(themeColor, segment.suffix));
	}

	return parts.join(" ");
}

interface RenderedSegment {
	text: string;
	width: number;
}

function renderSideSegments(ids: string[], segments: Map<string, Segment>, theme: Theme): RenderedSegment[] {
	const rendered: RenderedSegment[] = [];
	for (const id of ids) {
		const seg = segments.get(id);
		if (!seg || (!seg.text && !seg.suffix && !seg.icon)) continue;
		const text = renderSegmentText(seg, theme);
		rendered.push({ text, width: visibleWidth(text) });
	}
	return rendered;
}

function joinSegments(segments: RenderedSegment[], separator: string, separatorWidth: number): RenderedSegment {
	if (segments.length === 0) return { text: "", width: 0 };
	const text = segments.map((s) => s.text).join(separator);
	const width = segments.reduce((sum, s) => sum + s.width, 0) + separatorWidth * (segments.length - 1);
	return { text, width };
}

function shrinkWidest(segments: RenderedSegment[], overflow: number): void {
	if (segments.length === 0) return;
	let widestIdx = 0;
	for (let i = 1; i < segments.length; i++) {
		if (segments[i].width > segments[widestIdx].width) {
			widestIdx = i;
		}
	}
	const seg = segments[widestIdx];
	const targetWidth = Math.max(1, seg.width - overflow);
	segments[widestIdx] = {
		text: truncateToWidth(seg.text, targetWidth, "…"),
		width: targetWidth,
	};
}

function padRight(segment: RenderedSegment, width: number): RenderedSegment {
	const padding = Math.max(0, width - segment.width);
	return { text: segment.text + " ".repeat(padding), width: segment.width + padding };
}

function columnWidths(rows: RenderedSegment[][]): number[] {
	const widths: number[] = [];
	for (const row of rows) {
		for (let i = 0; i < row.length; i++) {
			widths[i] = Math.max(widths[i] ?? 0, row[i].width);
		}
	}
	return widths;
}

function joinAlignedSegments(segments: RenderedSegment[], widths: number[], separator: string, separatorWidth: number): RenderedSegment {
	const padded = segments.map((segment, index) => (index < segments.length - 1 ? padRight(segment, widths[index] ?? segment.width) : segment));
	return joinSegments(padded, separator, separatorWidth);
}

function renderBars(segments: Map<string, Segment>, theme: Theme, width: number): string[] {
	const separator = theme.fg("dim", SEPARATOR);
	const separatorWidth = visibleWidth(separator);
	const minPadding = 1;
	const rows = ROWS.map((row) => ({
		left: renderSideSegments([...row.left], segments, theme),
		right: renderSideSegments([...row.right], segments, theme),
	}));
	const leftWidths = columnWidths(rows.map((row) => row.left));
	const rightWidths = columnWidths(rows.map((row) => row.right));
	const maxRightWidth = Math.max(
		0,
		...rows.map((row) => joinAlignedSegments(row.right, rightWidths, separator, separatorWidth).width),
	);

	return rows.map((row) => {
		const allSegs = [...row.left, ...row.right];
		const leftSepCount = Math.max(0, row.left.length - 1);
		const rightSepCount = Math.max(0, row.right.length - 1);
		const totalSepWidth = (leftSepCount + rightSepCount) * separatorWidth;
		let left = joinAlignedSegments(row.left, leftWidths, separator, separatorWidth);
		let right = joinAlignedSegments(row.right, rightWidths, separator, separatorWidth);
		let totalNeeded = left.width + Math.max(right.width, maxRightWidth) + minPadding;

		if (totalNeeded > width) {
			let overflow = totalNeeded - width;
			const maxPasses = allSegs.length;
			for (let i = 0; i < maxPasses && overflow > 0; i++) {
				shrinkWidest(allSegs, overflow);
				const newSegWidth = allSegs.reduce((sum, s) => sum + s.width, 0);
				overflow = newSegWidth + totalSepWidth + minPadding - width;
			}
			left = joinSegments(allSegs.slice(0, row.left.length), separator, separatorWidth);
			right = joinSegments(allSegs.slice(row.left.length), separator, separatorWidth);
			totalNeeded = left.width + right.width + minPadding;
		}

		const rightOffset = Math.max(0, maxRightWidth - right.width);
		const padding = Math.max(minPadding, width - left.width - right.width - rightOffset);
		const line = `${left.text}${" ".repeat(padding)}${right.text}${" ".repeat(rightOffset)}`;

		return truncateToWidth(line, width, "…");
	});
}

// ─── Segment helpers ───

function emitUpdate(pi: ExtensionAPI, payload: PowerbarUpdatePayload): void {
	pi.events.emit("powerbar:update", payload);
}

function emitRemove(pi: ExtensionAPI, id: string): void {
	pi.events.emit("powerbar:update", { id, text: undefined });
}

// ─── Git segment ───

function getGitBranch(cwd: string): string | undefined {
	try {
		const head = readFileSync(join(cwd, ".git", "HEAD"), "utf-8").trim();
		if (head.startsWith("ref: refs/heads/")) {
			return head.slice(16);
		}
		return head.slice(0, 8);
	} catch {
		return undefined;
	}
}

function emitGitBranch(pi: ExtensionAPI, ctx: ExtensionContext): void {
	const branch = getGitBranch(ctx.cwd);
	if (branch) {
		emitUpdate(pi, { id: "git-branch", text: branch, icon: "⎇", color: "muted" });
	} else {
		emitRemove(pi, "git-branch");
	}
}

// ─── CWD segment ───

function formatCwd(cwd: string): string {
	const home = homedir();
	if (cwd === home) return "~";
	if (cwd.startsWith(`${home}/`)) {
		const relative = cwd.slice(home.length + 1);
		const parts = relative.split("/").filter(Boolean);
		if (parts.length <= 2) return `~/${relative}`;
		return `~/…/${parts.slice(-2).join("/")}`;
	}
	const dir = basename(cwd);
	return dir || cwd;
}

function emitCwd(pi: ExtensionAPI, ctx: ExtensionContext): void {
	emitUpdate(pi, { id: "cwd", text: formatCwd(ctx.cwd), icon: "⌂", color: "muted" });
}

// ─── Session name segment ───

function emitSessionName(pi: ExtensionAPI, ctx: ExtensionContext): void {
	const name = pi.getSessionName() ?? ctx.sessionManager.getSessionName();
	if (name) {
		emitUpdate(pi, { id: "session-name", text: name, icon: "◈", color: "dim" });
	} else {
		emitRemove(pi, "session-name");
	}
}

// ─── Tokens segment ───

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
	if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
	return `${Math.round(count / 1_000_000)}M`;
}

function emitTokens(pi: ExtensionAPI, ctx: ExtensionContext): void {
	const entries = ctx.sessionManager.getEntries();
	let totalInput = 0;
	let totalOutput = 0;
	let totalCost = 0;

	for (const entry of entries) {
		if (entry.type === "message" && entry.message.role === "assistant") {
			totalInput += entry.message.usage.input;
			totalOutput += entry.message.usage.output;
			totalCost += entry.message.usage.cost.total;
		}
	}

	if (totalInput === 0 && totalOutput === 0) return;

	const parts: string[] = [];
	parts.push(`↑${formatTokens(totalInput)}`);
	parts.push(`↓${formatTokens(totalOutput)}`);
	if (totalCost > 0) {
		parts.push(`$${totalCost.toFixed(2)}`);
	}

	emitUpdate(pi, { id: "tokens", text: parts.join(" "), color: "dim" });
}

// ─── Context segment ───

function contextColor(pct: number): string {
	if (pct > 80) return "error";
	if (pct > 60) return "warning";
	return "muted";
}

function formatCompactNumber(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1_000_000).toFixed(1)}M`;
}

function emitContextUsage(pi: ExtensionAPI, ctx: ExtensionContext): void {
	const usage = ctx.getContextUsage();
	if (usage && usage.tokens != null) {
		const pct = (usage.tokens / usage.contextWindow) * 100;
		const pctText = pct.toFixed(1);
		const contextWindow = formatCompactNumber(usage.contextWindow);
		emitUpdate(pi, {
			id: "context-usage",
			text: "",
			suffix: `${pctText}%/${contextWindow}`,
			color: contextColor(pct),
		});
	}
}

// ─── Provider segment ───

function emitProvider(pi: ExtensionAPI, ctx: ExtensionContext): void {
	const model = ctx.model;
	if (!model) return;
	emitUpdate(pi, { id: "provider", text: model.provider, color: "dim" });
}

// ─── Model segment ───

function emitModel(pi: ExtensionAPI, ctx: ExtensionContext): void {
	const model = ctx.model;
	if (!model) return;

	let text = model.id;
	if (model.reasoning) {
		const level = pi.getThinkingLevel();
		text = level === "off" ? `${model.id} · off` : `${model.id} · ${level}`;
	}

	emitUpdate(pi, { id: "model", text, color: "dim" });
}

// ─── Multi-pass pool segment ───

interface MultiPassSubscription {
	provider: string;
	index: number;
	label?: string;
}

interface MultiPassPool {
	name: string;
	baseProvider: string;
	members: string[];
	enabled?: boolean;
	strategy?: "round-robin" | "quota-first" | "scheduled" | "custom";
}

interface MultiPassConfig {
	subscriptions?: MultiPassSubscription[];
	pools?: MultiPassPool[];
	allowedSubs?: string[];
}

function readJsonFile<T>(path: string): T | undefined {
	try {
		return JSON.parse(readFileSync(path, "utf-8")) as T;
	} catch {
		return undefined;
	}
}

function multiPassGlobalConfigPath(): string {
	return join(homedir(), ".pi", "agent", "multi-pass.json");
}

function multiPassProjectConfigPath(cwd: string): string {
	return join(cwd, ".pi", "multi-pass.json");
}

function subProviderName(entry: MultiPassSubscription): string {
	return `${entry.provider}-${entry.index}`;
}

function strategyAbbrev(strategy: MultiPassPool["strategy"]): string {
	switch (strategy) {
		case "quota-first":
			return "qf";
		case "scheduled":
			return "sched";
		case "custom":
			return "custom";
		default:
			return "rr";
	}
}

function findSubscriptionLabel(providerName: string, subscriptions: MultiPassSubscription[]): string | undefined {
	const sub = subscriptions.find((entry) => subProviderName(entry) === providerName);
	return sub?.label;
}

function getMultiPassPools(cwd: string): { pools: MultiPassPool[]; subscriptions: MultiPassSubscription[] } {
	const globalConfig = readJsonFile<MultiPassConfig>(multiPassGlobalConfigPath()) ?? {};
	const projectConfig = readJsonFile<MultiPassConfig>(multiPassProjectConfigPath(cwd));
	const subscriptions = Array.isArray(globalConfig.subscriptions) ? globalConfig.subscriptions : [];
	let pools = Array.isArray(projectConfig?.pools)
		? projectConfig.pools
		: Array.isArray(globalConfig.pools)
			? globalConfig.pools
			: [];

	const allowed = projectConfig?.allowedSubs?.filter(Boolean);
	if (allowed && allowed.length > 0) {
		const allowedSet = new Set(allowed);
		pools = pools
			.map((pool) => ({ ...pool, members: pool.members.filter((member) => allowedSet.has(member)) }))
			.filter((pool) => pool.members.length > 0);
	}

	return { pools, subscriptions };
}

function emitMultiPassPool(pi: ExtensionAPI, ctx: ExtensionContext): void {
	const provider = ctx.model?.provider;
	if (!provider) {
		emitRemove(pi, "multi-pass-pool");
		return;
	}

	const { pools, subscriptions } = getMultiPassPools(ctx.cwd);
	const pool = pools.find((candidate) => candidate.enabled !== false && candidate.members.includes(provider));
	if (!pool) {
		emitRemove(pi, "multi-pass-pool");
		return;
	}

	const index = pool.members.indexOf(provider);
	const label = findSubscriptionLabel(provider, subscriptions);
	const member = label ? ` ${label}` : "";
	const text = `${pool.name}${member} ${index + 1}/${pool.members.length} ${strategyAbbrev(pool.strategy)}`;
	emitUpdate(pi, { id: "multi-pass-pool", text, icon: "◌", color: "dim" });
}

// ─── Sub usage helpers ───

function subColor(pct: number): string {
	if (pct > 80) return "error";
	if (pct > 60) return "warning";
	return "muted";
}

function emitSubWindow(pi: ExtensionAPI, segmentId: string, window: RateWindow | undefined): void {
	if (!window) {
		emitRemove(pi, segmentId);
		return;
	}
	const pct = Math.round(window.usedPercent);
	const label = window.label || "";
	const reset = window.resetDescription || "";
	const textParts: string[] = [];
	if (label) textParts.push(label);
	if (reset) textParts.push(reset);
	emitUpdate(pi, {
		id: segmentId,
		text: textParts.join(" "),
		suffix: `${pct}%`,
		color: subColor(pct),
	});
}

function emitSubUsage(pi: ExtensionAPI, usage: UsageSnapshot | undefined): void {
	if (!usage || usage.windows.length === 0) {
		emitRemove(pi, "sub-hourly");
		emitRemove(pi, "sub-weekly");
		return;
	}
	emitSubWindow(pi, "sub-hourly", usage.windows[0]);
	emitSubWindow(pi, "sub-weekly", usage.windows[1]);
}

// ─── Main extension ───

export default function createExtension(pi: ExtensionAPI): void {
	const segments: Map<string, Segment> = new Map();
	let currentCtx: ExtensionContext | undefined;
	let modelState: string | undefined;
	let modelStateTimer: ReturnType<typeof setInterval> | undefined;

	function refresh(): void {
		if (!currentCtx?.hasUI) return;
		currentCtx.ui.setWidget(
			"powerbar",
			(_tui: TUI, theme: Theme): Component & { dispose?(): void } => {
				return {
					render(width: number): string[] {
						return renderBars(segments, theme, width);
					},
					invalidate(): void {},
				};
			},
			{ placement: PLACEMENT },
		);
	}

	// Listen for external segment updates
	pi.events.on("powerbar:update", (data: unknown) => {
		const payload = data as PowerbarUpdatePayload;
		if (!payload?.id) return;

		if (!payload.text && !payload.suffix && !payload.icon) {
			segments.delete(payload.id);
		} else {
			segments.set(payload.id, {
				id: payload.id,
				text: payload.text ?? "",
				suffix: payload.suffix,
				icon: payload.icon,
				color: payload.color,
			});
		}
		refresh();
	});

	// Listen for external segment registrations
	pi.events.on("powerbar:register-segment", (data: unknown) => {
		const { id, label } = data as SegmentRegistration;
		// Catalog is kept for potential future use; segments hardcoded for now
		void id;
		void label;
	});

	function hideFooter(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		ctx.ui.setFooter((_tui, _theme, _footerData) => ({
			render(): string[] {
				return [];
			},
			invalidate(): void {},
		}));
	}

	function getModelState(ctx: ExtensionContext): string {
		const model = ctx.model;
		return `${model?.provider ?? ""}:${model?.id ?? ""}:${pi.getThinkingLevel()}`;
	}

	function syncModelState(ctx: ExtensionContext): void {
		const nextState = getModelState(ctx);
		if (nextState === modelState) return;
		modelState = nextState;
		emitProvider(pi, ctx);
		emitModel(pi, ctx);
		emitMultiPassPool(pi, ctx);
	}

	function startModelStateWatcher(ctx: ExtensionContext): void {
		if (modelStateTimer) clearInterval(modelStateTimer);
		modelState = undefined;
		syncModelState(ctx);
		modelStateTimer = setInterval(() => {
			if (currentCtx) syncModelState(currentCtx);
		}, 250);
	}

	pi.on("session_start", async (_event, ctx) => {
		currentCtx = ctx;
		hideFooter(ctx);
		startModelStateWatcher(ctx);
		refresh();
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		if (modelStateTimer) {
			clearInterval(modelStateTimer);
			modelStateTimer = undefined;
		}
		modelState = undefined;
		if (ctx.hasUI) {
			ctx.ui.setWidget("powerbar", undefined);
		}
		currentCtx = undefined;
	});

	// ─── CWD events ───
	pi.on("session_start", async (_event, ctx) => emitCwd(pi, ctx));
	pi.on("turn_start", async (_event, ctx) => emitCwd(pi, ctx));
	pi.on("tool_result", async (_event, ctx) => emitCwd(pi, ctx));

	// ─── Git branch events ───
	pi.on("session_start", async (_event, ctx) => emitGitBranch(pi, ctx));
	pi.on("tool_result", async (event, ctx) => {
		if (event.toolName === "bash") emitGitBranch(pi, ctx);
	});

	// ─── Session name events ───
	pi.on("session_start", async (_event, ctx) => emitSessionName(pi, ctx));
	pi.on("turn_start", async (_event, ctx) => emitSessionName(pi, ctx));
	pi.on("turn_end", async (_event, ctx) => emitSessionName(pi, ctx));
	pi.on("tool_result", async (_event, ctx) => emitSessionName(pi, ctx));

	// ─── Tokens events ───
	pi.on("session_start", async () => emitRemove(pi, "tokens"));
	pi.on("tool_result", async (_event, ctx) => emitTokens(pi, ctx));
	pi.on("turn_end", async (_event, ctx) => emitTokens(pi, ctx));

	// ─── Context usage events ───
	pi.on("session_start", async () => emitRemove(pi, "context-usage"));
	pi.on("turn_start", async (_event, ctx) => emitContextUsage(pi, ctx));
	pi.on("tool_result", async (_event, ctx) => emitContextUsage(pi, ctx));
	pi.on("turn_end", async (_event, ctx) => emitContextUsage(pi, ctx));

	// ─── Provider events ───
	pi.on("session_start", async (_event, ctx) => emitProvider(pi, ctx));
	pi.on("model_select", async (_event, ctx) => emitProvider(pi, ctx));
	pi.on("turn_start", async (_event, ctx) => emitProvider(pi, ctx));

	// ─── Model events ───
	pi.on("session_start", async (_event, ctx) => emitModel(pi, ctx));
	pi.on("model_select", async (_event, ctx) => emitModel(pi, ctx));
	pi.on("turn_start", async (_event, ctx) => emitModel(pi, ctx));

	// ─── Multi-pass pool events ───
	pi.on("session_start", async (_event, ctx) => emitMultiPassPool(pi, ctx));
	pi.on("model_select", async (_event, ctx) => emitMultiPassPool(pi, ctx));
	pi.on("turn_start", async (_event, ctx) => emitMultiPassPool(pi, ctx));
	pi.on("tool_result", async (_event, ctx) => emitMultiPassPool(pi, ctx));

	// ─── Sub usage events ───
	pi.events.on("sub-core:ready", (payload: unknown) => {
		const data = payload as { state?: SubCoreState };
		emitSubUsage(pi, data.state?.usage);
	});
	pi.events.on("sub-core:update-current", (payload: unknown) => {
		const data = payload as { state?: SubCoreState };
		emitSubUsage(pi, data.state?.usage);
	});
	pi.events.on("sub-core:update-all", (payload: unknown) => {
		const data = payload as { state?: SubCoreAllState };
		const currentProvider = data.state?.provider;
		const entry = currentProvider
			? data.state?.entries?.find((e) => e.provider === currentProvider)
			: data.state?.entries?.[0];
		emitSubUsage(pi, entry?.usage);
	});
}
