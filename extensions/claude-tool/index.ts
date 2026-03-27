/**
 * Claude Tool — Invoke Claude Code from within pi (cmux-based async version)
 *
 * Registers a `claude` tool that launches Claude Code CLI in a cmux pane.
 * Returns immediately — results delivered via steer message when Claude exits.
 *
 * Completion detection uses two layers:
 *   1. Sentinel file: PI_CLAUDE_SENTINEL=/tmp/pi-claude-<id>-done is set in env.
 *      Claude Code can create this file when it finishes (via the plugin).
 *   2. Screen sentinel: the command appends `; echo '__SUBAGENT_DONE_<exit>__'`
 *      which appears in the terminal output when the process exits.
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { keyHint } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { Box, Text, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { dirname, join } from "node:path";
import { existsSync, unlinkSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  isMuxAvailable,
  muxSetupHint,
  createSurface,
  sendCommand,
  closeSurface,
  readScreen,
  shellEscape,
  exitStatusVar,
} from "../../git/github.com/HazAT/pi-interactive-subagents/pi-extension/subagents/cmux.ts";

// ── State ──

interface RunningClaude {
  id: string;
  name: string;
  prompt: string;
  surface: string;
  startTime: number;
  sentinelFile: string;
  abortController: AbortController;
}

const runningClaude = new Map<string, RunningClaude>();

// ── Widget helpers ──

let latestCtx: ExtensionContext | null = null;
let widgetInterval: ReturnType<typeof setInterval> | null = null;

const ACCENT = "\x1b[38;2;77;163;255m";
const RST = "\x1b[0m";

function formatElapsedMMSS(startTime: number): string {
  const seconds = Math.floor((Date.now() - startTime) / 1000);
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function borderTop(title: string, info: string, width: number): string {
  const inner = Math.max(0, width - 2);
  const titlePart = `─ ${title} `;
  const infoPart = ` ${info} ─`;
  const fillLen = Math.max(0, inner - titlePart.length - infoPart.length);
  const fill = "─".repeat(fillLen);
  const content = `${titlePart}${fill}${infoPart}`.slice(0, inner).padEnd(inner, "─");
  return `${ACCENT}╭${content}╮${RST}`;
}

function borderLine(left: string, right: string, width: number): string {
  const contentWidth = Math.max(0, width - 2);
  const rightVis = visibleWidth(right);
  const maxLeft = Math.max(0, contentWidth - rightVis);
  const truncLeft = truncateToWidth(left, maxLeft);
  const leftVis = visibleWidth(truncLeft);
  const pad = Math.max(0, contentWidth - leftVis - rightVis);
  return `${ACCENT}│${RST}${truncLeft}${" ".repeat(pad)}${right}${ACCENT}│${RST}`;
}

function borderBottom(width: number): string {
  const inner = Math.max(0, width - 2);
  return `${ACCENT}╰${"─".repeat(inner)}╯${RST}`;
}

function updateWidget() {
  if (!latestCtx?.hasUI) return;

  if (runningClaude.size === 0) {
    latestCtx.ui.setWidget("claude-status", undefined);
    if (widgetInterval) {
      clearInterval(widgetInterval);
      widgetInterval = null;
    }
    return;
  }

  latestCtx.ui.setWidget(
    "claude-status",
    (_tui: any, _theme: any) => ({
      invalidate() {},
      render(width: number) {
        const count = runningClaude.size;
        const lines: string[] = [borderTop("Claude Code", `${count} running`, width)];
        for (const [, session] of runningClaude) {
          const elapsed = formatElapsedMMSS(session.startTime);
          const firstLine = session.prompt.split("\n").find((l) => l.trim()) ?? session.prompt;
          const label = ` ${elapsed}  `;
          const nameAvail = Math.max(0, width - 2 - visibleWidth(label));
          const name = truncateToWidth(firstLine, nameAvail);
          lines.push(borderLine(label + name, "", width));
        }
        lines.push(borderBottom(width));
        return lines;
      },
    }),
    { placement: "aboveEditor" },
  );
}

function startWidgetRefresh() {
  if (widgetInterval) return;
  updateWidget();
  widgetInterval = setInterval(updateWidget, 1000);
}

// ── watchClaude ──

async function watchClaude(running: RunningClaude, signal: AbortSignal, pi: ExtensionAPI): Promise<void> {
  const { surface, sentinelFile } = running;

  try {
    // Poll for completion via sentinel file or screen sentinel
    while (!signal.aborted) {
      await new Promise<void>((resolve) => setTimeout(resolve, 1000));
      if (signal.aborted) break;

      // Check sentinel file (created by Claude plugin)
      if (existsSync(sentinelFile)) break;

      // Check screen buffer for exit marker
      const screen = readScreen(surface, 5);
      if (/__SUBAGENT_DONE_\d+__/.test(screen)) break;
    }

    if (signal.aborted) {
      closeSurface(surface);
      try { unlinkSync(sentinelFile); } catch {}
      runningClaude.delete(running.id);
      updateWidget();
      return;
    }

    const startTime = running.startTime;
    const elapsed = Math.floor((Date.now() - startTime) / 1000);

    // Try to read result from sentinel file first (contains last_assistant_message)
    // Fall back to screen buffer if sentinel has no content
    let resultContent = "";
    try {
      resultContent = readFileSync(sentinelFile, "utf-8").trim();
    } catch {}

    if (!resultContent) {
      resultContent = readScreen(surface, 200)
        .replace(/__SUBAGENT_DONE_\d+__/, "")
        .trimEnd();
    }

    closeSurface(surface);
    try { unlinkSync(sentinelFile); } catch {}
    runningClaude.delete(running.id);
    updateWidget();

    pi.sendMessage(
      {
        customType: "claude_result",
        content: resultContent,
        display: true,
        details: {
          name: running.name,
          prompt: running.prompt,
          elapsed,
          id: running.id,
        },
      },
      { triggerTurn: true, deliverAs: "steer" },
    );
  } catch (err: any) {
    try { closeSurface(surface); } catch {}
    try { unlinkSync(sentinelFile); } catch {}
    runningClaude.delete(running.id);
    updateWidget();

    pi.sendMessage(
      {
        customType: "claude_result",
        content: `Claude Code error: ${err?.message ?? String(err)}`,
        display: true,
        details: { name: running.name, prompt: running.prompt, elapsed: 0, id: running.id, error: err?.message },
      },
      { triggerTurn: true, deliverAs: "steer" },
    );
  }
}

// ── Extension ──

export default function (pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    latestCtx = ctx;
  });

  pi.on("session_shutdown", (_event, _ctx) => {
    if (widgetInterval) {
      clearInterval(widgetInterval);
      widgetInterval = null;
    }
    for (const [, session] of runningClaude) {
      session.abortController.abort();
      try { closeSurface(session.surface); } catch {}
      try { unlinkSync(session.sentinelFile); } catch {}
    }
    runningClaude.clear();
  });

  pi.registerTool({
    name: "claude",
    label: "Claude Code",
    description:
      "Spawn a self-driving Claude Code session for deep investigation and research. " +
      "Claude Code has full autonomy: web search, bash, file access, git clone, curl, code editing — everything. " +
      "Use it as a hands-off research agent that investigates topics, clones repos, downloads and analyzes links, " +
      "tries things out, and comes back with detailed findings. " +
      "IMPORTANT: This tool returns IMMEDIATELY — the session runs asynchronously in the background. " +
      "Results are delivered later via a steer message. Do NOT fabricate or assume results.",

    promptSnippet:
      "Spawn a self-driving Claude Code session for deep investigation and research. " +
      "Claude Code has full autonomy: web search, bash, file access, git clone, curl, code editing — everything. " +
      "Use it as a hands-off research agent that investigates topics, clones repos, downloads and analyzes links, " +
      "tries things out, and comes back with detailed findings. " +
      "IMPORTANT: This tool returns IMMEDIATELY — results delivered via steer message. " +
      "Do NOT fabricate or assume results. Set resumeSessionId to continue a previous session.",

    promptGuidelines: [
      "Use claude as your go-to research and investigation tool — it's a fully autonomous agent with web search, bash, git, curl, and all coding tools.",
      "Delegate to claude when: investigating a library/API, exploring a repo, downloading and analyzing links, deep multi-file investigations, trying out approaches, or any task that benefits from autonomous exploration.",
      "For simple file reads, single edits, or quick commands you already know the answer to — use your own tools directly, don't spawn a full session.",
      "Give claude clear investigation goals and let it drive — it will clone repos, read docs, try things, and report back.",
    ],

    parameters: Type.Object({
      prompt: Type.String({ description: "The task or question for Claude Code" }),
      model: Type.Optional(
        Type.String({
          description: 'Model to use (default: "sonnet"). Examples: "sonnet", "opus", "haiku"',
        }),
      ),
      systemPrompt: Type.Optional(
        Type.String({ description: "Additional system prompt instructions to append" }),
      ),
      resumeSessionId: Type.Optional(
        Type.String({
          description:
            "Resume a previous Claude Code session by its ID. " +
            "Loads the conversation history and continues where it left off. " +
            "The session ID is returned in details of every claude tool call. " +
            "Use this to retry cancelled runs or ask follow-up questions.",
        }),
      ),
    }),

    async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
      if (!isMuxAvailable()) {
        return {
          content: [{ type: "text", text: `Claude Code requires a terminal multiplexer. ${muxSetupHint()}` }],
          details: { error: "mux not available" },
          isError: true,
        };
      }

      const { prompt, model, systemPrompt, resumeSessionId } = params;

      const id = Math.random().toString(16).slice(2, 10);
      const sentinelFile = `/tmp/pi-claude-${id}-done`;
      const pluginDir = join(dirname(fileURLToPath(import.meta.url)), "plugin");
      const shortPrompt = prompt.length > 40 ? prompt.slice(0, 40) + "…" : prompt;

      const surface = createSurface(`Claude: ${shortPrompt}`);
      await new Promise<void>((resolve) => setTimeout(resolve, 500));

      // Build claude CLI command
      const parts: string[] = [
        `PI_CLAUDE_SENTINEL=${shellEscape(sentinelFile)}`,
        "claude",
        "--dangerously-skip-permissions",
      ];

      if (existsSync(pluginDir)) {
        parts.push("--plugin-dir", shellEscape(pluginDir));
      }

      if (model) parts.push("--model", shellEscape(model));
      if (systemPrompt) parts.push("--append-system-prompt", shellEscape(systemPrompt));
      if (resumeSessionId) parts.push("--resume", shellEscape(resumeSessionId));

      parts.push(shellEscape(prompt));
      parts.push(`; echo '__SUBAGENT_DONE_'${exitStatusVar()}'__'`);

      const command = parts.join(" ");
      sendCommand(surface, command);

      const abortController = new AbortController();
      if (signal) {
        signal.addEventListener("abort", () => abortController.abort());
      }

      const running: RunningClaude = {
        id,
        name: shortPrompt,
        prompt,
        surface,
        startTime: Date.now(),
        sentinelFile,
        abortController,
      };

      runningClaude.set(id, running);
      startWidgetRefresh();

      // Fire-and-forget watcher
      watchClaude(running, abortController.signal, pi).catch(() => {});

      return {
        content: [
          {
            type: "text",
            text:
              "Claude Code launched and running in background. " +
              "Results delivered via steer message when complete. " +
              "Do NOT fabricate or assume results — wait for the steer message.",
          },
        ],
        details: { id, status: "started" },
      };
    },

    renderCall(args, theme) {
      const prompt = args.prompt ?? "";
      const firstLine = prompt.split("\n").find((l: string) => l.trim()) ?? "";
      const preview = firstLine.length > 100 ? firstLine.slice(0, 100) + "…" : firstLine;
      let text = "▸ " + theme.fg("toolTitle", theme.bold("Claude Code"));
      if (args.model) text += theme.fg("dim", ` [${args.model}]`);
      if (preview) text += "\n" + theme.fg("toolOutput", preview);
      return new Text(text, 0, 0);
    },

    renderResult(result, _opts, theme) {
      const details = result.details as any;
      if (details?.status === "started") {
        return new Text(
          theme.fg("accent", "▸") + " " + theme.fg("toolTitle", theme.bold("Claude Code")) + theme.fg("dim", " — started"),
          0,
          0,
        );
      }
      const text = typeof result.content?.[0]?.text === "string" ? result.content[0].text : "";
      return new Text(theme.fg("dim", text), 0, 0);
    },
  });

  // ── claude_result message renderer ──
  pi.registerMessageRenderer("claude_result", (message, options, theme) => {
    const details = message.details as any;
    if (!details) return undefined;

    return {
      render(width: number): string[] {
        const error = details.error;
        const bgFn = error
          ? (text: string) => theme.bg("toolErrorBg", text)
          : (text: string) => theme.bg("toolSuccessBg", text);
        const icon = error ? theme.fg("error", "✗") : theme.fg("success", "✓");
        const elapsed = details.elapsed != null
          ? (details.elapsed < 60 ? `${details.elapsed}s` : `${Math.floor(details.elapsed / 60)}m${details.elapsed % 60}s`)
          : "?";
        const header = `${icon} ${theme.fg("toolTitle", theme.bold("Claude Code"))} ${theme.fg("dim", `— ${elapsed}`)}`;

        const rawContent = typeof message.content === "string" ? message.content : "";
        const contentLines: string[] = [header];

        if (options.expanded) {
          for (const line of rawContent.split("\n")) {
            contentLines.push(line.slice(0, width - 6));
          }
        } else {
          if (rawContent) {
            const lines = rawContent.split("\n");
            const preview = lines.slice(0, 5);
            for (const line of preview) {
              contentLines.push(theme.fg("dim", line.slice(0, width - 6)));
            }
            if (lines.length > 5) {
              contentLines.push(theme.fg("muted", `… ${lines.length - 5} more lines`));
            }
          }
          contentLines.push(theme.fg("muted", keyHint("app.tools.expand", "to expand")));
        }

        // Render via Box for background + padding, with blank line above for separation
        const box = new Box(1, 1, bgFn);
        box.addChild(new Text(contentLines.join("\n"), 0, 0));
        return ["", ...box.render(width)];
      },
    };
  });
}
