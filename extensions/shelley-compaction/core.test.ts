// Behavioral cases ported from Shelley's compact_in_place_test.go and context_estimate_test.go.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  TOOL, applyCompaction, buildCompaction, compactIndex, compactionView,
  ContextNudger, estimateTokens, hideItems, itemTokens, prepareRecord,
  recentStart, retryGuidance, trimmedText, type Item, type Compaction,
} from "./core.ts";

const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const assistant = (content: any[]) => ({ role: "assistant" as const, content, timestamp: 0, api: "test", provider: "test", model: "test", stopReason: "stop" as const, usage });
const txt = (id: string, text: string, role: "user" | "assistant" = "user"): Item => ({ id, from: id, to: id, alone: role === "user", message: role === "user" ? { role, content: text, timestamp: 0 } : assistant([{ type: "text", text }]) });
const call = (id: string, toolId: string, name = "bash", args = {}): Item => ({ id, from: id, to: id, alone: false, message: assistant([{ type: "toolCall", id: toolId, name, arguments: args }]) });
const result = (id: string, toolId: string, text: string): Item => ({ id, from: id, to: id, alone: false, message: { role: "toolResult", toolCallId: toolId, toolName: "bash", content: [{ type: "text", text }], isError: false, timestamp: 0 } });
const big = "x".repeat(4 * 15_000);
const collapse = (from: string, to = from, note = "n") => ({ from, to, note });
const empty = (): Compaction => ({ trims: [], squishes: [], hiddenEntryIds: [], hiddenToolUseIds: [] });

test("Shelley recent cut: all recent, huge final output, and UTF-8 estimates", () => {
  assert.equal(recentStart([txt("1", "short"), txt("2", "also short")]), 0);
  const history = [txt("1", "do it"), call("2", "a"), result("3", "a", big), call("4", "b"), result("5", "b", big), txt("6", "done", "assistant"), txt("7", big + big)];
  assert.equal(history[recentStart(history)].id, "7");
  const huge = [...history.slice(0, 6), call("7", "d"), result("8", "d", "x".repeat(100_000))];
  assert.equal(huge[recentStart(huge)].id, "7");
  assert.equal(estimateTokens(txt("1", "🙂🙂").message), 2);
  assert.equal(estimateTokens({ role: "user", content: [{ type: "image", data: "huge-base64", mimeType: "image/png" }], timestamp: 0 }), 1200);
});

test("Shelley validation table, singleton exceptions, and chronological ordering", () => {
  const h = [txt("1", "do it"), call("2", "a"), result("3", "a", "x".repeat(100_000)), txt("4", big, "assistant"), txt("5", "aaaa", "assistant"), txt("6", "also this"), txt("7", "and that"), txt("8", "bbbbbbbb", "assistant"), txt("9", "cccccccc", "assistant"), txt("10", big + big, "assistant")];
  const cases: [any, RegExp][] = [
    [{}, /nothing to compact/],
    [{ collapse: [collapse("9", "10")] }, /recent part/],
    [{ collapse: [collapse("2", "4")] }, /at most/],
    [{ collapse: [collapse("8", "9"), collapse("9")] }, /overlaps/],
    [{ collapse: [collapse("8", "9", "  ")] }, /note is empty/],
    [{ collapse: [collapse("5", "8")] }, /covers 6.*collapse e.g. 5, 8 instead/],
    [{ collapse: [collapse("6", "7")] }, /collapse each of those rows on its own/],
    [{ collapse: [collapse("9", "8")] }, /from comes after/],
    [{ collapse: [collapse("8", "8", "far too much text for the source")] }, /note is not shorter/],
    [{ trim: ["2", "2"] }, /listed twice/],
  ];
  for (const [input, expected] of cases) assert.throws(() => buildCompaction(h, { action: "compact", ...input }), expected);
  const c = buildCompaction(h, { action: "compact", collapse: [collapse("8", "9"), collapse("2"), collapse("6"), collapse("1")] });
  assert.deepEqual(c.squishes.map(s => `${s.from}-${s.to}`), ["1-1", "2-3", "6-6", "8-9"]);
  assert.throws(() => buildCompaction(h, { action: "compact", trim: ["nope"], collapse: [collapse("99", "2"), collapse("2", "4")] }), error => {
    assert.match(String(error), /3 problems:/);
    assert.ok(String(error).endsWith(retryGuidance));
    return true;
  });
});

test("trim only older outputs; one Pi parallel batch shares a row", () => {
  const a = call("2", "a");
  if (a.message.role === "assistant") a.message.content.push({ type: "toolCall", id: "b", name: "bash", arguments: {} });
  const h = [txt("1", "do it"), a, result("3", "a", "old output a"), result("4", "b", "old output b"), call("5", "c"), result("6", "c", "new output")];
  const c = buildCompaction(h, { action: "compact", trim: ["2"] }, 1);
  assert.deepEqual(c.trims.map(t => t.entryId), ["3", "4"]);
  assert.throws(() => buildCompaction(h, { action: "compact", trim: ["3"] }, 1), /unknown id/);
  assert.throws(() => buildCompaction(h, { action: "compact", trim: ["5"] }, 1), /recent part/);
  assert.throws(() => buildCompaction(h, { action: "compact", trim: ["1"] }, 1), /has no tool output/);
  const applied = applyCompaction(h, c, "session", "record");
  assert.throws(() => buildCompaction(applied, { action: "compact", trim: ["2"] }, 1), /already trimmed/);
  assert.deepEqual(buildCompaction(h, { action: "compact", collapse: [collapse("2")] }, 1).squishes, [{ from: "2", to: "4", summary: "n" }]);
});

