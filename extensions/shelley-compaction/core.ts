// Portions adapted from Shelley, Copyright 2026 Bold Software, Inc.
// https://github.com/boldsoftware/shelley/tree/2925edc4d57f033a298b783843e448371c252d6b
// Licensed under Apache-2.0: https://www.apache.org/licenses/LICENSE-2.0
// Translated Go algorithm and prompts to TypeScript; adapted storage, message
// envelopes, IDs, lifecycle, and original-message retrieval to Pi's extension API.
// Source: server/compact_in_place.go, server/inplace_compaction.go,
// server/context_estimate.go, server/idle_compaction.go, server/idle_nudge_prompt.txt,
// db/inplace_compaction.go, and claudetool/compact_in_place.go.
import type { Message, ToolCall, Usage } from "@earendil-works/pi-ai";

export const TOOL = "compact_in_place";
export const RECORD = "shelley.compaction";
export const NUDGE = "shelley.context-nudge";
export const KEEP_RECENT = 20_000;
export const MAX_COLLAPSE = 20_000;
export const NUDGE_AT = 200_000;
export const NUDGE_STEP = 50_000;
export const IDLE_MIN_TOKENS = 50_000;
export type ConversationMessage = Exclude<Message, { role: "system" }>;
export interface Item {
  from: string;
  to: string;
  id: string;
  message: ConversationMessage;
  note?: string;
  alone: boolean;
  nudge?: boolean;
}
export interface Input {
  action: "index" | "compact";
  trim?: string[];
  collapse?: { from: string; to: string; note: string }[];
}
export interface Compaction {
  trims: { entryId: string; toolUseId: string }[];
  squishes: { from: string; to: string; summary: string }[];
  hiddenEntryIds: string[];
  hiddenToolUseIds: string[];
}
export const retryGuidance = "Nothing was compacted; fix only the reported problems and send the whole request again. Preserve existing notes verbatim unless a note itself is invalid or a corrected range changes what it must summarize. Do not shorten notes to fix IDs or ranges.";
export const indexGuidance = `Look for dead ends, out-of-date tool outputs (superseded file reads, old
build and test logs), side quests and finished subprojects. Collapse each into
a short note that keeps what still matters: decisions, findings, paths,
commands, ids. Write readable sentences or bullets with normal whitespace.
Keep words, numbers, and units clearly separated. Shorten by dropping obsolete
details, not by removing spaces or joining words.
Trim tool outputs you no longer need. Big tool inputs and
outputs are most of the context, so focus there. Compacting only a little is
fine; when unsure, leave it. Originals stay retrievable by session_id and
entry_id with read_compacted.

Then call compact_in_place with action "compact": trim lists ids of rows whose
tool outputs you no longer need; collapse lists {from, to, note} ranges of ids
from the table. A range may not cover more than ~20k tokens unless it is a
single row. Rows marked * are messages from the user or the parent and notes
and summaries from earlier compactions: they carry the task and its rules, so a
range may not cover one unless it is just that row.`;

const bytes = (s: string) => Buffer.byteLength(s, "utf8");
const blocks = (m: ConversationMessage) => typeof m.content === "string" ? [{ type: "text" as const, text: m.content }] : m.content;
export const calls = (it: Item): ToolCall[] => it.message.role === "assistant" ? it.message.content.filter((b): b is ToolCall => b.type === "toolCall") : [];
const isOutput = (it: Item) => it.message.role === "toolResult";
const hasCalls = (it: Item) => calls(it).length > 0;

// Shelley counts Go string bytes, not JavaScript UTF-16 code units.
export function estimateTokens(message: ConversationMessage): number {
  let chars = 0, images = 0;
  for (const c of blocks(message)) {
    switch (c.type) {
      case "text": chars += bytes(c.text); break;
      case "thinking": chars += bytes(c.thinking); break;
      case "image": images++; break;
      case "toolCall": chars += bytes(c.name) + bytes(JSON.stringify(c.arguments)); break;
    }
  }
  return Math.ceil(chars / 4) + images * 1200;
}
export const itemTokens = (items: Item[]) => items.reduce((n, it) => n + estimateTokens(it.message), 0);
export const noteText = (session: string, from: string, to: string, summary: string) => `[Messages compacted: session_id ${session} entry_id ${from}-${to}. Summary:]\n${summary}`;
export const trimmedText = (session: string, id: string) => `[Tool output compacted: session_id ${session} entry_id ${id}]`;
function isTrimmed(it: Item): boolean {
  const c = blocks(it.message);
  return isOutput(it) && c.length === 1 && c[0].type === "text" && /^\[Tool output compacted: session_id \S+ entry_id \S+\]$/.test(c[0].text);
}

