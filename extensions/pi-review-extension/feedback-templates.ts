export interface PlanDenyFeedbackOptions {
  planFilePath?: string;
}

export const planDenyFeedback = (feedback: string, options?: PlanDenyFeedbackOptions): string => {
  const planFileRule = options?.planFilePath
    ? `- Your plan is saved at: ${options.planFilePath}\n  Edit this file to make targeted changes, then submit it again the same way.\n`
    : '';

  return `YOUR PLAN WAS NOT APPROVED.\n\nYou MUST revise the plan to address ALL of the feedback below before submitting it again.\n\nRules:\n${planFileRule}- Do not resubmit the same plan unchanged.\n- Do NOT change the plan title (first # heading) unless the user explicitly asks you to.\n\n${feedback || 'Plan changes requested.'}`;
};
