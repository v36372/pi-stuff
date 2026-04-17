---
name: qmd
description: Retrieves high-recall, high-precision results from the alpha-research vault with QMD. Use when asked to "search the vault", "look something up in alpha-research", "find the right note/page", "retrieve knowledge-base context", or "use qmd". Chooses qmd search, qmd query, qmd vsearch, qmd get, and qmd multi-get based on the question.
---

Retrieve from `alpha-research/` with QMD before browsing directories by hand.

This skill is self-contained.

## Step 1: Confirm retrieval health

1. Run `qmd status`.
2. Confirm the `alpha-research` collection exists.
3. If embeddings are pending, say vector results may miss the newest pages and lean harder on exact lexical search.
4. Do not run `qmd update` or `qmd embed` unless the user asked to repair the index.

## Step 2: Choose the first-pass command

| Question shape | Command | Why |
|---|---|---|
| exact term, acronym, title, author, or slug | `qmd search "term" -c alpha-research -n 8` | highest-precision first pass |
| natural-language question with unknown vocabulary | `qmd query "question" -c alpha-research -n 8 --no-rerank` | best default semantic route |
| ambiguous or hard question | `qmd query $'intent: ...\nlex: ...\nvec: ...\nhyde: ...' -c alpha-research -n 8 --no-rerank` | highest recall without manual browsing |
| nearby pages or route-page discovery | `qmd vsearch "topic" -c alpha-research -n 8 --no-rerank` | explores the local topic cluster |
| inspect one candidate | `qmd get qmd://alpha-research/...` | read the page |
| inspect 2-3 small candidates together | `qmd multi-get "qmd://...1,qmd://...2" -l 80 --md` | compare candidates quickly |

## Step 3: Build a structured query when recall matters

Use a structured query document when the user's wording is broad, ambiguous, or likely to use different vocabulary than the vault.

| Line | Put this there | Keep it short |
|---|---|---|
| `intent:` | the job the user is trying to do | 1 clause |
| `lex:` | exact phrases, acronyms, author names, slugs | 2-8 strong terms |
| `vec:` | the actual question in plain English | 1 sentence |
| `hyde:` | a 1-2 sentence hypothetical answer | only when the first pass is fuzzy |

Rules:
- Put the best clue first. QMD weights earlier search lines more heavily.
- Quote exact multi-word phrases in `lex:`.
- Use `hyde:` only for conceptual or route-finding questions, not exact-title lookups.
- Keep `--no-rerank` as the default fast path. Use reranking only after you already have a reasonable candidate set and need a final ordering.

Example:

```bash
qmd query $'intent: route for validating an alpha before trusting a backtest
lex: "validating a new alpha" walk-forward overfitting transaction costs
vec: how should I validate a new alpha before trusting backtest results
hyde: I need the route page that connects alpha validation, overfitting checks, walk-forward analysis, and transaction-cost realism before live deployment.' -c alpha-research -n 8 --no-rerank
```

## Step 4: Read with precision

1. For broad questions, inspect the top 2-3 hits. Do not trust one hit blindly.
2. Prefer `category: guide` pages for route questions such as "how do I approach X?" or "where should I start?".
3. Prefer topical pages for exact concepts, formulas, acronyms, or named strategies.
4. Treat `alpha-research/index.md` as a routing hub only. Do not use it as the evidence page unless the user asked for top-level orientation.
5. If the first pass is close but noisy, run one follow-up exact search using terms copied from the best hit's `title`, `aliases`, or `related:` slugs.
6. If the first pass finds one strong page but you need siblings, run `qmd vsearch` on that page title or the core topic phrase.
7. Fetch the winning page with `qmd get` before summarizing.

## Step 5: Return compact retrieval results

Report:
- the 1-3 best `qmd://` paths,
- one short reason each is relevant,
- which page is the best entry point,
- one follow-up page only if it materially broadens or sharpens the answer.

Example:

```markdown
Best entry point:
- `qmd://alpha-research/signal-research/validating-a-new-alpha.md` — guide page for the full alpha-validation route.

Also relevant:
- `qmd://alpha-research/backtesting/walk-forward-analysis.md` — out-of-sample validation mechanics.
- `qmd://alpha-research/backtesting/dangers-of-backtesting.md` — failure modes and overfitting risk.
```

## Step 6: Stop conditions

Stop when:
- you have a clear best entry page plus at most 2 supporting pages,
- the retrieved pages answer the user's question directly, or
- QMD health is bad enough that you need to tell the user retrieval may be incomplete.
