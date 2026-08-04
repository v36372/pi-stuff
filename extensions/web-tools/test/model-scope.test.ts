import test from "node:test";
import assert from "node:assert/strict";
import { syncWebToolScope } from "../model-scope.ts";

function createToolScope(initialTools: string[]) {
	let activeTools = [...initialTools];
	const pi = {
		getActiveTools: () => [...activeTools],
		setActiveTools: (names: string[]) => { activeTools = [...names]; },
	};
	return { pi, getActiveTools: () => activeTools };
}

test("web tools are disabled for openai-codex and restored after switching providers", () => {
	const scope = createToolScope(["read", "webfetch", "websearch", "custom"]);
	const suppressedTools = new Set<string>();

	syncWebToolScope(scope.pi, "openai-codex", suppressedTools);
	assert.deepEqual(scope.getActiveTools(), ["read", "custom"]);

	syncWebToolScope(scope.pi, "anthropic", suppressedTools);
	assert.deepEqual(scope.getActiveTools(), ["read", "custom", "webfetch", "websearch"]);
});

test("tools that were already inactive are not enabled after leaving openai-codex", () => {
	const scope = createToolScope(["read", "webfetch"]);
	const suppressedTools = new Set<string>();

	syncWebToolScope(scope.pi, "openai-codex", suppressedTools);
	syncWebToolScope(scope.pi, "openai", suppressedTools);

	assert.deepEqual(scope.getActiveTools(), ["read", "webfetch"]);
});
