# Context line refs

Projects review comments from the file and diff tiles through the real provider formatter ([`projectComposerContextForProvider`](../../packages/shared/src/composerContextReferences.ts)) and checks that the agent acts on the line the user commented on. It reproduces a file comment on line 20 that an agent read as line 19 when the payload showed `range: L20 (19-19)`.

## Run

```sh
cd evals
pnpm context-line-refs --dry-run
pnpm context-line-refs --out runs/line-refs --task cite --model claude-sonnet-5-5
```

- It uses your local Claude login through `claude -p`, with no tools, settings or MCP servers.
- Flags: `--task sed|cite` (default `sed`), `--model <id>` (default `claude-haiku-5-5`), `--case <id>` (repeatable), `--samples <n>` (default 3), `--baseline <earlier run>` (adds that run's pass counts beside these), `--from <earlier run>` (re-grades its saved outputs without calling a model), `--dry-run` (print each projected message).
- `sed` asks for the one `sed -i` command that applies the comment. `cite` asks for the targeted file and lines as JSON. Both tasks fail a reply that names the wrong file. `cite` is the stricter check: before the fix, Sonnet cited line 19 in 4 of 5 samples.
- Cost: one call per case per sample. Five samples of every case cost about $0.005 on Haiku and $0.08 on Sonnet.

## Add a case

Add an entry to `cases.ts` with the record fields the client stores (`startIndex`, `endIndex`, `rangeLabel`, the excerpt) and the file lines the agent should name.
