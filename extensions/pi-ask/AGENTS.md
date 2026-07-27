# Agent notes

- This is a pi extension; `index.ts` is only the entrypoint.
- `ask` is the single human-in-the-loop surface for input, review, and handoff.
- Feature code lives under `ask/`: constants, contracts, normalize, state, pi-ui, tui, tool.
- Keep LLM-facing tool text short and user-facing.
- Preserve the blank `Other/rephrase` contract: it means the agent should rephrase or follow up.
- Keep response state in named objects, not parallel arrays.
- When changing TUI behavior, check pi extension/TUI docs and examples first.
