import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AssistantMessage } from "@mariozechner/pi-ai";
import type {
	BranchSummaryEntry,
	ExtensionAPI,
	ExtensionCommandContext,
	SessionEntry,
} from "@mariozechner/pi-coding-agent";

const COMMAND_NAME = "chain";
const CUSTOM_TYPE = "chain-anchor";
const STATUS_KEY = "chain";
const STAGE_SEPARATOR = /^\s*-{4,}\s*$/m;
const PREVIOUS_ARTIFACT_PLACEHOLDER = "{{previous_artifact_path}}";

interface ChainStage {
	index: number;
	title: string;
	slug: string;
	prompt: string;
}

interface ChainArtifactRecord {
	index: number;
	title: string;
	artifactPath: string;
	summaryEntryId?: string;
	status: "completed" | "failed";
}

interface ChainRunManifest {
	runId: string;
	startedAt: string;
	promptSource: string;
	artifactDir: string;
	anchorId: string;
	readToolAvailable: boolean;
	status: "completed" | "failed" | "cancelled";
	finalArtifactPath?: string;
	stages: ChainArtifactRecord[];
}

interface ActiveChainRun {
	commandCtx: ExtensionCommandContext;
	stages: ChainStage[];
	manifest: ChainRunManifest;
	currentStageIndex: number;
	currentStageStartLeafId: string | null;
	currentStagePrompt: string;
	previousArtifactPath?: string;
	finalArtifactPath?: string;
	processingStageResult: boolean;
}

function stripWrappingQuotes(value: string): string {
	if (value.length < 2) return value;
	const first = value[0];
	const last = value[value.length - 1];
	if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
		return value.slice(1, -1);
	}
	return value;
}

function resolvePromptSourcePath(cwd: string, input: string): string {
	const trimmed = stripWrappingQuotes(input.trim()).replace(/^@/, "");
	if (trimmed.startsWith("~/")) {
		return path.join(os.homedir(), trimmed.slice(2));
	}
	return path.resolve(cwd, trimmed);
}

