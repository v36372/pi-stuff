import { readFile } from "node:fs/promises";
import { parseFrontmatter, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Match Pi's template argument syntax. These helpers are not exported by Pi.
export function parseArgs(input: string): string[] {
	const args: string[] = [];
	let current = "";
	let quote: string | undefined;
	for (const char of input) {
		if (quote) {
			if (char === quote) quote = undefined;
			else current += char;
		} else if (char === '"' || char === "'") {
			quote = char;
		} else if (/\s/.test(char)) {
			if (current) args.push(current);
			current = "";
		} else {
			current += char;
		}
	}
	if (current) args.push(current);
	return args;
}

export function substituteArgs(content: string, args: string[]): string {
	const all = args.join(" ");
	return content.replace(
		/\$\{(\d+|ARGUMENTS|@):-([^}]*)\}|\$\{@:(\d+)(?::(\d+))?\}|\$(ARGUMENTS|@|\d+)/g,
		(_match, target, fallback, start, length, simple) => {
			if (target) {
				const value = target === "@" || target === "ARGUMENTS" ? all : args[Number(target) - 1];
				return value || fallback;
			}
			if (start) {
				const index = Math.max(0, Number(start) - 1);
				return (length ? args.slice(index, index + Number(length)) : args.slice(index)).join(" ");
			}
			return simple === "@" || simple === "ARGUMENTS" ? all : (args[Number(simple) - 1] ?? "");
		},
	);
}

export default function templateSkills(pi: ExtensionAPI) {
	pi.on("input", async (event, ctx) => {
		const invocation = event.text.match(/^\/([^\s]+)(?:\s+([\s\S]*))?$/);
		if (!invocation) return { action: "continue" };

		const commands = pi.getCommands();
		const name = invocation[1];
		// Preserve extension command precedence and direct /skill:name behavior.
		if (name.startsWith("skill:") || commands.some((c) => c.source === "extension" && c.name === name)) {
			return { action: "continue" };
		}
		const template = commands.find((c) => c.source === "prompt" && c.name === name);
		if (!template) return { action: "continue" };

		let body: string;
		try {
			body = parseFrontmatter(await readFile(template.sourceInfo.path, "utf8")).body;
		} catch (error) {
			ctx.ui.notify(`Cannot resolve template /${name}: ${error instanceof Error ? error.message : String(error)}`, "error");
			return { action: "handled" };
		}

		const expanded = substituteArgs(body, parseArgs(invocation[2] ?? "")).trimStart();
		const nested = expanded.match(/^\/([^\s]+)(?:\s+([\s\S]*))?$/);
		if (!nested) return { action: "continue" };

		const reference = nested[1];
		const explicit = reference.startsWith("skill:");
		const skillName = explicit ? reference.slice(6) : reference;
		// A shorthand must not shadow an extension command or another template.
		if (!explicit && commands.some((c) => c.source !== "skill" && c.name === reference)) {
			return { action: "continue" };
		}
		if (!commands.some((c) => c.source === "skill" && c.name === `skill:${skillName}`)) {
			return { action: "continue" };
		}

		// Pi now expands exactly one skill, including frontmatter stripping and
		// relative-reference context. No resubmission, command execution, or loop.
		return {
			action: "transform",
			text: `/skill:${skillName}${nested[2] ? ` ${nested[2]}` : ""}`,
			images: event.images,
		};
	});
}
