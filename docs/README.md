# Weavewing docs

## Using Weavewing

- [Install Weavewing](./user/install.md)
- [Messages and context](./user/composer.md)
- [Working with threads](./user/thread-sidebar.md)
- [Reviews and decisions](./user/reviews.md)
- [Permission modes](./user/permission-modes.md)
- [Terminal history](./user/terminal.md)
- [Source control](./user/source-control.md)
- [Project settings](./user/project-settings.md)
- [Appearance and themes](./user/appearance.md)
- [Keyboard shortcuts](./user/keybindings.md)
- [Voice input](./user/voice-input.md)
- [Text generation models](./user/text-generation.md)
- [SnapShots](./user/snap-shot.md)
- [Visual replies](./user/html-renders.md)
- [Import browser sessions](./user/browser-import.md)
- [Use Weavewing as your default browser](./user/default-browser.md)
- [Devices](./user/devices.md)
- [External tool status](./user/status-sources.md)
- [Usage and limits](./user/usage.md)
- [Secrets](./user/secrets.md)
- [Product usage data](./user/telemetry.md)
- [Remote access](./user/remote-access.md)
- [Guest links](./user/guest-links.md)
- [T3 Connect troubleshooting](./user/t3-connect-troubleshooting.md) (upstream's hosted service)
- [Outside agents (MCP)](./user/outside-agents.md)
- [Running in the background](./user/background-service.md)
- [Updating Weavewing](./user/updating.md)
- [Triage an issue](./user/triage.md)
- Provider guides: [Codex](./user/providers-codex.md) · [Claude](./user/providers-claude.md) · [OpenCode](./user/providers-opencode.md) · [Antigravity](./user/providers-antigravity.md) · [Kiro](./user/providers-kiro.md) · [Pi](./user/providers-pi.md) · [Muse Code](./user/providers-muse.md) · [fx](./user/providers-fx.md)

---

## Working on Weavewing

Start with the [development runbook](./operations/development.md) and
[contribution policy](../CONTRIBUTING.md).

Internal notes preserve architectural decisions, constraints, and implementation traps that the
source alone does not explain. Most code changes do not need an internal documentation update. Follow the
[documentation rules](#documentation-rules) before adding one.

- [Architecture overview](./internals/overview.md)
- [Glossary](./internals/glossary.md)
- [Connection runtime](./internals/connection-runtime.md)
- [Providers](./internals/providers.md)
- [Adding a provider](./internals/adding-a-provider.md)
- [Pull request file revisions](./internals/pull-request-file-revisions.md)
- [Model classification](./internals/model-manifest.md)
- [Remote environments](./internals/remote.md)
- [Fork wire compatibility](./internals/fork-wire-compatibility.md)
- [Server updates](./internals/server-updates.md)
- [Resource telemetry](./internals/resource-telemetry.md)
- [Product analytics](./internals/product-analytics.md)
- [Environment auth](./internals/environment-auth.md)
- [T3 Connect](./internals/t3-connect.md)
- [Assistant citations](./internals/assistant-citations.md)
- [Mobile layout](./internals/mobile-layout.md)
- [Mobile navigation](./internals/mobile-navigation.md)
- [Mobile development lifecycle](./internals/mobile-development.md)
- [Terminal runtime](./internals/terminal-runtime.md)
- [Devices](./internals/devices.md)
- [Voice input](./internals/voice-input.md)

### Documentation rules

Most code changes need no documentation change; agents can read the code.

- `docs/internals/` holds architectural decisions and their reasons, constraints that span components, and implementation traps the source does not reveal. Before adding a paragraph, ask what a maintainer would get wrong without it; if reading the code answers that, leave it out.
- Leave feature lists, field or method lists, control-flow narration, file catalogs, and PR summaries to the types, tests and code. The glossary defines shared vocabulary; it is not a feature index.
- A local reason the code can't show goes in a short nearby code comment. Use an internal doc when the reasoning crosses boundaries, and link to the source instead of copying it.
- When a documented decision or constraint changes, rewrite or remove the affected text rather than appending a second account. A new internal page needs a distinct, durable reason to exist.
- `docs/user/` helps users accomplish tasks: one concise section per major feature saying what it does, how to start, and anything unintuitive. A settings path helps; descriptions of buttons, icons, layouts, animations or every UI state do not. Keep the shipped product's voice, without implementation details or contributor tooling, and update the feature's section when its use changes.
- `docs/operations/` holds maintainer setup, release, and debugging procedures. Instructions for operating an installed server belong in the user guides.

### Runbooks

- [Development and local builds](./operations/development.md)
- [Scenarios: real-app proof for a fix](./operations/scenarios.md)
- [T3 Connect setup](./operations/connect-setup.md)
- [Release](./operations/release.md)
- [Observability](./operations/observability.md)
- [Relay observability](./operations/relay-observability.md)
- [Mobile app store screenshots](./operations/mobile-app-store-screenshots.md)
- [Release the Weavewing iOS app](./operations/weavewing-ios-release.md)
