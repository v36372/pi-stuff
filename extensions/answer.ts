/**
 * Q&A helper extension.
 *
 * Provides three ways to collect answers from the user:
 * 1. `ask_questions` tool for the LLM to proactively ask structured questions
 * 2. `/answer` command and Ctrl+. shortcut to extract questions from the last assistant message
 * 3. Automatic fallback after assistant replies that look like requirement-gathering questions
 */

import { complete, type Api, type Model, type UserMessage } from "@mariozechner/pi-ai";
import { BorderedLoader } from "@mariozechner/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
	type Component,
	Editor,
	type EditorTheme,
	Key,
	matchesKey,
	truncateToWidth,
	type TUI,
	visibleWidth,
	wrapTextWithAnsi,
} from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";

interface ExtractedQuestion {
	question: string;
	context?: string;
}

interface ExtractionResult {
	questions: ExtractedQuestion[];
}

const AskQuestionsParams = Type.Object({
	questions: Type.Array(
		Type.Object({
			question: Type.String({ description: "The question to ask the user" }),
			context: Type.Optional(
				Type.String({
					description: "Optional short context that helps the user answer the question",
				}),
			),
		}),
		{
			minItems: 1,
			description: "Questions to ask the user. Batch related questions into a single tool call.",
		},
	),
});

const SYSTEM_PROMPT = `You are a question extractor. Given text from a conversation, extract any questions that need answering.

Output a JSON object with this structure:
{
  "questions": [
    {
      "question": "The question text",
      "context": "Optional context that helps answer the question"
    }
  ]
}

Rules:
- Extract all questions that require user input
- Keep questions in the order they appeared
- Be concise with question text
- Include context only when it provides essential information for answering
- If no questions are found, return {"questions": []}

Example output:
{
  "questions": [
    {
      "question": "What is your preferred database?",
      "context": "We can only configure MySQL and PostgreSQL because of what is implemented."
    },
    {
      "question": "Should we use TypeScript or JavaScript?"
    }
  ]
}`;

const ANSWERS_PREFIX = "Here are my answers:\n\n";
const CODEX_MODEL_ID = "gpt-5.1-codex-mini";
const HAIKU_MODEL_ID = "claude-haiku-4-5";

async function selectExtractionModel(
	currentModel: Model<Api>,
	modelRegistry: {
		find: (provider: string, modelId: string) => Model<Api> | undefined;
		getApiKey: (model: Model<Api>) => Promise<string | undefined>;
	},
): Promise<Model<Api>> {
	const codexModel = modelRegistry.find("openai-codex", CODEX_MODEL_ID);
	if (codexModel) {
		const apiKey = await modelRegistry.getApiKey(codexModel);
		if (apiKey) return codexModel;
	}

	const haikuModel = modelRegistry.find("anthropic", HAIKU_MODEL_ID);
	if (!haikuModel) return currentModel;

	const apiKey = await modelRegistry.getApiKey(haikuModel);
	if (!apiKey) return currentModel;

	return haikuModel;
}

function parseExtractionResult(text: string): ExtractionResult | null {
	try {
		let jsonStr = text;
		const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
		if (jsonMatch) jsonStr = jsonMatch[1].trim();

		const parsed = JSON.parse(jsonStr);
		if (parsed && Array.isArray(parsed.questions)) {
			return parsed as ExtractionResult;
		}
		return null;
	} catch {
		return null;
	}
}

function getTextContent(content: Array<{ type: string; text?: string }> | undefined): string {
	if (!content) return "";
	return content
		.filter((part): part is { type: "text"; text: string } => part.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("\n")
		.trim();
}

function findLastCompleteAssistantText(ctx: ExtensionContext): string | undefined {
	const branch = ctx.sessionManager.getBranch();
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry.type !== "message") continue;
		const message = entry.message as {
			role?: string;
			stopReason?: string;
			content?: Array<{ type: string; text?: string }>;
		};
		if (message.role !== "assistant" || message.stopReason !== "stop") continue;
		const text = getTextContent(message.content);
		if (text) return text;
	}
	return undefined;
}

function formatAnswers(questions: ExtractedQuestion[], answers: string[]): string {
	const parts: string[] = [];
	for (let i = 0; i < questions.length; i++) {
		const question = questions[i];
		const answer = answers[i]?.trim() || "(no answer)";
		parts.push(`Q: ${question.question}`);
		if (question.context) parts.push(`> ${question.context}`);
		parts.push(`A: ${answer}`);
		parts.push("");
	}
	return parts.join("\n").trim();
}

