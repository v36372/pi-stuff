import { describe, expect, test } from "bun:test";
import {
	createPromptState,
	promptStateResponded,
	promptStatesToResponses,
	saveComment,
} from "../ask/state.js";

describe("prompt comments", () => {
	test("are optional but count as a response when present", () => {
		const state = createPromptState();
		expect(promptStateResponded(state)).toBe(false);

		saveComment(state, " Needs a smaller first pass. ");

		expect(promptStateResponded(state)).toBe(true);
		expect(promptStatesToResponses([{ id: "scope" }], [state])).toEqual([
			{
				id: "scope",
				selections: [],
				comment: "Needs a smaller first pass.",
			},
		]);
	});

	test("omits blank comments from the result", () => {
		const state = createPromptState();
		saveComment(state, "   ");

		expect(promptStatesToResponses([{ id: "scope" }], [state])).toEqual([
			{ id: "scope", selections: [] },
		]);
	});
});
