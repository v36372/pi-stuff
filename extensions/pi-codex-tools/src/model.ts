export interface CodexLikeModelDescriptor {
	provider: string;
	api: string;
	id: string;
}

// Conservative: false positives replace the tool surface on the wrong model.
export function isCodexLikeModel(model: Partial<CodexLikeModelDescriptor> | null | undefined): boolean {
	if (!model) return false;
	const provider = (model.provider ?? "").toLowerCase();
	const api = (model.api ?? "").toLowerCase();
	const id = (model.id ?? "").toLowerCase();
	const isCopilotGpt = (provider.includes("copilot") || api.includes("copilot")) && id.includes("gpt");
	return (
		provider.includes("codex")
		|| api.includes("codex")
		|| id.includes("codex")
		|| (provider.includes("openai") && id.includes("gpt"))
		|| isCopilotGpt
	);
}
