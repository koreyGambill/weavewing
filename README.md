<p align="center">
  <img src="./assets/weavewing/icon.png" width="80" height="80" alt="Weavewing logo" />
</p>

<h1 align="center">Weavewing</h1>

<p align="center">The open-source control plane for coding agents.</p>

<p align="center">
  <a href="https://github.com/koreyGambill/weavewing/releases"><strong>Download</strong></a> ·
  <a href="./docs/README.md">Docs</a>
</p>

Weavewing runs the coding agents on your machine and gives them one fast interface. Start a thread at your desk, then approve the next step from your phone.

It works with Claude Code, Codex, Cursor, OpenCode, Grok Build, Antigravity, Kiro, Pi, Muse Code, fx, and any [ACP](./docs/user/providers-acp.md) agent. If an agent is set up on your computer, Weavewing can control it.

Weavewing is a fork of [T3 Code](https://github.com/pingdotgg/t3code) by T3 Tools Inc.

## What you get

- **Your subscriptions.** Weavewing does not resell tokens. It drives the agents you are already signed in to.
- **Every agent in one place.** Change models in the middle of a thread. Let Claude hand a task to Codex.
- **Desktop, web, and phone.** One server, and every client shows the same threads.
- **Remote ready.** Run agents on any machine. Connect over your local network or Tailscale.
- **Git built in.** Each thread can work in its own worktree. Review the diff, then commit, push, and open a pull request with one button.
- **Open.** MIT licensed.

## Install

### Desktop app

Download Weavewing from [Weavewing Releases](https://github.com/koreyGambill/weavewing/releases).
Choose Linux x64 (AppImage or deb), Windows x64 (NSIS), or macOS arm64 (DMG).
Matching CLI archives and `SHA256SUMS` are included in each release.

The builds are unsigned. On Windows, choose **More info → Run anyway**.
On macOS 15, try opening the app once. After it is blocked, use
**System Settings → Privacy & Security → Open Anyway**, or run
`xattr -dr com.apple.quarantine /Applications/Weavewing.app` after copying the app.
Unsigned mac builds don't auto-update. A managed Mac may block the override.

Weavewing and upstream T3 Code share the default `~/.t3` home. Use separate homes when
running both. See [Weavewing installation](./docs/user/install.md#weavewing-fork)
and [managed policy](./docs/user/managed-policy.md) before setting up a managed machine.

Package managers such as Homebrew, winget, Scoop, the AUR, and Nix install upstream T3 Code, not Weavewing.

### Command line

Download the `t3-<version>-<platform>` archive for your platform from
[Weavewing Releases](https://github.com/koreyGambill/weavewing/releases).
Verify it against `SHA256SUMS`, unpack it, and keep the folder together.
Add that folder to `PATH`, then run `t3 --version` to check it.
On macOS, if the downloaded `t3` is blocked, run `xattr -dr com.apple.quarantine <folder>` once.
Run `t3` to start the server and open the web app.

### Phone

The mobile apps in the stores are upstream T3 Code's: get them from the [App Store](https://apps.apple.com/us/app/t3-code-remote-claude-more/id6787819824) or [Google Play](https://play.google.com/store/apps/details?id=com.t3tools.t3code). Then follow [remote access](./docs/user/remote-access.md) to connect the app to your computer.

### Sign in to an agent

Weavewing needs one agent that is installed and signed in. For example, install [Claude Code](https://claude.com/product/claude-code) and run `claude auth login`, or install [Codex CLI](https://developers.openai.com/codex/cli) and run `codex login`.

[Provider setup](./docs/user/install.md#providers) has the steps for each agent. [Install Weavewing](./docs/user/install.md) covers nightly builds, AppImage, WSL, and NixOS.

## Documentation

- [Install and first run](./docs/user/install.md)
- [Remote access from a phone or another machine](./docs/user/remote-access.md)
- [Permission modes](./docs/user/permission-modes.md)
- [Source control](./docs/user/source-control.md)
- [Connect outside agents over MCP](./docs/user/outside-agents.md)
- [FAQ](./docs/user/faq.md)

[All docs](./docs/README.md) has the full list.

## Contributing

- Read [CONTRIBUTING.md](./CONTRIBUTING.md) before you report a bug or open a pull request.
- Build from source with the [development runbook](./docs/operations/development.md#first-checkout). The [architecture overview](./docs/internals/overview.md) explains how it works.

## License

[MIT](./LICENSE)
