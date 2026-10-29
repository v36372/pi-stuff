// Differential validation against unmodified Shelley Go functions, isolated from
// its server/UI dependencies. No copied implementation is used as the oracle.
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { buildCompaction, compactionView, recentStart } from "./core.ts";

const source = process.env.SHELLEY_SOURCE ?? "/tmp/shelley";
const commit = "2925edc4d57f033a298b783843e448371c252d6b";
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const assistant = content => ({ role: "assistant", content, timestamp: 0, api: "test", provider: "test", model: "test", stopReason: "stop", usage });
const makeItem = ({ id, kind, text = "", toolId }) => ({
  from: String(id), to: String(id), id: String(id), alone: kind === "user",
  message: kind === "call" ? assistant([{ type: "toolCall", id: toolId, name: "bash", arguments: {} }])
    : kind === "output" ? { role: "toolResult", toolCallId: toolId, toolName: "bash", content: [{ type: "text", text }], timestamp: 0, isError: false }
    : kind === "assistant" ? assistant([{ type: "text", text }]) : { role: "user", content: text, timestamp: 0 },
});

const goTypes = `package main
import ("encoding/json"; "fmt"; "os"; "slices"; "strconv"; "strings")
type MessageRole string
const (MessageRoleUser MessageRole = "user"; MessageRoleAssistant MessageRole = "assistant")
type ContentType int
const (ContentTypeText ContentType = iota; ContentTypeToolUse; ContentTypeToolResult; ContentTypeThinking; ContentTypeRedactedThinking)
type Content struct { Type ContentType; Text, Thinking, MediaType, ID, ToolUseID, ToolName string; ToolInput json.RawMessage; ToolResult []Content }
type Message struct { Role MessageRole; Content []Content }
type Source struct { Type string; UserData *string }
const MessageTypeUser = "user"
type contextItem struct { from, to int64; source *Source; noteID, note string; message Message }
type IndexID string
type CompactCollapse struct { From, To IndexID; Note string }
type CompactInPlaceInput struct { Trim []IndexID; Collapse []CompactCollapse }
type CompactionTrim struct { SequenceID int64; ToolUseID string }
type CompactionSquish struct { FromSequenceID, ToSequenceID int64; Summary string }
type InPlaceCompaction struct { Trims []CompactionTrim; Squishes []CompactionSquish; HiddenSequenceIDs []int64; HiddenToolUseIDs []string }
const CompactInPlaceName = "compact_in_place"
const maxCollapseTokens = 20000
const piImageTokens = 1200
// These fixtures contain ordinary user messages, not sender-tagged DB rows.
func provenanceTag([]byte) (string, string, error) { panic("unexpected provenance fixture") }
`;
const goMain = `
type InputItem struct { ID int64; Kind, Text, ToolID string }
type Case struct { Items []InputItem; Keep int; Queries []CompactInPlaceInput }
func main() {
 var cases []Case
 if err := json.NewDecoder(os.Stdin).Decode(&cases); err != nil { panic(err) }
 var answers []any
 for _, tc := range cases {
  var items []contextItem
  for _, in := range tc.Items {
   m := Message{Role: MessageRoleUser, Content: []Content{{Type: ContentTypeText, Text: in.Text}}}
   typ := "user"
   switch in.Kind {
   case "assistant": m.Role = MessageRoleAssistant; typ = "agent"
   case "call": m.Role = MessageRoleAssistant; typ = "agent"; m.Content = []Content{{Type: ContentTypeToolUse, ID: in.ToolID, ToolName: "bash", ToolInput: json.RawMessage("{}")}}
   case "output": m.Content = []Content{{Type: ContentTypeToolResult, ToolUseID: in.ToolID, ToolResult: []Content{{Type: ContentTypeText, Text: in.Text}}}}
   }
   items = append(items, contextItem{from: in.ID, to: in.ID, source: &Source{Type: typ}, message: m})
  }
  view, err := compactionView(items); if err != nil { panic(err) }
  var results []any
  for _, q := range tc.Queries {
   c, err := buildCompaction(items, tc.Keep, q)
   if err != nil { results = append(results, map[string]any{"error": err.Error()}); continue }
   trims, squishes := []any{}, []any{}
   for _, t := range c.Trims { trims = append(trims, map[string]any{"entryId": fmt.Sprint(t.SequenceID), "toolUseId": t.ToolUseID}) }
   for _, s := range c.Squishes { squishes = append(squishes, map[string]any{"from": fmt.Sprint(s.FromSequenceID), "to": fmt.Sprint(s.ToSequenceID), "summary": s.Summary}) }
   results = append(results, map[string]any{"trims": trims, "squishes": squishes, "hiddenEntryIds": []string{}, "hiddenToolUseIds": []string{}})
  }
  answers = append(answers, map[string]any{"cut": recentStart(view, tc.Keep), "results": results})
 }
 if err := json.NewEncoder(os.Stdout).Encode(answers); err != nil { panic(err) }
}
`;

