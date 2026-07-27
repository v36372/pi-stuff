import { REPHRASE_REQUEST_RESPONSE } from "./constants.js";
import type {
	AskPrompt,
	AskResponse,
	PromptChoice,
	PromptState,
} from "./contracts.js";

export function customSelectionFor(value: unknown): string {
	const trimmed = typeof value === "string" ? value.trim() : "";
	return trimmed || REPHRASE_REQUEST_RESPONSE;
}

export function createPromptState(): PromptState {
	return { selections: [], customText: "", customEnabled: false, comment: "" };
}

export function promptStateResponded(
	promptState: PromptState | undefined,
): boolean {
	return (
		(promptState?.selections.length ?? 0) > 0 ||
		promptState?.customEnabled === true ||
		Boolean(promptState?.comment.trim())
	);
}

export function promptStatesToResponses(
	prompts: Array<Pick<AskPrompt, "id">>,
	promptStates: PromptState[],
): AskResponse[] {
	return promptStates.map((promptState, index) => {
		const comment = promptState.comment.trim();
		return {
			id: prompts[index]?.id ?? `p${index + 1}`,
			selections: promptState.selections,
			...(comment ? { comment } : {}),
		};
	});
}

export function saveComment(
	promptState: PromptState,
	submittedText: unknown,
): void {
	promptState.comment = typeof submittedText === "string" ? submittedText : "";
}

export function saveCustomSelection(
	prompt: Pick<AskPrompt, "multiple"> | undefined,
	promptState: PromptState,
	submittedText: unknown,
): void {
	const previous = promptState.customEnabled
		? customSelectionFor(promptState.customText)
		: null;
	const value = typeof submittedText === "string" ? submittedText : "";
	const next = customSelectionFor(value);

	promptState.customText = value;
	promptState.customEnabled = true;

	if (prompt?.multiple) {
		promptState.selections = [
			...promptState.selections.filter(
				(item) => item !== next && item !== previous,
			),
			next,
		];
	} else {
		promptState.selections = [next];
	}
}

export function clearCustomSelection(promptState: PromptState): void {
	if (!promptState.customEnabled) return;
	const customSelection = customSelectionFor(promptState.customText);
	promptState.selections = promptState.selections.filter(
		(item) => item !== customSelection,
	);
	promptState.customText = "";
	promptState.customEnabled = false;
}

export function pickChoiceSelection(
	prompt: Pick<AskPrompt, "multiple"> | undefined,
	promptState: PromptState,
	choice: PromptChoice | undefined,
): void {
	if (!choice) return;
	if (prompt?.multiple) {
		promptState.selections = promptState.selections.includes(choice.label)
			? promptState.selections.filter((item) => item !== choice.label)
			: [...promptState.selections, choice.label];
		return;
	}

	promptState.selections = [choice.label];
	promptState.customEnabled = false;
}
