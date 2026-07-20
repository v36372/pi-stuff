import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { SkillSource } from "../types.ts";

export interface SkillRoot {
  path: string;
  source: SkillSource;
}

export function getAgentDir(): string {
  const configured = process.env.PI_CODING_AGENT_DIR?.trim();
  if (configured) return expandHome(configured);
  return join(homedir(), ".pi", "agent");
}

export function getSkillRoots(cwd: string): SkillRoot[] {
  const resolvedCwd = resolve(cwd);
  const userAgentsSkills = join(homedir(), ".agents", "skills");
  const roots: SkillRoot[] = [
    {
      path: join(getAgentDir(), "skills"),
      source: { kind: "user", root: join(getAgentDir(), "skills") },
    },
    // Shared Agent Skills home (also used by Pi's package manager).
    {
      path: userAgentsSkills,
      source: { kind: "user-legacy", root: userAgentsSkills },
    },
    {
      path: resolve(resolvedCwd, ".pi", "skills"),
      source: { kind: "project", root: resolve(resolvedCwd, ".pi", "skills") },
    },
    // Project-local Agent Skills (cwd/.agents/skills and ancestors via Pi).
    {
      path: resolve(resolvedCwd, ".agents", "skills"),
      source: { kind: "project-legacy", root: resolve(resolvedCwd, ".agents", "skills") },
    },
  ];

  const seen = new Set<string>();
  return roots.filter((root) => {
    const key = resolve(root.path);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function expandHome(input: string): string {
  if (input === "~") return homedir();
  if (input.startsWith("~/")) return join(homedir(), input.slice(2));
  return input;
}
