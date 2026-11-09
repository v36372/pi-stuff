import { expect, test } from "bun:test";
import notesExtension from "./index";
import { acknowledge, CoreError, mailboxName, readNotes, type CoreCall, type Note } from "./core";

function memoryCore() {
	const docs = new Map<string, { value: unknown; version: number }>();
	const labels: Record<string, string> = {};
	const calls: string[] = [];
	const queue = (name: string, note: Note) => {
		const previous = docs.get(name) ?? { value: [], version: 0 };
		docs.set(name, { value: [...(previous.value as Note[] ?? []), note], version: previous.version + 1 });
	};
	let racingNote: Note | undefined;
	const call: CoreCall = async <T>(method: string, params: any): Promise<T> => {
		calls.push(method);
		if (method === "terminal.get") return { labels } as T;
		if (method === "terminal.label") {
			for (const [key, value] of Object.entries(params.labels)) {
				if (value) labels[key] = value as string;
				else delete labels[key];
			}
			return { labels } as T;
		}
		if (method === "doc.get") return structuredClone(docs.get(params.name) ?? { value: null, version: 0 }) as T;
		if (method === "doc.set") {
			if (racingNote) { queue(params.name, racingNote); racingNote = undefined; }
			const current = docs.get(params.name)?.version ?? 0;
			if (current !== params.version) throw new CoreError("conflict", "Changed meanwhile");
			docs.set(params.name, { value: structuredClone(params.value), version: current + 1 });
			return { version: current + 1 } as T;
		}
		throw new Error(`Unexpected method ${method}`);
	};
	return { call, calls, docs, labels, queue, raceNextAck: (note: Note) => { racingNote = note; } };
}

function note(id: string, text = "A useful fact"): Note {
	return { id, from: "t2", text };
}

function harness(core = memoryCore(), entries: any[] = [], session = "recipient") {
	const handlers = new Map<string, (event: any, ctx: any) => any>();
	let renderer: any;
	const ctx = { sessionManager: { getSessionId: () => session, getBranch: () => entries } };
	notesExtension({
		on: (name: string, handler: any) => handlers.set(name, handler),
		registerMessageRenderer: (_name: string, value: any) => { renderer = value; },
		registerTool: () => { throw new Error("Sending belongs to hc note, not a Pi tool"); },
		registerCommand: () => { throw new Error("Sending belongs to hc note, not a Pi command"); },
		sendMessage: () => { throw new Error("Must not send messages"); },
		sendUserMessage: () => { throw new Error("Must not start runs"); },
	} as any, core.call, "t1");
	return { core, entries, handlers, get renderer() { return renderer; }, emit: (name: string) => handlers.get(name)?.({}, ctx) };
}

test("receiver advertises a neutral mailbox without registering sender tools or commands", async () => {
	const h = harness();
	await h.emit("session_start");
	expect(h.core.labels["note-mailbox"]).toBe(mailboxName("recipient"));
	expect(h.core.calls).toEqual(["terminal.label"]);
});

test("idle recipients stay untouched; next input proposes context before acknowledging persistence", async () => {
	const h = harness();
	await h.emit("session_start");
	const name = mailboxName("recipient");
	h.core.queue(name, note("one"));
	expect(h.entries).toHaveLength(0);
	const { message } = await h.emit("before_agent_start");
	expect(message.content).toContain("Note from t2: A useful fact");
	expect(message.display).toBe(true);
	await h.emit("agent_settled");
	expect(await readNotes(h.core.call, name)).toHaveLength(1);
	h.entries.push({ type: "custom_message", ...message });
	await h.emit("agent_settled");
	expect(await readNotes(h.core.call, name)).toHaveLength(0);
	expect(await h.emit("before_agent_start")).toBeUndefined();
	expect(h.handlers.has("context")).toBe(false);
	expect(h.handlers.has("turn_end")).toBe(false);
});

test("reload after persistence but before acknowledgement does not redeliver", async () => {
	const core = memoryCore();
	const first = harness(core);
	await first.emit("session_start");
	core.queue(mailboxName("recipient"), note("one"));
	const { message } = await first.emit("before_agent_start");
	const reloaded = harness(core, [{ type: "custom_message", ...message }]);
	await reloaded.emit("session_start");
	expect(await reloaded.emit("before_agent_start")).toBeUndefined();
	expect(await readNotes(core.call, mailboxName("recipient"))).toHaveLength(0);
});

test("a concurrent hc note is preserved when an acknowledgement retries", async () => {
	const core = memoryCore();
	core.queue("inbox", note("read"));
	core.raceNextAck(note("new"));
	await acknowledge(core.call, "inbox", new Set(["read"]));
	expect((await readNotes(core.call, "inbox")).map(({ id }) => id)).toEqual(["new"]);
});

test("rejects malformed mailboxes and accepts notes from external CLI callers", async () => {
	const h = harness();
	await h.emit("session_start");
	const name = mailboxName("recipient");
	h.core.docs.set(name, { value: { unexpected: true }, version: 1 });
	await expect(h.emit("before_agent_start")).rejects.toThrow("Invalid");
	h.core.docs.set(name, { value: [{ id: "one", from: "external", text: "A human's note" }], version: 2 });
	expect((await h.emit("before_agent_start")).message.content).toContain("Note from external: A human's note");
});

test("batches context without losing excess notes or consuming another session's mailbox", async () => {
	const h = harness();
	await h.emit("session_start");
	const name = mailboxName("recipient");
	for (let i = 0; i < 8; i++) h.core.queue(name, note(String(i), "x".repeat(4000)));
	const { message } = await h.emit("before_agent_start");
	expect(Buffer.byteLength(message.content)).toBeLessThanOrEqual(16 * 1024);
	expect(message.details.notes.length).toBeGreaterThan(0);
	expect(message.details.notes.length).toBeLessThan(8);
	h.entries.push({ type: "custom_message", ...message });
	await h.emit("agent_settled");
	expect(await readNotes(h.core.call, name)).toHaveLength(8 - message.details.notes.length);
	const other = harness(h.core, [], "new-session");
	await other.emit("session_start");
	expect(await other.emit("before_agent_start")).toBeUndefined();
});

test("shutdown clears only this session's advertisement; outside Core the adapter is inactive", async () => {
	const h = harness();
	await h.emit("session_start");
	await h.emit("session_shutdown");
	expect(h.core.labels).not.toHaveProperty("note-mailbox");
	await h.emit("session_start");
	h.core.labels["note-mailbox"] = mailboxName("replacement");
	await h.emit("session_shutdown");
	expect(h.core.labels["note-mailbox"]).toBe(mailboxName("replacement"));
	notesExtension({ on: () => { throw new Error("Must be inactive"); } } as any, h.core.call, "");
});

test("collapsed and expanded note renderers are stable and strip terminal controls", async () => {
	const h = harness();
	const theme = { fg: (_color: string, text: string) => text };
	const message = { content: "fallback", details: { notes: [note("one", "Safe\x1b[31m text\x07\nsecond line")] } };
	const collapsed = h.renderer(message, { expanded: false, outputPad: 0 }, theme);
	expect(collapsed.render(100).join("\n")).toContain("Note from t2");
	expect(collapsed.render(100).join("\n")).not.toContain("second line");
	const expanded = h.renderer(message, { expanded: true, outputPad: 0 }, theme);
	const output = expanded.render(100);
	expect(output.join("\n")).toContain("second line");
	expect(output.join("\n")).not.toContain("\x07");
	expect(expanded.render(100)).toEqual(output);
});
