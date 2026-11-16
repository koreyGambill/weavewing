# Message summaries

Runs the incoming-card summary prompt ([`buildMessageSummaryPrompt`](../../packages/provider-core/src/server/textGenerationPrompts.ts)) through the server's Claude text generator on messages shaped like the reports, asks and advisories that land in a lead thread. It checks that each summary is one plain line of at most 100 characters that names the message's subject, and that a message cannot steer it.

## Run

```sh
cd evals
pnpm message-summaries --dry-run
pnpm message-summaries --out runs/summaries
```

- It uses your local Claude login, like the server does. Default model: `claude-haiku-5-5`, as the server uses.
- Flags: `--case <id>` (repeatable), `--samples <n>` (default 2), `--model <id>`, `--dry-run` (print each prompt without a model call).
- `summary.md` lists each case's pass count and the summaries themselves, so a person can judge tone too.
- Cost: one Haiku call per case per sample (10 by default), well under a cent.

## Add a case

Add an entry to `cases.ts` with the card `source`, the `message`, words the summary should `mention` (any one), and words it must `never` be.
