/**
 * Message timestamps extension.
 *
 * Appends a minimal HH:MM timestamp entry right after each user and assistant
 * message in the chat transcript. The timestamp entries do not participate in
 * LLM context, so they do not affect the model.
 *
 * Install:
 *   cp message-timestamps.ts ~/.pi/agent/extensions/
 *   # then restart pi, or run /reload inside pi
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { Component, Theme } from "@earendil-works/pi-tui";

interface TimestampData {
	ts: string; // ISO timestamp of the message this entry belongs to
}

/** Right-aligned timestamp component. */
class TimestampLabel implements Component {
	private text: string;
	private colorFn: (s: string) => string;

	constructor(text: string, colorFn: (s: string) => string) {
		this.text = text;
		this.colorFn = colorFn;
	}

	render(width: number): string[] {
		const styled = this.colorFn(this.text);
		const pad = Math.max(0, width - visibleWidth(styled));
		return [" ".repeat(pad) + styled];
	}

	invalidate(): void {}
}

export default function (pi: ExtensionAPI) {
	// Track session entry IDs we've already stamped so we never append a
	// duplicate in the same process.
	const seen = new Set<string>();

	// Render the timestamp entry as a right-aligned dim line.
	pi.registerEntryRenderer("message-timestamp", (entry, _options, theme: Theme) => {
		const data = entry.data as TimestampData | undefined;
		const ts = data?.ts ?? entry.timestamp;
		const time = new Date(ts).toLocaleTimeString([], {
			hour: "2-digit",
			minute: "2-digit",
		});
		return new TimestampLabel(time, (s) => theme.fg("dim", s));
	});

	// After each user or assistant message is finalized, append a timestamp entry.
	// message_end is emitted *before* the message is persisted, so we defer the
	// append until the next tick so the timestamp entry lands after the message.
	pi.on("message_end", async (event, ctx) => {
		if (event.message.role !== "user" && event.message.role !== "assistant") {
			return;
		}

		setTimeout(() => {
			const leaf = ctx.sessionManager.getLeafEntry();
			if (!leaf || leaf.type !== "message") {
				return;
			}
			if (seen.has(leaf.id)) {
				return;
			}
			seen.add(leaf.id);

			pi.appendEntry("message-timestamp", { ts: leaf.timestamp });
		}, 0);
	});
}
