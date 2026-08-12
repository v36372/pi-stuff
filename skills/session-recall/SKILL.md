---
name: session-recall
description: Searches and analyzes past Pi coding sessions on demand. Use when the user asks what happened in a previous conversation, what was decided or changed earlier, how an old problem was solved, or to find a prior session. Also use for phrases such as "remember when", "last time", "previous session", and "what did we decide".
license: MIT; see LICENSE
compatibility: Requires Python 3.10+ and ripgrep (rg). Reads ~/.pi/agent/sessions.
---

# Session Recall

Use Pi's existing `bash` tool and this skill's script. Do not add or request custom tools. The current agent performs the analysis; no second model call is needed.

This is a skill adaptation of [`@ogulcancelik/pi-session-recall`](https://github.com/ogulcancelik/pi-extensions/tree/main/packages/pi-session-recall). Unlike the extension, it adds no `session_search` or `session_query` tools and no model-selection command.

## Workflow

1. Extract one distinctive literal token or exact phrase from the user's question: a filename, function, package, error fragment, issue ID, unusual term, or remembered wording.
2. Search past sessions:

```bash
python3 ~/.pi/agent/skills/session-recall/scripts/session_recall.py search 'Cannot find module'
```

3. If there is no useful match, retry with up to three separate terms. Search is case-insensitive fixed-string matching, not regex or semantic search. Never combine unrelated keywords into one phrase.
4. Pick the most likely session using its date, project, match count, and snippets.
5. Prepare that session's active branch for a focused question:

```bash
python3 ~/.pi/agent/skills/session-recall/scripts/session_recall.py query \
  '/full/path/from/search.jsonl' \
  'What solution was chosen, why, and which files changed?'
```

6. Answer from the emitted conversation. If evidence spans multiple likely sessions, query each separately and reconcile them.

## Evidence rules

- Cite the session date and full session path in the answer.
- Separate explicit decisions/outcomes from your inference.
- If the selected session does not contain the answer, say so and search again.
- Do not expose assistant thinking. The script omits thinking and tool results.
- Search excludes the current session by default so the user's present question does not become a false match.

## Large sessions

`query` keeps the beginning, end, and question-relevant sections within 40,000 characters. Omitted spans are marked. For insufficient context, rerun with a narrower question before increasing the limit. As a last resort:

```bash
python3 ~/.pi/agent/skills/session-recall/scripts/session_recall.py query \
  '/full/path/session.jsonl' 'narrow question' --max-chars 80000
```
