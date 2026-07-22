import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const BLOCKED_COMMANDS = ["sops", "kubectl"] as const;

function ghCommandPattern(command: string): RegExp {
  const separator =
    "(?:\\s+(?:(?:-R|--repo)\\s+\\S+|(?:-R=?|--repo=)\\S+))*\\s+";
  const commandWithRepoFlags = command.replaceAll("\\s+", separator);

  return new RegExp(
    `(^|[^\\w.-])gh${separator}(?:${commandWithRepoFlags})(?=$|[^\\w.-])`,
    "i",
  );
}

const CONFIRM_COMMAND_PATTERNS = [
  {
    name: "git push",
    pattern:
      /(^|[^\w.-])git(?:\s+(?:-C|-c|--config-env|--git-dir|--work-tree|--namespace|--super-prefix|--exec-path)\s+\S+|\s+(?:-C|-c)\S+|\s+--[\w-]+(?:=\S+)?)*\s+push(?=$|[^\w.-])/i,
  },
  {
    name: "gh pull request create",
    pattern: ghCommandPattern("pr\\s+create"),
  },
  {
    name: "gh pull request edit",
    pattern: ghCommandPattern("pr\\s+edit"),
  },
] as const;

// gh api defaults to GET, or POST when -f/-F/--input are present.
// Only gate write-y requests so code search / read GraphQL stay silent.
const GH_API_PATTERN = ghCommandPattern("api");
const GH_API_METHOD_PATTERN =
  /(?:^|\s)(?:-X|--method)(?:=|\s+)(GET|HEAD|POST|PUT|PATCH|DELETE)\b/i;
const GH_API_BODY_PATTERN =
  /(?:^|\s)(?:-f|--raw-field|-F|--field|--input)(?:=|\s+)/;
const GH_API_GRAPHQL_PATTERN =
  /(?:^|[^\w.-])graphql(?=$|[^\w.-])/i;
// GraphQL operation type is case-sensitive in the language.
const GH_API_GRAPHQL_MUTATION_PATTERN = /\bmutation\b/;

function isGhApiSideEffect(command: string): boolean {
  if (!GH_API_PATTERN.test(command)) return false;

  const method = GH_API_METHOD_PATTERN.exec(command)?.[1]?.toUpperCase();
  if (method === "GET" || method === "HEAD") return false;
  if (method === "POST" || method === "PUT" || method === "PATCH" || method === "DELETE") {
    // GraphQL always POSTs; only mutations change state.
    if (method === "POST" && GH_API_GRAPHQL_PATTERN.test(command)) {
      return GH_API_GRAPHQL_MUTATION_PATTERN.test(command);
    }
    return true;
  }

  // No explicit method: body flags force POST.
  if (!GH_API_BODY_PATTERN.test(command)) return false;

  if (GH_API_GRAPHQL_PATTERN.test(command)) {
    // Inline query without mutation is a read; body from file/stdin is opaque.
    return (
      GH_API_GRAPHQL_MUTATION_PATTERN.test(command) ||
      /(?:^|\s)(?:--input|-f|--raw-field|-F|--field)(?:=|\s+)@/.test(command) ||
      /(?:^|\s)--input(?:=|\s+)/.test(command)
    );
  }

  return true;
}

const BLOCKED_COMMAND_PATTERNS = [
  {
    name: "direct AKHQ access (use ./tools/akhq/akhq)",
    pattern: /(^|[^\w.-])akhq\.skymavis\.tools(?=$|[^\w.-])/i,
  },
  {
    name: "AKHQ state-changing API",
    pattern:
      /\/api\/[^/\s"'?]+\/connect\/[^/\s"'?]+\/[^/\s"'?]+\/(?:pause|resume|restart|tasks\/[^/\s"'?]+\/restart)(?=$|[/?#\s"';&|])/i,
  },
  {
    name: "helm diff upgrade",
    pattern: /(^|[^\w.-])helm\s+diff\s+upgrade(?=$|[^\w.-])/i,
  },
  {
    name: "git send-pack",
    pattern:
      /(^|[^\w.-])git(?:\s+(?:-C|-c|--config-env|--git-dir|--work-tree|--namespace|--super-prefix|--exec-path)\s+\S+|\s+(?:-C|-c)\S+|\s+--[\w-]+(?:=\S+)?)*\s+send-pack(?=$|[^\w.-])/i,
  },
  {
    name: "git lfs push",
    pattern: /(^|[^\w.-])git\s+lfs\s+push(?=$|[^\w.-])/i,
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
      "pr\\s+(?:close|comment|new|lock|merge|ready|reopen|revert|review|unlock|update-branch)",
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

function findConfirmCommand(command: string): string | undefined {
  const match = CONFIRM_COMMAND_PATTERNS.find(({ pattern }) =>
    pattern.test(command),
  )?.name;
  if (match) return match;
  if (isGhApiSideEffect(command)) return "gh api write";
  return undefined;
}

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "bash") return;

    const command = event.input.command as string;
    const blocked = findBlockedCommand(command);
    if (blocked) {
      return {
        block: true,
        reason: `Blocked command: ${blocked}`,
      };
    }

    const confirm = findConfirmCommand(command);
    if (!confirm) return;

    if (!ctx.hasUI) {
      return {
        block: true,
        reason: `Blocked command: ${confirm} requires user confirmation`,
      };
    }

    const choice = await ctx.ui.select(
      `Allow this ${confirm} command once?\n\n${command}`,
      ["Yes", "No"],
    );
    if (choice === "Yes") return;

    return {
      block: true,
      reason: `Blocked by user: ${confirm}`,
    };
  });

  pi.on("user_bash", async (event, ctx) => {
    const blocked = findBlockedCommand(event.command);
    if (blocked) {
      return {
        result: {
          output: `Blocked command: ${blocked}`,
          exitCode: 1,
          cancelled: false,
          truncated: false,
        },
      };
    }

    const confirm = findConfirmCommand(event.command);
    if (!confirm) return;

    if (!ctx.hasUI) {
      return {
        result: {
          output: `Blocked command: ${confirm} requires user confirmation`,
          exitCode: 1,
          cancelled: false,
          truncated: false,
        },
      };
    }

    const choice = await ctx.ui.select(
      `Allow this ${confirm} command once?\n\n${event.command}`,
      ["Yes", "No"],
    );
    if (choice === "Yes") return;

    return {
      result: {
        output: `Blocked by user: ${confirm}`,
        exitCode: 1,
        cancelled: false,
        truncated: false,
      },
    };
  });
}
