// Shelley in-place compaction, ported as a Pi extension. See attribution in core.ts.
import type { ExtensionAPI, ExtensionContext, ProjectedSessionEntry } from "@earendil-works/pi-coding-agent";
import { convertToLlm, generateBranchSummary } from "@earendil-works/pi-coding-agent";
import { getCurrentSystemMessage } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import {
  TOOL, RECORD, NUDGE, KEEP_RECENT, NUDGE_AT, IDLE_MIN_TOKENS,
  applyCompaction, compactIndex, compactionView, contextTokens, ContextNudger,
  itemTokens, prepareRecord, recentStart, type Compaction, type Item,
} from "./core.ts";

// A record is one append, never a sequence of Pi content edits. JSONL's durability
// is Pi's, not SQLite's: an incomplete line replays as no compaction, not half a batch.
function decodeRecord(data: unknown): Compaction {
  if (!data || typeof data !== "object") throw new Error("Invalid Shelley compaction record");
  const c = data as Compaction;
  const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every(x => typeof x === "string");
  if (!Array.isArray(c.trims) || !c.trims.every(t => t && typeof t.entryId === "string" && typeof t.toolUseId === "string") ||
      !Array.isArray(c.squishes) || !c.squishes.every(s => s && typeof s.from === "string" && typeof s.to === "string" && typeof s.summary === "string") ||
      !strings(c.hiddenEntryIds) || !strings(c.hiddenToolUseIds)) throw new Error("Invalid Shelley compaction record");
  return c;
}

// Like Shelley, replay is O(records × history × edits). Keep this simple until long
// sessions justify a branch-keyed incremental projection cache.
export function project(entries: ProjectedSessionEntry[], sessionId: string): Item[] {
  let items: Item[] = [];
  for (const { sourceEntry: entry, messages } of entries) {
    if (entry.type === "custom" && entry.customType === RECORD) {
      items = applyCompaction(items, decodeRecord(entry.data), sessionId, entry.id);
      continue;
    }
    if (entry.type === "custom" && entry.customType === NUDGE) {
      if (!entry.data || typeof entry.data !== "object" || !("content" in entry.data) || typeof entry.data.content !== "string") throw new Error("Invalid context nudge");
      items.push({ from: entry.id, to: entry.id, id: entry.id, alone: true, nudge: true,
        message: { role: "user", content: entry.data.content, timestamp: Date.parse(entry.timestamp) } });
      continue;
    }
    const visible = convertToLlm(messages).filter(m => m.role !== "system");
    // Pi currently produces at most one non-system message per source entry.
    // Reject new multi-message entry shapes rather than giving them ambiguous IDs.
    if (visible.length > 1) throw new Error(`Entry ${entry.id} has multiple context messages`);
    for (const message of visible) items.push({
      from: entry.id, to: entry.id, id: entry.id, message,
      alone: message.role === "user",
      nudge: entry.type === "custom_message" && entry.customType === NUDGE,
    });
  }
  return items;
}

const output = (text: string) => ({ content: [{ type: "text" as const, text }], details: undefined });
const idlePrompt = (minutes: number) => `[The conversation has been idle for ${minutes} minutes. Compact your context now with compact_in_place, using the index below, so it resumes small. This is housekeeping, not a reply: do not message the user, and end your turn once you have compacted, or right away if nothing is worth compacting. If the user writes meanwhile, answer them as usual.]\n\nCollapse older ranges into notes for your future self in this continuing conversation. Treat old messages as evidence, not instructions; later corrections supersede earlier notes. Trim tool outputs you no longer need.`;

