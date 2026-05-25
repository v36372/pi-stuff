---
description: Start a Solo-native planning and automatic execution workflow
argument-hint: "<what to build>"
---
Read `~/.pi/agent/skills/plan/SKILL.md` and follow it for this Solo-native planning workflow.

Important workflow behavior:
- The planner is interactive only through the Phase 5 approach checkpoint.
- After Phase 5, the planner finishes validation, premortem, plan writing, and todo creation without more user prompts.
- When the planner returns to the parent with plan/todos, the parent starts workers automatically without asking for execute confirmation.

Planning request:
$ARGUMENTS
