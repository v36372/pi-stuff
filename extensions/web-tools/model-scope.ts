const WEB_TOOL_NAMES = ["webfetch", "websearch"] as const;

interface ActiveTools {
	getActiveTools(): string[];
	setActiveTools(names: string[]): void;
}

function isWebTool(name: string): name is (typeof WEB_TOOL_NAMES)[number] {
	return name === "webfetch" || name === "websearch";
}

export function syncWebToolScope(
	pi: ActiveTools,
	provider: string | undefined,
	suppressedTools: Set<string>,
): void {
	const activeTools = pi.getActiveTools();
	if (provider?.trim().toLowerCase() === "openai-codex") {
		for (const name of activeTools) if (isWebTool(name)) suppressedTools.add(name);
		const nextTools = activeTools.filter((name) => !isWebTool(name));
		if (nextTools.length !== activeTools.length) pi.setActiveTools(nextTools);
		return;
	}

	if (suppressedTools.size === 0) return;
	const nextTools = [...activeTools];
	for (const name of WEB_TOOL_NAMES) {
		if (suppressedTools.has(name) && !nextTools.includes(name)) nextTools.push(name);
	}
	suppressedTools.clear();
	if (nextTools.length !== activeTools.length) pi.setActiveTools(nextTools);
}
