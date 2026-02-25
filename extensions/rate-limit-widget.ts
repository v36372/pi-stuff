/**
 * rate-limit-widget.ts
 *
 * Minimal Pi extension: shows a compact rate-limit progress bar below the
 * editor for Anthropic (Claude) and OpenAI Codex.
 *
 * Install (one-time): add the absolute path to this file in ~/.pi/settings.json:
 *   { "extensions": ["/absolute/path/to/rate-limit-widget.ts"] }
 */

import type { AuthStorage, ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { type Component, truncateToWidth } from "@mariozechner/pi-tui";
import type { Theme } from "@mariozechner/pi-coding-agent";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface RateLimitWindow {
  label: string;
  usedPercent: number;
  resetsAt: Date | null;
  windowSeconds?: number;
}

interface ProviderRateLimits {
  provider: string;
  windows: RateLimitWindow[];
  error?: string;
}

type ProviderKey = "anthropic" | "openai-codex";
type FillColor = "success" | "warning" | "error";

// ---------------------------------------------------------------------------
// Timeout helper
// ---------------------------------------------------------------------------

function makeTimeoutSignal(ms: number, outer?: AbortSignal): AbortSignal {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  ctrl.signal.addEventListener("abort", () => clearTimeout(t), { once: true });
  if (outer) {
    if (outer.aborted) ctrl.abort();
    outer.addEventListener("abort", () => ctrl.abort(), { once: true });
  }
  return ctrl.signal;
}

// ---------------------------------------------------------------------------
// Claude rate-limit fetcher
// ---------------------------------------------------------------------------

async function fetchClaudeRateLimits(
  authStorage: AuthStorage,
  outer?: AbortSignal,
): Promise<ProviderRateLimits> {
  const token = await authStorage.getApiKey("anthropic");
  if (!token) return { provider: "Claude", windows: [], error: "No API key" };

  const sig = makeTimeoutSignal(5000, outer);
  const headers = {
    Authorization: `Bearer ${token}`,
    "anthropic-beta": "oauth-2025-04-20",
  };

  try {
    const res = await fetch("https://api.anthropic.com/api/oauth/usage", {
      headers,
      signal: sig,
    });
    if (!res.ok) {
      const err = res.status === 401 || res.status === 403 ? "Token expired" : "Fetch failed";
      return { provider: "Claude", windows: [], error: err };
    }

    const json = (await res.json()) as {
      five_hour?: { utilization?: number; resets_at?: string } | null;
      seven_day?: { utilization?: number; resets_at?: string } | null;
      seven_day_sonnet?: { utilization?: number; resets_at?: string } | null;
      seven_day_opus?: { utilization?: number; resets_at?: string } | null;
    };

    const build = (
      label: string,
      entry?: { utilization?: number; resets_at?: string } | null,
      windowSeconds?: number,
    ): RateLimitWindow | null => {
      if (!entry) return null;
      return {
        label,
        usedPercent: Math.max(0, Math.min(100, entry.utilization ?? 0)),
        resetsAt: entry.resets_at ? new Date(entry.resets_at) : null,
        windowSeconds,
      };
    };

    const windows = [
      build("5h", json.five_hour, 5 * 60 * 60),
      build("7d (all)", json.seven_day, 7 * 24 * 60 * 60),
      build("7d (sonnet)", json.seven_day_sonnet, 7 * 24 * 60 * 60),
      build("7d (opus)", json.seven_day_opus, 7 * 24 * 60 * 60),
    ].filter((w): w is RateLimitWindow => w !== null);

    return { provider: "Claude", windows };
  } catch {
    return { provider: "Claude", windows: [], error: "Network error" };
  }
}

// ---------------------------------------------------------------------------
// Codex rate-limit fetcher
// ---------------------------------------------------------------------------

async function fetchCodexRateLimits(
  authStorage: AuthStorage,
  outer?: AbortSignal,
): Promise<ProviderRateLimits> {
  const token = await authStorage.getApiKey("openai-codex");
  if (!token) return { provider: "Codex", windows: [], error: "No API key" };

  const credential = authStorage.get("openai-codex") as
    | { accountId?: string; account_id?: string }
    | undefined;
  const accountId = credential?.accountId ?? credential?.account_id;

  const sig = makeTimeoutSignal(5000, outer);
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "User-Agent": "PiUsage",
    Accept: "application/json",
  };
  if (accountId) headers["ChatGPT-Account-Id"] = accountId;

  try {
    const res = await fetch("https://chatgpt.com/backend-api/wham/usage", {
      headers,
      signal: sig,
    });
    if (!res.ok) {
      const err = res.status === 401 || res.status === 403 ? "Token expired" : "Fetch failed";
      return { provider: "Codex", windows: [], error: err };
    }

    const json = (await res.json()) as {
      rate_limit?: {
        primary_window?: {
          used_percent?: number;
          limit_window_seconds?: number;
          reset_at?: number;
        } | null;
        secondary_window?: {
          used_percent?: number;
          limit_window_seconds?: number;
          reset_at?: number;
        } | null;
      };
    };

    const buildCodexWindow = (
      fallbackLabel: string,
      entry?: {
        used_percent?: number;
        limit_window_seconds?: number;
        reset_at?: number;
      } | null,
    ): RateLimitWindow | null => {
      if (!entry) return null;
      const secs = entry.limit_window_seconds ?? 0;
      const label =
        secs >= 86400
          ? `${Math.round(secs / 86400)}d`
          : secs >= 3600
            ? `${Math.round(secs / 3600)}h`
            : fallbackLabel;
      return {
        label,
        usedPercent: Math.max(0, Math.min(100, entry.used_percent ?? 0)),
        resetsAt: entry.reset_at ? new Date(entry.reset_at * 1000) : null,
        windowSeconds: secs > 0 ? secs : undefined,
      };
    };

    const windows = [
      buildCodexWindow("5h", json.rate_limit?.primary_window),
      buildCodexWindow("7d", json.rate_limit?.secondary_window),
    ].filter((w): w is RateLimitWindow => w !== null);

    return { provider: "Codex", windows };
  } catch {
    return { provider: "Codex", windows: [], error: "Network error" };
  }
}

