# Template skills

Expands one leading skill reference inside an invoked prompt template. Run `/reload` after adding this extension.

With `prompts/catchup.md` containing:

```text
/bro catch me up on everything since my last message, and if there are any action items for me give me enough context (exec summary) to make a call
```

`/catchup` becomes `/skill:bro ...`, which Pi expands into the loaded skill's instructions, file location, relative-reference directory, and the catch-up request.

The explicit spelling is also supported and avoids name collisions:

```text
/skill:bro catch me up ...
```

## Boundaries

- Only skills in `pi.getCommands()` are eligible, including skills with `disable-model-invocation: true`. No independent filesystem discovery or trust bypass.
- Only the template's leading command is resolved. Skill bodies are not recursively scanned; template-to-template chains and extension commands are not executed.
- Shorthand `/name` is ignored when that name belongs to an extension command or prompt template. Use `/skill:name` to disambiguate.
- Direct skill commands and templates without a resolvable leading skill reference retain Pi's normal behavior.
- Template frontmatter and argument placeholders use Pi-compatible parsing. Template files are reread per invocation; the command list comes from the current Pi runtime.
- Image attachments, RPC input, steering, and follow-up input are preserved. No extra messages or agent runs are created.
- Requires Pi's normal skill/template expansion to be enabled for the submitted input.

## Tests

`bun test extensions/template-skills/index.test.ts` with `@earendil-works/pi-coding-agent` resolvable locally. Pi supplies this package automatically when loading the extension; a standalone test runner needs a local link to the installed package.

Tests compare argument substitution with the installed Pi implementation and verify that Pi's real skill-expansion pipeline loads exactly one skill.
