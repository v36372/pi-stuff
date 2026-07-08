import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	findAssistantMessageByEntryId,
	getLastAssistantMessageSnapshot,
	getRecentAssistantMessages,
	type LastAssistantMessageSnapshot,
} from "../assistant-message.js";
import { startAnnotateServer, type AnnotateServerResult } from "../server/serverAnnotate.js";
import { isRemoteSession, openBrowser } from "../server/network.js";
import { loadConfig, resolveSharingEnabled } from "../generated/config.js";
import { parseAnnotateArgs } from "../generated/annotate-args.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

let planHtmlContent = "";
try {
	planHtmlContent = readFileSync(resolve(__dirname, "../plannotator.html"), "utf-8");
} catch {
	// Built asset missing.
}

function getStartupErrorMessage(err: unknown): string {
	return err instanceof Error ? err.message : "Unknown error";
}

function excerptText(text: string, maxChars = 1000): string {
	const trimmed = text.trim();
	if (trimmed.length <= maxChars) return trimmed;
	return `${trimmed.slice(0, maxChars).trimEnd()}...`;
}

function blockquote(text: string): string {
	return text
		.split("\n")
		.map((line) => `> ${line}`)
		.join("\n");
}

function anchorMessageFeedback(feedback: string, originalMessage: string): string {
	return `This feedback applies to the earlier assistant response excerpted below:

${blockquote(excerptText(originalMessage))}

User feedback:
${feedback}`;
}

function hasSessionMovedPastEntry(ctx: ExtensionContext, entryId: string): boolean {
	if (!ctx.isIdle()) return true;
	const branch = ctx.sessionManager.getBranch() as Array<{ id: string; type: string }>;
	const index = branch.findIndex((entry) => entry.id === entryId);
	if (index === -1) return true;
	return branch.slice(index + 1).some((entry) => entry.type === "message");
}

function buildFeedbackMessage(
	ctx: ExtensionContext,
	snapshot: LastAssistantMessageSnapshot,
	result: Awaited<ReturnType<AnnotateServerResult["waitForDecision"]>>,
): string {
	const target =
		result.selectedMessageId && result.selectedMessageId !== snapshot.entryId
			? findAssistantMessageByEntryId(ctx, result.selectedMessageId) ?? snapshot
			: snapshot;

	const feedback =
		result.feedbackScope !== "messages" && hasSessionMovedPastEntry(ctx, target.entryId)
			? anchorMessageFeedback(result.feedback, target.text)
			: result.feedback;

	return feedback;
}

async function openBrowserForServer(serverUrl: string, ctx: ExtensionContext): Promise<void> {
	const browserResult = await openBrowser(serverUrl);
	if (isRemoteSession()) {
		ctx.ui.notify(`[Annotate Last] ${serverUrl}`, "info");
	} else if (!browserResult.opened) {
		ctx.ui.notify(`Open this URL to annotate: ${serverUrl}`, "info");
	}
}

export default function (pi: ExtensionAPI): void {
	pi.registerCommand("annotate-last", {
		description: "Annotate the last assistant message in the Plannotator UI (pass --gate for review-gate mode)",
		handler: async (args, ctx) => {
			const { gate } = parseAnnotateArgs(args ?? "");
			if (!ctx.hasUI) {
				ctx.ui.notify("Annotation UI is not available in this session.", "error");
				return;
			}
			if (!planHtmlContent) {
				ctx.ui.notify(
					"Annotation UI assets are missing. Build the extension before using it.",
					"error",
				);
				return;
			}

			const snapshot = getLastAssistantMessageSnapshot(ctx);
			if (!snapshot) {
				ctx.ui.notify("No assistant message found in session.", "error");
				return;
			}

			const recent = getRecentAssistantMessages(ctx, 25);
			const pickerMessages = recent.length > 1 ? recent : undefined;

			ctx.ui.notify("Opening annotation UI for last message...", "info");

			let server: Awaited<ReturnType<typeof startAnnotateServer>> | undefined;
			try {
				const config = loadConfig();
				server = await startAnnotateServer({
					markdown: snapshot.text,
					filePath: "last-message",
					htmlContent: planHtmlContent,
					origin: "pi",
					mode: "annotate-last",
					gate,
					recentMessages: pickerMessages,
					sharingEnabled: resolveSharingEnabled(config),
					shareBaseUrl: process.env.PLANNOTATOR_SHARE_URL || undefined,
					pasteApiUrl: process.env.PLANNOTATOR_PASTE_URL || undefined,
					agentCwd: ctx.cwd,
					project: "annotate-last",
				});

				await openBrowserForServer(server.url, ctx);

				const result = await server.waitForDecision();

				if (result.exit) {
					ctx.ui.notify("Annotation session closed.", "info");
					return;
				}
				if (result.approved) {
					ctx.ui.notify("Message approved.", "info");
					return;
				}
				if (!result.feedback) {
					ctx.ui.notify("Annotation closed (no feedback).", "info");
					return;
				}

				const feedback = buildFeedbackMessage(ctx, snapshot, result);
				pi.sendUserMessage(feedback, { deliverAs: "followUp" });
			} catch (err) {
				ctx.ui.notify(
					`Failed to start annotation UI: ${getStartupErrorMessage(err)}`,
					"error",
				);
			} finally {
				server?.stop();
			}
		},
	});
}
