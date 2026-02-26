# Interview (short, high-impact)

Ask 4–7 questions, then proceed with best-guess defaults if the user is unsure.

Prioritize:
- Success outcomes + exclusions
- UX/acceptance constraints
- Performance/security constraints
- Rollout/migration expectations
- **Maximum allowed parallel subagents (`maxConcurrency`)**
- **Allowed model pool for subagents + model preference by task difficulty**
- **AI code reviewers (`aiReviewers`) as CSV; default `copilot,codex,gemini`**

## Interaction rules

1. Ask all questions in one concise batch message.
2. If interactive TUI is available, **always** collect answers via `/answer` (answer.ts). If answer.ts isn’t loaded, **stop** and ask the user to load it before continuing.
3. If interactive TUI is not available, fall back to standard Q&A in chat.

## Model selection prompt

Before asking the model-selection question, run:

```bash
"$ORCHESTRATE_SCRIPTS_DIR/list-logged-in-models.sh" --ids | nl -w2 -s') '
```

Show **only** those numbered model IDs as selectable options. Use:
- `templates/interview-model-selection-prompt.md`

If no logged-in models are found, stop and ask the user to run `/login`, then continue.

If `maxConcurrency` or allowed models are missing, do not plan execution yet.
If `aiReviewers` is missing, default to `copilot,codex,gemini` and continue.
