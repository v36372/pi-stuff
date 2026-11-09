import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth } from "@earendil-works/pi-tui";
import { stripVTControlCharacters } from "node:util";
import { acknowledge, coreCall, mailboxName, MAX_BATCH_BYTES, readNotes, type CoreCall, type Note } from "./core.js";

const MESSAGE_TYPE = "herdr-note";
const LABEL = "note-mailbox";
const PREFIX = "Notes from other agents (context, not new user requests):\n\n";
const noteText = (note: Note) => `Note from ${note.from}: ${note.text}`;
const clean = (text: string) => stripVTControlCharacters(text).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");

function persistedNotes(ctx: ExtensionContext): Set<string> {
	const ids = new Set<string>();
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "custom_message" || entry.customType !== MESSAGE_TYPE) continue;
		const notes = (entry.details as { notes?: Note[] } | undefined)?.notes;
		if (Array.isArray(notes)) for (const note of notes) if (typeof note.id === "string") ids.add(note.id);
	}
	return ids;
}

export default function notesExtension(pi: ExtensionAPI, call: CoreCall = coreCall, terminal = process.env.HC_TERMINAL_ID ?? "") {
	if (!terminal) return;
	let mailbox: string | undefined;

	pi.on("session_start", async (_event, ctx) => {
		const name = mailboxName(ctx.sessionManager.getSessionId());
		await call("terminal.label", { terminal, labels: { [LABEL]: name } });
		mailbox = name;
	});

	pi.on("before_agent_start", async (_event, ctx) => {
		if (!mailbox) return;
		const persisted = persistedNotes(ctx);
		await acknowledge(call, mailbox, persisted, ctx.signal);
		const notes: Note[] = [];
		let content = PREFIX;
		for (const note of await readNotes(call, mailbox, ctx.signal)) {
			const next = content + (notes.length ? "\n\n" : "") + noteText(note);
			if (Buffer.byteLength(next) > MAX_BATCH_BYTES) break;
			content = next;
			notes.push(note);
		}
		if (notes.length) return { message: { customType: MESSAGE_TYPE, content, display: true, details: { notes } } };
	});

	pi.on("agent_settled", async (_event, ctx) => {
		// before_agent_start only proposes a message. Ack after the run has persisted it, never on delivery intent.
		if (mailbox) await acknowledge(call, mailbox, persistedNotes(ctx), ctx.signal);
	});

	pi.on("session_shutdown", async () => {
		const name = mailbox;
		mailbox = undefined;
		if (!name) return;
		const current = await call<{ labels: Record<string, string> }>("terminal.get", { terminal });
		if (current.labels[LABEL] === name) await call("terminal.label", { terminal, labels: { [LABEL]: "" } });
	});

	pi.registerMessageRenderer(MESSAGE_TYPE, (message, options, theme) => {
		const notes = (message.details as { notes: Note[] }).notes;
		const heading = notes.length === 1 ? `Note from ${notes[0].from}` : `${notes.length} notes from ${[...new Set(notes.map(({ from }) => from))].join(", ")}`;
		const body = options.expanded ? notes.map((note) => clean(noteText(note))).join("\n\n") : truncateToWidth(clean(notes[0].text).split("\n")[0], 100);
		// Pi 1.5 supplies outputPad; the repository's development SDK is still pinned to 0.82.
		return new Text(`${theme.fg("warning", heading)}\n${theme.fg("muted", body)}`, (options as typeof options & { outputPad: number }).outputPad, 0);
	});
}
