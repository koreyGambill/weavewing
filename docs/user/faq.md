# FAQ

## Is Weavewing a harness?

No. A harness turns an LLM into an agent: it gives the model tools, runs the tools the model calls, and hands the results back. Claude Code is an interface (the TUI, the Code tab in the desktop app) plus a harness underneath (the Anthropic Agent SDK). Codex has the same split: the app plus the Codex App Server. Weavewing drives those harnesses. It is not a harness, and it does not work without one.

Bring your own: Claude Code, Codex, Cursor, Grok Build, OpenCode, Google Antigravity, Kiro, Pi, Muse Code, or fx. [Provider setup](./install.md#providers)

## Why use Weavewing instead of Claude Code or the Codex app?

- It drives the subscriptions you already have: Claude, Codex, and the other agents installed on your machine.
- Run `t3 up` on any machine and drive it from another computer or your phone.
- Every agent works in the same interface, so you can change models in the middle of a thread.
- It is open source under the MIT license.

[Install](./install.md)

## Can I use Weavewing with my Claude Code subscription?

Yes.

## How much does Weavewing cost?

Nothing. Weavewing is free and open source (MIT). You bring your own subscription and keep paying your provider as you do now. [Install](./install.md)

## Why is my Claude 5-hour limit draining so fast?

Weavewing drives Claude through Anthropic's Agent SDK. Anthropic's 5h meter used to charge Agent SDK usage about 1.7x more than using Claude Code directly; weekly limits were never affected. Upstream T3 Code fixed this for its own release v0.1.7, and Weavewing inherits that fix. Anthropic sets the meter, so Weavewing cannot promise a rate. If your limit still drains faster than you expect, make sure the machine that runs your agents is [up to date](./updating.md) and compare with the usage Claude Code reports.

## How do I use Weavewing remotely?

Your agents run wherever Weavewing runs: your desktop, a server, a VPS. You connect to it from other devices. Run `t3 up` on that machine, then pair over your local network or Tailscale. Weavewing builds omit T3 Connect configuration, so use a direct connection. [Remote access](./remote-access.md)

## What about T3 Connect machine limits and disconnects?

T3 Connect is upstream T3 Code's hosted service and applies only to a build configured for it. Upstream's limits and paid T3 Chat plans are described in [More machines with T3 Chat](./remote-access.md#more-machines-with-t3-chat), and dropped connections in [T3 Connect troubleshooting](./t3-connect-troubleshooting.md).

## How do I use Weavewing on my phone?

The mobile apps in the stores are upstream T3 Code's: get the [iOS](https://apps.apple.com/us/app/t3-code-remote-claude-more/id6787819824) or [Android](https://play.google.com/store/apps/details?id=com.t3tools.t3code) app, then connect it to your computer with a pairing link. The phone is a remote. Your computer does the work and needs to stay on. [Mobile setup](./install.md#mobile-app) · [Remote access](./remote-access.md)

## Can I add a bunch of accounts for one provider?

Weavewing does not switch between accounts automatically, because rotating accounts can break a provider's terms of service.

A separate work account is fine. Setup for two: [Codex](./providers-codex.md#use-multiple-accounts) · [Claude](./providers-claude.md#separate-accounts-or-configurations). For a bigger pool, manage them outside Weavewing with a self-hosted proxy such as [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI), and check each provider's terms first. After you set up a hub, Weavewing can show its pooled limits under Usage. [Connect a hub](./usage.md#connect-a-cliproxyapi-hub)

## Can I use an API key or OpenRouter instead of a subscription?

Yes. Add another provider instance in Settings and give it its own keys and endpoint. Claude has a full OpenRouter recipe. Your subscription setup stays untouched. On a Claude or Codex API key, Thread Details and the context ring show the thread's estimated cost at list price; set a price under [Model prices](./usage.md#set-custom-model-prices) when a model has none. [OpenRouter](./providers-claude.md#openrouter) · [Provider instances](./install.md#providers)

## Does Weavewing support local models?

Not directly. Weavewing drives agent CLIs, so a local model works only through an agent that supports one.

## Does my code go to Weavewing servers?

No. Your code and prompts go from your machine to your provider (Anthropic, OpenAI, and similar). Weavewing sends no product usage events. [Product usage data](./telemetry.md)

## Worktrees are eating my disk. How do I clean them up?

Open **Settings → Worktrees → Cleanup** and turn on automatic worktree cleanup. You can also run it now from there. [Storage cleanup](./project-settings.md#storage-cleanup)

## Is there voice input?

Yes. On iPhone and Android, dictation uses on-device speech by default; you can opt in to a paired environment instead. Web and desktop require you to choose an environment first. The transcript goes into your draft for review. See [Voice input](./voice-input.md).

## Does it work on Windows, Mac, and Linux?

Yes, all three. Weavewing releases cover Linux x64, Windows x64, and macOS arm64, with a desktop app and a CLI for each. Windows users can also run agents inside WSL. [Install](./install.md)

## Why is my provider not showing up?

Almost always, the CLI is not installed or not on the `PATH` of the machine that runs the server (the computer, not your phone). Log in on that machine first, like `codex login` or `claude auth login`. Still missing? Point **Binary path** at it in provider settings; version managers often cause this. [Provider setup](./install.md#providers)