test("orphans cannot be range boundaries", () => {
  const h = [result("1", "missing", "orphan output"), txt("2", "completed task", "assistant"), call("3", "no-result"), txt("4", big + big)];
  assert.throws(() => buildCompaction(h, { action: "compact", collapse: [collapse("1", "2")] }), /without its call/);
  assert.throws(() => buildCompaction(h, { action: "compact", collapse: [collapse("2", "3")] }), /without its output/);
});

test("compacting does not move recent boundary, even alongside another call", () => {
  const h = [txt("1", "do it"), call("2", "a"), result("3", "a", big), txt("4", big + big), call("5", "b"), result("6", "b", "out")];
  const extra = [...h, { ...txt("7", big), nudge: true }, call("8", "index", TOOL), result("9", "index", big), call("10", "compact", TOOL, { huge: big })];
  assert.equal(compactionView(h)[recentStart(compactionView(h))].id, "4");
  assert.equal(compactionView(extra)[recentStart(compactionView(extra))].id, "4");
  const parallel = call("3", "a", "bash", { huge: big });
  if (parallel.message.role === "assistant") parallel.message.content.push({ type: "toolCall", id: "index", name: TOOL, arguments: {} });
  const running = [txt("1", "do it"), txt("2", "ok", "assistant"), parallel];
  const done = [...running, result("4", "a", "out"), result("5", "index", "index")];
  for (const view of [running, done].map(compactionView)) assert.equal(view[recentStart(view, 10_000)].id, "3");
});

test("notes are user messages in place; originals immutable; notes collapse only alone", () => {
  const h = [txt("1", "user request"), call("2", "a"), result("3", "a", big), txt("4", "completed a task with important details", "assistant"), txt("5", big + big)];
  const original = structuredClone(h);
  const c = prepareRecord(h, { action: "compact", trim: ["2"], collapse: [collapse("4")] }, "session");
  const after = applyCompaction(h, c, "session", "r1");
  assert.deepEqual(h, original);
  assert.equal(after[3].message.role, "user");
  assert.equal(after[3].id, "sr1.0");
  assert.equal(after[3].note, "n");
  assert.match(JSON.stringify(after[2].message), /Tool output compacted/);
  assert.deepEqual(after[4], h[4]);
  assert.throws(() => buildCompaction(after, { action: "compact", collapse: [collapse("2", "sr1.0")] }), /only be collapsed on its own/);
  const again = prepareRecord(after, { action: "compact", collapse: [collapse("sr1.0")] }, "session");
  assert.equal(applyCompaction(after, again, "session", "r2")[3].id, "sr2.0");
  assert.ok(itemTokens(after) < itemTokens(h));
});

test("cleanup hides earlier index/errors/nudges but retains running receipt and sibling calls", () => {
  const mixed = call("6", "index", TOOL);
  if (mixed.message.role === "assistant") mixed.message.content.push({ type: "toolCall", id: "other", name: "bash", arguments: {} });
  const h = [txt("1", "request"), call("2", "a"), result("3", "a", big), txt("4", big + big), { ...txt("5", "nudge"), nudge: true }, mixed, result("7", "index", "index output"), result("8", "other", "keep this"), call("9", "now", TOOL)];
  const c = prepareRecord(h, { action: "compact", trim: ["2"] }, "session");
  assert.deepEqual(c.hiddenEntryIds, ["5"]);
  assert.deepEqual(c.hiddenToolUseIds, ["index"]);
  const after = applyCompaction(h, c, "session", "record");
  assert.ok(after.some(it => it.id === "9"));
  assert.match(JSON.stringify(after), /keep this/);
  assert.doesNotMatch(JSON.stringify(after), /index output/);
  assert.throws(() => hideItems(h, [], ["unknown"]), /not both in context/);
});

test("index readability, exact placeholder detection and guidance", () => {
  const h = [txt("1", "do it"), call("2", "a", "bash", { command: "cd /x && ls\n -la", slow_ok: false, nested: [1] }), result("3", "a", "[Tool output compacted, says the log]" + "x".repeat(363)), call("4", "b"), result("5", "b", trimmedText("session", "5")), txt("6", big + big)];
  const index = compactIndex(h);
  assert.match(index, /user\*/);
  assert.match(index, /bash "cd \/x && ls -la slow_ok=false" → 100/);
  assert.match(index, /→ trimmed/);
  assert.match(index, /normal whitespace/);
  assert.match(index, /dropping obsolete/);
  assert.doesNotMatch(index, /nested/);
  assert.doesNotMatch(index, /x{20}/);
});

test("apply rejects stale spans, missing trims and split tool pairs without mutation", () => {
  const h = [txt("1", "hi"), call("2", "a"), result("3", "a", "output"), txt("4", "done", "assistant")];
  for (const [from, to] of [["none", "3"], ["3", "4"], ["1", "2"]]) assert.throws(() => applyCompaction(h, { ...empty(), squishes: [{ from, to, summary: "n" }] }, "s", "r"));
  assert.throws(() => applyCompaction(h, { ...empty(), trims: [{ entryId: "1", toolUseId: "a" }] }, "s", "r"));
});

test("nudge thresholds, rounding, zero usage, restart and rearming match Shelley", () => {
  const n = new ContextNudger();
  assert.equal(n.take(), undefined);
  n.observe({ ...usage, input: 195_001, output: 5_000 });
  assert.equal(n.take(), "Context is 200k.");
  assert.equal(n.take(), undefined);
  n.observe(usage);
  assert.equal(n.take(), undefined);
  n.observe({ ...usage, input: 250_000 });
  assert.equal(n.take(), "Context is 250k.");
  n.observe({ ...usage, input: 100_000 });
  assert.equal(n.take(), undefined);
  n.observe({ ...usage, input: 200_000 });
  assert.equal(n.take(), "Context is 200k.");
  assert.equal(new ContextNudger(200_000, 300_000).take(), undefined);
});
