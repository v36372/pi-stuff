/**
 * Rounded editor text box for pi.
 *
 *   ╭─────────────────────────╮
 *   │ › text box              │
 *   ╰────── Model Name (high) ─╯
 */

import {
	CustomEditor,
	type ExtensionAPI,
	type ExtensionContext,
	type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import type { EditorTheme, TUI } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

function stripAnsi(text: string): string {
	return text.replace(
		/[\u001b\u009b][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]+)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g,
		"",
	);
}

function isHorizontalBorder(text: string): boolean {
	const plain = stripAnsi(text);
	return plain.length > 0 && plain.replace(/─/g, "") === "";
}

/** Build a rounded border with an optional right-aligned label. */
function roundedEditorBorder(
	width: number,
	left: string,
	right: string,
	border: (text: string) => string,
	label = "",
): string {
	const innerWidth = Math.max(0, width - 2);
	if (!label) return border(left) + border("─".repeat(innerWidth)) + border(right);

	let labelText = ` ${label} `;
	const tailWidth = Math.min(2, Math.max(0, innerWidth - visibleWidth(labelText)));
	labelText = truncateToWidth(labelText, Math.max(0, innerWidth - tailWidth), "");
	const leftWidth = Math.max(0, innerWidth - visibleWidth(labelText) - tailWidth);
	return (
		border(left) +
		border("─".repeat(leftWidth)) +
		labelText +
		border("─".repeat(tailWidth)) +
		border(right)
	);
}

export default function (pi: ExtensionAPI) {
	let tuiRef: { requestRender: () => void } | null = null;

	const applyEditor = (ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;

		class RoundedEditor extends CustomEditor {
			constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) {
				super(tui, theme, keybindings, { paddingX: 0 });
				tuiRef = tui;
			}

			render(width: number): string[] {
				if (width < 6) return super.render(width);

				// Render four columns narrower: two for the outer │ borders and two for
				// the "› " hanging prompt. Nothing is truncated afterwards, so a full
				// first line keeps its last character and the cursor cell / IME marker
				// always survive.
				const innerWidth = width - 2;
				const lines = super.render(innerWidth - 2);
				if (lines.length < 2) return lines;

				const borderColor = (text: string) => this.borderColor(text);
				const prompt = `${ctx.ui.theme.fg("accent", "›")} `;

				// Border-like lines (visible text ends with ─: the horizontal borders
				// and any "↑/↓ N more" scroll indicator) are extended with ─ so the
				// indicator stays intact inside the shell; text lines get the hanging
				// prompt/indent and are space-padded.
				const wrap = (line: string, left: string, right: string, prefix: string) => {
					const borderLike = stripAnsi(line).endsWith("─");
					const content = borderLike ? line : prefix + line;
					const gap = Math.max(0, innerWidth - visibleWidth(content));
					const fill = borderLike ? borderColor("─".repeat(gap)) : " ".repeat(gap);
					return borderColor(left) + content + fill + borderColor(right);
				};

				// The bottom border is the last all-─ line; searching from the end keeps
				// a user-typed ─── rule from being mistaken for it. When the editor is
				// scrolled the bottom border carries a "↓ N more" indicator and is not
				// all-─, so it stays visible as a boxed line above the ╰──╯ appended below.
				const bottomIndex = lines.findLastIndex(
					(line, index) => index > 0 && isHorizontalBorder(line),
				);
				const endOfEditor = bottomIndex === -1 ? lines.length : bottomIndex;
				const body = lines.slice(1, endOfEditor);
				const extra = bottomIndex === -1 ? [] : lines.slice(bottomIndex + 1);

				const result = [wrap(lines[0]!, "╭", "╮", "")];
				for (let index = 0; index < body.length; index++) {
					result.push(wrap(body[index]!, "│", "│", index === 0 ? prompt : "  "));
				}
				// Autocomplete entries remain inside the same rounded shell, aligned
				// with the input text.
				for (const line of extra) {
					result.push(wrap(line, "│", "│", "  "));
				}
				const modelName = ctx.model?.name || ctx.model?.id || "no model";
				const thinkingLevel = pi.getThinkingLevel();
				const modelStatus =
					ctx.ui.theme.fg("muted", modelName) +
					ctx.ui.theme.fg("dim", ` (${thinkingLevel})`);
				result.push(
					roundedEditorBorder(width, "╰", "╯", borderColor, modelStatus),
				);
				return result;
			}
		}

		ctx.ui.setEditorComponent(
			(tui, theme, keybindings) => new RoundedEditor(tui, theme, keybindings),
		);
	};

	pi.on("session_start", async (_event, ctx) => {
		applyEditor(ctx);
	});

	pi.on("model_select", async () => tuiRef?.requestRender());
	pi.on("thinking_level_select", async () => tuiRef?.requestRender());
}