export function evidence(items: Item[]): Pick<Compaction, "hiddenEntryIds" | "hiddenToolUseIds"> {
  const results = new Set(items.flatMap(it => it.message.role === "toolResult" ? [it.message.toolCallId] : []));
  return {
    hiddenEntryIds: items.filter(it => it.nudge).map(it => it.from),
    hiddenToolUseIds: items.flatMap(calls).filter(c => c.name === TOOL && results.has(c.id)).map(c => c.id),
  };
}

export function hideItems(items: Item[], entryIds: string[], toolUseIds: string[]): Item[] {
  let out = items.slice();
  for (const id of entryIds) {
    const i = out.findIndex(it => it.note === undefined && it.from === id);
    if (i < 0) throw new Error(`hide: no message with entry id ${id} in context`);
    out.splice(i, 1);
  }
  for (const id of toolUseIds) {
    let found = 0;
    out = out.flatMap(it => {
      const m = it.message;
      if (m.role === "toolResult" && m.toolCallId === id) { found++; return []; }
      if (m.role !== "assistant" || !calls(it).some(c => c.id === id)) return [it];
      found++;
      const content = m.content.filter(c => c.type !== "toolCall" || c.id !== id);
      // Shelley drops an assistant message left without a tool call, including its text.
      return content.some(c => c.type === "toolCall") ? [{ ...it, message: { ...m, content } }] : [];
    });
    if (found !== 2) throw new Error(`hide: tool call ${id} and its result are not both in context`);
  }
  return out;
}

export function compactionView(history: Item[]): Item[] {
  const e = evidence(history);
  return hideItems(history, e.hiddenEntryIds, e.hiddenToolUseIds).flatMap(it => {
    const m = it.message;
    if (m.role !== "assistant" || !calls(it).some(c => c.name === TOOL)) return [it];
    const content = m.content.filter(c => c.type !== "toolCall" || c.name !== TOOL);
    return content.some(c => c.type === "toolCall") ? [{ ...it, message: { ...m, content } }] : [];
  });
}

export function recentStart(items: Item[], keep = KEEP_RECENT): number {
  const cuts = items.flatMap((it, i) => isOutput(it) ? [] : [i]);
  if (!cuts.length) return 0;
  let cut = cuts[0], accumulated = 0;
  for (let i = items.length - 1; i >= 0; i--) {
    accumulated += estimateTokens(items[i].message);
    if (accumulated >= keep) { cut = cuts.find(c => c >= i) ?? cuts[cuts.length - 1]; break; }
  }
  return cut;
}

export function splitRows(items: Item[], recent: number): { rows: Item[][]; recentRow: number } {
  const rows: Item[][] = [];
  const group = (part: Item[]) => {
    for (let i = 0; i < part.length; i++) {
      const row = [part[i]];
      // Pi persists one result per call; Shelley puts a parallel batch's results in one message.
      if (hasCalls(part[i])) while (i + 1 < part.length && isOutput(part[i + 1])) row.push(part[++i]);
      rows.push(row);
    }
  };
  group(items.slice(0, recent));
  const recentRow = rows.length;
  group(items.slice(recent));
  return { rows, recentRow };
}
const rowID = (row: Item[]) => row[0].id;
const orphanOutput = (row: Item[]) => isOutput(row[0]);
const orphanCall = (row: Item[]) => hasCalls(row[row.length - 1]);
const rowTrims = (row: Item[]) => row.flatMap(it => it.message.role === "toolResult" && !isTrimmed(it) ? [{ entryId: it.from, toolUseId: it.message.toolCallId }] : []);
function suggestRanges(rows: Item[][], alone: boolean[], i: number, j: number): string {
  const ranges: string[] = [];
  let start = -1;
  for (let k = i; k <= j + 1; k++) {
    if (k <= j && !alone[k]) { if (start < 0) start = k; }
    else if (start >= 0) {
      let end = k - 1;
      while (start <= end && orphanOutput(rows[start])) start++;
      while (start <= end && orphanCall(rows[end])) end--;
      if (start <= end) ranges.push(rowID(rows[start]) + (start < end ? `-${rowID(rows[end])}` : ""));
      start = -1;
    }
  }
  return ranges.join(", ");
}

