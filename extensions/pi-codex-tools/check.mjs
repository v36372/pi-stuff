import assert from "node:assert/strict";
import {
	DEFAULT_TOOL_NAMES,
	captureBaseline,
	mergeAdapterTools,
	restoreBaseline,
	restoreTools,
	shouldActivate,
	stripAdapterTools,
	syncAdapter,
} from "./src/activation.ts";
import { REASONING_DESCRIPTION, withReasoning } from "./src/ui/reasoning.ts";
import { renderCommandHeadline, renderWriteStdinCall } from "./src/ui/tool-rendering/codex-rendering.ts";

assert.deepEqual(
	mergeAdapterTools(["read", "bash", "edit", "write", "grep", "find", "ls", "webfetch"]),
	["exec_command", "write_stdin", "apply_patch", "webfetch"],
);

assert.deepEqual(
	stripAdapterTools(["exec_command", "write_stdin", "apply_patch", "webfetch"]),
	["webfetch"],
);

assert.deepEqual(
	restoreTools(DEFAULT_TOOL_NAMES, ["exec_command", "write_stdin", "apply_patch", "webfetch"]),
	[...DEFAULT_TOOL_NAMES, "webfetch"],
);

assert.equal(
	shouldActivate(
		{ model: { provider: "openai-codex", api: "responses", id: "gpt-5.6-luna" } },
		{ scope: { allProviders: "off" }, tools: { customRustBinariesDir: "" }, ui: { statusLine: true } },
	),
	true,
);

assert.equal(
	shouldActivate(
		{ model: { provider: "grok-cli", api: "openai-completions", id: "grok-4.5" } },
		{ scope: { allProviders: "off" }, tools: { customRustBinariesDir: "" }, ui: { statusLine: true } },
	),
	false,
);

assert.equal(
	shouldActivate(
		{ model: { provider: "grok-cli", api: "openai-completions", id: "grok-4.5" } },
		{ scope: { allProviders: "on" }, tools: { customRustBinariesDir: "" }, ui: { statusLine: true } },
	),
	true,
);

const off = { scope: { allProviders: "off" }, tools: { customRustBinariesDir: "" }, ui: { statusLine: false } };
const on = { scope: { allProviders: "on" }, tools: { customRustBinariesDir: "" }, ui: { statusLine: false } };

// Restricted startup set must not expand to all built-ins when inactive.
{
	const state = { enabled: false, config: off };
	let active = ["read", "exec_command", "write_stdin", "apply_patch"];
	const pi = {
		getActiveTools: () => active,
		setActiveTools: (names) => {
			active = names;
		},
	};
	syncAdapter(pi, { hasUI: false, model: { provider: "grok-cli", api: "openai-completions", id: "grok-4.5" } }, state);
	assert.deepEqual(active, ["read"]);
	assert.equal(state.previousToolNames, undefined);
	assert.equal(state.enabled, false);
}

// Empty baseline capture.
assert.deepEqual(captureBaseline(["exec_command", "write_stdin", "apply_patch"]), []);

// Active → restoreBaseline (reload/shutdown) recovers original built-ins.
{
	const state = { enabled: false, config: on };
	let active = ["read", "bash", "edit", "write", "webfetch"];
	const pi = {
		getActiveTools: () => active,
		setActiveTools: (names) => {
			active = names;
		},
	};
	const ctx = { hasUI: false, model: { provider: "openai-codex", api: "responses", id: "gpt-5.6-sol" } };
	syncAdapter(pi, ctx, state);
	assert.deepEqual(active, ["exec_command", "write_stdin", "apply_patch", "webfetch"]);
	assert.equal(state.enabled, true);
	restoreBaseline(pi, state);
	assert.deepEqual(active, ["read", "bash", "edit", "write", "webfetch"]);
	assert.equal(state.enabled, false);
	assert.equal(state.previousToolNames, undefined);
}

// Inactive tool-change → active → inactive recaptures the later baseline.
{
	const state = { enabled: false, config: off };
	let active = ["read", "exec_command", "write_stdin", "apply_patch"];
	const pi = {
		getActiveTools: () => active,
		setActiveTools: (names) => {
			active = names;
		},
	};
	const grok = { hasUI: false, model: { provider: "grok-cli", api: "openai-completions", id: "grok-4.5" } };
	const codex = { hasUI: false, model: { provider: "openai-codex", api: "responses", id: "gpt-5.6-sol" } };

	// First inactive strip.
	syncAdapter(pi, grok, state);
	assert.deepEqual(active, ["read"]);

	// User enables bash while inactive.
	active = ["read", "bash"];

	// Activate on Codex — should capture [read, bash].
	syncAdapter(pi, codex, state);
	assert.deepEqual(active, ["exec_command", "write_stdin", "apply_patch"]);
	assert.deepEqual(state.previousToolNames, ["read", "bash"]);

	// Back to grok — restore [read, bash], not just [read].
	syncAdapter(pi, grok, state);
	assert.deepEqual(active, ["read", "bash"]);
	assert.equal(state.previousToolNames, undefined);
}

const theme = {
	bold: (text) => text,
	fg: (_role, text) => text,
};
const schema = withReasoning({
	type: "object",
	properties: { cmd: { type: "string" } },
	required: ["cmd"],
});
assert.deepEqual(Object.keys(schema.properties), ["reasoning", "cmd"]);
assert.deepEqual(schema.required, ["reasoning", "cmd"]);
assert.equal(schema.properties.reasoning.description, REASONING_DESCRIPTION);
assert.match(renderCommandHeadline("running", theme, "verify the renderer"), /Running verify the renderer/);
assert.match(renderCommandHeadline("done", theme, "verify the renderer", false, 0.1), /Ran verify the renderer in 100ms ✓/);
assert.match(renderWriteStdinCall(7, undefined, "bun test", theme, "collect test output"), /Waited collect test output · bun test/);

console.log("reason-first renderers ok");