const DISPLAY_NAMES: Record<ProviderKey, string> = {
  anthropic: "Claude",
  "openai-codex": "Codex",
};

// ---------------------------------------------------------------------------
// Bar rendering helpers
// ---------------------------------------------------------------------------

function getPacePercent(w: RateLimitWindow): number | null {
  if (!w.windowSeconds || !w.resetsAt) return null;
  const totalMs = w.windowSeconds * 1000;
  if (!totalMs || !Number.isFinite(totalMs)) return null;
  const elapsed = totalMs - (w.resetsAt.getTime() - Date.now());
  return Math.max(0, Math.min(100, (elapsed / totalMs) * 100));
}

function getProjectedPercent(used: number, pace: number | null): number {
  if (pace === null) return used;
  const effectivePace = Math.max(5, pace);
  return Math.max(0, (used / effectivePace) * 100);
}

function getFillColor(projected: number): FillColor {
  if (projected >= 90) return "error";
  if (projected >= 80) return "warning";
  return "success";
}

function formatTimeRemaining(w: RateLimitWindow): string {
  if (!w.resetsAt || !w.windowSeconds) return "?";
  const totalSec = w.windowSeconds;
  const remainSec = Math.max(0, (w.resetsAt.getTime() - Date.now()) / 1000);
  const elapsedSec = totalSec - remainSec;

  const unit =
    totalSec >= 24 * 60 * 60
      ? { label: "d", secs: 86400 }
      : totalSec >= 60 * 60
        ? { label: "h", secs: 3600 }
        : { label: "m", secs: 60 };

  const fmt = (s: number) => {
    const v = s / unit.secs;
    const r = Math.round(v * 10) / 10;
    return Number.isInteger(r) ? r.toFixed(0) : r.toFixed(1);
  };

  return `${fmt(elapsedSec)}/${fmt(totalSec)}${unit.label}`;
}

function renderBar(w: RateLimitWindow, barWidth: number, theme: Theme): string {
  const pace = getPacePercent(w);
  const projected = getProjectedPercent(w.usedPercent, pace);
  const fillColor = getFillColor(projected);
  const percent = Math.round(w.usedPercent);
  const filled = Math.round((Math.max(0, Math.min(100, percent)) / 100) * barWidth);

  const markerIndex =
    pace === null
      ? null
      : Math.max(0, Math.min(barWidth - 1, Math.round((pace / 100) * (barWidth - 1))));

  const bar = Array.from({ length: barWidth }, (_, i) => {
    if (i === markerIndex) return theme.fg("accent", "│");
    return i < filled ? theme.fg(fillColor, "━") : theme.fg("dim", "─");
  }).join("");

  const timeStr = formatTimeRemaining(w);
  const pctStr = theme.fg(fillColor, `${percent}%`);

  return `${w.label} (${timeStr}) ${bar} ${pctStr}`;
}

// ---------------------------------------------------------------------------
// Widget component
// ---------------------------------------------------------------------------

