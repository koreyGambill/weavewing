# Thread workspace

Open **Workspace** in a started conversation or search for **Open workspace** in
the command palette. It keeps questions, action items, design explanations, and
catch-up notes beside the conversation. Groups can nest, and an item's short
reference stays the same when it moves.

Ask the agent to **workspace this for later** when you want something saved.
The agent can organize and update the board without stopping its other work.
Ordinary chat does not populate the board automatically. The Workspace badge counts
unanswered questions and unfinished action items. Section tabs show their item counts.

## Questions and action items

Questions can offer one choice, several choices, or a written answer. A recommended
choice shows the agent's advice. It is never selected on your behalf.

Your answers and action notes save as you work and stay private from the agent
until you send them. **Add to chat** places one response or all ready responses in
the composer, with readable answers and references back to the workspace items.
Review or edit the draft, then send it. Completed action items are ready to add
even without notes. If saving fails, your draft remains available to retry. A
conflicting edit from another device needs resolving before you add responses.

Action items hold outstanding needs and future work. Mark one done or reopen it
without starting an agent run. Add it to chat when you want the agent to act on
its status or your notes.

## Agent questions

Turn on **Agent questions** in **Settings → Labs** to let agents ask for the
decisions they need without stopping their work. Each question appears in the
chat where the agent asked it, with its options and a note field. Choosing an
option or typing a note saves a draft; choosing the chosen option again clears
it. Nothing reaches the agent by itself: **Answer** puts the answer in your
message box, and it goes out with your next message, together with anything you
type. **Cancel** on the card, or removing the chip, takes it back out and keeps
your choice on the card as a draft.

**Discuss** puts your note in the message box as a comment on the question
instead of an answer, for when you want to ask the agent something first. The
question stays open and keeps counting as waiting on you. A question has an
answer or a comment in the message box, not both. Once the agent's turn picks
up your comment, the note clears from the card and the question reads
**Discussing**; an option you chose stays as a draft. The agent replies in chat
and, when the decision is still open, asks it again as a newer question that
reflects the discussion.

Paste or drop an image into a question's note to show the agent what you mean.
The note gets a marker such as `[Q1 image 1]` and the card shows the image. The
image waits on the card and joins your message only together with the answer or
comment: **Cancel**, removing the chip, dismissing or deferring the question
takes it back out, and the card keeps it. Deleting the marker from the note, the
image's remove button on the card, or removing the image from the message box
drops the image and its marker. Images follow the message box's limits on type,
size and count; an answer whose images would not fit is not added.