export function buildCompaction(history: Item[], input: Input, keep = KEEP_RECENT): Compaction {
  const c: Compaction = { trims: [], squishes: [], hiddenEntryIds: [], hiddenToolUseIds: [] };
  if (!input.trim?.length && !input.collapse?.length) throw new Error("nothing to compact: give trim and/or collapse");
  const items = compactionView(history);
  const { rows, recentRow: recent } = splitRows(items, recentStart(items, keep));
  const alone = rows.map(row => row.length === 1 && row[0].alone);
  const problems: string[] = [], trimmed: number[] = [];
  const spans: { i: number; j: number }[] = [];
  const index = (id: string) => rows.findIndex(row => rowID(row) === id);
  for (const id of input.trim ?? []) {
    const r = index(id);
    let problem: string | undefined;
    if (r < 0) problem = "unknown id; use ids from the index";
    else if (r >= recent) problem = "in the recent part, which is kept as is";
    else if (trimmed.includes(r)) problem = "listed twice";
    else if (!rows[r].some(isOutput)) problem = "has no tool output";
    else if (!rowTrims(rows[r]).length) problem = "already trimmed";
    if (problem) problems.push(`trim ${id}: ${problem}`);
    else { trimmed.push(r); c.trims.push(...rowTrims(rows[r])); }
  }
  for (const col of input.collapse ?? []) {
    const i = index(col.from), j = index(col.to);
    const problem = (s: string) => problems.push(`collapse ${col.from}-${col.to}: ${s}`);
    if (i < 0 || j < 0) { problem("unknown id; use ids from the index"); continue; }
    if (j < i) { problem("from comes after to"); continue; }
    if (j >= recent) { problem(`reaches into the recent part (from ${rowID(rows[recent])} on), which is kept as is`); continue; }
    if (orphanOutput(rows[i])) { problem(`${rowID(rows[i])} is a tool output without its call; start the range after it`); continue; }
    if (orphanCall(rows[j])) { problem(`${rowID(rows[j])} is a tool call without its output; end the range before it`); continue; }
    if (spans.some(s => i <= s.j && s.i <= j)) { problem("overlaps another collapse"); continue; }
    const k = alone.slice(i, j + 1).indexOf(true);
    if (k >= 0 && j > i) {
      const ranges = suggestRanges(rows, alone, i, j);
      problem(`covers ${rowID(rows[i + k])}, which can only be collapsed on its own; ${ranges ? `collapse e.g. ${ranges} instead` : "collapse each of those rows on its own"}`);
      continue;
    }
    spans.push({ i, j });
    const tokens = itemTokens(rows.slice(i, j + 1).flat());
    if (!col.note.trim()) { problem("note is empty"); continue; }
    if (tokens > MAX_COLLAPSE && j > i) { problem(`covers ~${tokens} tokens; at most ~${MAX_COLLAPSE} per collapse unless it is a single row, so split it`); continue; }
    if (Math.ceil(bytes(col.note) / 4) >= tokens) { problem(`note is not shorter than the ~${tokens} tokens it replaces`); continue; }
    c.squishes.push({ from: rows[i][0].from, to: rows[j][rows[j].length - 1].to, summary: col.note });
  }
  if (problems.length === 1) throw new Error(`${problems[0]}. ${retryGuidance}`);
  if (problems.length > 1) throw new Error(`${problems.length} problems:\n- ${problems.join("\n- ")}\n\n${retryGuidance}`);
  c.squishes.sort((a, b) => items.findIndex(it => it.from === a.from) - items.findIndex(it => it.from === b.from));
  return c;
}

export function applyCompaction(items: Item[], c: Compaction, session: string, recordId: string): Item[] {
  let out = items.slice();
  for (const t of c.trims) {
    const i = out.findIndex(it => it.note === undefined && it.from === t.entryId);
    if (i < 0) throw new Error(`trim: no message with entry id ${t.entryId} in context`);
    const m = out[i].message;
    if (m.role !== "toolResult" || m.toolCallId !== t.toolUseId) throw new Error(`trim: message ${t.entryId} has no tool result for ${t.toolUseId}`);
    out[i] = { ...out[i], message: { ...m, content: [{ type: "text", text: trimmedText(session, t.entryId) }] } };
  }
  for (const [n, s] of c.squishes.entries()) {
    const i = out.findIndex(it => it.from === s.from), j = out.findIndex(it => it.to === s.to);
    if (i < 0 || j < i) throw new Error(`squish: range ${s.from}-${s.to} does not align with messages in context`);
    if (isOutput(out[i])) throw new Error(`squish: range ${s.from}-${s.to} starts with a tool result whose tool use precedes it`);
    if (hasCalls(out[j])) throw new Error(`squish: range ${s.from}-${s.to} ends with a tool use whose result follows it`);
    out.splice(i, j - i + 1, {
      from: s.from, to: s.to, id: `s${recordId}.${n}`, note: s.summary, alone: true,
      message: { role: "user", content: [{ type: "text", text: noteText(session, s.from, s.to, s.summary) }], timestamp: out[i].message.timestamp },
    });
  }
  return hideItems(out, c.hiddenEntryIds, c.hiddenToolUseIds);
}

