import { expect, test } from "bun:test";
import type { createAskTool } from "../ask/tool.js";
import humanInTheLoop from "../index.js";

test("reports open prompts to Herdr through Pi's event bus", async () => {
	let tool: ReturnType<typeof createAskTool> | undefined;
	const events: Array<{ channel: string; data: unknown }> = [];
	humanInTheLoop({
		registerTool: (definition: unknown) => {
			tool = definition as ReturnType<typeof createAskTool>;
		},
		on: () => {},
		events: {
			emit: (channel: string, data: unknown) => events.push({ channel, data }),
		},
	} as never);

	const answers = ["Proceed", ""];
	await tool?.execute(
		"call-1",
		{ prompts: [{ title: "Choose a path" }] },
		undefined,
		undefined,
		{
			hasUI: true,
			mode: "rpc",
			ui: { input: async () => answers.shift() },
		} as never,
	);

	expect(events).toEqual([
		{
			channel: "herdr:blocked",
			data: { active: true, label: "Waiting for input" },
		},
		{
			channel: "herdr:blocked",
			data: { active: false, label: "Waiting for input" },
		},
	]);
});
