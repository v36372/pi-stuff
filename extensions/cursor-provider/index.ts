/**
 * Cursor Provider Extension for pi
 *
 * Provides access to Cursor models (Claude, GPT, Gemini, etc.) via:
 * 1. Browser-based PKCE OAuth login to Cursor
 * 2. Local proxy translating OpenAI format → Cursor gRPC protocol
 *
 * Usage:
 *   /login cursor    — authenticate via browser
 *   /model           — select any Cursor model
 *
 * Based on https://github.com/ephraimduncan/opencode-cursor by Ephraim Duncan.
 */

import rawFallbackModels from "./cursor-models-raw.json" with { type: "json" };
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type {
  OAuthCredentials,
  OAuthLoginCallbacks,
} from "@mariozechner/pi-ai";
import { appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as pathJoin } from "node:path";
import {
  generateCursorAuthParams,
  getTokenExpiry,
  pollCursorAuth,
  refreshCursorToken,
} from "./auth.js";
import {
  cleanupSessionState,
  getCursorModels,
  inferContextWindow,
  loadCachedModels,
  startProxy,
  type CursorModel,
} from "./proxy.js";

// ── Cost estimation ──

interface ModelCost {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

let extensionDebugLogFilePath: string | undefined;

function isExtensionDebugEnabled(): boolean {
  const raw = process.env.PI_CURSOR_PROVIDER_DEBUG?.trim().toLowerCase();
  return !!raw && raw !== "0" && raw !== "false" && raw !== "off";
}

function getExtensionDebugLogFilePath(): string {
  if (extensionDebugLogFilePath) return extensionDebugLogFilePath;
  const configured =
    process.env.PI_CURSOR_PROVIDER_EXTENSION_DEBUG_FILE?.trim();
  if (configured) {
    extensionDebugLogFilePath = configured;
    return extensionDebugLogFilePath;
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  extensionDebugLogFilePath = pathJoin(
    tmpdir(),
    `pi-cursor-provider-extension-debug-${stamp}-${process.pid}.log`,
  );
  return extensionDebugLogFilePath;
}

function truncateDebugValue(value: string, max = 240): string {
  return value.length > max
    ? `${value.slice(0, max)}…<truncated ${value.length - max} chars>`
    : value;
}

function summarizeContent(content: unknown): unknown {
  if (typeof content === "string") return truncateDebugValue(content);
  if (!Array.isArray(content)) return content;
  return content.map((block) => {
    if (!block || typeof block !== "object") return block;
    const typed = block as Record<string, unknown>;
    switch (typed.type) {
      case "text":
        return {
          type: "text",
          text: truncateDebugValue(String(typed.text ?? "")),
        };
      case "thinking":
        return {
          type: "thinking",
          thinking: truncateDebugValue(String(typed.thinking ?? "")),
        };
      case "toolCall":
        return {
          type: "toolCall",
          id: typed.id,
          name: typed.name,
          arguments: typed.arguments,
        };
      case "image":
        return {
          type: "image",
          mimeType: typed.mimeType,
          data: `<redacted base64 ${String(typed.data ?? "").length} chars>`,
        };
      default:
        return typed;
    }
  });
}

function summarizeMessage(message: unknown): unknown {
  if (!message || typeof message !== "object") return message;
  const typed = message as Record<string, unknown>;
  return {
    role: typed.role,
    stopReason: typed.stopReason,
    toolCallId: typed.toolCallId,
    toolName: typed.toolName,
    isError: typed.isError,
    errorMessage: typed.errorMessage,
    content: summarizeContent(typed.content),
  };
}

function summarizeBranchTail(
  ctx: {
    sessionManager?: {
      getBranch?: () => unknown[];
      getLeafId?: () => string | null;
      getSessionId?: () => string;
    };
  },
  limit = 6,
): unknown {
  try {
    const branch = ctx.sessionManager?.getBranch?.();
    if (!Array.isArray(branch)) return undefined;
    return {
      sessionId: ctx.sessionManager?.getSessionId?.(),
      leafId: ctx.sessionManager?.getLeafId?.(),
      size: branch.length,
      tail: branch.slice(-limit).map((entry) => {
        if (!entry || typeof entry !== "object") return entry;
        const typed = entry as Record<string, unknown>;
        return {
          type: typed.type,
          id: typed.id,
          parentId: typed.parentId,
          customType: typed.customType,
          message: summarizeMessage(typed.message),
        };
      }),
    };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

function summarizeProviderPayload(payload: unknown): unknown {
  if (!payload || typeof payload !== "object") return payload;
  const typed = payload as Record<string, unknown>;
  const messages = Array.isArray(typed.messages)
    ? typed.messages.map((message) => summarizeMessage(message)).slice(-8)
    : undefined;
  return {
    model: typed.model,
    stream: typed.stream,
    pi_session_id: typed.pi_session_id,
    messageCount: Array.isArray(typed.messages)
      ? typed.messages.length
      : undefined,
    messages,
    toolCount: Array.isArray(typed.tools) ? typed.tools.length : undefined,
  };
}

function debugExtensionLog(
  event: string,
  data?: Record<string, unknown>,
): void {
  if (!isExtensionDebugEnabled()) return;
  const payload = JSON.stringify({
    ts: new Date().toISOString(),
    pid: process.pid,
    scope: "extension",
    event,
    ...data,
  });
  appendFileSync(getExtensionDebugLogFilePath(), `${payload}\n`, "utf8");
}

const MODEL_COST_TABLE: Record<string, ModelCost> = {
  "claude-4-sonnet": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  "claude-4.5-haiku": { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  "claude-4.5-opus": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-4.5-sonnet": {
    input: 3,
    output: 15,
    cacheRead: 0.3,
    cacheWrite: 3.75,
  },
  "claude-4.6-opus": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-4.6-sonnet": {
    input: 3,
    output: 15,
    cacheRead: 0.3,
    cacheWrite: 3.75,
  },
  "claude-4.7-opus": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-4.8-opus": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "composer-1": { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 },
  "composer-1.5": { input: 3.5, output: 17.5, cacheRead: 0.35, cacheWrite: 0 },
  "composer-2": { input: 0.5, output: 2.5, cacheRead: 0.2, cacheWrite: 0 },
  "composer-2.5": { input: 0.5, output: 2.5, cacheRead: 0.2, cacheWrite: 0 },
  "claude-fable-5": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-sonnet-5": {
    input: 3,
    output: 15,
    cacheRead: 0.3,
    cacheWrite: 3.75,
  },
  "claude-opus-4-5": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-opus-4-6": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-opus-4-7": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-opus-4-8": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-sonnet-4": {
    input: 3,
    output: 15,
    cacheRead: 0.3,
    cacheWrite: 3.75,
  },
  "claude-sonnet-4-5": {
    input: 3,
    output: 15,
    cacheRead: 0.3,
    cacheWrite: 3.75,
  },
  "claude-sonnet-4-6": {
    input: 3,
    output: 15,
    cacheRead: 0.3,
    cacheWrite: 3.75,
  },
  "claude-haiku-4-5": {
    input: 1,
    output: 5,
    cacheRead: 0.1,
    cacheWrite: 1.25,
  },
  "gemini-2.5-flash": {
    input: 0.3,
    output: 2.5,
    cacheRead: 0.03,
    cacheWrite: 0,
  },
  "gemini-3-flash": { input: 0.5, output: 3, cacheRead: 0.05, cacheWrite: 0 },
  "gemini-3-pro": { input: 2, output: 12, cacheRead: 0.2, cacheWrite: 0 },
  "gemini-3.1-pro": { input: 2, output: 12, cacheRead: 0.2, cacheWrite: 0 },
  "gemini-3.5-flash": { input: 1.5, output: 9, cacheRead: 0.15, cacheWrite: 0 },
  "gemini-3.6-flash": { input: 1.5, output: 9, cacheRead: 0.15, cacheWrite: 0 },
  "glm-5.2": { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 0 },
  "gpt-5": { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 },
  "gpt-5-fast": { input: 2.5, output: 20, cacheRead: 0.25, cacheWrite: 0 },
  "gpt-5-codex": { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 },
  "gpt-5.1-codex": { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 },
  "gpt-5.1-codex-max": { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 },
  "gpt-5.1-codex-mini": { input: 0.25, output: 2, cacheRead: 0.025, cacheWrite: 0 },
  "gpt-5-mini": { input: 0.25, output: 2, cacheRead: 0.025, cacheWrite: 0 },
  "gpt-5.2": { input: 1.75, output: 14, cacheRead: 0.175, cacheWrite: 0 },
  "gpt-5.2-codex": { input: 1.75, output: 14, cacheRead: 0.175, cacheWrite: 0 },
  "gpt-5.3-codex": { input: 1.75, output: 14, cacheRead: 0.175, cacheWrite: 0 },
  "gpt-5.4": { input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: 0 },
  "gpt-5.4-mini": { input: 0.75, output: 4.5, cacheRead: 0.075, cacheWrite: 0 },
  "gpt-5.4-nano": { input: 0.2, output: 1.25, cacheRead: 0.02, cacheWrite: 0 },
  "gpt-5.5": { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0 },
  "gpt-5.6-luna": { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0 },
  "gpt-5.6-sol": { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0 },
  "gpt-5.6-terra": { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0 },
  "grok-4.20": { input: 2, output: 6, cacheRead: 0.2, cacheWrite: 0 },
  "grok-4-3": { input: 1.25, output: 2.5, cacheRead: 0.2, cacheWrite: 0 },
  "grok-4.3": { input: 1.25, output: 2.5, cacheRead: 0.2, cacheWrite: 0 },
  "grok-4.5": { input: 1.25, output: 2.5, cacheRead: 0.2, cacheWrite: 0 },
  "cursor-grok-4.5": {
    input: 1.25,
    output: 2.5,
    cacheRead: 0.2,
    cacheWrite: 0,
  },
  "grok-build-0.1": { input: 1, output: 2, cacheRead: 0.2, cacheWrite: 0 },
  "kimi-k2.5": { input: 0.6, output: 3, cacheRead: 0.1, cacheWrite: 0 },
  "kimi-k2.7-code": { input: 0.6, output: 3, cacheRead: 0.1, cacheWrite: 0 },
};

const MODEL_COST_PATTERNS: Array<{
  match: (id: string) => boolean;
  cost: ModelCost;
}> = [
  {
    match: (id) => /claude.*opus.*fast/i.test(id),
    cost: { input: 30, output: 150, cacheRead: 3, cacheWrite: 37.5 },
  },
  {
    match: (id) => /claude.*(?:opus|fable)/i.test(id),
    cost: MODEL_COST_TABLE["claude-4.6-opus"]!,
  },
  {
    match: (id) => /claude.*haiku/i.test(id),
    cost: MODEL_COST_TABLE["claude-4.5-haiku"]!,
  },
  {
    match: (id) => /claude.*sonnet/i.test(id),
    cost: MODEL_COST_TABLE["claude-4.6-sonnet"]!,
  },
  {
    match: (id) => /composer-2\.5/i.test(id),
    cost: MODEL_COST_TABLE["composer-2.5"]!,
  },
  {
    match: (id) => /composer-2/i.test(id),
    cost: MODEL_COST_TABLE["composer-2"]!,
  },
  {
    match: (id) => /composer/i.test(id),
    cost: MODEL_COST_TABLE["composer-1"]!,
  },
  {
    match: (id) => /gpt-5\.6/i.test(id),
    cost: MODEL_COST_TABLE["gpt-5.6-sol"]!,
  },
  {
    match: (id) => /gpt-5\.5/i.test(id),
    cost: MODEL_COST_TABLE["gpt-5.5"]!,
  },
  {
    match: (id) => /gpt-5\.4.*mini/i.test(id),
    cost: MODEL_COST_TABLE["gpt-5.4-mini"]!,
  },
  {
    match: (id) => /gpt-5\.4.*nano/i.test(id),
    cost: MODEL_COST_TABLE["gpt-5.4-nano"]!,
  },
  { match: (id) => /gpt-5\.4/i.test(id), cost: MODEL_COST_TABLE["gpt-5.4"]! },
  {
    match: (id) => /gpt-5\.3/i.test(id),
    cost: MODEL_COST_TABLE["gpt-5.3-codex"]!,
  },
  { match: (id) => /gpt-5\.2/i.test(id), cost: MODEL_COST_TABLE["gpt-5.2"]! },
  {
    match: (id) => /gpt-5.*mini/i.test(id),
    cost: MODEL_COST_TABLE["gpt-5-mini"]!,
  },
  { match: (id) => /gpt-5/i.test(id), cost: MODEL_COST_TABLE["gpt-5"]! },
  {
    match: (id) => /gemini.*3\.1/i.test(id),
    cost: MODEL_COST_TABLE["gemini-3.1-pro"]!,
  },
  {
    match: (id) => /gemini.*3\.6.*flash/i.test(id),
    cost: MODEL_COST_TABLE["gemini-3.6-flash"]!,
  },
  {
    match: (id) => /gemini.*flash/i.test(id),
    cost: MODEL_COST_TABLE["gemini-2.5-flash"]!,
  },
  {
    match: (id) => /gemini/i.test(id),
    cost: MODEL_COST_TABLE["gemini-3-pro"]!,
  },
  { match: (id) => /glm/i.test(id), cost: MODEL_COST_TABLE["glm-5.2"]! },
  {
    match: (id) => /grok-4\.5|cursor-grok/i.test(id),
    cost: MODEL_COST_TABLE["grok-4.5"]!,
  },
  { match: (id) => /grok/i.test(id), cost: MODEL_COST_TABLE["grok-4.20"]! },
  {
    match: (id) => /kimi-k2\.7/i.test(id),
    cost: MODEL_COST_TABLE["kimi-k2.7-code"]!,
  },
  { match: (id) => /kimi/i.test(id), cost: MODEL_COST_TABLE["kimi-k2.5"]! },
];

const DEFAULT_COST: ModelCost = {
  input: 3,
  output: 15,
  cacheRead: 0.3,
  cacheWrite: 0,
};

const COST_STRIP_SUFFIXES = [
  "extra-high",
  "spark-preview",
  "thinking",
  "preview",
  "minimal",
  "medium",
  "xhigh",
  "high",
  "low",
  "none",
  "max",
  "fast",
] as const;

function stripCostSuffixes(id: string): string {
  let current = id;
  let changed = true;
  while (changed) {
    changed = false;
    for (const suffix of COST_STRIP_SUFFIXES) {
      const token = `-${suffix}`;
      if (current.endsWith(token)) {
        current = current.slice(0, -token.length);
        changed = true;
        break;
      }
    }
  }
  return current;
}

function estimateModelCost(modelId: string): ModelCost {
  const normalized = modelId.toLowerCase();
  const exact = MODEL_COST_TABLE[normalized];
  if (exact) return exact;
  const stripped = stripCostSuffixes(normalized);
  const strippedMatch = MODEL_COST_TABLE[stripped];
  if (strippedMatch) return strippedMatch;
  return (
    MODEL_COST_PATTERNS.find((p) => p.match(normalized))?.cost ?? DEFAULT_COST
  );
}

// ── Effort-level dedup ──

/** Multi-segment effort suffixes must be checked before single-segment ones. */
const MULTI_SEGMENT_EFFORTS = ["extra-high"] as const;

const EFFORT_LEVELS = new Set([
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "extra-high",
  "max",
  "none",
]);

interface ParsedModelId {
  base: string; // model ID with effort stripped
  effort: string; // effort level, or "" if no effort suffix
  fast: boolean; // has -fast suffix
  thinking: boolean; // has -thinking suffix
}

function stripEffortSuffix(id: string): { id: string; effort: string } {
  for (const effort of MULTI_SEGMENT_EFFORTS) {
    const token = `-${effort}`;
    if (id.endsWith(token)) {
      return { id: id.slice(0, -token.length), effort };
    }
  }
  const lastDash = id.lastIndexOf("-");
  if (lastDash >= 0) {
    const suffix = id.slice(lastDash + 1);
    if (EFFORT_LEVELS.has(suffix)) {
      return { id: id.slice(0, lastDash), effort: suffix };
    }
  }
  return { id, effort: "" };
}

/**
 * New Cursor Claude IDs use family-first naming (claude-opus-4-8) and place
 * effort after -thinking. Legacy IDs use version-first naming (claude-4.6-opus)
 * and place effort before -thinking.
 */
export function usesThinkingThenEffort(base: string): boolean {
  return /^claude-(opus|sonnet|haiku|fable)-/i.test(base);
}

export function parseModelId(id: string): ParsedModelId {
  let remaining = id;
  let fast = false;
  let thinking = false;

  if (remaining.endsWith("-fast")) {
    fast = true;
    remaining = remaining.slice(0, -5);
  }

  // Legacy order: {base}-{effort}-thinking
  if (remaining.endsWith("-thinking")) {
    thinking = true;
    remaining = remaining.slice(0, -9);
    const stripped = stripEffortSuffix(remaining);
    return {
      base: stripped.id,
      effort: stripped.effort,
      fast,
      thinking,
    };
  }

  // New order: {base}-thinking-{effort}  (and non-thinking {base}-{effort})
  const stripped = stripEffortSuffix(remaining);
  remaining = stripped.id;
  const effort = stripped.effort;
  if (remaining.endsWith("-thinking")) {
    thinking = true;
    remaining = remaining.slice(0, -9);
  }

  return { base: remaining, effort, fast, thinking };
}

interface ProcessedModel extends CursorModel {
  supportsEffort: boolean;
  effortMap?: Record<string, string>;
}

export function supportsReasoningModelId(id: string): boolean {
  const { base, effort, thinking } = parseModelId(id);
  if (effort || thinking) return true;
  if (base === "default") return true;
  return /^(claude|composer|gemini|gpt|grok|kimi|glm|cursor)(-|$)/i.test(base);
}

/**
 * Ordered effort levels from lowest to highest.
 * "" = default (no effort suffix in model ID).
 */
const EFFORT_ORDER = [
  "none",
  "minimal",
  "low",
  "",
  "medium",
  "high",
  "xhigh",
  "extra-high",
  "max",
] as const;

/**
 * Build a reasoning-effort map from the set of available effort suffixes.
 * For each pi effort level (minimal/low/medium/high/xhigh), picks the closest
 * available cursor effort, falling back to the lowest available.
 */
export function buildEffortMap(efforts: Set<string>): Record<string, string> {
  const sorted = EFFORT_ORDER.filter((e) => efforts.has(e));
  if (sorted.length === 0) return {};
  const lowest = sorted[0]!;

  const pick = (...targets: string[]) => {
    for (const t of targets) if (efforts.has(t)) return t;
    return lowest;
  };

  return {
    minimal: pick("minimal", "none", "low", ""),
    low: pick("low", "minimal", "none", ""),
    medium: pick("medium", "", "low"),
    high: pick("high", "medium", ""),
    xhigh: pick("max", "extra-high", "xhigh", "high"),
  };
}

/** Dedup raw models: collapse effort variants into one entry with supportsReasoningEffort. */
/**
 * Drop superseded Cursor model IDs that still appear in GetUsableModels.
 * Version-first Claude names (claude-4.6-opus-*) are replaced by family-first
 * IDs (claude-opus-4-8-*). Keep this list tight so the picker stays current.
 */
export function isLegacyCursorModelId(id: string): boolean {
  const lower = id.toLowerCase();
  // Version-first Claude: claude-4-sonnet, claude-4.5-*, claude-4.6-*, …
  if (/^claude-\d/.test(lower)) return true;
  return false;
}

export function processModels(raw: CursorModel[]): ProcessedModel[] {
  // Group by (base, fast, thinking)
  const groups = new Map<
    string,
    {
      base: string;
      fast: boolean;
      thinking: boolean;
      efforts: Map<string, CursorModel>;
    }
  >();

  for (const model of raw) {
    if (isLegacyCursorModelId(model.id)) continue;
    const p = parseModelId(model.id);
    const key = `${p.base}|${p.fast}|${p.thinking}`;
    let g = groups.get(key);
    if (!g) {
      g = {
        base: p.base,
        fast: p.fast,
        thinking: p.thinking,
        efforts: new Map(),
      };
      groups.set(key, g);
    }
    g.efforts.set(p.effort, model);
  }

  const result: ProcessedModel[] = [];

  for (const g of groups.values()) {
    // Dedup when there are multiple effort variants, OR a single variant
    // whose effort is non-empty (e.g. claude-4.5-opus-high — strip the
    // mandatory effort suffix so the model appears as claude-4.5-opus
    // with effort mapping).
    const hasOnlyEffortVariants = g.efforts.size === 1 && !g.efforts.has("");
    if (g.efforts.size >= 2 || hasOnlyEffortVariants) {
      // Prefer a clean display name: high often has no effort word
      // ("Cursor Grok 4.5"), while medium is "… Medium". Always sanitize.
      const rep =
        g.efforts.get("high") ??
        g.efforts.get("medium") ??
        g.efforts.get("") ??
        [...g.efforts.values()][0]!;

      // Build deduped model ID: base + thinking/fast suffix (no effort).
      // Display order is always base[-thinking][-fast]; resolveModelId places
      // the effort segment according to the family's native ID scheme.
      let id = g.base;
      if (g.thinking) id += "-thinking";
      if (g.fast) id += "-fast";

      const effortMap = buildEffortMap(new Set(g.efforts.keys()));

      result.push({
        ...rep,
        id,
        name: sanitizeDisplayName(rep.name, g.fast, g.thinking),
        supportsEffort: true,
        effortMap,
      });
    } else {
      // Keep single entries as-is (base model without effort variants)
      for (const model of g.efforts.values()) {
        result.push({ ...model, supportsEffort: false });
      }
    }
  }

  return result.sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Strip effort words that Cursor bakes into display names so a deduped model
 * does not permanently show "Medium" when the user selects high thinking.
 */
export function sanitizeDisplayName(
  name: string,
  fast: boolean,
  thinking: boolean,
): string {
  let cleaned = name
    .replace(
      /\b(extra[\s-]*high|xhigh|minimal|medium|high|low|max|none)\b/gi,
      "",
    )
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([-/])/g, "$1")
    .replace(/([-/])\s+/g, "$1")
    .trim();

  // Drop trailing Fast/Thinking tokens; re-add from flags so order is stable.
  cleaned = cleaned
    .replace(/\b(fast|thinking)\b/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();

  if (thinking && !/\bthinking\b/i.test(cleaned)) cleaned = `${cleaned} Thinking`;
  if (fast && !/\bfast\b/i.test(cleaned)) cleaned = `${cleaned} Fast`;
  return cleaned.replace(/\s{2,}/g, " ").trim();
}

function modelConfig(m: ProcessedModel) {
  // Current pi maps thinking levels via model.thinkingLevelMap (not the
  // deprecated compat.reasoningEffortMap). Values are Cursor effort suffixes.
  const thinkingLevelMap = m.supportsEffort && m.effortMap
    ? {
        // Cursor models always reason when selected; hide "off".
        off: null as null,
        minimal: m.effortMap.minimal,
        low: m.effortMap.low,
        medium: m.effortMap.medium,
        high: m.effortMap.high,
        xhigh: m.effortMap.xhigh,
      }
    : undefined;

  return {
    id: m.id,
    name: m.name,
    reasoning: supportsReasoningModelId(m.id),
    input: ["text", "image"] as ("text" | "image")[],
    cost: estimateModelCost(m.id),
    contextWindow: inferContextWindow(m.id),
    maxTokens: m.maxTokens,
    ...(thinkingLevelMap ? { thinkingLevelMap } : {}),
    compat: {
      supportsDeveloperRole: false,
      supportsReasoningEffort: m.supportsEffort,
      maxTokensField: "max_tokens" as const,
    },
  };
}

export const FALLBACK_MODELS: CursorModel[] = (
  rawFallbackModels as CursorModel[]
).map((model) => ({
  ...model,
  reasoning: supportsReasoningModelId(model.id),
}));

// ── Extension ──

export function registerSessionLifecycleCleanup(pi: ExtensionAPI): void {
  const cleanupCurrentSession = (
    _event: unknown,
    ctx: {
      sessionManager: { getSessionId(): string; getLeafId?: () => string | null };
    },
  ) => {
    debugExtensionLog("session.cleanup_hook", {
      sessionId: ctx.sessionManager.getSessionId(),
      leafId: ctx.sessionManager.getLeafId?.(),
    });
    cleanupSessionState(ctx.sessionManager.getSessionId());
  };

  pi.on("session_before_switch", cleanupCurrentSession);
  pi.on("session_before_fork", cleanupCurrentSession);
  pi.on("session_before_tree", cleanupCurrentSession);
  pi.on("session_shutdown", cleanupCurrentSession);

  // After pi compacts its message list, keep the checkpoint intact.
  // The checkpoint is the only thing that gives Cursor memory of prior turns;
  // clearing it forces a rebuild from turns, which Cursor's server silently
  // ignores (it doesn't fetch turn blobs from a synthetic state).  The
  // checkpoint already reflects the full server-side conversation and remains
  // valid regardless of what pi compacted locally.
  pi.on("session_compact", (_event, ctx) => {
    debugExtensionLog("session.post_compact_noop", {
      sessionId: ctx.sessionManager.getSessionId(),
    });
  });
}

function registerExtensionDebugHooks(pi: ExtensionAPI) {
  if (!isExtensionDebugEnabled()) return;

  pi.on("message_start", async (event, ctx) => {
    if (ctx.model?.provider !== "cursor") return;
    debugExtensionLog("message.start", {
      sessionId: ctx.sessionManager.getSessionId(),
      leafId: ctx.sessionManager.getLeafId?.(),
      model: ctx.model?.id,
      message: summarizeMessage((event as { message?: unknown }).message),
    });
  });

  pi.on("message_update", async (event, ctx) => {
    if (ctx.model?.provider !== "cursor") return;
    const typedEvent = event as {
      message?: unknown;
      assistantMessageEvent?: Record<string, unknown>;
    };
    debugExtensionLog("message.update", {
      sessionId: ctx.sessionManager.getSessionId(),
      leafId: ctx.sessionManager.getLeafId?.(),
      model: ctx.model?.id,
      assistantMessageEvent: typedEvent.assistantMessageEvent
        ? {
            type: typedEvent.assistantMessageEvent.type,
            delta: truncateDebugValue(
              String(
                (typedEvent.assistantMessageEvent as Record<string, unknown>)
                  .delta ??
                  (typedEvent.assistantMessageEvent as Record<string, unknown>)
                    .content ??
                  "",
              ),
            ),
          }
        : undefined,
      message: summarizeMessage(typedEvent.message),
    });
  });

  pi.on("message_end", async (event, ctx) => {
    if (ctx.model?.provider !== "cursor") return;
    debugExtensionLog("message.end", {
      sessionId: ctx.sessionManager.getSessionId(),
      leafId: ctx.sessionManager.getLeafId?.(),
      model: ctx.model?.id,
      message: summarizeMessage((event as { message?: unknown }).message),
      branch: summarizeBranchTail(ctx),
    });
  });

  pi.on("context", async (event, ctx) => {
    if (ctx.model?.provider !== "cursor") return;
    const typedEvent = event as { messages?: unknown[] };
    debugExtensionLog("context", {
      sessionId: ctx.sessionManager.getSessionId(),
      leafId: ctx.sessionManager.getLeafId?.(),
      model: ctx.model?.id,
      messageCount: Array.isArray(typedEvent.messages)
        ? typedEvent.messages.length
        : undefined,
      messages: Array.isArray(typedEvent.messages)
        ? typedEvent.messages
            .slice(-8)
            .map((message) => summarizeMessage(message))
        : undefined,
      branch: summarizeBranchTail(ctx),
    });
  });

  pi.on("turn_end", async (event, ctx) => {
    if (ctx.model?.provider !== "cursor") return;
    const typedEvent = event as {
      turnIndex?: number;
      message?: unknown;
      toolResults?: unknown[];
    };
    debugExtensionLog("turn.end", {
      sessionId: ctx.sessionManager.getSessionId(),
      leafId: ctx.sessionManager.getLeafId?.(),
      model: ctx.model?.id,
      turnIndex: typedEvent.turnIndex,
      message: summarizeMessage(typedEvent.message),
      toolResults: Array.isArray(typedEvent.toolResults)
        ? typedEvent.toolResults.map((message) => summarizeMessage(message))
        : undefined,
      branch: summarizeBranchTail(ctx),
    });
  });

  debugExtensionLog("extension.debug_hooks_registered", {
    logFile: getExtensionDebugLogFilePath(),
  });
}

export default async function (pi: ExtensionAPI): Promise<void> {
  // Current access token, updated by login/refresh/getApiKey
  let currentToken = "";

  // Start proxy eagerly — it just binds a port, no auth needed until a request arrives.
  // The getAccessToken callback reads currentToken at request time.
  const proxyReady = startProxy(async () => {
    if (!currentToken)
      throw new Error("Not logged in to Cursor. Run /login cursor");
    return currentToken;
  });

  const skipDedup = !!process.env.PI_CURSOR_RAW_MODELS;

  registerSessionLifecycleCleanup(pi);
  registerExtensionDebugHooks(pi);
  debugExtensionLog("extension.start", {
    debugLogFile: isExtensionDebugEnabled()
      ? getExtensionDebugLogFilePath()
      : undefined,
  });

  pi.on("before_provider_request", (event, ctx) => {
    const payload = event.payload as Record<string, unknown> | undefined;
    if (payload && ctx.model?.provider === "cursor") {
      payload.pi_session_id = ctx.sessionManager.getSessionId();
      debugExtensionLog("before_provider_request", {
        sessionId: ctx.sessionManager.getSessionId(),
        leafId: ctx.sessionManager.getLeafId?.(),
        model: ctx.model?.id,
        payload: summarizeProviderPayload(payload),
        branch: summarizeBranchTail(ctx),
      });
    }
    return payload;
  });

  // Await proxy so models are registered before pi proceeds with model resolution.
  // Prefer the on-disk cache from the last successful discovery so a fresh
  // process registers current models (e.g. Opus 4.8) synchronously — before Pi
  // resolves enabledModels — instead of the stale bundled snapshot.
  const port = await proxyReady;
  register(pi, port, loadCachedModels() ?? FALLBACK_MODELS);

  // Discovery only happens on OAuth login/refresh, which may not fire when a
  // stored token is still valid. Trigger it once as soon as we have a token so
  // the model list refreshes every session, not just on auth changes.
  let startupDiscoveryDone = false;
  async function ensureStartupDiscovery(token: string): Promise<void> {
    if (startupDiscoveryDone || !token) return;
    startupDiscoveryDone = true;
    try {
      const discovered = await getCursorModels(token);
      if (discovered.length > 0) register(pi, await proxyReady, discovered);
    } catch {
      startupDiscoveryDone = false;
    }
  }

  function register(pi: ExtensionAPI, port: number, rawModels: CursorModel[]) {
    const baseUrl = `http://127.0.0.1:${port}/v1`;
    const current = rawModels.filter((m) => !isLegacyCursorModelId(m.id));
    const processed = skipDedup
      ? current.map(
          (m) => ({ ...m, supportsEffort: false }) as ProcessedModel,
        )
      : processModels(current);

    pi.registerProvider("cursor", {
      baseUrl,
      api: "openai-completions",
      models: processed.map(modelConfig),
      oauth: {
        name: "Cursor",

        async login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
          const { verifier, uuid, loginUrl } = await generateCursorAuthParams();
          callbacks.onAuth({ url: loginUrl });
          const { accessToken, refreshToken } = await pollCursorAuth(
            uuid,
            verifier,
          );
          currentToken = accessToken;

          // Discover real models and re-register
          const realPort = await proxyReady;
          const discovered = await getCursorModels(accessToken);
          if (discovered.length > 0) register(pi, realPort, discovered);

          return {
            refresh: refreshToken,
            access: accessToken,
            expires: getTokenExpiry(accessToken),
          };
        },

        async refreshToken(
          credentials: OAuthCredentials,
        ): Promise<OAuthCredentials> {
          const refreshed = await refreshCursorToken(credentials.refresh);
          currentToken = refreshed.access;

          // Discover real models on refresh too
          const realPort = await proxyReady;
          const discovered = await getCursorModels(refreshed.access);
          if (discovered.length > 0) register(pi, realPort, discovered);

          return refreshed;
        },

        getApiKey(credentials: OAuthCredentials): string {
          currentToken = credentials.access;
          void ensureStartupDiscovery(credentials.access);
          return "cursor-proxy";
        },
      },
    });
  }
}
