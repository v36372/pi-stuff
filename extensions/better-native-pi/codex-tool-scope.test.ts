import { describe, expect, test } from "bun:test";
import { scopeCodexTools } from "./codex-tool-scope.js";

function toolState(initialTools: string[]) {
	let activeTools = [...initialTools];
	let updates = 0;
	return {
		pi: {
			getActiveTools: () => [...activeTools],
			setActiveTools: (tools: string[]) => {
				activeTools = [...tools];
				updates += 1;
			},
		},
		activeTools: () => activeTools,
		updates: () => updates,
	};
}

describe("scopeCodexTools", () => {
	test("removes every native-name tool from structured Codex mode", () => {
		const state = toolState([
			"exec_command",
			"write_stdin",
			"apply_patch",
			"grep",
			"find",
			"ls",
			"ask",
		]);

		expect(scopeCodexTools(state.pi)).toBe(true);
		expect(state.activeTools()).toEqual([
			"exec_command",
			"write_stdin",
			"apply_patch",
			"ask",
		]);
		expect(state.updates()).toBe(1);
	});

	test("removes native-name tools from Codex Code Mode", () => {
		const state = toolState(["exec", "wait", "read", "bash", "edit", "write", "grep", "find", "ls"]);

		expect(scopeCodexTools(state.pi)).toBe(true);
		expect(state.activeTools()).toEqual(["exec", "wait"]);
	});

	test("leaves non-Codex models and already-scoped sets unchanged", () => {
		const native = toolState(["read", "bash", "edit", "write", "grep", "find", "ls"]);
		const scoped = toolState(["exec_command", "write_stdin", "apply_patch"]);

		expect(scopeCodexTools(native.pi)).toBe(false);
		expect(scopeCodexTools(scoped.pi)).toBe(false);
		expect(native.updates()).toBe(0);
		expect(scoped.updates()).toBe(0);
	});
});