function shouldAttemptAutomaticPrompt(text: string): boolean {
	const questionMarks = (text.match(/[?？]/g) || []).length;
	if (questionMarks >= 2) return true;

	return /\b(i have .*questions|a few questions|need a few answers|can you clarify|could you clarify|please answer|which option|which one|should we|do you want|would you like|what should|what would you prefer)\b/i.test(
		text,
	);
}

async function extractQuestionsFromText(ctx: ExtensionContext, text: string): Promise<ExtractionResult | null> {
	if (!ctx.hasUI || !ctx.model) return null;

	const extractionModel = await selectExtractionModel(ctx.model, ctx.modelRegistry);
	return ctx.ui.custom<ExtractionResult | null>((tui, theme, _kb, done) => {
		const loader = new BorderedLoader(tui, theme, `Extracting questions using ${extractionModel.id}...`);
		loader.onAbort = () => done(null);

		const doExtract = async () => {
			const apiKey = await ctx.modelRegistry.getApiKey(extractionModel);
			const userMessage: UserMessage = {
				role: "user",
				content: [{ type: "text", text }],
				timestamp: Date.now(),
			};

			const response = await complete(
				extractionModel,
				{ systemPrompt: SYSTEM_PROMPT, messages: [userMessage] },
				{ apiKey, signal: loader.signal },
			);

			if (response.stopReason === "aborted") return null;

			const responseText = getTextContent(response.content as Array<{ type: string; text?: string }>);
			return parseExtractionResult(responseText);
		};

		doExtract()
			.then(done)
			.catch(() => done(null));

		return loader;
	});
}

class QnAComponent implements Component {
	private questions: ExtractedQuestion[];
	private answers: string[];
	private currentIndex = 0;
	private editor: Editor;
	private tui: TUI;
	private onDone: (result: string | null) => void;
	private showingConfirmation = false;
	private cachedWidth?: number;
	private cachedLines?: string[];

	private dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
	private bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
	private cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
	private green = (s: string) => `\x1b[32m${s}\x1b[0m`;
	private yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
	private gray = (s: string) => `\x1b[90m${s}\x1b[0m`;

	constructor(questions: ExtractedQuestion[], tui: TUI, onDone: (result: string | null) => void) {
		this.questions = questions;
		this.answers = questions.map(() => "");
		this.tui = tui;
		this.onDone = onDone;

		const editorTheme: EditorTheme = {
			borderColor: this.dim,
			selectList: {
				selectedBg: (s: string) => `\x1b[44m${s}\x1b[0m`,
				matchHighlight: this.cyan,
				itemSecondary: this.gray,
			},
		};

		this.editor = new Editor(tui, editorTheme);
		this.editor.disableSubmit = true;
		this.editor.onChange = () => {
			this.invalidate();
			this.tui.requestRender();
		};
	}

	private saveCurrentAnswer(): void {
		this.answers[this.currentIndex] = this.editor.getText();
	}

	private navigateTo(index: number): void {
		if (index < 0 || index >= this.questions.length) return;
		this.saveCurrentAnswer();
		this.currentIndex = index;
		this.editor.setText(this.answers[index] || "");
		this.invalidate();
	}

	private submit(): void {
		this.saveCurrentAnswer();
		this.onDone(formatAnswers(this.questions, this.answers));
	}

	private cancel(): void {
		this.onDone(null);
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	handleInput(data: string): void {
		if (this.showingConfirmation) {
			if (matchesKey(data, Key.enter) || data.toLowerCase() === "y") {
				this.submit();
				return;
			}
			if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c")) || data.toLowerCase() === "n") {
				this.showingConfirmation = false;
				this.invalidate();
				this.tui.requestRender();
				return;
			}
			return;
		}

		if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
			this.cancel();
			return;
		}

		if (matchesKey(data, Key.tab)) {
			if (this.currentIndex < this.questions.length - 1) {
				this.navigateTo(this.currentIndex + 1);
				this.tui.requestRender();
			}
			return;
		}
		if (matchesKey(data, Key.shift("tab"))) {
			if (this.currentIndex > 0) {
				this.navigateTo(this.currentIndex - 1);
				this.tui.requestRender();
			}
			return;
		}

