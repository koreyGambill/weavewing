# Monitoring review

Runs the turn-end standards review prompt ([`MonitoringRunner.ts`](../../apps/server/src/monitoring/MonitoringRunner.ts)) through the server's Claude text generator on a lead thread that already has a filed finding. It checks that the reviewer files a new incident but does not file an old one again under another rule or because the lead mentions it.

## Run

```sh
cd evals
pnpm monitoring-review --dry-run
pnpm monitoring-review --out runs/review --model haiku
```

- It uses your local Claude login, like the server does. Default model: `haiku`, as review automations use.
- Flags: `--case <id>` (repeatable), `--samples <n>` (default 2), `--dry-run` (print each case's prompt without a model call).
- Grading runs the model's findings through the runner's dedupe first, so it scores what would be filed; the summary also shows the raw model result. A `repeat` case passes when nothing survives. A `new` case passes when a surviving finding cites a message from the ended turn.
- Cost: a full run is one Haiku call per case per sample (8 by default), a few cents.

## Add a case

Add an entry to `cases.ts`. Mark messages an earlier review saw with `priorContext`. The filed finding every case shares is in `cases.ts`.