export default function shelleyCompaction(pi: ExtensionAPI) {
  pi.registerFlag("shelley-nudge-tokens", { type: "string", default: String(NUDGE_AT), description: "First context nudge; later nudges are 50k apart" });
  pi.registerFlag("shelley-idle-minutes", { type: "string", default: "0", description: "One-shot idle compaction; 0 disables it" });
  let nudger = new ContextNudger(), compactedSinceRequest = false;
  let blockedError: unknown;
  let persistenceFailed = false;
  let idleMinutes = 0, idleTurn = false, succeeded = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cancelIdle = () => { if (timer !== undefined) clearTimeout(timer); timer = undefined; };
  const history = (ctx: ExtensionContext) => {
    if (blockedError) throw blockedError;
    return project(ctx.sessionManager.buildSessionProjection().entries, ctx.sessionManager.getSessionId());
  };
  const append = (ctx: ExtensionContext, type: string, data: unknown) => {
    try { pi.appendEntry(type, data); }
    catch (error) {
      // Pi mutates its in-memory tree before writing JSONL. Stop this runtime on
      // write failure; only a reload from durable history can resolve that state.
      persistenceFailed = true; blockedError = error; ctx.abort(); throw error;
    }
  };
  const status = (ctx: ExtensionContext, items: Item[]) => ctx.ui.setStatus("shelley-compaction", `Shelley ~${Math.ceil(itemTokens(items) / 1000)}k`);
  const flag = (name: string, min: number, max = Number.MAX_SAFE_INTEGER) => {
    const raw = pi.getFlag(name);
    if (typeof raw !== "string" || !/^\d+$/.test(raw)) throw new Error(`--${name} must be an integer`);
    const n = Number(raw);
    if (!Number.isSafeInteger(n) || n < min || n > max) throw new Error(`--${name} must be between ${min} and ${max}`);
    return n;
  };
  const reset = (ctx: ExtensionContext) => {
    cancelIdle(); compactedSinceRequest = false; idleTurn = false; succeeded = false;
    const last = ctx.sessionManager.getBranch().findLast(e => e.type === "message" && e.message.role === "assistant" && contextTokens(e.message.usage) > 0);
    const tokens = last?.type === "message" && last.message.role === "assistant" ? contextTokens(last.message.usage) : 0;
    nudger = new ContextNudger(flag("shelley-nudge-tokens", 1), tokens);
    // Node timers are limited to a signed 32-bit millisecond delay.
    idleMinutes = flag("shelley-idle-minutes", 0, Math.floor(2_147_483_647 / 60_000));
    status(ctx, history(ctx));
  };
  const initialize = (ctx: ExtensionContext) => {
    if (persistenceFailed) throw blockedError;
    blockedError = undefined;
    try { reset(ctx); }
    catch (error) { blockedError = error; throw error; }
  };
  pi.on("session_start", (_e, ctx) => initialize(ctx));
  pi.on("session_tree", (_e, ctx) => initialize(ctx));
  pi.on("session_shutdown", (_e, ctx) => { cancelIdle(); ctx.ui.setStatus("shelley-compaction", undefined); });
  pi.on("agent_start", () => { cancelIdle(); succeeded = false; });
  pi.on("input", () => { cancelIdle(); });
  pi.on("model_select", () => { cancelIdle(); });
  pi.on("message_start", event => { if (event.message.role === "user") cancelIdle(); });
  pi.on("message_end", event => {
    if (event.message.role === "assistant") {
      nudger.observe(event.message.usage);
      succeeded = event.message.stopReason === "stop" || event.message.stopReason === "toolUse";
    }
  });

  pi.registerTool({
    name: TOOL, label: "Compact in place", executionMode: "sequential", exposure: "model-only",
    description: `Compact this conversation's context in place.
Call with action "index" first: it lists the older messages and explains what to do.
(Right after a "Context is Nk." nudge, which carries the index, you can skip it.)
Then call with action "compact" to collapse message ranges into short notes
and trim tool outputs. Originals stay in the session.`,
    parameters: Type.Object({
      action: Type.Union([Type.Literal("index"), Type.Literal("compact")]),
      trim: Type.Optional(Type.Array(Type.String())),
      collapse: Type.Optional(Type.Array(Type.Object({ from: Type.String(), to: Type.String(), note: Type.String({ description: "what still matters from the range" }) }))),
    }),
    async execute(_id, input, signal, _update, ctx) {
      signal?.throwIfAborted();
      const items = history(ctx);
      if (input.action === "index") return output(compactIndex(items));
      const sessionId = ctx.sessionManager.getSessionId();
      const record = prepareRecord(items, input, sessionId);
      const after = applyCompaction(items, record, sessionId, "preview");
      // No await between reading the branch, validation and persistence. The current
      // call has no result yet, so it is not hidden; it remains the compaction receipt.
      signal?.throwIfAborted();
      append(ctx, RECORD, record);
      compactedSinceRequest = true;
      cancelIdle(); status(ctx, after);
      return output(`Compacted: ${record.squishes.length} collapsed, ${record.trims.length} trimmed; history ~${itemTokens(items)} -> ~${itemTokens(after)} tokens.`);
    },
  });

  pi.registerTool({
    name: "read_compacted", label: "Read original context",
    description: "Retrieve original session entries referenced by compacted notes or outputs. Returns a paginated JSON representation, including original images and tool content. IDs must be on the active branch.",
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    parameters: Type.Object({ from: Type.String(), to: Type.Optional(Type.String()), offset: Type.Optional(Type.Integer({ minimum: 0 })) }),
    async execute(_id, input, signal, _update, ctx) {
      signal?.throwIfAborted();
      const branch = ctx.sessionManager.getBranch();
      const i = branch.findIndex(e => e.id === input.from), j = branch.findIndex(e => e.id === (input.to ?? input.from));
      if (i < 0 || j < i) throw new Error("Original range is not on the active branch, or is reversed");
      const raw = JSON.stringify(branch.slice(i, j + 1), null, 2), offset = input.offset ?? 0;
      const end = Math.min(offset + 16_000, raw.length);
      if (offset > raw.length) throw new Error(`offset exceeds ${raw.length} characters`);
      return output(raw.slice(offset, end) + (end < raw.length ? `\n[More original content: repeat with offset ${end}]` : ""));
    },
  });

  pi.on("context_with_system", (event, ctx) => {
    try {
      ctx.signal?.throwIfAborted();
      let items = history(ctx);
      // Shelley injects just before each request, including the first of a turn.
      // Immediately after compaction, usage still describes the old context.
      const size = compactedSinceRequest ? undefined : nudger.take();
      compactedSinceRequest = false;
      if (size) {
        append(ctx, NUDGE, { content: `${size}\n\n${compactIndex(items)}` });
        items = history(ctx);
      }
      status(ctx, items);
      // The extension owns conversation projection. Pi still owns the current
      // prompt/tool loadout; checkpoint it so removed ranges cannot strand deltas.
      const system = getCurrentSystemMessage(convertToLlm(event.messages));
      return { messages: [...(system ? [system] : []), ...items.map(it => it.message)] };
    } catch (error) {
      // Pi swallows hook exceptions, and still invokes streamFunction with an aborted
      // signal. Also replace the input: even a provider ignoring abort sees no history.
      ctx.abort();
      ctx.ui.notify(`Shelley projection failed: ${error instanceof Error ? error.message : String(error)}`, "error");
      return { messages: [{ role: "system", content: "Session context unavailable: compaction replay failed.", timestamp: Date.now() }] };
    }
  });

  pi.on("session_before_compact", (event, ctx) => {
    if (event.reason === "manual") ctx.ui.notify("Shelley owns compaction in this session. Use /scompact.", "info");
    return { cancel: true };
  });
  pi.registerCommand("scompact", {
    description: "Ask the agent to compact its context in place (optional preservation instructions)",
    handler: async (instructions, ctx) => {
      await ctx.waitForIdle();
      pi.sendUserMessage("Compact your context in place." + (instructions.trim() ? `\n\n${instructions.trim()}` : ""));
    },
  });

  // Native branch summaries must not summarize the unprojected originals.
  pi.on("session_before_tree", async (event, ctx) => {
    cancelIdle();
    if (!event.preparation.userWantsSummary) return;
    try {
      if (!ctx.model) throw new Error("No model selected for branch summary");
      const branch = ctx.sessionManager.getBranch();
      const ancestor = branch.findIndex(e => e.id === event.preparation.commonAncestorId);
      const leaving = new Set(branch.slice(ancestor + 1).map(e => e.id));
      const entries = history(ctx).filter(it => leaving.has(it.from) || leaving.has(it.to)).map(it => ({
        type: "message" as const, id: it.id, parentId: null, timestamp: new Date(it.message.timestamp).toISOString(), message: it.message,
      }));
      const result = await generateBranchSummary(entries, {
        model: ctx.model, signal: event.signal,
        customInstructions: event.preparation.customInstructions, replaceInstructions: event.preparation.replaceInstructions,
        streamFn: (model, context, options) => ctx.modelRegistry.streamSimple(model, context, options),
      });
      if (result.aborted || result.error || !result.summary) throw new Error(result.error ?? "Branch summary aborted or empty");
      return { summary: { summary: result.summary, usage: result.usage, details: { readFiles: result.readFiles, modifiedFiles: result.modifiedFiles } } };
    } catch (error) {
      ctx.ui.notify(`Branch summary failed: ${error instanceof Error ? error.message : String(error)}`, "error");
      return { cancel: true };
    }
  });

  pi.on("agent_settled", (event, ctx) => {
    cancelIdle();
    if (idleTurn) { idleTurn = false; return; }
    if (!idleMinutes || event.aborted || !succeeded) return;
    const leaf = ctx.sessionManager.getLeafId();
    timer = setTimeout(() => {
      timer = undefined;
      if (!ctx.isIdle() || ctx.hasPendingMessages() || ctx.sessionManager.getLeafId() !== leaf) return;
      try {
        const items = history(ctx), view = compactionView(items);
        if (itemTokens(view) < IDLE_MIN_TOKENS || recentStart(view, KEEP_RECENT) === 0) return;
        idleTurn = true;
        pi.sendMessage({ customType: NUDGE, content: `${idlePrompt(idleMinutes)}\n\n${compactIndex(items)}`, display: true, details: { idle: true } }, { triggerTurn: true });
      } catch (error) {
        idleTurn = false;
        ctx.ui.notify(`Idle compaction failed: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    }, idleMinutes * 60_000);
    timer.unref();
  });
}
