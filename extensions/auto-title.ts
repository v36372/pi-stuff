/**
 * Auto Title
 *
 * Vendored from @samfp/pi-essentials (MIT):
 * https://github.com/samfoy/pi-essentials/blob/master/src/auto-title.ts
 *
 * Sets the terminal title from the first user input of an unnamed session.
 * No-ops in headless mode (`pi -p`).
 *
 * When running inside Herdr (HERDR_ENV=1 + HERDR_PANE_ID), also renames:
 * - the current pane label (`herdr pane rename`) — visible on split borders only
 * - the current tab label (`herdr tab rename`) when this is the only pane in the tab
 *   (single-pane tabs have no border, so pane labels are invisible there)
 * - the current agent name (`herdr agent rename`)
 *
 * Refreshes on `agent_end` if `pi.getSessionName()` changed (e.g. by
 * auto-session-name, `/name`, or other extensions).
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { basename } from "node:path";

/** Pane/tab labels are freeform; Herdr caps presentation text around 80 chars. */
const MAX_LABEL_CHARS = 80;
/** Agent names: [a-z][a-z0-9_-]{0,31} */
const MAX_AGENT_NAME_CHARS = 32;

function truncate(text: string, max: number): string {
	const clean = text.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
	return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

/** Map free text to a valid unique-ish Herdr agent name. */
function toAgentName(label: string): string | undefined {
	let slug = label
		.toLowerCase()
		.replace(/[^a-z0-9_-]+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-+|-+$/g, "");
	if (!slug) return undefined;
	if (!/^[a-z]/.test(slug)) slug = `a-${slug}`;
	slug = slug.slice(0, MAX_AGENT_NAME_CHARS).replace(/-+$/g, "");
	if (!/^[a-z][a-z0-9_-]{0,31}$/.test(slug)) return undefined;
	return slug;
}

export default function (pi: ExtensionAPI) {
	let titled = false;
	let lastLabel: string | undefined;

	const herdrEnabled = process.env.HERDR_ENV === "1";
	const paneId = process.env.HERDR_PANE_ID;
	const tabIdEnv = process.env.HERDR_TAB_ID;

	async function herdrJson(args: string[]): Promise<any | undefined> {
		try {
			const result = await pi.exec("herdr", args);
			if (result.code !== 0) {
				console.debug("[auto-title] herdr failed", args.join(" "), result.stderr || result.stdout);
				return undefined;
			}
			const text = (result.stdout || "").trim();
			if (!text) return undefined;
			return JSON.parse(text);
		} catch (error) {
			console.debug("[auto-title] herdr error", args.join(" "), error);
			return undefined;
		}
	}

	async function resolveTabId(): Promise<string | undefined> {
		if (tabIdEnv) return tabIdEnv;
		if (!paneId) return undefined;
		const response = await herdrJson(["pane", "get", paneId]);
		return response?.result?.pane?.tab_id;
	}

	/** Pane border labels only render when the tab is split. */
	async function isSinglePaneTab(tabId: string): Promise<boolean> {
		const response = await herdrJson(["tab", "get", tabId]);
		const count = response?.result?.tab?.pane_count;
		return typeof count === "number" ? count <= 1 : true;
	}

	async function applyLabel(label: string, cwd: string, ctx: ExtensionContext) {
		const folder = basename(cwd) || cwd;
		const paneTitle = `π - ${folder} - ${label}`;
		ctx.ui.setTitle(paneTitle);
		lastLabel = label;

		if (!herdrEnabled || !paneId) return;

		const displayLabel = truncate(label, MAX_LABEL_CHARS);

		// Pane border title (only visible when the tab has multiple panes).
		await herdrJson(["pane", "rename", paneId, displayLabel]);

		// Tab bar title — the only always-visible chrome for single-pane tabs.
		const tabId = await resolveTabId();
		if (tabId && (await isSinglePaneTab(tabId))) {
			await herdrJson(["tab", "rename", tabId, displayLabel]);
		}

		const agentName = toAgentName(label);
		if (!agentName) return;
		// Target by pane id so this works even when the agent is still unnamed.
		await herdrJson(["agent", "rename", paneId, agentName]);
	}

	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		titled = !!pi.getSessionName();
		lastLabel = undefined;
	});

	pi.on("input", async (event, ctx) => {
		if (!ctx.hasUI) return { action: "continue" as const };
		if (!event.text?.trim()) return { action: "continue" as const };

		if (!titled && !pi.getSessionName()) {
			// Claim before await so concurrent inputs don't double-paint.
			titled = true;
			const label = truncate(event.text, 40);
			await applyLabel(label, ctx.cwd, ctx);
		}
		return { action: "continue" as const };
	});

	pi.on("agent_end", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		const name = pi.getSessionName();
		if (name && name !== lastLabel) {
			await applyLabel(name, ctx.cwd, ctx);
		}
	});
}
