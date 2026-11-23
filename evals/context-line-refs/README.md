# Context line refs

Projects review comments from the file and diff tiles through the real provider formatter ([`projectComposerContextForProvider`](../../packages/shared/src/composerContextReferences.ts)) and checks that the agent acts on the line the user commented on. It reproduces a file comment on line 20 that an agent read as line 19 when the payload showed `range: L20 (19-19)`.

## Run

```sh
cd evals
pnpm context-line-refs --dry-run
pnpm context-line-refs --out runs/line-refs --model claude-sonnet-5-5
```

- It uses your local Claude login through `claude -p`, with no tools, settings or MCP servers.
- Flags: `--model <id>` (default `claude-haiku-5-5`), `--case <id>` (repeatable), `--samples <n>` (default 3), `--baseline <earlier run>` (adds that run's pass counts for the selected cases), `--from <earlier run>` (re-grades its saved outputs without calling a model), `--dry-run` (print each projected message). Both saved runs must be `cite` runs; the runner refuses anything else.
- The agent replies with the targeted file and lines as JSON. A wrong file or wrong lines fail. Before the fix, Sonnet cited line 19 for an L20 comment in 4 of 5 samples.
- Cost: one call per case per sample. Five samples of every case cost about $0.005 on Haiku and $0.08 on Sonnet.

## Add a case

Add an entry to `cases.ts` with the record fields the client stores (`startIndex`, `endIndex`, `rangeLabel`, the excerpt) and the file lines the agent should name.
