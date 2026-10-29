import { describe, expect, it } from "vitest";

import { planCompletion } from "../src/completion.ts";

describe("completion routing", () => {
  it("tells a successful agent wake to check for stale or handled work", () => {
    const plan = planCompletion("succeeded", "agent");
    expect(plan.kind).toBe("agent");
    if (plan.kind !== "agent") throw new Error("Expected agent plan");
    expect(plan.instruction).toContain("was true when checked");
    expect(plan.instruction).toContain("If the task is finished, stop");
    expect(plan.instruction).toContain("excluding handled results");
    expect(plan.instruction).not.toContain("Continue the pending work");
  });

  it("keeps notify-only actor failures out of the agent wake path", () => {
    expect(planCompletion("failed", "notify")).toEqual({
      kind: "notify",
      level: "warning",
      summary: "failed",
    });
  });

  it("wakes the agent for agent-mode failures", () => {
    expect(planCompletion("failed", "agent")).toMatchObject({
      kind: "agent",
    });
  });
});
