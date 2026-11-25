# Claude

T3 Code uses Claude Code's login and configuration. Start with the default provider
for one account; [provider setup](./install.md#providers) covers installation and
shared provider settings.

## Separate accounts or configurations

Use a separate Claude config directory for each account. This also works for named
presets that need different Claude settings or a router connection.

Keep your existing account in the default directory. On the environment's machine,
create the second login:

```bash
mkdir -p ~/.claude_personal
CLAUDE_CONFIG_DIR=~/.claude_personal claude auth login
```

Add another Claude instance in **Settings > Providers**:

| Instance        | Binary path | CLAUDE_CONFIG_DIR path |
| --------------- | ----------- | ---------------------- |
| Claude Work     | `claude`    | Leave empty            |
| Claude Personal | `claude`    | `~/.claude_personal`   |

On mobile, tap **Add Claude account** in **Settings > Providers** and enter a name and the
config folder. The login itself still happens on the environment's machine.

An empty config-directory setting uses Claude Code's normal configuration. The
custom setting changes `CLAUDE_CONFIG_DIR`, leaving `HOME` and the system keychain
location intact. Use the same variable for the login command. Setting `HOME`
instead can put credentials where this provider will not find them.

Check the account reported in provider settings after signing in. Existing
threads can switch only between Claude instances with the same config directory.
Separate account directories stay isolated, including their local conversation
state. Claude does not have Codex's shared-home and shadow-home arrangement.

For presets that differ only in API keys or endpoints, use the instance's
**Environment variables**. Variable assignments do not belong in **Launch arguments**.

File paths in the `--settings` and `--append-system-prompt-file` launch arguments
can start with `~` for the home directory of the machine running T3 Code. Any
other relative path is read from the thread's project folder, or its worktree.

Claude Code's verbose mode can stay enabled when you use Claude for text generation, including
thread titles, branch names, commit messages, and pull request descriptions. On a remote connection,
T3 Code uses the Claude configuration on the connected server.

## Compact long conversations

Set **Auto-compact after** in the Claude provider settings to an integer between
`100000` and `1000000`. For example, `300000` asks Claude to summarize at about
300,000 tokens. This changes when compaction happens, not the model's context
window. Leave it empty for Claude Code's default.

You can also send `/compact` in an existing conversation. Claude Code also
compacts automatically. To see context usage, see
[commands and skills](./composer.md#commands-and-skills).

T3 Code sends `/compact` only when you request it. Returning to an idle thread or
sending a message keeps the conversation history. Claude Code still compacts at
its configured context threshold.

## Leave out built-in tools

**Built-in tools to leave out** removes Claude Code tools from the model's context to save
tokens. By default it leaves out all seven it lists, including the artifact tools, so Claude
cannot publish claude.ai artifact pages from threads. **Keep artifact tools** leaves out only
Task (native subagents), Workflow, ScheduleWakeup and ReportFindings; **Clear** keeps every tool;
**Recommended** returns to the default. A change applies when a thread's Claude process next starts, which includes an existing thread
resuming after a restart or an idle period.

## claude.ai connectors

**claude.ai connectors** in the Claude provider settings decides whether threads load the
connectors on your Claude account. **Leave to Claude Code**, the default, changes nothing.
**Off** keeps them out of every thread and saves an estimated 3,200 tokens of context; a single
thread can still switch them on with its **Tools** control. A change applies when a thread's
Claude process next starts.

## Tools for one thread

The **Tools** control under the composer counts what a Claude thread leaves out, for example
"Tools 8 off", or reads "Tools all on". Open it to switch a left-out tool on for this thread
only. Each row shows an estimate of the context the item adds. Switches take effect when you
choose **Reload session**.

The popover also lists the MCP servers the thread's session can load, read when you open it, and
marks the ones the current session has not loaded. Switching a server off keeps its tools out of
the model's context; the server may still connect. T3 Code's own server always stays in.

The claude.ai connectors form a group. When the provider setting is **Off**, the group's switch
brings them all into this thread, and switching on one connector brings in that connector alone.
When it is **Leave to Claude Code**, the group reads "Left to Claude Code" and the thread can turn
them on; otherwise Claude Code decides, and a connector the session loaded can be left out. Only
the connectors as a whole have a token estimate, so the popover shows no total when some of them
may be left out.

**Reload session** saves the tools, and the thread's Claude session restarts before the next
message, keeping the conversation. The change applies from that message, which can carry more
uncached input. The thread's timeline notes what changed. Choosing **Reload session** with
nothing changed restarts the session anyway, which picks up changed Claude settings, skills or
MCP servers.

A reload is refused while a turn is running or the session has background agents or commands;
stop them or wait, then reload. Queued messages stay queued and run on the reloaded session. A
fork keeps its source thread's tools; new threads, delegated tasks and a switch to another
provider start from the provider's defaults.

Per-thread tools are a Claude feature. Threads on Codex, Antigravity, OpenCode, Pi, Kiro, fx,
Muse Code, Cursor or an ACP provider do not show the control.

## Usage limits

If your Claude subscription runs out of usage mid-turn, the thread shows which
limit was reached and the remaining wait when Claude provides a reset time.
Claude Code holds the turn until that window reopens, so it can keep showing as
working. Wait for the reset, or stop the turn and continue later. The warning's
timestamp shows when the displayed wait started.

## Skills

Claude skills come from the config directory's `skills` folder and the project's
`.claude/skills` folder. If both define the same name, the config-directory copy
wins. Skills disabled in Claude's settings do not appear in the composer.

Use `$` in the composer to select a skill. Enabled installed Claude plugins,
and plugins synced from your claude.ai account, also contribute skills under
names such as `plugin:review`. Skills marked `disable-model-invocation` can
still be started by you. Invoke those one per message: Claude directly runs only
the last named skill and may try to start earlier ones through its Skill tool,
which refuses skills reserved for manual invocation.

## Task lists

To show Claude task lists in the web and desktop apps, add
`CLAUDE_CODE_ENABLE_TODO_TOOLS=1` under **Variables** in the Claude instance's
**Environment** section in **Settings > Providers**. Each update shows as a Tasks
row in the thread; open it to see every step.

## Claude in Chrome

Claude threads can use the Claude in Chrome extension, which works in your own
Chrome with its sign-ins. T3 Code sessions load it only when asked: add `--chrome`
to **Launch arguments** in the Claude instance's settings in **Settings > Providers**.
It applies to sessions that start after you save. Set up the extension as you would
for Claude Code first; see Claude Code's [Chrome guide](https://code.claude.com/docs/en/chrome).

The instance must be signed in with `/login` on a direct Anthropic plan. Instances
that use an API key or a `claude setup-token` token don't get it, even with
`--chrome`, and neither do third-party providers such as Amazon Bedrock. Claude Code
doesn't support it in WSL.

## OpenRouter

Create a Claude instance with its own config directory, such as
`~/.claude_openrouter`, and keep **Binary path** set to `claude`. In that instance's
**Environment variables**, use:

| Variable               | Value                                     |
| ---------------------- | ----------------------------------------- |
| `ANTHROPIC_BASE_URL`   | `https://openrouter.ai/api`               |
| `ANTHROPIC_AUTH_TOKEN` | Your OpenRouter API key, marked Sensitive |
| `ANTHROPIC_API_KEY`    | An explicitly empty value                 |

If that Claude config directory has a cached Anthropic login, run `/logout` in a
Claude Code session using that directory before starting the router setup. Cached
login credentials can conflict with the router token.

Select the model you want in T3 Code. For an OpenRouter model outside the built-in
list, open that Claude instance in **Settings > Providers** and add its full model
ID with **Add custom model**. Then select it in the chat model picker.
`ANTHROPIC_DEFAULT_*_MODEL` variables map Claude Code aliases such as `sonnet`; they
do not replace the explicit model ID selected in T3 Code. Custom models may have
fewer effort, thinking, or context controls than built-in models.

Verify the model used in OpenRouter's activity dashboard. For current compatibility
requirements, use the
[OpenRouter Claude Code guide](https://openrouter.ai/docs/cookbook/coding-agents/claude-code-integration).

## Other routers

A local router uses an ordinary Claude provider instance. Give it a separate
config directory and put the router's endpoint and credential variables in that
instance's **Environment variables**. The router must run where the environment
can reach it. Follow the [Claude Code Router instructions](https://github.com/musistudio/claude-code-router)
for its installation and routing configuration.
