# Subagent Follow-up Prompt Template

[ORCHESTRATOR FOLLOW-UP]
Task: {{TASK_ID}}
PR: {{PR_URL}}
Goal: Unblock the current PR branch. Keep scope unchanged and continue on the same branch.

Blocking summary:
{{ISSUE_SUMMARY}}

CI failing checks (with links):
{{CI_FAILURE_DETAILS}}

Critical AI review feedback:
{{AI_REVIEW_DETAILS}}

Human review feedback:
{{HUMAN_REVIEW_DETAILS}}

Required execution order:
1. Fix CI failures first.
2. Address AI and human review feedback.
3. Re-run relevant local validation for touched areas.
4. Push commits to the same branch and update the same PR.

Reply in this exact format after pushing:
- Root cause(s):
- Changes made (files/modules):
- Validation run (commands + outcomes):
- Remaining blockers (if any):
