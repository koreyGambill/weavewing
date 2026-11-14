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
- A `repeat` case passes when the review files nothing. A `new` case passes when a finding cites a message from the ended turn.
- Cost: a full run is six Haiku calls, a few cents.

## Add a case

Add an entry to `cases.ts`. Mark messages an earlier review saw with `priorContext`. The filed finding every case shares is in `run.ts`.
