# Context in portable handoffs

T3 Code transfers conversation context when you switch providers, continue through a portable
restart, or use a fork that the provider cannot resume itself.

## Forks, side chats, and drill-ins

A fork or side chat starts from a particular reply or finished turn. When the
provider supports a native fork from that point, the new chat inherits the
provider's history through it. The new question and any side chat instructions
are appended. The provider decides which input tokens it can reuse from its
cache. A native fork can preserve history and still have a cold first request.
Use **Get newest context** when you want a side chat to also see activity
that happened after its fork point.

Keep **Automatic** in the **Conversation history** section of **Thread details** to use a portable
handoff when native forking is unavailable. A side chat opened before the parent
finishes its first turn uses the available saved history. Choose **Require native
history** to stop the fork if its provider cannot preserve native history. Use the
source provider and a supported finished turn, or choose **Automatic** and create
the fork again. The fork’s details show which kind of history it received.

## Hand off a summary

Choose **Hand off summary** in the source thread’s **Conversation history** section.
Review the prepared text, choose a destination on the same environment, and add
it to the draft. The handoff is appended to any existing draft text. Send it from
the destination when you’re ready.

On supported Claude Code profiles, Weavewing prepares the summary in a temporary
native fork of the latest completed turn using that turn’s model and reasoning
settings. Summary preparation runs with tools disabled.

For Codex or a Claude Code profile where tools can’t be disabled, choose **Use
saved conversation** to prepare a summary from a bounded portion of saved
messages. When summary generation is unavailable, edit the excerpt or write the
handoff yourself.

## What a portable handoff carries

Short conversations transfer intact. For longer conversations, T3 Code favors recent requests and
answers, the original request, and relevant activity such as command outcomes. Selected messages
keep their full text, order, and user or assistant role, including partial work from failed or
interrupted turns. Your new request stays separate and is never shortened to make history fit.

Codex receives historical messages directly when its installed version supports that operation.
Other providers receive the same selection as attributed conversation context. A handoff does not
copy the outgoing provider's reasoning, tool-call state, or attachments.

The handoff includes references to omitted history. The agent can use T3 Code's thread-reading tool
to retrieve saved messages and activity, including the remainder of a long item. For an important
constraint, you can still repeat it in your next message. A handoff is a budgeted selection, not an
agent-written summary.

## Context limits

A handoff must leave room for existing provider context, your request and attachments, instructions,
tools, and subsequent work. If the target conversation has no room for the handoff, T3 Code starts
a fresh provider conversation with a bounded selection of saved history and sends your request
automatically. You do not need to compact manually. If the request and attachments leave too little
room even in a fresh conversation, shorten the request or select a larger-context model. T3 Code
never shortens your request to make it fit.

Recovery leaves running background work intact. Let it finish or stop it before retrying the handoff.

Server operators can set `T3CODE_CONTEXT_HANDOFF_TOKEN_CAP` to change the initial history allowance
(default 16,000; clamped to 1,024–64,000). This is an upper bound, not a provider context-window
guarantee. Text accounting conservatively charges one token per UTF-8 byte, including attribution
and JSON escaping. Imported history has a separate 64,000-byte ceiling; your current input and
attachment payloads do not consume that ceiling.

T3 Code uses available capacity information for your selected model and options, together with
provider context telemetry. Starting a fresh provider conversation clears prior usage, while keeping
known model capacity. Changing models or context-window options discards stale usage and compaction
thresholds.

When no capacity information is available, T3 Code assumes a 128,000-token window. It reserves at
least 16,000 tokens, or a quarter of the window when larger, for instructions, tools, and subsequent
work. Images reserve an estimated 8,192 tokens each, independent of their file size; other
attachments reserve 4,096 each for their references. Existing context is estimated from saved
activity when usage telemetry is unavailable. Known smaller windows still constrain the handoff.
These are fallback estimates, not exact token counts. Image resolution, custom models, and hidden
native context can differ, so the provider may still reject an input.
