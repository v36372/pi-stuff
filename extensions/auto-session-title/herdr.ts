import { createConnection } from "node:net";

const REQUEST_TIMEOUT_MS = 1_000;
const MAX_LABEL_CHARS = 80;
const METADATA_SOURCE = "auto-session-title";
const METADATA_AGENT = "pi";
const METADATA_APPLIES_TO_SOURCE = "herdr:pi";

export interface HerdrEnv {
	HERDR_ENV?: string;
	HERDR_SOCKET_PATH?: string;
	HERDR_PANE_ID?: string;
	HERDR_TAB_ID?: string;
}

export interface HerdrContext {
	socketPath: string;
	paneId: string;
	tabId: string;
}

export type HerdrTarget = "tab" | "pane";

export type HerdrRequest = (
	method: string,
	params: Record<string, unknown>,
	socketPath: string,
) => Promise<Record<string, unknown> | undefined>;

let metadataSeq = Date.now() * 1000;

function nextMetadataSeq(): number {
	metadataSeq += 1;
	return metadataSeq;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	return value as Record<string, unknown>;
}

export function herdrContextFromEnv(env: HerdrEnv = process.env): HerdrContext | undefined {
	if (env.HERDR_ENV !== "1") return undefined;
	const socketPath = env.HERDR_SOCKET_PATH?.trim();
	const paneId = env.HERDR_PANE_ID?.trim();
	const tabId = env.HERDR_TAB_ID?.trim();
	if (!socketPath || !paneId || !tabId) return undefined;
	return { socketPath, paneId, tabId };
}

export function normalizeHerdrLabel(title: string): string | undefined {
	const label = title.replace(/\s+/g, " ").trim().slice(0, MAX_LABEL_CHARS).trim();
	return label || undefined;
}

export function chooseHerdrTarget(paneCount: number): HerdrTarget {
	return paneCount <= 1 ? "tab" : "pane";
}

function socketEndpoint(socketPath: string): string {
	return process.platform === "win32" ? `\\\\.\\pipe\\${socketPath}` : socketPath;
}

export function herdrRequest(
	method: string,
	params: Record<string, unknown>,
	socketPath: string,
): Promise<Record<string, unknown> | undefined> {
	return new Promise((resolve) => {
		let done = false;
		let buffer = "";
		const finish = (result?: Record<string, unknown>) => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			socket.destroy();
			resolve(result);
		};

		const socket = createConnection(socketEndpoint(socketPath));
		socket.on("error", () => finish());
		socket.on("connect", () => {
			const id = `auto-session-title:${Date.now()}:${Math.random().toString(36).slice(2)}`;
			socket.write(`${JSON.stringify({ id, method, params })}\n`);
		});
		socket.on("data", (chunk) => {
			buffer += chunk.toString();
			const newline = buffer.indexOf("\n");
			if (newline < 0) return;
			try {
				const response = JSON.parse(buffer.slice(0, newline));
				finish(asRecord(response?.result));
			} catch {
				finish();
			}
		});
		socket.on("end", () => finish());
		const timer = setTimeout(() => finish(), REQUEST_TIMEOUT_MS);
		timer.unref?.();
	});
}

function readPaneCount(result: Record<string, unknown> | undefined): number {
	const tab = asRecord(result?.tab);
	const count = tab?.pane_count;
	return typeof count === "number" && Number.isFinite(count) && count > 0 ? count : 1;
}

async function syncLayoutLabel(
	label: string,
	context: HerdrContext,
	request: HerdrRequest,
): Promise<HerdrTarget | undefined> {
	const tabInfo = await request("tab.get", { tab_id: context.tabId }, context.socketPath);
	const target = chooseHerdrTarget(readPaneCount(tabInfo));
	if (target === "tab") {
		await request("tab.rename", { tab_id: context.tabId, label }, context.socketPath);
	} else {
		await request("pane.rename", { pane_id: context.paneId, label }, context.socketPath);
	}
	return target;
}

/**
 * Sidebar presentation for the recommended Herdr layout:
 *
 *   [ui.sidebar.agents]
 *   rows = [
 *     ["state_icon", { token = "agent", bold = true }],
 *     ["$kind"],
 *   ]
 *
 * - `display_agent` fills the highlighted primary `agent` token with the session title
 * - token `kind` keeps the underlying agent kind ("pi") on the next line
 */
async function syncSidebarDisplay(
	label: string,
	context: HerdrContext,
	request: HerdrRequest,
): Promise<boolean> {
	await request("pane.report_metadata", {
		pane_id: context.paneId,
		source: METADATA_SOURCE,
		agent: METADATA_AGENT,
		applies_to_source: METADATA_APPLIES_TO_SOURCE,
		display_agent: label,
		title: label,
		tokens: { kind: METADATA_AGENT },
		seq: nextMetadataSeq(),
	}, context.socketPath);
	return true;
}

/**
 * Apply a Pi session title to Herdr UI:
 * - sole pane in the tab → rename the tab
 * - multiple panes → rename this pane
 * - always → Agents sidebar session title + kind token
 *
 * Best-effort: never throws; returns the layout target written, or undefined
 * when Herdr is unavailable / layout rename fails. Sidebar updates are independent.
 */
export async function syncTitleToHerdr(
	title: string,
	options: {
		env?: HerdrEnv;
		request?: HerdrRequest;
	} = {},
): Promise<HerdrTarget | undefined> {
	const label = normalizeHerdrLabel(title);
	const context = herdrContextFromEnv(options.env ?? process.env);
	if (!label || !context) return undefined;

	const request = options.request ?? herdrRequest;
	const sidebar = syncSidebarDisplay(label, context, request).catch(() => false);
	let target: HerdrTarget | undefined;
	try {
		target = await syncLayoutLabel(label, context, request);
	} catch {
		target = undefined;
	}
	await sidebar;
	return target;
}