const WIDGET_ID = "rate-limit";

class RateLimitWidget implements Component {
  constructor(
    private theme: Theme,
    private providerState: Record<ProviderKey, ProviderRateLimits | null>,
    private loadingState: Record<ProviderKey, boolean>,
  ) {}

  private renderProviderLine(width: number, providerKey: ProviderKey): string {
    const th = this.theme;
    const name = DISPLAY_NAMES[providerKey];
    const limits = this.providerState[providerKey];
    const loading = this.loadingState[providerKey];

    if (loading || !limits) {
      return truncateToWidth(`${th.fg("accent", name)}${th.fg("dim", " Loading…")}`, width);
    }

    if (limits.error) {
      return truncateToWidth(`${th.fg("dim", name)} ${th.fg("error", limits.error)}`, width);
    }

    const windows = limits.windows;
    if (!windows.length) {
      return truncateToWidth(`${th.fg("dim", name)} (no data)`, width);
    }

    const windowFixedWidths = windows.map((w) => {
      const time = formatTimeRemaining(w);
      const pct = Math.round(w.usedPercent);
      return w.label.length + 2 + time.length + 2 + 1 + String(pct).length + 1;
    });

    let fixedTotal = name.length + 3 * windows.length;
    for (const fw of windowFixedWidths) fixedTotal += fw;

    const remaining = Math.max(0, width - fixedTotal);
    const barWidth = Math.max(8, Math.floor(remaining / windows.length));

    const parts: string[] = [th.fg("accent", name)];
    for (const w of windows) {
      parts.push(renderBar(w, barWidth, th));
    }

    return truncateToWidth(parts.join(th.fg("dim", " | ")), width);
  }

  render(width: number): string[] {
    const th = this.theme;
    const sep = th.fg("borderMuted", "─".repeat(width));

    return [
      this.renderProviderLine(width, "anthropic"),
      this.renderProviderLine(width, "openai-codex"),
      sep,
    ];
  }

  invalidate(): void {}
}

// ---------------------------------------------------------------------------
// Extension state & refresh logic
// ---------------------------------------------------------------------------

const providerState: Record<ProviderKey, ProviderRateLimits | null> = {
  anthropic: null,
  "openai-codex": null,
};

const loadingState: Record<ProviderKey, boolean> = {
  anthropic: true,
  "openai-codex": true,
};

let lastFetchTime: number | null = null;
const REFRESH_INTERVAL_MS = 5 * 60 * 1000;

function shouldRefresh(): boolean {
  if (!lastFetchTime) return true;
  return Date.now() - lastFetchTime >= REFRESH_INTERVAL_MS;
}

// biome-ignore lint/suspicious/noExplicitAny: ExtensionContext uses any
function updateWidget(ctx: any): void {
  if (!ctx.hasUI) return;
  ctx.ui.setWidget(
    WIDGET_ID,
    (_tui: unknown, theme: Theme) => new RateLimitWidget(theme, providerState, loadingState),
    { placement: "belowEditor" },
  );
}

async function refreshRateLimits(
  // biome-ignore lint/suspicious/noExplicitAny: ExtensionContext uses any
  ctx: any,
  force = false,
): Promise<void> {
  if (!ctx.hasUI) return;

  if (!force && !shouldRefresh()) {
    updateWidget(ctx);
    return;
  }

  loadingState.anthropic = true;
  loadingState["openai-codex"] = true;
  updateWidget(ctx);

  try {
    const auth = ctx.modelRegistry.authStorage;
    const [claude, codex] = await Promise.all([
      fetchClaudeRateLimits(auth),
      fetchCodexRateLimits(auth),
    ]);

    providerState.anthropic = claude;
    providerState["openai-codex"] = codex;
    lastFetchTime = Date.now();
  } catch {
    // Keep existing cache on error
  } finally {
    loadingState.anthropic = false;
    loadingState["openai-codex"] = false;
    updateWidget(ctx);
  }
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function rateLimitWidgetExtension(pi: ExtensionAPI): void {
  pi.on("session_start", async (_event, ctx) => {
    providerState.anthropic = null;
    providerState["openai-codex"] = null;
    loadingState.anthropic = true;
    loadingState["openai-codex"] = true;
    lastFetchTime = null;
    updateWidget(ctx);
    refreshRateLimits(ctx, true).catch(() => {});
  });

  pi.on("model_select", async (_event, ctx) => {
    updateWidget(ctx);
    refreshRateLimits(ctx, true).catch(() => {});
  });

  pi.on("agent_end", async (_event, ctx) => {
    refreshRateLimits(ctx).catch(() => {});
  });
}
