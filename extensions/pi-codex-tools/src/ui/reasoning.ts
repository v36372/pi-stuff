export const REASONING_DESCRIPTION = "≤8-word present-tense intent phrase: why needed, not what it does. No period. Emit first.";

/** Clone a JSON-schema object and make reasoning its first required property. */
export function withReasoning(parameters: any): any {
	return {
		...parameters,
		properties: {
			reasoning: { type: "string", description: REASONING_DESCRIPTION },
			...(parameters?.properties ?? {}),
		},
		required: Array.from(new Set(["reasoning", ...(parameters?.required ?? [])])),
	};
}

export function reasoningFromArgs(args: unknown): string | undefined {
	if (!args || typeof args !== "object" || !("reasoning" in args)) return undefined;
	return typeof args.reasoning === "string" ? args.reasoning.replace(/\s+/g, " ").trim() : undefined;
}
