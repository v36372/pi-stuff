export type CompletionStatus = "succeeded" | "timedOut" | "failed";

export type CompletionPlan =
  | {
      readonly kind: "agent";
      readonly instruction: string;
    }
  | {
      readonly kind: "notify";
      readonly level: "info" | "warning";
      readonly summary: string;
    };

export const planCompletion = (
  status: CompletionStatus,
  wake: "agent" | "notify"
): CompletionPlan => {
  if (wake === "notify") {
    return {
      kind: "notify",
      level: status === "succeeded" ? "info" : "warning",
      summary: status === "succeeded" ? "condition met" : status,
    };
  }

  if (status === "succeeded") {
    return {
      kind: "agent",
      instruction:
        "The condition was true when checked. Before acting, confirm the task still needs work and the matching result is unhandled. If the task is finished, stop. Do not act on a handled result again. Re-arm only for continuing work, after recording consumed item IDs or a source cursor and excluding handled results.",
    };
  }
  if (status === "timedOut") {
    return {
      kind: "agent",
      instruction:
        "The watch timed out. Inspect the receipt and decide what to do next.",
    };
  }
  return {
    kind: "agent",
    instruction:
      "The watch failed. Inspect the receipt and decide what to do next.",
  };
};
