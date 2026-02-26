# Interview model-selection prompt snippet

Use this when asking which subagent models are allowed.

## Build numbered options

```bash
"$ORCHESTRATE_SCRIPTS_DIR/list-logged-in-models.sh" --ids | nl -w2 -s') '
```

## Prompt template

```text
Please choose the allowed model pool for subagents.
I can only use models from providers you are currently logged into.

Available models:
{{NUMBERED_LOGGED_IN_MODELS}}

Reply with one of:
1) A comma-separated list of model IDs (exact `provider/model` IDs from above)
2) "all" to allow every listed model

Optional: include preference by difficulty, e.g.
- low: <provider/model>
- medium: <provider/model>
- high: <provider/model>
```

## Reviewer selection prompt (ask after model selection)

```text
Which AI code reviewers should I request on each PR?
Default is: copilot,codex,gemini
Supported values: copilot, codex, gemini

Reply with either:
1) Enter to accept default
2) A comma-separated list (e.g. "copilot,codex")
```

## Parsing rules

- If user says `all`, set allowed models to all IDs from `"$ORCHESTRATE_SCRIPTS_DIR/list-logged-in-models.sh" --ids`.
- Otherwise, normalize comma-separated IDs and reject IDs not present in the logged-in list.
- If any invalid ID appears, ask user to re-select from the displayed list.
- For `aiReviewers`, if blank/missing, default to `copilot,codex,gemini`.
