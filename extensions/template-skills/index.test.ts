import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentSession, createSyntheticSourceInfo, type ExtensionAPI, type ExtensionContext, type InputEvent, type InputEventResult } from "@earendil-works/pi-coding-agent";
import templateSkills, { parseArgs, substituteArgs } from "./index";

// Verify compatibility against the installed Pi implementation, not a duplicate mock.
const native = await import(new URL("./core/prompt-templates.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href);
const directories: string[] = [];
afterEach(async () => {
	await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function harness(content: string) {
	const dir = await mkdtemp(join(tmpdir(), "pi-template-skills-"));
	directories.push(dir);
	const path = join(dir, "catchup.md");
	await writeFile(path, content);
	const commands: ReturnType<ExtensionAPI["getCommands"]> = [
		{ name: "catchup", source: "prompt", sourceInfo: createSyntheticSourceInfo(path, { source: "test" }) },
		{ name: "skill:bro", source: "skill", sourceInfo: createSyntheticSourceInfo(join(dir, "SKILL.md"), { source: "test" }) },
	];
	let handler!: (event: InputEvent, ctx: ExtensionContext) => Promise<InputEventResult | void>;
	const notifications: string[] = [];
	templateSkills({
		getCommands: () => commands,
		on: (_event: string, listener: typeof handler) => { handler = listener; },
	} as unknown as ExtensionAPI);
	return {
		dir, path, commands, notifications,
		input: (text: string, extra: Partial<InputEvent> = {}) => handler(
			{ type: "input", text, source: "interactive", ...extra },
			{ ui: { notify: (message: string) => notifications.push(message) } } as unknown as ExtensionContext,
		),
	};
}

describe("template skill expansion", () => {
	test("resolves the existing catchup shorthand", async () => {
		const h = await harness(await readFile(new URL("../../prompts/catchup.md", import.meta.url), "utf8"));
		const result = await h.input("/catchup");
		expect(result?.action).toBe("transform");
		if (result?.action === "transform") {
			expect(result.text).toStartWith("/skill:bro catch me up on everything since my last message");
		}
	});

	test("supports explicit skill references, frontmatter, whitespace, and multiline arguments", async () => {
		const h = await harness('---\ndescription: Catch up\n---\n\n/skill:bro $1\nExtra context: ${2:-none}\n');
		expect(await h.input('/catchup "this week"')).toEqual({
			action: "transform", text: "/skill:bro this week\nExtra context: none", images: undefined,
		});
	});

	test("preserves image attachments and handles RPC, injected, and streaming input", async () => {
		const h = await harness("/bro $@\n");
		const images = [{ type: "image" as const, data: "aGVsbG8=", mimeType: "image/png" }];
		for (const source of ["interactive", "rpc", "extension"] as const) {
			const result = await h.input("/catchup hello", { source, images, streamingBehavior: "followUp" });
			expect(result).toEqual({ action: "transform", text: "/skill:bro hello\n", images });
		}
	});

	test("leaves ordinary input, direct skills, unknown skills, and template chains alone", async () => {
		for (const content of ["Explain $1", "/missing hello", "/skill:missing hello", "/catchup loop", "Please use /bro here"]) {
			const h = await harness(content);
			expect(await h.input("/catchup")).toEqual({ action: "continue" });
		}
		const h = await harness("/bro hello");
		for (const input of ["hello", "/unknown", "/skill:bro hello", "/bro hello"]) {
			expect(await h.input(input)).toEqual({ action: "continue" });
		}
	});

	test("preserves extension precedence and shorthand collisions; explicit references win", async () => {
		const h = await harness("/bro hello");
		h.commands.push({ name: "bro", source: "extension", sourceInfo: h.commands[0].sourceInfo });
		expect(await h.input("/catchup")).toEqual({ action: "continue" });
		await writeFile(h.path, "/skill:bro hello");
		expect((await h.input("/catchup"))?.action).toBe("transform");
		h.commands.push({ name: "catchup", source: "extension", sourceInfo: h.commands[0].sourceInfo });
		expect(await h.input("/catchup")).toEqual({ action: "continue" });
		const other = await harness("/bro hello");
		other.commands.push({ name: "bro", source: "prompt", sourceInfo: other.commands[0].sourceInfo });
		expect(await other.input("/catchup")).toEqual({ action: "continue" });
	});

	test("uses the current loaded command list and rereads templates", async () => {
		const h = await harness("/bro before");
		expect((await h.input("/catchup"))?.action).toBe("transform");
		await writeFile(h.path, "/bro after");
		expect(await h.input("/catchup")).toMatchObject({ action: "transform", text: "/skill:bro after" });
		h.commands.pop();
		expect(await h.input("/catchup")).toEqual({ action: "continue" });
	});

	test("reports unreadable templates without sending an unresolved command", async () => {
		const h = await harness("/bro hello");
		await rm(h.path);
		expect(await h.input("/catchup")).toEqual({ action: "handled" });
		expect(h.notifications[0]).toContain("Cannot resolve template /catchup");
	});

	test("Pi's real pipeline loads the skill once and preserves relative references", async () => {
		const h = await harness("/bro catch me up");
		const skillPath = join(h.dir, "SKILL.md");
		await writeFile(skillPath, "---\nname: bro\ndescription: Simple language\ndisable-model-invocation: true\n---\n/bro do not recurse\nRead references/style.md.\n");
		const result = await h.input("/catchup");
		if (result?.action !== "transform") throw new Error("Expected a transformed input");
		const session = {
			resourceLoader: { getSkills: () => ({ skills: [{ name: "bro", filePath: skillPath, baseDir: h.dir }] }) },
			_extensionRunner: { emitError: (error: unknown) => { throw error; } },
		};
		const expandedSkill = (AgentSession.prototype as any)._expandSkillCommand.call(session, result.text);
		const final = native.expandPromptTemplate(expandedSkill, [{ name: "bro", content: "WRONG TEMPLATE" }]);
		expect(final).toContain(`<skill name="bro" location="${skillPath}">`);
		expect(final).toContain(`References are relative to ${h.dir}.`);
		expect(final).toContain("/bro do not recurse");
		expect(final).toEndWith("</skill>\n\ncatch me up");
		expect(final).not.toContain("disable-model-invocation");
		expect(final).not.toContain("WRONG TEMPLATE");
	});
});

test("argument helpers match Pi, including defaults, slices, quotes, and non-recursive substitution", () => {
	const inputs = ["", 'one "two words" three', "'single quoted' plain", '"" x', '"unclosed', "one\ntwo\tthree", '"$1" "$@"'];
	const contents = ["$1 $2 $10 $@ $ARGUMENTS", "${1:-default} ${9:-missing} ${@:-all} ${ARGUMENTS:-all}", "${@:0} ${@:2} ${@:2:1} ${@:1:0}", "${1:-$2} $1 $@"];
	for (const input of inputs) {
		expect(parseArgs(input)).toEqual(native.parseCommandArgs(input));
		for (const content of contents) {
			expect(substituteArgs(content, parseArgs(input))).toBe(native.substituteArgs(content, native.parseCommandArgs(input)));
		}
	}
});
