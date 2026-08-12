import type { ExecutePatchResult } from "../../patch/types.ts";
import { formatApplyPatchCollapsedDiff, formatApplyPatchSummary, renderApplyPatchCall } from "./rendering.ts";

interface ApplyPatchRenderState {
	cwd: string;
	patchText: string;
	collapsed: string;
	collapsedDiff: string;
	expanded: string;
	status: "pending" | "success" | "partial_failure" | "failed";
	failedTargets?: string[] | undefined;
}

export interface ApplyPatchSuccessDetails {
	status: "success";
	result: ExecutePatchResult;
}

export interface ApplyPatchPartialFailureDetails {
	status: "partial_failure";
	result: ExecutePatchResult;
	failedTargets?: string[] | undefined;
}

export type ApplyPatchToolDetails = ApplyPatchSuccessDetails | ApplyPatchPartialFailureDetails;

const applyPatchRenderStates = new Map<string, ApplyPatchRenderState>();

export function isApplyPatchToolDetails(details: unknown): details is ApplyPatchToolDetails {
	return typeof details === "object" && details !== null && "status" in details && "result" in details;
}

export function clearApplyPatchRenderState(): void {
	applyPatchRenderStates.clear();
}

export function setApplyPatchRenderState(
	toolCallId: string,
	patchText: string,
	cwd: string,
	status: "pending" | "partial_failure" | "failed" = "pending",
	failedTargets?: string[],
): void {
	const collapsed = formatApplyPatchSummary(patchText, cwd);
	const collapsedDiff = formatApplyPatchCollapsedDiff(patchText, cwd);
	const expanded = renderApplyPatchCall(patchText, cwd);
	applyPatchRenderStates.set(toolCallId, { cwd, patchText, collapsed, collapsedDiff, expanded, status, failedTargets });
}

export function markApplyPatchPartialFailure(toolCallId: string, failedTargets?: string[]): void {
	markApplyPatchFailure(toolCallId, "partial_failure", failedTargets);
}

export function markApplyPatchSuccess(toolCallId: string): void {
	const existing = applyPatchRenderStates.get(toolCallId);
	if (existing) applyPatchRenderStates.set(toolCallId, { ...existing, status: "success" });
}

export function markApplyPatchFailure(toolCallId: string, status: "partial_failure" | "failed", failedTargets?: string[]): void {
	const existing = applyPatchRenderStates.get(toolCallId);
	if (!existing) return;
	applyPatchRenderStates.set(toolCallId, { ...existing, status, failedTargets });
}

function markFailedTargetLine(line: string, failedTarget: string): string | undefined {
	const suffixMatch = line.match(/ \(\+\d+ -\d+\)$/);
	if (!suffixMatch) return undefined;
	const suffix = suffixMatch[0]!;
	const prefixAndTarget = line.slice(0, -suffix.length);
	const candidatePrefixes = ["• Edit partially failed ", "• Added ", "• Edited ", "• Deleted ", "  └ ", "    "];
	for (const prefix of candidatePrefixes) {
		if (prefixAndTarget === `${prefix}${failedTarget}`) {
			return `${prefix}${failedTarget} failed${suffix}`;
		}
	}
	return undefined;
}

function renderPartialFailureCall(text: string, theme: { fg(role: string, text: string): string }, failedTargets?: string[]): string {
	const lines = text.split("\n");
	if (lines.length === 0) return theme.fg("warning", "• Edit partially failed");
	lines[0] = lines[0]!.replace(/^• (Added|Edited|Deleted)\b/, "• Edit partially failed");
	const failedLineIndexes = new Set<number>();
	if (failedTargets) {
		for (let i = 0; i < lines.length; i += 1) {
			for (const failedTarget of failedTargets) {
				const failedLine = markFailedTargetLine(lines[i]!, failedTarget);
				if (failedLine) {
					lines[i] = failedLine;
					failedLineIndexes.add(i);
					break;
				}
			}
		}
	}
	return lines.map((line, index) => {
		if (failedLineIndexes.has(index)) return theme.fg("error", line);
		if (index === 0) return theme.fg("warning", line);
		return line;
	}).join("\n");
}