test("differential parity: cut points and complete validator results match Shelley Go", async () => {
  assert.equal(execFileSync("git", ["-C", source, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(), commit, "Use the pinned Shelley snapshot");
  const compact = await readFile(join(source, "server/compact_in_place.go"), "utf8");
  const inplace = await readFile(join(source, "server/inplace_compaction.go"), "utf8");
  const estimate = await readFile(join(source, "server/context_estimate.go"), "utf8");
  const extract = (s, name) => {
    const start = s.indexOf(`func ${name}(`);
    assert.ok(start >= 0, `Missing upstream function ${name}`);
    const end = s.indexOf("\n}", start);
    assert.ok(end >= 0);
    return s.slice(start, end + 2);
  };
  const compactNames = ["compactionEvidence", "buildCompaction", "collapsesAlone", "splitRows", "rowID", "indexOfRow", "aloneRows", "orphanOutput", "orphanCall", "suggestRanges", "rowTrims", "isTrimmedOutput", "compactionView", "recentStart", "itemID", "itemTokens"];
  const sourceFunctions = [
    ...compactNames.map(n => extract(compact, n)),
    ...["hideItems", "indexOfItem", "hasContent"].map(n => extract(inplace, n)),
    ...["estimatePiMessageTokens", "isToolResultMessage", "findPiCutPoint"].map(n => extract(estimate, n)),
    extract(inplace, "trimmedToolOutputText"),
    inplace.match(/const trimmedToolOutputPrefix = [^\n]+/)[0],
    compact.match(/const compactRetryGuidance = `[^`]+`/)[0],
  ].join("\n\n").replaceAll("generated.Message", "Source").replace(/\b(?:llm|db|claudetool)\./g, "");
  const dir = await mkdtemp(join(tmpdir(), "shelley-go-parity-"));
  try {
    await writeFile(join(dir, "main.go"), goTypes + sourceFunctions + goMain);
    const items = [
      { id: 1, kind: "user", text: "do the task, preserve this important constraint" },
      { id: 2, kind: "call", toolId: "a" }, { id: 3, kind: "output", toolId: "a", text: "x".repeat(100_000) },
      { id: 4, kind: "assistant", text: "αβγ🙂".repeat(100) },
      { id: 5, kind: "assistant", text: "completed the old task" },
      { id: 6, kind: "user", text: "new user requirement" },
      { id: 7, kind: "user", text: "and another correction" },
      { id: 8, kind: "call", toolId: "b" }, { id: 9, kind: "output", toolId: "b", text: "log".repeat(300) },
      { id: 10, kind: "assistant", text: "x".repeat(120_000) },
    ];
    const queries = [{}, { trim: ["missing"], collapse: [{ from: "99", to: "1", note: "n" }, { from: "2", to: "4", note: "n" }] }];
    for (let i = 1; i <= 11; i++) {
      queries.push({ trim: [String(i)] }, { trim: [String(i), String(i)] });
      for (let j = 1; j <= 11; j++) queries.push({ collapse: [{ from: String(i), to: String(j), note: "n" }] });
    }
    queries.push({ collapse: [{ from: "4", to: "5", note: "n" }, { from: "5", to: "5", note: "n" }] }, { collapse: [{ from: "4", to: "4", note: " " }] }, { collapse: [{ from: "5", to: "5", note: "this summary is far longer than the material it would replace" }] });
    const cases = [1, 20_000, 100_000].map(keep => ({ items, keep, queries }));
    const orphanItems = [{ id: 1, kind: "output", toolId: "missing", text: "orphan" }, { id: 2, kind: "assistant", text: "some work done" }, { id: 3, kind: "call", toolId: "lost" }, { id: 4, kind: "user", text: "x".repeat(100_000) }];
    cases.push({ items: orphanItems, keep: 20_000, queries });
    const run = spawnSync("go", ["run", "main.go"], { cwd: dir, input: JSON.stringify(cases), encoding: "utf8", maxBuffer: 4 * 1024 * 1024, timeout: 60_000, env: { ...process.env, GOTOOLCHAIN: "local", GO111MODULE: "off" } });
    assert.equal(run.status, 0, run.stderr || String(run.error));
    const expected = JSON.parse(run.stdout);
    for (const [i, tc] of cases.entries()) {
      const history = tc.items.map(makeItem);
      assert.equal(recentStart(compactionView(history), tc.keep), expected[i].cut);
      for (const [j, input] of tc.queries.entries()) {
        let actual;
        try { actual = buildCompaction(history, { action: "compact", ...input }, tc.keep); }
        catch (error) { actual = { error: error.message }; }
        assert.deepEqual(actual, expected[i].results[j], `case ${i}, query ${JSON.stringify(input)}`);
      }
    }
    console.log(`Compared ${cases.reduce((n, c) => n + c.queries.length, 0)} validator results and ${cases.length} cut points against pinned Go source.`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
