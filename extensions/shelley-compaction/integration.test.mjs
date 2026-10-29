import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Use the actual installed Pi without installing a duplicate runtime in the extension.
// `npm --prefix <extension> test` exports that local prefix to child npm calls.
const { npm_config_prefix: _localPrefix, ...npmEnv } = process.env;
const root = process.env.PI_PACKAGE_ROOT ?? join(execFileSync("npm", ["root", "-g"], { encoding: "utf8", env: npmEnv }).trim(), "@earendil-works/pi-coding-agent");
const ai = join(root, "node_modules/@earendil-works/pi-ai/dist");
const { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } = await import(pathToFileURL(join(root, "dist/index.js")));
const { getModel } = await import(pathToFileURL(join(ai, "compat.js")));
const { AssistantMessageEventStream } = await import(pathToFileURL(join(ai, "utils/event-stream.js")));
const extensionPath = fileURLToPath(new URL("./extension.ts", import.meta.url));
const model = getModel("openai", "gpt-4o");
const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const text = value => [{ type: "text", text: value }];
const assistant = (content, stopReason = "stop", u = usage) => ({ role: "assistant", content, stopReason, api: model.api, provider: model.provider, model: model.id, usage: structuredClone(u), timestamp: Date.now() });
const call = (id, name, args = {}) => ({ type: "toolCall", id, name, arguments: args });
const result = (id, value) => ({ role: "toolResult", toolCallId: id, toolName: "fixture", content: text(value), isError: false, timestamp: Date.now() });
const records = manager => manager.getBranch().filter(e => e.type === "custom" && e.customType === "shelley.compaction");

async function sandbox(t) {
  const cwd = await mkdtemp(join(tmpdir(), "shelley-integration-"));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("Network forbidden in integration tests"); };
  const sessions = [];
  t.after(async () => { for (const s of sessions) s.dispose(); globalThis.fetch = originalFetch; await rm(cwd, { recursive: true, force: true }); });
  const runtime = await ModelRuntime.create({ authPath: join(cwd, "auth.json"), modelsPath: null, modelsStorePath: join(cwd, "models-store.json"), refreshOnCreate: false, allowModelNetwork: false });
  await runtime.setRuntimeApiKey("openai", "offline-fixture-not-a-real-key");
  const open = async (manager, reply, flags = {}) => {
    const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
    const loader = new DefaultResourceLoader({ cwd, agentDir: cwd, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, systemPrompt: "Offline integration check.", additionalExtensionPaths: [extensionPath] });
    await loader.reload();
    const extensions = loader.getExtensions();
    assert.deepEqual(extensions.errors, []);
    assert.equal(extensions.extensions.length, 1);
    for (const [key, value] of Object.entries(flags)) extensions.runtime.flagValues.set(key, value);
    const { session } = await createAgentSession({ cwd, agentDir: cwd, modelRuntime: runtime, model, thinkingLevel: "off", resourceLoader: loader, sessionManager: manager, settingsManager, tools: ["compact_in_place", "read_compacted"] });
    sessions.push(session);
    const captured = [], aborted = [];
    session.agent.streamFunction = (_model, context, options) => {
      if (options.signal?.aborted) {
        aborted.push(structuredClone(context.messages));
        const stream = new AssistantMessageEventStream();
        stream.push({ type: "error", reason: "aborted", error: assistant([], "aborted") });
        return stream;
      }
      captured.push(structuredClone(context.messages));
      const message = reply(captured.length - 1, context.messages);
      const stream = new AssistantMessageEventStream();
      stream.push({ type: "start", partial: { ...message, content: [] } });
      stream.push({ type: "done", reason: message.stopReason, message });
      return stream;
    };
    await session.bindExtensions({});
    return { session, captured, aborted, extensions, settingsManager, runtime };
  };
  return { cwd, open };
}

function seed(manager) {
  const user = manager.appendMessage({ role: "user", content: "KEEP_USER_CONSTRAINT", timestamp: Date.now() });
  const collapsed = manager.appendMessage(assistant([call("a", "fixture"), call("b", "fixture")], "toolUse"));
  const outputA = manager.appendMessage(result("a", "OBSOLETE_A ".repeat(1000)));
  const outputB = manager.appendMessage(result("b", "OBSOLETE_B ".repeat(1000)));
  const keptCall = manager.appendMessage(assistant([call("c", "fixture")], "toolUse"));
  const trimmed = manager.appendMessage(result("c", "OBSOLETE_C ".repeat(1000)));
  const oldEnd = manager.appendMessage(assistant(text("Finished the old task.")));
  manager.appendMessage({ role: "user", content: "RECENT ".repeat(12_000), timestamp: Date.now() });
  manager.appendMessage(assistant(text("Ready.")));
  return { user, collapsed, outputA, outputB, keptCall, trimmed, oldEnd };
}

