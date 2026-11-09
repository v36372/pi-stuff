import { execFile } from "node:child_process";
import { createHash } from "node:crypto";

export type Note = { id: string; from: string; text: string };
export type CoreCall = <T>(method: string, params: Record<string, unknown>, signal?: AbortSignal) => Promise<T>;
const MAX_TEXT = 4000;
export const MAX_BATCH_BYTES = 16 * 1024;

export class CoreError extends Error {
	constructor(readonly kind: string, message: string) { super(message); }
}

/** hc owns endpoint discovery, including HC_SESSION and Windows named pipes. No PTY input is used. */
export const coreCall: CoreCall = <T>(method: string, params: Record<string, unknown>, signal?: AbortSignal) => new Promise<T>((resolve, reject) => {
	const child = execFile("hc", ["connect"], { timeout: 5000, maxBuffer: 2 * 1024 * 1024, signal }, (error, stdout, stderr) => {
		if (error) { reject(new Error(`hc connect: ${stderr.trim() || error.message}`)); return; }
		try {
			const response = JSON.parse(stdout.trim());
			if (response.error) throw new CoreError(response.error.data?.kind ?? "rpc_error", response.error.message);
			if (response.id !== 1 || !("result" in response)) throw new Error("Invalid hc response");
			resolve(response.result as T);
		} catch (error) { reject(error); }
	});
	child.stdin?.on("error", reject);
	child.stdin?.end(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })}\n`);
});

export function mailboxName(sessionId: string): string {
	return `notes-${createHash("sha256").update(sessionId).digest("hex").slice(0, 20)}`;
}

function parseNotes(value: unknown): Note[] {
	if (value === null) return [];
	if (!Array.isArray(value) || !value.every((note) => note && typeof note.id === "string" && note.id.length > 0 && note.id.length <= 128
		&& typeof note.from === "string" && (note.from === "external" || /^t[0-9a-z]+$/.test(note.from))
		&& typeof note.text === "string" && note.text.trim().length > 0 && note.text.length <= MAX_TEXT)) {
		throw new Error("Invalid herdr-notes mailbox; refusing to overwrite it");
	}
	return value;
}

export async function readNotes(call: CoreCall, name: string, signal?: AbortSignal): Promise<Note[]> {
	const doc = await call<{ value: unknown; version: number }>("doc.get", { name }, signal);
	return parseNotes(doc.value);
}

export async function acknowledge(call: CoreCall, name: string, persisted: ReadonlySet<string>, signal?: AbortSignal) {
	for (let attempt = 0; attempt < 8; attempt++) {
		const doc = await call<{ value: unknown; version: number }>("doc.get", { name }, signal);
		const notes = parseNotes(doc.value);
		const value = notes.filter(({ id }) => !persisted.has(id));
		if (value.length === notes.length) return;
		try {
			await call("doc.set", { name, value: value.length ? value : null, version: doc.version }, signal);
			return;
		} catch (error) {
			if (!(error instanceof CoreError) || error.kind !== "conflict") throw error;
		}
	}
	throw new Error("Note mailbox kept changing; retry the operation.");
}