		if (matchesKey(data, Key.up) && this.editor.getText() === "") {
			if (this.currentIndex > 0) {
				this.navigateTo(this.currentIndex - 1);
				this.tui.requestRender();
				return;
			}
		}
		if (matchesKey(data, Key.down) && this.editor.getText() === "") {
			if (this.currentIndex < this.questions.length - 1) {
				this.navigateTo(this.currentIndex + 1);
				this.tui.requestRender();
				return;
			}
		}

		if (matchesKey(data, Key.enter) && !matchesKey(data, Key.shift("enter"))) {
			this.saveCurrentAnswer();
			if (this.currentIndex < this.questions.length - 1) {
				this.navigateTo(this.currentIndex + 1);
			} else {
				this.showingConfirmation = true;
			}
			this.invalidate();
			this.tui.requestRender();
			return;
		}

		this.editor.handleInput(data);
		this.invalidate();
		this.tui.requestRender();
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;

		const lines: string[] = [];
		const boxWidth = Math.min(width - 4, 120);
		const contentWidth = boxWidth - 4;
		const horizontalLine = (count: number) => "─".repeat(count);
		const boxLine = (content: string, leftPad = 2): string => {
			const paddedContent = " ".repeat(leftPad) + content;
			const contentLen = visibleWidth(paddedContent);
			const rightPad = Math.max(0, boxWidth - contentLen - 2);
			return this.dim("│") + paddedContent + " ".repeat(rightPad) + this.dim("│");
		};
		const emptyBoxLine = (): string => this.dim("│") + " ".repeat(boxWidth - 2) + this.dim("│");
		const padToWidth = (line: string): string => line + " ".repeat(Math.max(0, width - visibleWidth(line)));

		lines.push(padToWidth(this.dim("╭" + horizontalLine(boxWidth - 2) + "╮")));
		const title = `${this.bold(this.cyan("Questions"))} ${this.dim(`(${this.currentIndex + 1}/${this.questions.length})`)}`;
		lines.push(padToWidth(boxLine(title)));
		lines.push(padToWidth(this.dim("├" + horizontalLine(boxWidth - 2) + "┤")));

		const progressParts: string[] = [];
		for (let i = 0; i < this.questions.length; i++) {
			const answered = (this.answers[i]?.trim() || "").length > 0;
			const current = i === this.currentIndex;
			if (current) progressParts.push(this.cyan("●"));
			else if (answered) progressParts.push(this.green("●"));
			else progressParts.push(this.dim("○"));
		}
		lines.push(padToWidth(boxLine(progressParts.join(" "))));
		lines.push(padToWidth(emptyBoxLine()));

		const question = this.questions[this.currentIndex];
		for (const line of wrapTextWithAnsi(`${this.bold("Q:")} ${question.question}`, contentWidth)) {
			lines.push(padToWidth(boxLine(line)));
		}

		if (question.context) {
			lines.push(padToWidth(emptyBoxLine()));
			for (const line of wrapTextWithAnsi(this.gray(`> ${question.context}`), contentWidth - 2)) {
				lines.push(padToWidth(boxLine(line)));
			}
		}

		lines.push(padToWidth(emptyBoxLine()));

		const answerPrefix = this.bold("A: ");
		const editorWidth = contentWidth - 7;
		const editorLines = this.editor.render(editorWidth);
		for (let i = 1; i < editorLines.length - 1; i++) {
			if (i === 1) lines.push(padToWidth(boxLine(answerPrefix + editorLines[i])));
			else lines.push(padToWidth(boxLine("   " + editorLines[i])));
		}

		lines.push(padToWidth(emptyBoxLine()));
		lines.push(padToWidth(this.dim("├" + horizontalLine(boxWidth - 2) + "┤")));
		if (this.showingConfirmation) {
			const confirmMsg = `${this.yellow("Submit all answers?")} ${this.dim("(Enter/y to confirm, Esc/n to cancel)")}`;
			lines.push(padToWidth(boxLine(truncateToWidth(confirmMsg, contentWidth))));
		} else {
			const controls = `${this.dim("Tab/Enter")} next · ${this.dim("Shift+Tab")} prev · ${this.dim("Shift+Enter")} newline · ${this.dim("Esc")} cancel`;
			lines.push(padToWidth(boxLine(truncateToWidth(controls, contentWidth))));
		}
		lines.push(padToWidth(this.dim("╰" + horizontalLine(boxWidth - 2) + "╯")));

		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}
}