export function prepareRecord(history: Item[], input: Input, session: string, keep = KEEP_RECENT): Compaction {
  const c = buildCompaction(history, input, keep);
  Object.assign(c, evidence(applyCompaction(history, c, session, "preview")));
  applyCompaction(history, c, session, "preview");
  return c;
}

function quoteStart(s: string): string {
  const runes = Array.from(s.trim().replace(/\s+/gu, " "));
  return `"${runes.slice(0, 60).join("")}${runes.length > 60 ? "…" : ""}"`;
}
function readableInput(input: Record<string, unknown>): string {
  return Object.entries(input).flatMap(([k, v]) => typeof v === "string" ? (v ? [v] : []) : typeof v === "number" || typeof v === "boolean" ? [`${k}=${v}`] : []).join(" ");
}
function describeRow(row: Item[], names: Map<string, string>): string {
  if (row[0].note !== undefined) return `note ${quoteStart(row[0].note)}`;
  const outputs = new Map(row.flatMap(it => it.message.role === "toolResult" ? [[it.message.toolCallId, isTrimmed(it) ? "→ trimmed" : `→ ${estimateTokens(it.message)}`] as const] : []));
  const called = new Set<string>(), parts: string[] = [];
  for (const it of row) {
    if (it.message.role === "toolResult") {
      if (!called.has(it.message.toolCallId)) parts.push(`${names.get(it.message.toolCallId) ?? "tool"} output ${outputs.get(it.message.toolCallId)}`);
      continue;
    }
    for (const c of blocks(it.message)) {
      switch (c.type) {
        case "text": parts.push(`text ${quoteStart(c.text)}`); break;
        case "image": parts.push("image"); break;
        case "thinking": parts.push("thinking"); break;
        case "toolCall": {
          names.set(c.id, c.name); called.add(c.id);
          const input = readableInput(c.arguments);
          parts.push(`${c.name}${input ? ` ${quoteStart(input)}` : ""} ${outputs.get(c.id) ?? "→ no output"}`);
          break;
        }
      }
    }
  }
  return parts.join(", ");
}
export function compactIndex(history: Item[], keep = KEEP_RECENT): string {
  const items = compactionView(history), recent = recentStart(items, keep);
  let result = `## Index\n\n${items.length} messages, ~${itemTokens(items)} tokens.\n`;
  if (!recent) return result + "All of it is recent, so nothing can be compacted yet.\n";
  result += `The recent part, from ${items[recent].id} on (${items.length - recent} messages, ~${itemTokens(items.slice(recent))} tokens), is kept as is and not listed.\n\n${indexGuidance}\n\n`;
  result += "One row per message, oldest first, except that a tool call and its outputs\nshare a row. id is the entry_id (of the call, for a shared row), or s<n>.<i>\nfor a note from an earlier compaction. tokens are estimated; `→ N` gives the\ntokens of a call's output, or says it is trimmed or missing.\n\n```\n";
  const { rows, recentRow } = splitRows(items, recent), names = new Map<string, string>();
  const table = [["id", "role", "tokens", "content"], ...rows.slice(0, recentRow).map(row => [
    rowID(row), (row[0].note !== undefined ? "note" : row[0].message.role === "assistant" ? "assistant" : "user") + (row.length === 1 && row[0].alone ? "*" : ""),
    String(itemTokens(row)), describeRow(row, names),
  ])];
  const widths = [0, 1, 2].map(i => Math.max(...table.map(row => row[i].length)));
  return result + table.map(row => row.map((s, i) => i < 3 ? s.padEnd(widths[i] + 2) : s).join("")).join("\n") + "\n```\n";
}

export function contextTokens(u: Usage): number { return u.input + u.output + u.cacheRead + u.cacheWrite; }
export class ContextNudger {
  level: number;
  tokens: number;
  readonly at: number;
  constructor(at = NUDGE_AT, tokens = 0) { this.at = at; this.tokens = tokens; this.level = this.levelOf(tokens); }
  private levelOf(n: number) { return n < this.at ? -1 : Math.floor((n - this.at) / NUDGE_STEP); }
  observe(u: Usage) { const n = contextTokens(u); if (n) this.tokens = n; }
  take(): string | undefined {
    const level = this.levelOf(this.tokens), due = level > this.level;
    this.level = level;
    return due ? `Context is ${Math.floor((this.tokens + 5000) / 10000) * 10}k.` : undefined;
  }
}