function renderFailedCall(text: string, theme: { fg(role: string, text: string): string }, failedTargets?: string[]): string {
	const lines = text.split("\n");
	if (lines.length === 0) return theme.fg("error", "• Edit failed");
	lines[0] = lines[0]!.replace(/^• (Added|Edited|Deleted)\b/, "• Edit failed");
	const failedLineIndexes = new Set<number>();
	if (failedTargets) {
		for (let i = 0; i < lines.length; i += 1) {
			for (const failedTarget of failedTargets) {
				const failedLine = markFailedTargetLine(lines[i]!, failedTarget);
				if (failedLine) {
					lines[i] = failedLine;
					failedLineIndexes.add(i);
					break;
				}
			}
		}
	}
	return lines.map((line, index) => failedLineIndexes.has(index) || index === 0 ? theme.fg("error", line) : line).join("\n");
}

export function renderApplyPatchCallFromState(args: { input?: unknown | undefined; reasoning?: unknown | undefined }, theme: { fg(role: string, text: string): string; bold(text: string): string }, context?: { toolCallId?: string | undefined; cwd?: string | undefined; expanded?: boolean | undefined; argsComplete?: boolean | undefined; showCollapsedDiff?: boolean | undefined }): string {
	const reasoning = typeof args.reasoning === "string" ? args.reasoning.replace(/\s+/g, " ").trim() : "";
	if (context?.argsComplete === false) return `${theme.fg("accent", "•")} Patching${reasoning ? ` ${theme.fg("accent", reasoning)}` : ` ${theme.fg("dim", "…")}`}`;
	const patchText = typeof args.input === "string" ? args.input : "";
	if (patchText.trim().length === 0) return `${theme.fg("accent", "•")} Patching${reasoning ? ` ${theme.fg("accent", reasoning)}` : ""}`;
	const cached = context?.toolCallId ? applyPatchRenderStates.get(context.toolCallId) : undefined;
	const cwd = context?.cwd ?? cached?.cwd;
	const effectivePatchText = cached?.patchText ?? patchText;
	const baseText = context?.expanded
		? cached?.expanded ?? renderApplyPatchCall(effectivePatchText, cwd)
		: context?.showCollapsedDiff
			? cached?.collapsedDiff ?? formatApplyPatchCollapsedDiff(effectivePatchText, cwd)
		: cached?.collapsed ?? formatApplyPatchSummary(effectivePatchText, cwd);
	if (baseText.trim().length === 0) {
		if (cached?.status === "failed") return theme.fg("error", "• Edit failed");
		return `${theme.fg("dim", "•")} ${theme.bold("Patching")}`;
	}
	const reasonedText = reasoning ? addReasoning(baseText, reasoning, theme) : baseText;
	if (cached?.status === "partial_failure") return renderPartialFailureCall(reasonedText, theme, cached.failedTargets);
	if (cached?.status === "failed") return renderFailedCall(reasonedText, theme, cached.failedTargets);
	const lines = reasonedText.split("\n");
	if (lines[0]?.startsWith("• ")) lines[0] = `${theme.fg(cached?.status === "success" ? "success" : "accent", "•")}${lines[0].slice(1)}`;
	return lines.join("\n");
}

function addReasoning(text: string, reasoning: string, theme: { fg(role: string, text: string): string }): string {
	const lines = text.split("\n");
	const first = lines[0] ?? "";
	const counts = first.match(/ (\(\+\d+ -\d+\))$/)?.[1];
	if (!counts) return text;
	lines[0] = `${first.slice(0, -(counts.length + 1))}${theme.fg("dim", " to ")}${theme.fg("accent", reasoning)} ${theme.fg("dim", "·")} ${counts}`;
	return lines.join("\n");
}