function deriveStageTitle(prompt: string, index: number): string {
	const firstLine = prompt
		.split("\n")
		.map((line) => line.trim())
		.find((line) => line.length > 0);

	if (!firstLine) return `Stage ${index}`;

	const cleaned = firstLine
		.replace(/^#+\s*/, "")
		.replace(/[`*_]/g, "")
		.trim();
	if (cleaned.length <= 72) return cleaned;
	return `${cleaned.slice(0, 69).trimEnd()}...`;
}

function slugifyStageTitle(title: string, index: number): string {
	const slug = title
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.split("-")
		.filter((part) => part.length > 0)
		.slice(0, 8)
		.join("-");

	return slug || `stage-${index}`;
}

function createStagesFromBlocks(blocks: string[]): ChainStage[] {
	return blocks.map((prompt, index) => {
		const stageIndex = index + 1;
		const title = deriveStageTitle(prompt, stageIndex);
		return {
			index: stageIndex,
			title,
			slug: slugifyStageTitle(title, stageIndex),
			prompt,
		};
	});
}

function parseNumberedStages(raw: string): string[] {
	const trimmed = raw.trim();
	if (!/^1[.)]\s+/.test(trimmed)) {
		return [];
	}

	const normalized = trimmed.includes("\n") ? trimmed : trimmed.replace(/\s+(?=\d+[.)]\s+)/g, "\n");
	const matches = [...normalized.matchAll(/^(\d+)[.)]\s+/gm)];
	if (matches.length === 0) {
		return [];
	}

	const blocks: string[] = [];
	for (let index = 0; index < matches.length; index++) {
		const match = matches[index];
		const itemStart = match.index ?? 0;
		const contentStart = itemStart + match[0].length;
		const nextItemStart = matches[index + 1]?.index ?? normalized.length;
		const prompt = normalized.slice(contentStart, nextItemStart).trim();
		if (prompt.length > 0) {
			blocks.push(prompt);
		}
	}
	return blocks;
}

function parseStages(raw: string): ChainStage[] {
	const normalized = raw.replace(/\r\n/g, "\n").trim();
	if (normalized.length === 0) {
		return [];
	}

	if (STAGE_SEPARATOR.test(normalized)) {
		const blocks = normalized
			.split(STAGE_SEPARATOR)
			.map((block) => block.trim())
			.filter((block) => block.length > 0);
		return createStagesFromBlocks(blocks);
	}

	const numberedBlocks = parseNumberedStages(normalized);
	if (numberedBlocks.length > 0) {
		return createStagesFromBlocks(numberedBlocks);
	}

	return createStagesFromBlocks([normalized]);
}

function applyPlaceholders(prompt: string, values: Record<string, string>): string {
	let result = prompt;
	for (const [key, value] of Object.entries(values)) {
		result = result.split(`{{${key}}}`).join(value);
	}
	return result;
}

function buildStagePrompt(
	stage: ChainStage,
	totalStages: number,
	artifactDir: string,
	previousArtifactPath: string | undefined,
	readToolAvailable: boolean,
): string {
	const replacedPrompt = applyPlaceholders(stage.prompt, {
		previous_artifact_path: previousArtifactPath ?? "(no previous artifact)",
		artifact_dir: artifactDir,
		step_index: String(stage.index),
		step_count: String(totalStages),
	});

	if (!previousArtifactPath || stage.prompt.includes(PREVIOUS_ARTIFACT_PLACEHOLDER)) {
		return replacedPrompt;
	}

	const handoffInstructions = readToolAvailable
		? [
				`This is stage ${stage.index} of ${totalStages} in a chained /tree workflow.`,
				`Before continuing, use the read tool on this cumulative handoff artifact: ${previousArtifactPath}`,
				"Treat that markdown file as the authoritative result from the previous stage(s).",
			]
		: [
				`This is stage ${stage.index} of ${totalStages} in a chained /tree workflow.`,
				`A cumulative handoff artifact was written to: ${previousArtifactPath}`,
				"The read tool is not active, so rely on the collapsed branch summary already in context unless you re-enable read.",
			];

	return `${handoffInstructions.join("\n")}\n\n${replacedPrompt}`;
}

function buildBranchSummaryFocus(
	stage: ChainStage,
	totalStages: number,
	previousArtifactPath: string | undefined,
): string {
	const priorArtifactLine = previousArtifactPath
		? `Prior cumulative artifact: ${previousArtifactPath}`
		: "This is the first stage in the chain.";

	return [
		`This summary will be saved as the cumulative markdown handoff for stage ${stage.index}/${totalStages}.`,
		priorArtifactLine,
		`Current stage title: ${stage.title}`,
		"Make the summary self-contained for the next stage.",
		"Emphasize verified findings, disputed claims, exact file paths, concrete evidence, and unresolved uncertainty.",
	].join("\n");
}

function getBranchEntriesAfter(branch: readonly SessionEntry[], entryId: string | null): SessionEntry[] {
	if (entryId === null) {
		return [...branch];
	}

	const startIndex = branch.findIndex((entry) => entry.id === entryId);
	if (startIndex === -1) {
		return [...branch];
	}
	return branch.slice(startIndex + 1);
}

function isAssistantEntry(entry: SessionEntry): entry is SessionEntry & { type: "message"; message: AssistantMessage } {
	return entry.type === "message" && entry.message.role === "assistant";
}

function getLastAssistantMessage(entries: readonly SessionEntry[]): AssistantMessage | undefined {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (isAssistantEntry(entry)) {
			return entry.message;
		}
	}
	return undefined;
}

function extractAssistantText(message: AssistantMessage | undefined): string {
	if (!message) return "";
	return message.content
		.filter((block): block is { type: "text"; text: string } => block.type === "text")
		.map((block) => block.text)
		.join("\n")
		.trim();
}

function describeAssistantOutcome(message: AssistantMessage | undefined): string {
	if (!message) {
		return "No assistant response was captured for this stage.";
	}

	if (message.stopReason === "error") {
		return message.errorMessage?.trim() || "The stage ended with an assistant error.";
	}

	if (message.stopReason === "aborted") {
		return "The stage was aborted before the assistant completed.";
	}

	const text = extractAssistantText(message);
	return text || `The stage ended with stopReason=${message.stopReason}.`;
}

function getCurrentBranchSummary(ctx: ExtensionCommandContext): BranchSummaryEntry | undefined {
	const leafEntry = ctx.sessionManager.getLeafEntry();
	if (leafEntry?.type === "branch_summary") {
		return leafEntry;
	}
	return undefined;
}

function writeArtifactFile(args: {
	artifactDir: string;
	runId: string;
	promptSource: string;
	stage: ChainStage;
	totalStages: number;
	anchorId: string;
	effectivePrompt: string;
	previousArtifactPath: string | undefined;
	summaryEntry: BranchSummaryEntry | undefined;
	stageStatus: "completed" | "failed";
	failureDetails?: string;
}): string {
	const artifactPath = path.join(
		args.artifactDir,
		`${String(args.stage.index).padStart(2, "0")}-${args.stage.slug}.md`,
	);
	const latestArtifactPath = path.join(args.artifactDir, "latest.md");

	const summaryText = args.summaryEntry?.summary?.trim() || "No branch summary was produced for this stage.";
	const lines = [
		"# Chain Artifact",
		"",
		`- Run ID: ${args.runId}`,
		`- Stage: ${args.stage.index}/${args.totalStages}`,
		`- Title: ${args.stage.title}`,
		`- Generated: ${new Date().toISOString()}`,
		`- Prompt source: ${args.promptSource}`,
		`- Anchor entry: ${args.anchorId}`,
		`- Summary entry: ${args.summaryEntry?.id ?? "(none)"}`,
		`- Previous artifact: ${args.previousArtifactPath ?? "(none)"}`,
		`- Stage status: ${args.stageStatus}`,
		"",
		"## Stage Prompt Template",
		args.stage.prompt.trim(),
		"",
		"## Effective Stage Prompt",
		args.effectivePrompt.trim(),
		"",
		"## Cumulative Collapsed Summary",
		summaryText,
		"",
		"## Handoff Notes",
		"- This file is the cumulative handoff for the next chain stage.",
		`- Artifact directory: ${args.artifactDir}`,
		`- Latest artifact path: ${latestArtifactPath}`,
	];

	if (args.failureDetails) {
		lines.push("", "## Failure Details", args.failureDetails.trim());
	}

	const content = `${lines.join("\n")}\n`;
	fs.writeFileSync(artifactPath, content, { encoding: "utf8", mode: 0o600 });
	fs.writeFileSync(latestArtifactPath, content, { encoding: "utf8", mode: 0o600 });
	return artifactPath;
}

function writeManifestFile(manifest: ChainRunManifest): void {
	const manifestPath = path.join(manifest.artifactDir, "manifest.json");
	fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

function copyFinalArtifact(artifactDir: string, artifactPath: string): string {
	const finalArtifactPath = path.join(artifactDir, "final.md");
	fs.copyFileSync(artifactPath, finalArtifactPath);
	return finalArtifactPath;
}

function looksLikeInlineChain(input: string): boolean {
	const trimmed = input.trim();
	return trimmed.includes("\n") || trimmed.includes("----") || /^1[.)]\s+/.test(trimmed);
}

function looksLikePromptPath(input: string): boolean {
	const trimmed = stripWrappingQuotes(input.trim());
	return trimmed.startsWith("@") || trimmed.includes("/") || trimmed.includes("\\") || /\.md$/i.test(trimmed);
}

function stripPromptTemplateFrontmatter(content: string): string {
	const normalized = content.replace(/\r\n/g, "\n");
	if (!normalized.startsWith("---\n")) {
		return normalized.trim();
	}

	const endMarkerIndex = normalized.indexOf("\n---\n", 4);
	if (endMarkerIndex === -1) {
		return normalized.trim();
	}

	return normalized.slice(endMarkerIndex + 5).trim();
}

function resolvePromptTemplateSource(
	input: string,
	pi: ExtensionAPI,
): { sourceLabel: string; content: string } | undefined {
	const trimmed = stripWrappingQuotes(input.trim());
	if (trimmed.length === 0 || /\s/.test(trimmed)) {
		return;
	}

	const templateName = trimmed.replace(/^\//, "");
	const templateCommand = pi
		.getCommands()
		.find(
			(command) => command.source === "prompt" && command.name === templateName && typeof command.path === "string",
		);

	if (!templateCommand?.path) {
		return;
	}

	return {
		sourceLabel: `template:${templateName}`,
		content: stripPromptTemplateFrontmatter(fs.readFileSync(templateCommand.path, "utf8")),
	};
}

function resolvePromptTemplateSourceFallback(
	input: string,
	cwd: string,
): { sourceLabel: string; content: string } | undefined {
	const trimmed = stripWrappingQuotes(input.trim());
	if (!trimmed.startsWith("/") || /\s/.test(trimmed)) {
		return;
	}

	const templateName = trimmed.slice(1);
	const candidates = [
		path.join(cwd, "prompts", `${templateName}.md`),
		path.join(cwd, ".pi", "prompts", `${templateName}.md`),
		path.join(os.homedir(), ".pi", "agent", "prompts", `${templateName}.md`),
	];

	for (const candidate of candidates) {
		if (!fs.existsSync(candidate)) continue;
		if (!fs.statSync(candidate).isFile()) continue;
		return {
			sourceLabel: `template:${templateName}`,
			content: stripPromptTemplateFrontmatter(fs.readFileSync(candidate, "utf8")),
		};
	}
}

async function loadPromptSource(
	args: string,
	ctx: ExtensionCommandContext,
	pi: ExtensionAPI,
): Promise<{ sourceLabel: string; content: string } | undefined> {
	const trimmedArgs = args.trim();
	if (trimmedArgs.length > 0) {
		if (looksLikeInlineChain(trimmedArgs)) {
			return {
				sourceLabel: "inline-args",
				content: trimmedArgs,
			};
		}

		const promptTemplateSource =
			resolvePromptTemplateSource(trimmedArgs, pi) ?? resolvePromptTemplateSourceFallback(trimmedArgs, ctx.cwd);
		if (promptTemplateSource) {
			return promptTemplateSource;
		}

		const resolvedPath = resolvePromptSourcePath(ctx.cwd, trimmedArgs);
		if (fs.existsSync(resolvedPath)) {
			const stats = fs.statSync(resolvedPath);
			if (!stats.isFile()) {
				if (ctx.hasUI) ctx.ui.notify(`Prompt chain path is not a file: ${resolvedPath}`, "error");
				return;
			}

			return {
				sourceLabel: resolvedPath,
				content: fs.readFileSync(resolvedPath, "utf8"),
			};
		}

		if (looksLikePromptPath(trimmedArgs)) {
			if (ctx.hasUI) ctx.ui.notify(`Prompt chain file not found: ${resolvedPath}`, "error");
			return;
		}

		return {
			sourceLabel: "inline-args",
			content: trimmedArgs,
		};
	}

	if (!ctx.hasUI) {
		return;
	}

	const content = await ctx.ui.editor(
		"Chain prompts",
		[
			"You can write stages either as a numbered list or separated by ----",
			"",
			"1. First stage prompt",
			"2. Second stage prompt",
			"3. Third stage prompt",
			"",
			"or",
			"",
			"<stage 1>",
			"",
			"----",
			"",
			"<stage 2>",
			"",
			"Optional placeholders:",
			"- {{previous_artifact_path}}",
			"- {{artifact_dir}}",
			"- {{step_index}}",
			"- {{step_count}}",
			"",
			"Paste your chained prompts below and replace this text.",
		].join("\n"),
	);

	if (content === undefined) {
		return;
	}

	return {
		sourceLabel: "inline-editor",
		content,
	};
}

export default function (pi: ExtensionAPI) {
	let activeRun: ActiveChainRun | null = null;

	function clearRun(run: ActiveChainRun): void {
		run.commandCtx.ui.setStatus(STATUS_KEY, undefined);
		activeRun = null;
	}

	function finishRun(run: ActiveChainRun): void {
		if (!run.finalArtifactPath) {
			run.manifest.status = run.manifest.status === "completed" ? "cancelled" : run.manifest.status;
			writeManifestFile(run.manifest);
			if (run.commandCtx.hasUI) run.commandCtx.ui.notify("chain finished without writing an artifact", "warning");
			clearRun(run);
			return;
		}

		writeManifestFile(run.manifest);
		if (run.commandCtx.hasUI) {
			run.commandCtx.ui.notify(`chain finished. Final artifact: ${run.finalArtifactPath}`, "info");
		}
		clearRun(run);
	}

	function dispatchStage(run: ActiveChainRun): void {
		const stage = run.stages[run.currentStageIndex];
		run.commandCtx.ui.setStatus(STATUS_KEY, `Stage ${stage.index}/${run.stages.length}: ${stage.title}`);
		if (run.commandCtx.hasUI) {
			run.commandCtx.ui.notify(`chain stage ${stage.index}/${run.stages.length}: ${stage.title}`, "info");
		}

		run.currentStageStartLeafId = run.commandCtx.sessionManager.getLeafId();
		run.currentStagePrompt = buildStagePrompt(
			stage,
			run.stages.length,
			run.manifest.artifactDir,
			run.previousArtifactPath,
			run.manifest.readToolAvailable,
		);
		pi.sendUserMessage(run.currentStagePrompt);
	}

	pi.on("agent_end", async (_event, ctx) => {
		if (!activeRun || activeRun.processingStageResult) {
			return;
		}

		const run = activeRun;
		const stage = run.stages[run.currentStageIndex];
		if (!stage) {
			return;
		}

		run.processingStageResult = true;
		try {
			const branchAfterStage = run.commandCtx.sessionManager.getBranch();
			const stageEntries = getBranchEntriesAfter(branchAfterStage, run.currentStageStartLeafId);
			const lastAssistant = getLastAssistantMessage(stageEntries);
			if (!lastAssistant) {
				return;
			}
			const stageFailed = lastAssistant.stopReason === "error" || lastAssistant.stopReason === "aborted";

			const navigateResult = await run.commandCtx.navigateTree(run.manifest.anchorId, {
				summarize: true,
				customInstructions: buildBranchSummaryFocus(stage, run.stages.length, run.previousArtifactPath),
			});

			if (navigateResult.cancelled) {
				run.manifest.status = "cancelled";
				finishRun(run);
				return;
			}

			const summaryEntry = getCurrentBranchSummary(run.commandCtx);
			const failureDetails = stageFailed ? describeAssistantOutcome(lastAssistant) : undefined;
			const artifactPath = writeArtifactFile({
				artifactDir: run.manifest.artifactDir,
				runId: run.manifest.runId,
				promptSource: run.manifest.promptSource,
				stage,
				totalStages: run.stages.length,
				anchorId: run.manifest.anchorId,
				effectivePrompt: run.currentStagePrompt,
				previousArtifactPath: run.previousArtifactPath,
				summaryEntry,
				stageStatus: stageFailed ? "failed" : "completed",
				failureDetails,
			});

			run.manifest.stages.push({
				index: stage.index,
				title: stage.title,
				artifactPath,
				summaryEntryId: summaryEntry?.id,
				status: stageFailed ? "failed" : "completed",
			});
			run.previousArtifactPath = artifactPath;
			run.finalArtifactPath = copyFinalArtifact(run.manifest.artifactDir, artifactPath);
			run.manifest.finalArtifactPath = run.finalArtifactPath;
			run.manifest.status = stageFailed ? "failed" : run.manifest.status;
			writeManifestFile(run.manifest);

			if (stageFailed) {
				const failedSummary = summaryEntry?.summary?.trim();
				if (failedSummary) {
					const failureMessage = [
						`## Chain Failed at Stage ${stage.index}/${run.stages.length}`,
						"",
						"### Summary Before Failure",
						failedSummary,
						"",
						`**Artifact saved to:** ${run.finalArtifactPath}`,
					].join("\n");
					pi.sendUserMessage(failureMessage);
				}
				if (ctx.hasUI) {
					ctx.ui.notify(
						`Stage ${stage.index} failed after collapsing back to the anchor. Final artifact: ${run.finalArtifactPath}`,
						"warning",
					);
				}
				finishRun(run);
				return;
			}

			if (run.currentStageIndex + 1 >= run.stages.length) {
				const finalSummary = summaryEntry?.summary?.trim();
				if (finalSummary) {
					const completionMessage = [
						`## Chain Completed (${run.stages.length} stages)`,
						"",
						"### Final Summary",
						finalSummary,
						"",
						`**Final artifact saved to:** ${run.finalArtifactPath}`,
					].join("\n");
					pi.sendUserMessage(completionMessage);
				}
				finishRun(run);
				return;
			}

			run.currentStageIndex += 1;
			dispatchStage(run);
		} catch (error) {
			run.manifest.status = "failed";
			writeManifestFile(run.manifest);
			if (ctx.hasUI) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`chain failed: ${message}`, "error");
			}
			finishRun(run);
		} finally {
			if (activeRun === run) {
				run.processingStageResult = false;
			}
		}
	});

	pi.registerCommand(COMMAND_NAME, {
		description:
			"Run a chained prompt workflow via /tree from inline numbered steps, a prompt file, or a prompt template",
		handler: async (args, ctx) => {
			if (activeRun) {
				if (ctx.hasUI) ctx.ui.notify(`/${COMMAND_NAME} is already running`, "warning");
				return;
			}

			if (!ctx.isIdle()) {
				if (ctx.hasUI) ctx.ui.notify(`/${COMMAND_NAME} requires the agent to be idle`, "warning");
				return;
			}

			if (!ctx.model) {
				if (ctx.hasUI) ctx.ui.notify("No model selected", "error");
				return;
			}

			const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
			if (!auth.ok) {
				if (ctx.hasUI) ctx.ui.notify(auth.error, "error");
				return;
			}

			const promptSource = await loadPromptSource(args, ctx, pi);
			if (!promptSource) {
				return;
			}

			const stages = parseStages(promptSource.content);
			if (stages.length === 0) {
				if (ctx.hasUI) ctx.ui.notify("No stages found. Use a numbered list or separate stages with ----", "error");
				return;
			}

			const readToolAvailable = pi.getActiveTools().includes("read");
			if (stages.length > 1 && !readToolAvailable && ctx.hasUI) {
				ctx.ui.notify(
					"The read tool is disabled. Later stages will rely on the collapsed branch summary in context instead of reopening the artifact file.",
					"warning",
				);
			}

			const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${Math.random().toString(16).slice(2, 8)}`;
			const artifactDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-chain-"));
			const originalLeafId = ctx.sessionManager.getLeafId();

			pi.appendEntry(CUSTOM_TYPE, {
				kind: "anchor",
				runId,
				createdAt: new Date().toISOString(),
				originalLeafId,
				promptSource: promptSource.sourceLabel,
				artifactDir,
			});

			const anchorId = ctx.sessionManager.getLeafId();
			if (!anchorId) {
				if (ctx.hasUI) ctx.ui.notify("Failed to create a chain anchor", "error");
				return;
			}

			const manifest: ChainRunManifest = {
				runId,
				startedAt: new Date().toISOString(),
				promptSource: promptSource.sourceLabel,
				artifactDir,
				anchorId,
				readToolAvailable,
				status: "completed",
				stages: [],
			};
			writeManifestFile(manifest);

			activeRun = {
				commandCtx: ctx,
				stages,
				manifest,
				currentStageIndex: 0,
				currentStageStartLeafId: anchorId,
				currentStagePrompt: "",
				processingStageResult: false,
			};

			ctx.ui.setStatus(STATUS_KEY, `Running 1/${stages.length}`);
			const run = activeRun;
			try {
				dispatchStage(run);
			} catch (error) {
				run.manifest.status = "failed";
				writeManifestFile(run.manifest);
				const message = error instanceof Error ? error.message : String(error);
				if (ctx.hasUI) ctx.ui.notify(`chain failed to start: ${message}`, "error");
				finishRun(run);
			}
		},
	});
}
