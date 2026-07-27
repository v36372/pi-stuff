/**
 * Auto Session Name
 *
 * Vendored from @samfp/pi-essentials (MIT):
 * https://github.com/samfoy/pi-essentials/blob/master/src/auto-session-name.ts
 *
 * Names the Pi session from the first user message (raw truncate).
 * Surfaces in /resume, default footer, and anything reading getSessionName().
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const MAX_NAME_CHARS = 60;

export default function (pi: ExtensionAPI) {
	let named = false;

	pi.on("session_start", async () => {
		named = !!pi.getSessionName();
	});

	pi.on("agent_end", async (event) => {
		if (named) return;

		const userMsg = event.messages.find((m) => m.role === "user");
		if (!userMsg) return;

		const text =
			typeof userMsg.content === "string"
				? userMsg.content
				: userMsg.content
						.filter((b) => b.type === "text")
						.map((b) => (b as { text: string }).text)
						.join(" ");
		if (!text) return;

		const name = text.slice(0, MAX_NAME_CHARS).replace(/\n/g, " ").trim();
		if (!name) return;

		pi.setSessionName(name);
		named = true;
	});
}
