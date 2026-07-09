import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const BLOCKED_COMMANDS = ["gcloud", "sops", "kubectl"] as const;

function findBlockedCommand(command: string): string | undefined {
  const blockedPattern = new RegExp(
    `(^|[^\\w.-])(?:${BLOCKED_COMMANDS.join("|")})(?=$|[^\\w.-])`,
    "i",
  );

  const match = blockedPattern.exec(command);
  return match?.[0].replace(/^[^\w.-]+/, "").toLowerCase();
}

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", async (event) => {
    if (event.toolName !== "bash") return;

    const command = event.input.command as string;
    const blocked = findBlockedCommand(command);
    if (!blocked) return;

    return {
      block: true,
      reason: `Blocked command: ${blocked}`,
    };
  });

  pi.on("user_bash", (event) => {
    const blocked = findBlockedCommand(event.command);
    if (!blocked) return;

    return {
      result: {
        output: `Blocked command: ${blocked}`,
        exitCode: 1,
        cancelled: false,
        truncated: false,
      },
    };
  });
}
