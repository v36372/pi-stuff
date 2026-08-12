import type { ShellAction } from "../../shell/summary.ts";
import type { ExecCommandStatus } from "../../tools/exec/command-state.ts";

export interface RenderTheme {
	fg(role: string, text: string): string;
	bold(text: string): string;
}

export function renderGroupedExecCommandCall(actionGroups: ShellAction[][], state: ExecCommandStatus, theme: RenderTheme): string {
	return renderExplorationText(actionGroups, state, theme);
}

export function renderWriteStdinCall(
	sessionId: number | string,
	input: string | undefined,
	command: string | undefined,
	theme: RenderTheme,
	reasoning?: string,
): string {
	const interacted = typeof input === "string" && input.length > 0;
	const marker = interacted ? "↳ " : "• ";
	const title = interacted ? "Interacted" : "Waited";
	const bulletColor = interacted ? "accent" : "success";
	let text = `${theme.fg(bulletColor, marker)}${title}`;
	if (reasoning) text += ` ${theme.fg("accent", reasoning)}`;
	const commandPreview = formatCommandPreview(command);
	if (commandPreview) {
		text += `${theme.fg("dim", " · ")}${theme.fg("muted", commandPreview)}`;
	}
	// Keep the session fallback only when we do not have a stable command display.
	if (!commandPreview) {
		text += `${theme.fg("dim", " ")}${theme.fg("muted", `#${sessionId}`)}`;
	}
	return text;
}

function renderExplorationText(actionGroups: ShellAction[][], state: ExecCommandStatus, theme: RenderTheme): string {
	const header = state === "running" ? "Exploring" : "Explored";
	let text = `${theme.fg("dim", "•")} ${theme.bold(header)}`;

	for (const [index, line] of coalesceReadGroups(actionGroups).map(formatActionLine).entries()) {
		const prefix = index === 0 ? "  └ " : "    ";
		text += `\n${theme.fg("dim", prefix)}${theme.fg("accent", line.title)} ${theme.fg("muted", line.body)}`;
	}

	return text;
}

export function renderCommandHeadline(
	state: ExecCommandStatus,
	theme: RenderTheme,
	reasoning?: string,
	failed = false,
	wallTimeSeconds?: number,
): string {
	const verb = state === "running" ? "Running" : "Ran";
	const color = state === "running" ? "accent" : failed ? "error" : "success";
	let text = `${theme.fg(color, "•")} ${verb}`;
	if (reasoning) text += ` ${theme.fg("accent", reasoning)}`;
	else if (state === "running") text += ` ${theme.fg("dim", "…")}`;
	if (state === "done") {
		if (typeof wallTimeSeconds === "number") text += ` ${theme.fg("dim", `in ${formatDuration(wallTimeSeconds)}`)}`;
		text += ` ${theme.fg(color, failed ? "✗" : "✓")}`;
	}
	return text;
}

function formatDuration(seconds: number): string {
	if (seconds < 1) return `${Math.max(1, Math.round(seconds * 1000))}ms`;
	if (seconds < 60) return `${Math.floor(seconds)}s`;
	return `${Math.floor(seconds / 60)}m ${Math.floor(seconds % 60).toString().padStart(2, "0")}s`;
}

function shortenCommand(command: string, max = 100): string {
	const trimmed = command.replace(/\s+/g, " ").trim();
	if (trimmed.length <= max) return trimmed;
	return `${trimmed.slice(0, max - 3)}...`;
}

function formatCommandPreview(command: string | undefined): string | undefined {
	if (!command) return undefined;
	const singleLine = command.replace(/\s+/g, " ").trim();
	if (singleLine.length === 0) return undefined;
	return shortenCommand(singleLine, 80);
}

function formatActionLine(action: ShellAction): { title: string; body: string } {
	if (action.kind === "read") {
		return { title: "Read", body: formatReadLabel(action) };
	}
	if (action.kind === "list") {
		return { title: "List", body: action.path ?? action.command };
	}
	if (action.kind === "search") {
		if (action.query && action.path) {
			return { title: "Search", body: `${action.query} in ${action.path}` };
		}
		if (action.query) {
			return { title: "Search", body: action.query };
		}
		return { title: "Search", body: action.command };
	}
	return { title: "Run", body: action.command };
}

function formatReadLabel(action: Extract<ShellAction, { kind: "read" }>): string {
	const skillName = skillNameFromSkillPath(action.path);
	return skillName ? `${skillName} skill` : action.name;
}

function skillNameFromSkillPath(path: string): string | undefined {
	const normalized = path.replace(/\\/g, "/");
	const parts = normalized.split("/").filter(Boolean);
	if (parts.at(-1) !== "SKILL.md") return undefined;
	if (parts.at(-3) !== "skills") return undefined;
	const skillDir = parts.at(-2);
	return skillDir && skillDir !== ".system" ? skillDir : undefined;
}

function coalesceReadGroups(actionGroups: ShellAction[][]): ShellAction[] {
	const flattened: ShellAction[] = [];

	for (let index = 0; index < actionGroups.length; index += 1) {
		const actions = actionGroups[index]!;
		if (actions.every((action) => action.kind === "read")) {
			const reads: Extract<ShellAction, { kind: "read" }>[] = [];
			const seenPaths = new Set<string>();
			let lastRead: Extract<ShellAction, { kind: "read" }> | undefined;

			for (let readIndex = index; readIndex < actionGroups.length; readIndex += 1) {
				const readActions = actionGroups[readIndex]!;
				if (!readActions.every((action) => action.kind === "read")) {
					break;
				}

				for (const action of readActions) {
					if (action.kind !== "read") continue;
					lastRead = action;
					if (seenPaths.has(action.path)) continue;
					seenPaths.add(action.path);
					reads.push(action);
				}

				index = readIndex;
			}

			if (lastRead) {
				const duplicateLabels = new Set<string>();
				const seenLabels = new Set<string>();
				for (const read of reads) {
					const label = formatReadLabel(read);
					if (seenLabels.has(label)) {
						duplicateLabels.add(label);
						continue;
					}
					seenLabels.add(label);
				}
				const labels = reads.map((read) => {
					const label = formatReadLabel(read);
					return duplicateLabels.has(label) ? read.path : label;
				});
				flattened.push({
					kind: "read",
					command: labels.join(" && "),
					name: labels.join(", "),
					path: "",
				});
			}
			continue;
		}

		flattened.push(...actions);
	}

	return flattened;
}