async function collectAnswers(ctx: ExtensionContext, questions: ExtractedQuestion[]): Promise<string | null> {
	if (!ctx.hasUI) return null;
	return ctx.ui.custom<string | null>((tui, _theme, _kb, done) => new QnAComponent(questions, tui, done));
}

function submitAnswers(pi: ExtensionAPI, answersText: string): void {
	pi.sendUserMessage(ANSWERS_PREFIX + answersText);
}

export default function (pi: ExtensionAPI) {
	let autoPromptInFlight = false;

	const answerHandler = async (ctx: ExtensionContext) => {
		if (!ctx.hasUI) {
			ctx.ui.notify("answer requires interactive mode", "error");
			return;
		}
		if (!ctx.model) {
			ctx.ui.notify("No model selected", "error");
			return;
		}

		const lastAssistantText = findLastCompleteAssistantText(ctx);
		if (!lastAssistantText) {
			ctx.ui.notify("No assistant messages found", "error");
			return;
		}

		const extractionResult = await extractQuestionsFromText(ctx, lastAssistantText);
		if (extractionResult === null) {
			ctx.ui.notify("Cancelled", "info");
			return;
		}
		if (extractionResult.questions.length === 0) {
			ctx.ui.notify("No questions found in the last message", "info");
			return;
		}

		const answersResult = await collectAnswers(ctx, extractionResult.questions);
		if (answersResult === null) {
			ctx.ui.notify("Cancelled", "info");
			return;
		}

		submitAnswers(pi, answersResult);
	};

	pi.registerTool({
		name: "ask_questions",
		label: "Ask Questions",
		description: "Ask the user one or more structured clarification questions and return their answers.",
		promptSnippet: "Ask the user one or more structured clarification questions and return their answers.",
		promptGuidelines: [
			"When you need clarification, a decision, or missing information from the user, use ask_questions instead of asking plain-text questions in your assistant message.",
			"Batch related questions into a single ask_questions call.",
			"After the tool returns, continue the task using the user's answers.",
		],
		parameters: AskQuestionsParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!ctx.hasUI) {
				return {
					content: [{ type: "text", text: "Error: ask_questions requires interactive mode." }],
					details: { questions: params.questions, cancelled: true },
				};
			}

			if (params.questions.length === 0) {
				return {
					content: [{ type: "text", text: "Error: No questions provided." }],
					details: { questions: [], cancelled: true },
				};
			}

			const answersText = await collectAnswers(ctx, params.questions);
			if (answersText === null) {
				return {
					content: [{ type: "text", text: "User cancelled answering the questions." }],
					details: { questions: params.questions, cancelled: true },
				};
			}

			return {
				content: [{ type: "text", text: `User answered the questions:\n\n${answersText}` }],
				details: { questions: params.questions, answersText, cancelled: false },
			};
		},
	});

	pi.registerCommand("answer", {
		description: "Extract questions from last assistant message into interactive Q&A",
		handler: (_args, ctx) => answerHandler(ctx),
	});

	pi.registerShortcut("ctrl+.", {
		description: "Extract and answer questions",
		handler: answerHandler,
	});

	pi.on("agent_end", async (event, ctx) => {
		if (autoPromptInFlight || !ctx.hasUI || !ctx.model) return;

		const lastAssistant = [...event.messages]
			.reverse()
			.find(
				(message) =>
					(message as { role?: string; stopReason?: string }).role === "assistant" &&
					(message as { stopReason?: string }).stopReason === "stop",
			) as { content?: Array<{ type: string; text?: string }> } | undefined;
		if (!lastAssistant) return;

		const assistantText = getTextContent(lastAssistant.content);
		if (!assistantText || !shouldAttemptAutomaticPrompt(assistantText)) return;

		autoPromptInFlight = true;
		try {
			const extractionResult = await extractQuestionsFromText(ctx, assistantText);
			if (!extractionResult || extractionResult.questions.length === 0) return;

			const answersResult = await collectAnswers(ctx, extractionResult.questions);
			if (answersResult === null) {
				ctx.ui.notify("Question prompt cancelled", "info");
				return;
			}

			submitAnswers(pi, answersResult);
		} finally {
			autoPromptInFlight = false;
		}
	});
}
