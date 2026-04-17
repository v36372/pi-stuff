import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

export default function (pi: ExtensionAPI) {
  // Queue of slash commands to place in editor after agent finishes
  let pendingSlashCommand: { command: string; reason?: string } | null = null;

  pi.registerTool({
    name: "execute_command",
    label: "Execute Command",
    description: `Execute a slash command or send a message as if the user typed it. The message is added to the session history and triggers a new turn. Use this to:
- Self-invoke /answer after asking multiple questions
- Run /reload after creating skills
- Execute any slash command programmatically
- Send follow-up prompts to yourself

The command/message appears in the conversation as a user message.`,
    promptSnippet:
      "Execute a slash command or send a message as if the user typed it. " +
      "Use to self-invoke /answer after asking questions, run /reload after creating skills, or send follow-up prompts.",

    parameters: Type.Object({
      command: Type.String({
        description:
          "The command or message to execute (e.g., '/answer', '/reload', or any text)",
      }),
      reason: Type.Optional(
        Type.String({
          description:
            "Optional explanation for why you're executing this command (shown to user)",
        }),
      ),
    }),

    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const { command, reason } = params;
      const trimmed = command.trim();

      // /answer — fire-and-forget via event bus (works immediately)
      if (trimmed === "/answer") {
        pi.events.emit("trigger:answer", ctx);
        return {
          content: [
            {
              type: "text",
              text: reason ? `Triggered /answer.\nReason: ${reason}` : "Triggered /answer.",
            },
          ],
          details: { command: trimmed, reason, mechanism: "event" },
        };
      }

      // Slash commands — queue for editor prefill after agent finishes.
      // pi.sendUserMessage bypasses command routing (expandPromptTemplates=false),
      // so slash commands can only run through actual user input in the TUI.
      if (trimmed.startsWith("/")) {
        pendingSlashCommand = { command: trimmed, reason };
        return {
          content: [
            {
              type: "text",
              text: reason
                ? `${trimmed} will be placed in the editor after your response ends. The user will press Enter to execute it.\nReason: ${reason}\n\nIMPORTANT: Stop making tool calls now. Finish your response so the command can execute.`
                : `${trimmed} will be placed in the editor after your response ends. The user will press Enter to execute it.\n\nIMPORTANT: Stop making tool calls now. Finish your response so the command can execute.`,
            },
          ],
          details: { command: trimmed, reason, mechanism: "editor-prefill" },
        };
      }

      // Non-command text — send as steer message (delivered between turns to the LLM)
      pi.sendUserMessage(trimmed, { deliverAs: "steer" });
      return {
        content: [
          {
            type: "text",
            text: reason
              ? `Queued message as steer (will be delivered after current turn):\n"${trimmed}"\nReason: ${reason}`
              : `Queued message as steer (will be delivered after current turn):\n"${trimmed}"`,
          },
        ],
        details: { command: trimmed, reason, mechanism: "steer" },
      };
    },
  });

  // After agent finishes, prefill editor with any pending slash command
  pi.on("agent_end", async (_event, ctx) => {
    if (!pendingSlashCommand) return;

    const { command, reason } = pendingSlashCommand;
    pendingSlashCommand = null;

    if (ctx.hasUI) {
      ctx.ui.setEditorText(command);
      ctx.ui.notify(
        `Press Enter to execute: ${command}${reason ? ` (${reason})` : ""}`,
        "info",
      );
    }
  });
}
