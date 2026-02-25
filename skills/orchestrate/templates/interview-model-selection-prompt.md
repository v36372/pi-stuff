# Interview model-selection prompt snippet

Use this when asking which subagent models are allowed.

## Build numbered options

```bash
./scripts/list-logged-in-models.sh --ids | nl -w2 -s') '
```

## Prompt template

```text
Please choose the allowed model pool for subagents.
I can only use models from providers you are currently logged into.

Available models:
{{NUMBERED_LOGGED_IN_MODELS}}

Reply with one of:
1) A comma-separated list of model IDs (exact IDs from above)
2) "all" to allow every listed model

Optional: include preference by difficulty, e.g.
- low: <model-id>
- medium: <model-id>
- high: <model-id>
```

## Parsing rules

- If user says `all`, set allowed models to all IDs from `list-logged-in-models.sh --ids`.
- Otherwise, normalize comma-separated IDs and reject IDs not present in the logged-in list.
- If any invalid ID appears, ask user to re-select from the displayed list.