Each question shows where its answer is: drafted, in the composer, sent (your
message is waiting for the agent's next turn), or received once that turn
starts; or, for a comment, in the composer or discussing. A sent answer stops counting as waiting on you. Editing or cancelling
the queued message returns it with its draft. A closed question shrinks to one
line; click it to see the whole card again, with your choice and note, read-only.
A replaced question links to its replacement with **Replaced by Qn**, and the
newer question links back with **Replaces Qn**.

Clicking the line above the composer lists the waiting questions; picking one
scrolls the chat to it, and **Answer all drafted** queues every draft.
**Open panel** shows every question beside the chat in one scrolling column,
where J and K move, 1 to 9 choose an option, and N defers. Its filters show
waiting, deferred, answered, or dismissed questions, and this device remembers
your choice. **Refresh questions** adds a request to your message box asking the
agent to withdraw questions that no longer matter and replace outdated ones;
it is sent only when you send your message.

A thread with questions waiting shows a count in the thread list, and an idle
one reads **Needs Decision**. It stays out of automatic settling until you answer
or close them; you can still settle it yourself.

- **Not yet** defers a question. It leaves the count and no longer holds the
  thread open. The agent reopens it when its work comes to need that decision.
- **Dismiss** closes a question without starting a run, and leaves a line in the
  chat with **Undo**. The agent learns that you dismissed, deferred, or reopened
  questions with your next message.
- When the agent records an answer it read from one of your messages, the card
  says so, so you can reopen it if the agent misread you.

Turning the setting off hides all of this, including questions already asked.
Agents already running follow a change after they restart.

## Agent work

**Agent work** keeps the work an agent takes on, what changed, and how to try it.
Choose **All threads and machines** to review work across connected environments,
including archived and settled conversations. Each entry links back to its thread.
Disconnected machines show that their work could not be loaded.

QA of landed work lives in **Evidence** in the sidebar strip (see
[Thread sidebar](thread-sidebar.md)). Pending QA does not stop routine work or
authorized landing.

Verification entries distinguish a run by another thread from the implementing
thread's own report. Source review stays labeled as source review, with the tested
revision, evidence, and remaining gaps when supplied.

## Design and summary

Design holds the agent's explanations, context, diagrams, and documents. Ask for
changes in chat. Summary covers the whole conversation so you can catch up on
what happened, what changed, and the current state. Future work belongs in Action
items.

## Child preamble

The **Record** tab has a **Child preamble**: standing instructions added to the
task of every delegate this thread starts, such as which checkout to use or which
checks to run. The child sees it marked as coming from this Workspace, and the
delegate's own task wins where they differ. Native subagents and new threads do
not receive it, and no conversation history is copied. You can also ask the agent
to set it.

## Marks and related threads

Marks collects links from chat, keeping each URL's first appearance. Search,
filter, sort, and choose columns before copying. **Copy all** produces plain-text
rows using your visible columns and current results. The agent can add a link
description when useful.

Threads shows related conversations and why they matter. The clock in the chat
header opens **Recent Threads**. Back and Forward follow your navigation path.

## Context marks

Ask your agent to save a finished turn as a named context mark in Workspace,
then start workers from that mark. Each mark keeps its original conversation
point when the source thread continues. Workers can share that point and still
use separate checkouts. Reviews start with fresh conversation context unless
you ask them to inherit a point.

The worker's Lineage shows its context source and whether it received a native
fork or portable conversation context. A busy source or a different provider
uses portable context, which can omit older history to fit the context budget.
Files stay at the worker's checkout state. The worker receives a summary of
file changes since the marked point when its snapshot is available.

## Personal notes

Personal notes are yours. Choose a notes directory for each environment to save
thread notes as Markdown files. Preview the current Markdown draft without sharing it.
Notes remain private until you select text and
add it to the composer, then send it. You can include the T3 thread ID in the file. The note includes a
terminal resume command when the provider has a resumable session.

Paste or drop PNG, JPEG, GIF, or WebP images (up to 10 MB each) into a note. T3 saves
them in a folder beside the note file and links them relatively, so the note still shows
them in other Markdown viewers. Images stay on disk when you delete their link.

Workspace is available in web and desktop builds with workspace support. An
older connected environment needs a build with support before it can serve the
panel.

## Inspect: loads and token usage

Choose **Inspect** in the sidebar's strip for Loads, Context and Tokens.

Loads shows file reads, skill loads, and related tool activity observed in the
conversation. Use Refresh to update these views while an agent is working. Reported events and events inferred from command text are labeled
separately. A command mentioning a file does not prove every byte reached the
model, and an unavailable tool result has no invented token count.

Tokens shows the usage the provider reported for each turn, including cache
accounting when available. Instruction sizes are a separate estimate from the
actual application payload prepared for a turn. They break down T3 instructions
by section, application context, and custom prompt additions. Estimates use
UTF-8 bytes divided by four. They are not billed token counts, and they should
not be added to the provider's totals.

Hidden provider harness instructions remain unknown. Earlier turns without an
instruction snapshot stay unavailable rather than inheriting today's prompt.

## Agent context

**Settings › Agent context** shows everything that shapes what a new session
receives for one provider and project: instruction files with their `@` imports,
skills grouped by where they come from, and the compiled order under **View
compiled**. **Edit in Settings** in the Inspect panel opens the same view for a
thread.

Each row names the real file behind any link, its Git repository and whether it
has uncommitted changes, and its estimated size. Skills show what their listing
costs on every turn and flag the same skill offered from more than one place,
such as a user copy and a plugin copy.

**Edit** saves to the real file, so links keep pointing at it. If the file
changed since you opened it, the save stops and asks you to reload. Text between
`<!-- overwing standards` markers is generated and read-only here. Plugin and
`npx skills` copies, and project skills that link outside the project, open
read-only with **View**.

**Uncommitted edits** lists each repository with changes, its branch, and any
untracked files that look like secrets, such as `.env`. **Ask an agent to
commit** starts a new thread in that repository with the selected provider and
its default model. The agent commits every change, moves, deletes or ignores
files that should not be committed, and tells you which ones and why. It does
not push. A repository that is not yet a project is added as one.

**Load watchers** decide which tool calls Inspect's Loads view labels as
knowledge loads. A shell command watcher matches its words in order, such as
`overwing search`. A tool watcher matches the tool name, where `*` matches any
run of characters, such as `mcp__vault__*`.