test("real Pi: index → invalid plan → single record → next request; resume, branch and original retrieval", async t => {
  const { cwd, open } = await sandbox(t);
  const manager = SessionManager.create(cwd, join(cwd, "sessions"));
  const ids = seed(manager), originals = structuredClone(manager.getBranch());
  const { session, captured } = await open(manager, i => {
    switch (i) {
      case 0: return assistant([call("index", "compact_in_place", { action: "index" })], "toolUse");
      case 1: return assistant([call("bad", "compact_in_place", { action: "compact", trim: ["missing"], collapse: [{ from: "absent", to: "absent", note: "n" }] })], "toolUse");
      case 2:
        assert.equal(records(manager).length, 0);
        return assistant([call("compact", "compact_in_place", { action: "compact", trim: [ids.keptCall], collapse: [{ from: ids.collapsed, to: ids.collapsed, note: "Investigated the issue; preserve src/example.ts." }] })], "toolUse");
      case 3: return assistant(text("Done."));
      default: throw new Error("Unexpected continuation");
    }
  });
  await session.prompt("Compact the old task.");
  assert.equal(captured.length, 4);
  assert.match(JSON.stringify(captured[1]), /## Index/);
  assert.match(JSON.stringify(captured[2]), /2 problems/);
  const after = captured[3];
  assert.doesNotMatch(JSON.stringify(after), /OBSOLETE_[ABC]|## Index|2 problems/);
  assert.match(JSON.stringify(after), /KEEP_USER_CONSTRAINT/);
  assert.match(JSON.stringify(after), /RECENT/);
  const noteIndex = after.findIndex(m => JSON.stringify(m.content).includes("Investigated the issue"));
  assert.ok(noteIndex > 0);
  assert.equal(after[noteIndex].role, "user");
  assert.ok(noteIndex < after.findIndex(m => m.role === "assistant" && m.content.some(c => c.id === "c")));
  const calls = after.filter(m => m.role === "assistant").flatMap(m => m.content.filter(c => c.type === "toolCall").map(c => c.id));
  const results = after.filter(m => m.role === "toolResult").map(m => m.toolCallId);
  assert.deepEqual(calls.sort(), results.sort());
  assert.ok(calls.includes("compact"));
  assert.equal(records(manager).length, 1);
  assert.equal(manager.getBranch().filter(e => e.type === "context_edit").length, 0);
  for (const e of originals) assert.deepEqual(manager.getEntry(e.id), e);
  const raw = await readFile(manager.getSessionFile(), "utf8");
  assert.equal(raw.split("\n").filter(line => line.includes('"customType":"shelley.compaction"')).length, 1);
  session.dispose();

  const resumed = SessionManager.open(manager.getSessionFile());
  const reopened = await open(resumed, () => assistant(text("Resumed.")));
  await reopened.session.prompt("Continue.");
  assert.doesNotMatch(JSON.stringify(reopened.captured[0]), /OBSOLETE_[ABC]/);
  const compactedLeaf = resumed.getLeafId();
  reopened.session.dispose();
  resumed.branch(ids.oldEnd);
  const sibling = await open(resumed, () => assistant(text("Sibling.")));
  await sibling.session.prompt("Try a different approach.");
  assert.match(JSON.stringify(sibling.captured[0]), /OBSOLETE_A/);
  sibling.session.dispose();
  resumed.branch(compactedLeaf);
  const reader = await open(resumed, i => i === 0 ? assistant([call("read", "read_compacted", { from: ids.outputA })], "toolUse") : assistant(text("Read.")));
  await reader.session.prompt("Retrieve the original output.");
  assert.match(JSON.stringify(reader.captured[1]), /OBSOLETE_A/);
  assert.equal(reader.captured[1].find(m => m.role === "toolResult" && m.toolCallId === "read")?.isError, false);
});

test("Pi-native summary can become a user-role singleton note; no native summary fallback", async t => {
  const { cwd, open } = await sandbox(t);
  const manager = SessionManager.inMemory(cwd);
  const ids = seed(manager);
  const native = manager.appendCompaction("NATIVE_SUMMARY ".repeat(100), ids.keptCall, 40_000);
  const { session, captured, settingsManager } = await open(manager, i => i === 0
    ? assistant([call("compact", "compact_in_place", { action: "compact", collapse: [{ from: native, to: native, note: "Prior task resolved." }] })], "toolUse")
    : assistant(text("Done.")));
  await session.prompt("Compact.");
  assert.equal(captured.length, 2);
  assert.doesNotMatch(JSON.stringify(captured[1]), /NATIVE_SUMMARY/);
  assert.ok(captured[1].some(m => m.role === "user" && JSON.stringify(m.content).includes("Prior task resolved.")));
  const count = manager.getBranch().filter(e => e.type === "compaction").length;
  await assert.rejects(session.compact(), /cancelled/i);
  assert.equal(manager.getBranch().filter(e => e.type === "compaction").length, count);
  assert.equal(settingsManager.getCompactionSettings().enabled, false);
});

test("corrupt compaction fails closed before a provider request", async t => {
  const { cwd, open } = await sandbox(t);
  const manager = SessionManager.inMemory(cwd);
  seed(manager);
  const { session, captured, aborted } = await open(manager, () => assistant(text("MUST_NOT_RUN")));
  manager.appendCustomEntry("shelley.compaction", { trims: [{ entryId: "missing", toolUseId: "missing" }], squishes: [], hiddenEntryIds: [], hiddenToolUseIds: [] });
  await session.prompt("Continue.");
  assert.equal(captured.length, 0, "A corrupt projection must not fall through to raw history");
  assert.equal(aborted.length, 1);
  assert.doesNotMatch(JSON.stringify(aborted), /OBSOLETE_|KEEP_USER|RECENT/);
});

test("context nudges are injected before the next request and hidden by compaction", async t => {
  const { cwd, open } = await sandbox(t);
  const manager = SessionManager.inMemory(cwd), ids = seed(manager);
  const { session, captured } = await open(manager, i => {
    if (i === 0) return assistant([call("read", "read_compacted", { from: ids.user })], "toolUse", { ...usage, input: 200_000 });
    if (i === 1) return assistant([call("compact", "compact_in_place", { action: "compact", trim: [ids.keptCall] })], "toolUse", { ...usage, input: 200_000 });
    return assistant(text("Done."));
  });
  await session.prompt("Continue.");
  assert.equal(captured.length, 3);
  assert.match(JSON.stringify(captured[1]), /Context is 200k/);
  assert.match(JSON.stringify(captured[1]), /## Index/);
  assert.doesNotMatch(JSON.stringify(captured[2]), /Context is 200k|## Index/);
  assert.equal(manager.getBranch().filter(e => e.type === "custom" && e.customType === "shelley.context-nudge").length, 1);
});

test("idle policy: one shot, 50k floor, cancellation and no housekeeping loop", async t => {
  const { cwd, open } = await sandbox(t);
  const manager = SessionManager.inMemory(cwd), ids = seed(manager);
  manager.appendMessage({ role: "user", content: "more recent material ".repeat(10_000), timestamp: Date.now() });
  const { session, captured } = await open(manager, () => assistant(text("Done.")), { "shelley-idle-minutes": "1" });
  const scheduled = new Map();
  t.mock.method(globalThis, "setTimeout", (fn, delay, ...args) => {
    const handle = { unref() { return handle; } };
    scheduled.set(handle, { fn: () => fn(...args), delay });
    return handle;
  });
  t.mock.method(globalThis, "clearTimeout", handle => { scheduled.delete(handle); });
  const fire = () => {
    assert.equal(scheduled.size, 1);
    const [handle, timer] = [...scheduled][0];
    assert.equal(timer.delay, 60_000);
    scheduled.delete(handle); timer.fn();
  };
  await session.prompt("Finish this task.");
  assert.equal(scheduled.size, 1);
  const settled = new Promise(resolve => {
    const unsubscribe = session.subscribe(e => { if (e.type === "agent_settled") { unsubscribe(); resolve(); } });
  });
  fire();
  await settled;
  assert.equal(captured.length, 2);
  assert.match(JSON.stringify(captured[1]), /conversation has been idle for 1 minutes/);
  assert.equal(scheduled.size, 0, "Housekeeping must not re-arm itself");
  await session.prompt("New real activity.");
  assert.equal(scheduled.size, 1);
  await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
  session.dispose();
  assert.equal(scheduled.size, 0, "Session shutdown cancels the timer");

  const small = SessionManager.inMemory(cwd);
  small.appendMessage({ role: "user", content: "tiny context", timestamp: Date.now() });
  const tiny = await open(small, () => assistant(text("Done.")), { "shelley-idle-minutes": "1" });
  await tiny.session.prompt("Finish.");
  fire();
  assert.equal(tiny.captured.length, 1, "Contexts under 50k must not trigger a housekeeping turn");
  assert.equal(scheduled.size, 0);
  assert.ok(manager.getEntry(ids.user));
});

test("native branch summarization sees the compacted projection, not discarded outputs", async t => {
  const { cwd, open } = await sandbox(t);
  const manager = SessionManager.inMemory(cwd), ids = seed(manager);
  const { session, runtime } = await open(manager, i => i === 0
    ? assistant([call("compact", "compact_in_place", { action: "compact", trim: [ids.keptCall], collapse: [{ from: ids.collapsed, to: ids.collapsed, note: "Resolved old task." }] })], "toolUse")
    : assistant(text("Done.")));
  await session.prompt("Compact.");
  const summarized = [];
  runtime.streamSimple = (_model, context) => {
    summarized.push(context);
    const stream = new AssistantMessageEventStream();
    stream.push({ type: "done", reason: "stop", message: assistant(text("Branch work completed.")) });
    return stream;
  };
  await session.navigateTree(ids.user, { summarize: true });
  assert.equal(summarized.length, 1);
  assert.doesNotMatch(JSON.stringify(summarized), /OBSOLETE_[ABC]/);
  assert.match(JSON.stringify(summarized), /Resolved old task/);
  assert.equal(manager.getLeafEntry().type, "branch_summary");
});

test("invalid configuration and failed record writes stop instead of continuing with a different view", async t => {
  const { cwd, open } = await sandbox(t);
  const manager = SessionManager.inMemory(cwd), ids = seed(manager);
  const { session, captured } = await open(manager, () => assistant([call("compact", "compact_in_place", { action: "compact", trim: [ids.keptCall] })], "toolUse"));
  const append = manager.appendCustomEntry.bind(manager);
  manager.appendCustomEntry = (type, data) => {
    const id = append(type, data);
    if (type === "shelley.compaction") throw new Error("Simulated write failure after in-memory append");
    return id;
  };
  await session.prompt("Compact.");
  assert.equal(captured.length, 1, "Failed persistence must not start another request");
  await session.prompt("Continue.");
  assert.equal(captured.length, 1, "The failed runtime remains blocked until reload");
  const invalid = await open(SessionManager.inMemory(cwd), () => assistant(text("MUST_NOT_RUN")), { "shelley-nudge-tokens": "invalid" });
  await invalid.session.prompt("Hello.");
  assert.equal(invalid.captured.length, 0);
});

test("repeated compaction replays synthetic note IDs and hides earlier receipts", async t => {
  const { cwd, open } = await sandbox(t);
  const manager = SessionManager.inMemory(cwd), ids = seed(manager);
  const { session, captured } = await open(manager, i => {
    if (i === 0) return assistant([call("first", "compact_in_place", { action: "compact", collapse: [{ from: ids.collapsed, to: ids.collapsed, note: "The old task was investigated and resolved; preserve src/example.ts." }] })], "toolUse");
    if (i === 1) {
      const noteId = `s${records(manager)[0].id}.0`;
      return assistant([call("second", "compact_in_place", { action: "compact", collapse: [{ from: noteId, to: noteId, note: "Resolved; see src/example.ts." }] })], "toolUse");
    }
    return assistant(text("Done."));
  });
  await session.prompt("Compact twice.");
  assert.equal(captured.length, 3);
  assert.equal(records(manager).length, 2);
  assert.match(JSON.stringify(captured[2]), /Resolved; see src/);
  assert.doesNotMatch(JSON.stringify(captured[2]), /old task was investigated/);
  assert.ok(!captured[2].some(m => m.role === "toolResult" && m.toolCallId === "first"));
  assert.ok(captured[2].some(m => m.role === "toolResult" && m.toolCallId === "second"));
});

test("auto-discovered from the extensions directory on startup and reload", async t => {
  const cwd = await mkdtemp(join(tmpdir(), "shelley-discovery-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await mkdir(join(cwd, "extensions"));
  await symlink(fileURLToPath(new URL(".", import.meta.url)), join(cwd, "extensions/shelley-compaction"), "dir");
  const loader = new DefaultResourceLoader({
    cwd, agentDir: cwd, settingsManager: SettingsManager.inMemory(),
    noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
  });
  for (let load = 0; load < 2; load++) {
    await loader.reload();
    const result = loader.getExtensions();
    assert.deepEqual(result.errors, []);
    assert.equal(result.extensions.length, 1, "No explicit path or settings should be needed");
    assert.ok(result.extensions[0].tools.has("compact_in_place"));
    assert.ok(result.extensions[0].tools.has("read_compacted"));
    assert.ok(result.extensions[0].handlers.has("context_with_system"));
  }
});
