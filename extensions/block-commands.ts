import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const BLOCKED_COMMANDS = ["gcloud", "sops", "kubectl"] as const;

function ghCommandPattern(command: string): RegExp {
  const separator =
    "(?:\\s+(?:(?:-R|--repo)\\s+\\S+|(?:-R=?|--repo=)\\S+))*\\s+";
  const commandWithRepoFlags = command.replaceAll("\\s+", separator);

  return new RegExp(
    `(^|[^\\w.-])gh${separator}(?:${commandWithRepoFlags})(?=$|[^\\w.-])`,
    "i",
  );
}

const BLOCKED_COMMAND_PATTERNS = [
  {
    name: "helm diff upgrade",
    pattern: /(^|[^\w.-])helm\s+diff\s+upgrade(?=$|[^\w.-])/i,
  },
  {
    name: "git remote write",
    pattern:
      /(^|[^\w.-])git(?:\s+(?:-C|-c|--config-env|--git-dir|--work-tree|--namespace|--super-prefix|--exec-path)\s+\S+|\s+(?:-C|-c)\S+|\s+--[\w-]+(?:=\S+)?)*\s+(?:push|send-pack)(?=$|[^\w.-])/i,
  },
  {
    name: "git lfs push",
    pattern: /(^|[^\w.-])git\s+lfs\s+push(?=$|[^\w.-])/i,
  },
  {
    name: "gh api",
    pattern: ghCommandPattern("api"),
  },
  {
    name: "gh agent task write",
    pattern: ghCommandPattern("(?:agent-(?:task|tasks)|agents?)\\s+create"),
  },
  {
    name: "gh actions write",
    pattern: ghCommandPattern(
      "(?:cache\\s+delete|run\\s+(?:cancel|delete|rerun)|workflow\\s+(?:disable|enable|run))",
    ),
  },
  {
    name: "gh codespace write",
    pattern: ghCommandPattern(
      "(?:codespace|cs)\\s+(?:cp|create|delete|edit|rebuild|ssh|stop|ports\\s+visibility)",
    ),
  },
  {
    name: "gh discussion write",
    pattern: ghCommandPattern("discussion\\s+(?:comment|create|edit)"),
  },
  {
    name: "gh gist write",
    pattern: ghCommandPattern("gist\\s+(?:create|new|delete|edit|rename)"),
  },
  {
    name: "gh issue write",
    pattern: ghCommandPattern(
      "issue\\s+(?:close|comment|create|new|delete|develop|edit|lock|pin|reopen|transfer|unlock|unpin)",
    ),
  },
  {
    name: "gh label write",
    pattern: ghCommandPattern("label\\s+(?:clone|create|delete|edit)"),
  },
  {
    name: "gh pull request write",
    pattern: ghCommandPattern(
      "pr\\s+(?:close|comment|create|new|edit|lock|merge|ready|reopen|revert|review|unlock|update-branch)",
    ),
  },
  {
    name: "gh project write",
    pattern: ghCommandPattern(
      "project\\s+(?:close|copy|create|delete|edit|field-create|field-delete|item-add|item-archive|item-create|item-delete|item-edit|link|mark-template|unlink)",
    ),
  },
  {
    name: "gh release write",
    pattern: ghCommandPattern(
      "release\\s+(?:create|new|delete|delete-asset|edit|upload)",
    ),
  },
  {
    name: "gh repository write",
    pattern: ghCommandPattern(
      "repo\\s+(?:archive|create|new|delete|edit|fork|rename|sync|unarchive|autolink\\s+(?:create|new|delete)|deploy-key\\s+(?:add|delete))",
    ),
  },
  {
    name: "gh account or repository setting write",
    pattern: ghCommandPattern(
      "(?:gpg-key\\s+(?:add|delete)|secret\\s+(?:delete|remove|set)|ssh-key\\s+(?:add|delete)|variable\\s+(?:delete|remove|set))",
    ),
  },
  {
    name: "gh skill publish",
    pattern: ghCommandPattern("skills?\\s+publish"),
  },
  {
    name: "gh extension command",
    pattern: ghCommandPattern("(?:extension|extensions|ext)\\s+exec"),
  },
] as const;

function findBlockedCommand(command: string): string | undefined {
  const blockedPattern = new RegExp(
    `(^|[^\\w.-])(?:${BLOCKED_COMMANDS.join("|")})(?=$|[^\\w.-])`,
    "i",
  );

  const match = blockedPattern.exec(command);
  if (match) return match[0].replace(/^[^\w.-]+/, "").toLowerCase();

  return BLOCKED_COMMAND_PATTERNS.find(({ pattern }) => pattern.test(command))?.name;
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
