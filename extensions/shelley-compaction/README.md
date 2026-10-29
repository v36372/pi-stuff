# Shelley compaction — extension-only Pi port

Place this directory under `~/.pi/agent/extensions/`, then run `/reload`. The `pi.extensions` manifest makes Pi discover it automatically; no settings change or `-e` flag is needed.

Automatic context nudges are enabled at 200k tokens. `/scompact` is optional: it asks the agent to compact now. Preservation instructions can follow it, for example `/scompact preserve the deployment commands`.

No settings or Pi core files are modified. Tested against installed Pi **1.4.0**. Keep the extension enabled when resuming its sessions; without it, Pi ignores its custom compaction records and sees the original history again.

## Behavior preserved from Shelley

Ported from `boldsoftware/shelley` commit `2925edc4d57f033a298b783843e448371c252d6b` (Apache-2.0; see NOTICE).

- **Same tool and decisions:** `compact_in_place` exposes `index` and `compact`, with `trim` IDs and `collapse: [{from, to, note}]`. The running agent chooses obsolete material; no second summarizer is introduced for compaction.
- **Same local operations:** trim replaces a tool output with an original-message pointer. Collapse replaces an inclusive range with a **user-role note at that position**, even when the original message was an assistant message. Unselected content remains intact.
- **Same validation:** approximately 20k recent tokens protected; calls/results kept together; user messages and previous notes collapse only individually; at most 20k source tokens per collapse except a single row; nonempty notes shorter than source; invalid IDs, duplicates, reversed/overlapping ranges rejected together. Retry guidance preserves valid note text verbatim.
- **Same replay order:** trims, then chronological collapses, then hidden housekeeping. Prior index calls, failed attempts, compaction receipts and nudges disappear from context; the current successful call remains as its receipt. Housekeeping never moves the protected recent boundary. Originals remain in the session.
- **Same default policy:** nudge at 200k, then every 50k, including the index; falling below a level re-arms it. Do not nudge immediately after compaction using stale pre-compaction usage. Optional idle housekeeping skips contexts under 50k and never re-arms itself after its own turn.

## Pi adapter

Each successful operation appends **one `shelley.compaction` custom entry**. No batch of native `context_edit` records is written. `context_with_system` replays records into the request's message list. Notes use `s<record-entry-id>.<index>` IDs and preserve their original span endpoints for subsequent operations. The index and validator use that same projected view.

`read_compacted({from, to?, offset?})` retrieves original active-branch entries in bounded pages. This replaces Shelley's SQLite/previous-conversations skill. IDs are Pi session/entry IDs, not numeric DB sequence IDs. Pi stores one result per tool call, so the adapter groups a parallel call's result entries into one index row.

Pi still manages the prompt and tool loadout. The adapter checkpoints their current state at the head of each request; it does not reproduce Shelley's AGENTS.md/skills re-rendering machinery. Native branch navigation remains available; when asked for a branch summary, the adapter passes projected messages to Pi's existing budgeted branch-summary helper instead of summarizing discarded originals.

A failed replay aborts the request and removes the conversation from its input, rather than allowing Pi's swallowed hook exception to expose unprojected history. Failed record writes block subsequent requests in that runtime. Original raw entries and accounting metadata are not rewritten.

## Options

```bash
pi --shelley-nudge-tokens 200000 \
  --shelley-idle-minutes 10
```

| Option | Default | Meaning |
|---|---:|---|
| `--shelley-nudge-tokens` | 200000 | First nudge; subsequent steps remain 50000 |
| `--shelley-idle-minutes` | 0 | One-shot idle housekeeping; 0 disables it |

Options are chosen when starting Pi, not changed live through a settings UI. Idle work is cancelled on user activity, model changes, navigation, shutdown, or compaction. It checks that the session is still idle, the leaf is unchanged, and no messages are queued. It does not have access to Shelley's server-side delegated-work/live-call registry. SDK hosts must dispatch `session_shutdown` before disposal, as Pi's CLI/runtime does.

The 200k default is deliberately **not** scaled to a model's window. For smaller models, choose a lower value explicitly; self-compaction needs spare space for the index and notes.

## Extension-only boundaries

This ports the compaction algorithm and operation model, not Shelley's entire server:

1. **Native prefix compaction is cancelled while loaded**, including overflow recovery. `/compact` directs you to `/scompact`. There is no silent fallback to Pi's different algorithm. An overflow can still require manual intervention or a larger model.
2. **Pi's canonical accounting still sees its raw projection.** The `Shelley ~Nk` status is an estimate of this extension's conversation view (excluding the system prompt). Pi's normal context meter and automatic threshold attempts may disagree until provider usage catches up. Native summaries already in a session can be collapsed as singleton notes.
3. **One record is not SQLite durability.** Pi appends JSONL, without a database transaction/fsync guarantee. The record prevents partially applied multi-edit batches; underlying storage durability remains Pi's. A write failure requires reloading from disk before continuing. Power-loss behavior is not verified.
4. **This extension owns conversation projection.** Do not combine it with another extension that rewrites conversation context, performs its own compaction, or edits past targets behind these records. It uses Pi's active branch and existing projected context edits, not unrelated branches. Pi does not standardize Shelley-style parent/subagent provenance; user-role messages are singleton-protected.
5. **Not a claim of identical model outcomes or provider cost.** Parallel result envelopes, message IDs, and prompt handling differ between hosts. Tests use actual Pi runtime code with synthetic model responses, not live model APIs. This has not been benchmarked for retention quality, provider acceptance, or cache cost.

## Verification

No dependency installation is needed. Node must support TypeScript type stripping; the checks were run on Node 26.4.0.

```bash
cd ~/.pi/agent/extensions/shelley-compaction
npm test
```

The integration suite finds globally installed Pi with `npm root -g`. Set `PI_PACKAGE_ROOT` to a different installed package root when needed. It uses isolated settings/auth paths and disposable session files, blocks network fetches, and loads `extension.ts` through Pi's real extension loader. Tests cover automatic directory discovery/reload, same-run application, user-role notes, tool pairing, original retrieval, replay/resume/branching, repeated compaction, native-summary interoperability, nudges, idle scheduling, invalid config, failed persistence and corrupt records.

The source-level differential check needs Go and the pinned Shelley checkout:

```bash
SHELLEY_SOURCE=/tmp/shelley npm run test:parity
```

It extracts the original Go validation/cut-point functions into a dependency-free temporary harness and compares **592 complete validator results and four cut points** with the TypeScript port. It does not run Shelley's full server/UI test suite or constitute exhaustive proof. The normal core tests additionally cover replay, cleanup, note singleton protection, images, UTF-8 estimates and nudge hysteresis.
