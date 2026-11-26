# Working with threads

Use a new thread for a separate task. Choose **New worktree** when its code changes
need a separate branch and working directory.

On web and desktop, **Settings → General → Thread glyph alerts** controls the
one-second glyph flash when a thread replies or needs attention. It appears over
the whole application, including when you are viewing that thread, and respects
reduced motion. A dot on the thread's glyph marks an unread reply or a request
that still needs attention. System notifications and sounds have separate controls.

## Start a thread

On web and desktop, **New thread** or `mod+n` opens a new thread at your default place,
ready to type: the default project if you set one on this device, otherwise the default
folder on your preferred machine. **Shift-click** or `mod+shift+n` starts in
the current thread's project instead, or use a project's own new-thread action. A new thread carries
your model and mode selections, unless the destination project has its own model default.
Its branch and workspace mode come from your configured defaults. To continue in
an existing worktree, use **New thread in this worktree** from the branch toolbar.

On mobile, **New thread** starts in the current thread's project, or else in the
project the thread list is filtered to, or else in the last project you opened
or chose on that device. If none is available, the project picker opens. Turn
off **Settings → General → Use last project** to choose a project every time.
When you pick a project that is on more than one machine, the thread starts on
a connected one if any is connected.

The line under the composer shows where the thread runs: the machine, the project and
folder, and the branch. To change it before the first message, click the folder, press
`mod+shift+o`, or choose **Change project or folder…** in the command palette. After
the first message, the same click or key opens **Change folder**. Search
by project name or path. The same picker opens from **New thread in…** in the command
palette. Before you type, it lists projects you have run threads in on the current machine,
pinned first and then by recency; type to find any other project. Enter accepts the
highlighted first row.

Choose the machine with the machine button beside the folder under the composer. In the
picker, **All machines** searches every connected machine, and choosing a project on another
machine moves the draft to it. **Open folder** and **Clone repo** add a project on the
selected machine. Adding needs permission to add projects there, and cloning also needs
source-control write access. With All machines on, they consider every connected machine
that allows the action and ask which one when more than one does. When none does, the button is unavailable and its tooltip says why.
The **?** button lists the picker's keys, including `ctrl+alt+m` to cycle
machines and `ctrl+alt+shift+m` to toggle All machines. The gear button opens the default
folder setting. In the picker under the composer, it can also make the current place this
device's default for new threads.

Type a path such as `~/code/` to browse folders on the selected machine. In All
machines, each machine resolves `~` to its own home. Tab completes a highlighted
folder, Backspace after a path separator goes up, and Enter starts there. A folder
that is not yet a project is added automatically. Your unsent text stays with the
draft when you change its project.

### Start in the default folder

A thread does not need a project. **New thread** and `mod+n` start in the default folder
(`~/code` unless you change it). While the preferred machine is offline, the thread starts
on another connected machine and the line under the composer says why. **Use default place** under the
composer moves a draft back there. On mobile, pick **No project** from the
project list. Before sending, click the folder under the composer to pick a project, **Open
folder** for any folder on that machine, or **Clone repo**; the draft moves there
with what you typed. Pick another machine from the machine menu to move it there.

A new thread shows in the sidebar as soon as you open it. If you leave it without typing
or attaching anything, its row goes away; once you type, it stays as a draft.

Set the folder in **Settings → Threads → Default folder for new threads**. Each machine
has its own, and the path is on that machine.
If the folder does not exist, Weavewing uses the `scratch` folder in its data directory.
The start folder must sit outside a Git repository and cannot be your home, `~/.xwing`, or a parent of Weavewing's data folder. Threads share it without
creating a separate visible folder per thread. Sandboxed agents run from a private
thread folder and can read the shared folder. Full-access agents run there directly.
Older threads keep their existing folders. Deleting a thread keeps its files.

File search in the shared start folder lists only its immediate files and folders.
Choose a repository folder to search inside it. Ask the agent to create its own
Xwing environment for code changes and keep throwaway files in `/tmp`.
Sandboxed agents can edit linked worktrees but need approval to commit.

Choose **Change folder** from a thread's menu or details to work somewhere else.
Pick a recent folder, a project, or a linked Xwing environment, or enter a path.
The thread moves to the matching project when the folder belongs to one. Other
folders appear under **No project**, with the current folder name in the sidebar.
The thread keeps its history. Its next turn starts a new agent session in that
folder with the conversation carried over. Finish or stop any work before moving.

The thread's views (Todos, Evidence, Artifacts, Links, Related, Timeline, Details,
Environments, Inspect and Automations) open in the side panel on the right, along
with Inbox, Calendar and Status. Open it with the panel button at the right of the
titlebar, with `Cmd+Alt+Shift+B` on macOS or `Ctrl+Alt+Shift+B` on Windows and
Linux, or on a thread's details with the panel button at the right end of the row
under the composer. Choose a view from the menu at the top left of the panel. The
panel covers the right edge of the chat instead of narrowing it, and shows the
selected thread. It closes when you press Escape, click outside it or switch
threads. **Pin** keeps it open while you move between threads, and its views
follow the thread you select. **Lock to thread** keeps showing one thread while
you select others; the panel names the locked thread, and unlocking returns it to
following. Drag the panel's left edge to resize it; double-click the edge to
reset it. On narrow screens the panel opens over the conversation.

Calendar, Status and Pull requests also open as full pages beside the thread list.
The expand button next to **Pin** opens such a view as a page; for a thread view it
maximizes the panel instead. The command palette offers **Open Calendar as a page**
and **Open Status as a page**, and **Open pull requests** as before. On a page,
**Open in side panel** moves the view back into the panel and returns you to where you
were. A view that needs more room than the panel, such as Pull requests, shows
**Open full size** there instead.

The left sidebar also holds the same thread views, plus the Inbox. Pick a tool from the strip beside the thread list; pick it again, or
**Threads** at the top of the strip, to return to your threads. `Cmd+Alt+I` on macOS or `Ctrl+Alt+I`
on Windows and Linux switches between your threads and the last tool, and opens
a hidden sidebar on that tool. While the sidebar is hidden, its toggle shows when
something needs you, such as an unanswered question or a status alert. The tools
follow the focused tile; pin them to keep one thread while you move between
tiles. Hide tools you don't use from the bottom of the strip. Opening a hidden
tool from elsewhere, such as an artifact reminder, shows it again.

**Waiting on you**, at the top of the thread list, counts the threads where
something waits on you: a question, a change to check or a task. It also shows
how many notifications are unread, and hides when nothing waits and nothing is
unread. Click it, or press Enter on it, to list those threads, most recently
changed first, with each kind's count and, when more than one machine is
connected, the machine's name; choose one to open it. Threads where you
are only discussing something with the agent follow under **Waiting on the
agent** and are not counted. Unread alerts that belong to no thread, such as a
failing status source or an automation that keeps failing, come next, and
choosing one opens it in the Inbox. **Open Inbox** opens the whole Inbox in the
side panel. Arrow keys move through the list and Escape closes it. On narrow
windows the list opens as a sheet. **Show what is waiting on me** in the command
palette opens it too, and you can bind a shortcut to it under **Settings →
Keybindings**; when the thread list is not on screen, both open the Inbox
instead. Turning **Waiting-on-you cards** off in **Settings → Threads** hides
the row and its palette command; the Inbox keeps its own entry points.

The **Inbox**, the bell under Threads in the strip and a view in the side panel, collects notifications that
need urgent action or are important enough that you must not miss them, newest first.
Agents must choose urgent or important when raising one. Routine progress,
completions and review nitpicks stay in their threads. Landed work awaiting QA
stays in **Evidence**. Status failures raise urgent alerts, while warnings need
three consecutive observations. Scheduled tasks alert after two consecutive
failed runs. Each failure episode raises one alert, so dismissals stick across
server restarts. A status source leaving its warning or failure state moves that
alert to **Dismissed**. The inbox badge counts unread alerts and turns
red for critical or amber for a warning. Open one to read it; it then counts as
read. Snooze one to have it come back later, or dismiss it once it's handled. The
Snoozed and Dismissed tabs show those, where you can unsnooze or restore them.
**Open inbox** in the command palette, a notification's **Open inbox** button
and a desktop notification open it in the side panel, so the thread list stays in
view; on a phone they open the sidebar's Inbox. Critical notifications also send a desktop notification and play a sound, and
warnings do when Weavewing is in the background,
following your settings under **Settings → General → Notifications**.

Open **Status** in the side panel to check your status sources. Its alert dot
also appears on the panel button while the panel is closed. Configure sources
under **Settings → Status sources**, also linked from the Status tool.

Links, Artifacts and Related have a filter box, and each row can copy its link,
ticket ID or thread link. Links also filters by service, sorts, and copies every
shown link at once.

**Todos** holds the commitments you and agents track for a thread. New items are
yours; give one to the agent before adding it, or change who is responsible from
the item's menu. Items nest up to three levels: indent and outdent from the item's
menu, or press Tab and Shift+Tab while editing its text. Select an item's text to
edit it and its note. Filter the list to your items or the agent's, and show done
and dropped items when you need them. These choices stay on this device. The
Todos badge counts the agent's open items; your own open items count in the
thread's **Waiting on you** strip instead (see [Thread workspace](reviews.md#waiting-on-you)).

**Evidence** is the proof behind each land: what you asked for, the commits,
the checks that ran, the reviewer's verdict, captures and anything left unproven.
Agents record a landing with `evidence_record` after they merge work. A landing with
nothing you or a reviewer could check records an exemption with a one-line reason
instead; it covers its commits and shows in Evidence as **Exempt**. Agents never exempt
work you asked to see or verify, and an exemption cannot replace a landing that already
records changes.

When an agent's turn ends after a landing command moved the project's target branch,
and no landing or exemption covers the commits it added, Weavewing sends that agent one
message asking it to record evidence or an exemption. The landing commands are
`git merge`, `git push` to the project's remote and target branch, and `xwing env land`;
a merge made on the forge, such as with `gh pr merge`, is not seen. When it is unclear
which thread's command moved the branch, no thread is asked. Each commit is asked about once, in one thread. Work landed during
the turn that answers that message is not asked about again, so an answer can never
start another round. Turn this off with **Ask agents to record landed work** in
**Settings → Threads**.

A change with a waived review or one that asked for changes, or a failed or skipped
check, always shows a **QA card** in the thread where the agent recorded it. The
agent marks each other change: **needs you** when you should look at it, such as a
visual change with its screenshots, or check behavior the agent could not run, which
also shows a card, or a **note** when its gaps are routine, such as no run on a device.
A note's captures are not shown in chat; expand it in Evidence to see them.
An approval alone raises no card, because no review verdict is checked yet; a card
that is raised still shows it as an unverified review. A landing a delegated agent
recorded shows in its lead's thread, where the delegated work reported back. A
change with nothing to check leaves one quiet line instead, and a note's line ends
in "noted". Each card has three buttons:

- **Looks good** marks it confirmed.
- **Dismiss** closes it without checking. Open the closed card to add why, if you want to.
- **Discuss** puts a reference to the change in your composer, so you can say what's
  wrong or ask about it. The card reads **Discussing** after you send.

None of the three starts a turn. When you tell the agent in chat that a change works
or what's wrong with it, the agent records that on the card as **Recorded by the
agent**. A problem it records shows as **Agent fixing** until a later landing names the
fix. **Reopen** on any settled card makes it open again.

The Evidence tool lists the same landings. Pick **Thread** for this thread's landings
or **All** for every thread on this server, and filter to the ones that still need QA
or to **Notes**. Notes lists each noted change with the start of its gaps, newest landing
first, 50 at a time, and a lead's thread includes the notes its delegated agents recorded.
Expand a note or open its landing to read all of it, or choose **Needs me** to show a note
as a QA card. A later record of that landing keeps the card, and keeps any card you
discussed, reopened or answered as it was. The agent can turn a card back into a note only
while you have not touched it and no review or check outcome holds it.
Open a landing to see its changes and load their captures; click a capture to view it
full size. Each change's QA button sets it to Open, Confirmed or Dismissed, and you can
change it at any time. Changes waiting for your QA count in each thread's
**Waiting on you** strip, and QA cards show only while **Waiting-on-you cards** is on
in **Settings → Threads**.

To clear an old backlog at once, open the Evidence filter menu and choose **Dismiss
pending before…**. Pick a day and give a reason; the dialog shows how many changes in
every thread landed before that day and still wait for your QA before you confirm.
Changes you are discussing and problems the agent is fixing stay open. Only the
changes it counted are dismissed, and only those still waiting when you confirm; one
that starts waiting meanwhile stays for next time. Each dismissed card keeps your
reason and can be reopened.

Each change's review shows as **Unverified review** with the verdict the agent
reported, such as "agent reported approved". Weavewing does not yet check that
verdict against the reviewer. When the agent names the reviewer thread, a
**Reviewer** link beside the claim opens it; it must be a `review` delegate of the
same lead, so a reviewer in a linked environment gets no link.
Agents must give a one-line reason to waive review or skip a check, and opening the
landing shows each reason in full.

To come back to something later, bookmark it. Hover a message, yours or the
agent's, and open its bookmark menu, or select text in a message to mark just that
passage. **Bookmark** marks it to find again. **Bookmark as to-do** also makes it
a to-do you can tick off; a bookmark's menu can make it a to-do later or stop it
being one. A bookmarked message keeps a gold mark beside it, bookmarked text
stays tinted, and gold bars on the right edge of the thread show where each
bookmark sits. Click a bar to jump to its bookmark, or hover it to mark it done
or remove it. Bookmarks too close together share one bar with a count; click it
to choose one. **Next bookmark** and **Previous bookmark** in the command palette
step through them, and you can bind keys to them, and to **Chat: Bookmark
Selection**, in Settings > Keybindings. To remove a bookmark, use its mark beside
the message, hover its bar, or select its text again.

In Todos, the **Bookmarked** section at the top lists this thread's open bookmark
to-dos, not its plain bookmarks, and the Todos badge counts them until they're
done. Click one to jump to it, or tick it once you're finished. **All** at the top
of Todos lists bookmarks across every thread on that thread's environment. Its filter
shows every bookmark under **All**, open to-dos under **To-do** and finished ones under
**Done**. Bookmarks are yours only: agents never see them. This is unrelated to
**Follow-up behavior** in Settings, which decides what a message sent while an
agent is busy does.

**Timeline** shows when the thread and everything it delegated ran: one row per
thread, with its delegates and side chats indented beneath it, on a shared clock.
Use it to see where a long task spent its time and which work ran in parallel.
Hover a bar for its model, duration and how long it waited to start; click it to
open that thread. On a thread that ran for days, pick a shorter window from the
view's header. Delegates in a linked environment and plain forks are not shown.

The sidebar's **Environments** view shows Xwing environments used by the thread
and its delegated children. Open an environment to see its repositories and apps,
open a terminal, or review an archive or deletion. **Unlink** removes a link to a
folder the thread is not using. Select it again with **Change folder** to restore
the link. Changing folder keeps earlier links as history and releases their
cleanup protection.

### Start in the background

In a desktop browser or the desktop app, press `Cmd+Enter` on macOS or `Ctrl+Enter`
on Windows and Linux to start a new thread and immediately open another draft. The
next draft keeps the workspace mode and base branch you selected. With **New
worktree**, each background submission creates its own worktree.

To send the same prompt to several models on web or desktop, **Shift-click** models
in a new thread's model picker to add or remove them. A regular click returns to a
single model. Choose a base branch and send. Each selection starts a separate thread
and worktree while you stay in the new thread composer. This requires a Git project.

## Pin and reorder threads

Pin a thread from its menu to keep it above your active work.

On web and desktop, unpinning, settling, snoozing, and archiving a thread each show
a notification with **Undo** for five seconds. Undo restores the thread's previous
state, including its pinned position, and reopens an archived thread you were
viewing. Discarding an unsent draft from the sidebar works the same way: Undo brings
back its text and attachments. `mod+z` triggers the most recent Undo, even from the composer; see
[Keybindings](./keybindings.md#commands-with-special-behavior).

On web and desktop, you can also drag files from your computer onto any thread row:
the thread opens and the files are attached in its composer, ready for
your next message. The same per-message file limits apply as when attaching
files directly; see [Attach files](./composer.md#attach-files).

On web and desktop, pinning or unpinning a thread keeps the sidebar at your current
scroll position instead of following the thread to its new place in the list.

Pinning does not prevent automatic settlement. Settling a thread removes its pin.

On web and desktop, drag a thread between sections to change its state. Drag a thread up into
the pinned section to pin it at the spot you drop it; drag a pinned thread down into the active
list to unpin it. Dragging a thread onto the **Settled** header settles it, and dragging a settled
thread into the active list un-settles it. A snoozed thread can be dragged out of the snoozed
shelf, which wakes it, but threads cannot be dragged into the shelf because snoozing needs a wake
time. Dragging a pinned thread out of the pinned section does not ask for unpin confirmation.
Pinned and active boundary labels appear only while dragging, without moving the rows. The
other rows slide aside to show where the thread will land. When you cross into another section,
the dragged thread shows the action the drop performs, with its icon: **Pin**, **Unpin**,
**Settle**, **Un-settle**, or **Wake**. Its status and hover actions hide during the drag. A pinned
thread keeps its pin only while it stays in the pinned section; once it leaves, the badge takes
over. Reordering within the same section shows no badge. When there are no pins, drag to the top
edge to pin a thread. Section labels stay readable for the whole drag, and the section the
thread is over takes the accent color. Section labels also
identify empty sections and a collapsed settled shelf.

On web and desktop, drag within the pinned section to change its order. Active threads
use recent-message order. On mobile, open a thread's menu and choose **Arrange threads**. Drag a handle within or between
**Pinned** and **Active** to reorder, pin, or unpin. Drop onto the **Settled** divider to
settle a thread. The dragged card shows the action before you release it. Expand **Snoozed**
or **Settled** to drag a parked thread back into either live section. Each drop saves; close the sheet to return to the thread list.
**Move up** and **Move down** are also available in the thread menu. The server
saves the order, so it survives a refresh and appears on your other connected devices.

To move several threads at once, Ctrl-click (Cmd-click on Mac) or Shift-click to select them,
then drag one of them. In named groups, the selected active threads land together where you drop.

When the sidebar is grouped by project and **Fixed** is chosen under the View menu, project
folders stay where you put them instead of following recent activity. Drag a folder header to
move it, or select several headers with Ctrl-click (Cmd-click on Mac) or Shift-click and drag
them together. Folder order is saved on this device.

On web and desktop, the list also animates section changes made with thread actions such as
**Pin**, **Settle**, and **Snooze**. These transitions respect your system's reduced-motion
preference. While dragging, rows follow the insertion gap without replaying a second transition
after the drop.

New threads appear above the active threads you have arranged. Settling clears a thread's active
position, so using **Un-settle** returns it to the top. Pinning and snoozing preserve its active
position until you move it again. Thread activity does not change the order. The settled shelf
continues to use settlement time.

If dragging is unavailable for one environment, update the Weavewing server running in that
environment. Pinned and active reordering require server support. Threads from older servers keep
their default order until the server is updated.

To generate a fresh title from the conversation, open a thread's menu and choose
**Regenerate title**. The action is unavailable while title generation is in progress
or when the connected environment needs a server update.

To change how titles are written, add **Thread title instructions** in **Settings → Threads →
Text generation**, under Advanced, such as a length limit or an identifier to put first. They apply to new and
regenerated titles. Select a project to give it its own instructions.

Agents connected through Weavewing can use the same server-owned metadata workflow to
rename a thread, regenerate its title, or link and unlink a pull request. These changes
appear on web, desktop, and mobile without requiring the originating browser to remain
open.

### Recent threads and forks

On web and desktop, pinned threads stay first. Other active conversations sort by
when you last sent a message, with new conversations using their creation time.
Running threads keep their status icon in the list. Streaming and completion do
not move them into a separate section.

Use **Fork conversation** in the chat header to branch from the latest completed
response when the provider supports it. Forks appear below their visible source
conversation, including nested forks. A family's most recent message determines
its place in the active list. Pinning, snoozing, or settling a fork gives it its
own placement in that section.

### Group threads by project (beta)

Turn on **Settings → Labs → Boring sidebar (group by project)** on web and desktop to put active
threads in a folder for each project. Pinned projects come first. A project with no active
threads has no folder unless it is pinned or you pick it in the project filter. An archived
project's folder comes last and shows only while it has active threads. Click a folder to open or
close it. A closed folder shows how many threads it holds, and a dot when one of them
needs you. Use the pen button on a folder, or right-click it, to start a thread in that project.
Pinned threads stay above the folders, and Snoozed and Settled stay below them. In this mode you
can drag a thread onto the composer to mention it, but not within the sidebar, and the Working
section is off. Each device keeps its own choice.

## Settle finished work

Choose **Settle thread** from its menu to move finished work out of the active list
without deleting the conversation. **Un-settle thread** restores it to active work
and prevents automatic settlement until new activity resumes the usual rules.
Manually settling an idle thread dismisses unanswered async questions without
sending an answer or restarting the agent. Settling also closes the thread's
terminals that wait at an idle prompt, and keeps their output. A terminal that
runs a command, such as a dev server, stays open unless its action has **Stop this action
when the thread settles** enabled in Settings > Projects > Actions. You can also set
`"stopOnSettle": true` on a `t3.json` action and import it there. Start the command through
that action so T3 can stop its terminal and child processes. Commands started through an
agent's own shell tools are managed by the provider.

To reclaim disk space from settled work, turn on **Run in the thread's worktree when the
thread settles** for one of the project's actions, or set `"runOnSettle": true` on a
`t3.json` script, for example `cargo clean`. It runs each time a thread in its own
worktree settles, manually or automatically, even if a terminal there still runs a
command such as a dev server. Threads in the project's main checkout skip it. Its terminal
closes when the command succeeds and stays open when it fails.

On web and desktop, press a thread's **Settle** button and drag up or down to
settle every thread in that section between it and the one you release on.
The **Un-settle** and **Wake** buttons work the same way in their sections.
Press `Escape` while dragging to cancel.

By default, environments settle inactive threads after seven days and settle
threads whose pull request merged. A closed pull request can also settle an idle
thread. An empty thread's inactivity counts from when it was created.
Work in progress, pending questions or approvals, and background work the agent
is waiting on prevent automatic settlement. An open pull request does not prevent inactivity
settlement unless you turn on **Keep threads with a PR** in **Settings → Threads**,
but an old closed or merged pull request does not settle work you
resumed after it closed. Only your own messages count as resuming. A turn that
finished background work or a pull request watch starts on its own does not.

To keep one thread out of the settled shelf no matter how long it sits idle, open its menu,
choose **Auto-settle behavior**, and pick **Never**. The current option is checked. Pick
**Follow settings** to return to the rules in **Settings → Threads**. While those rules are off,
a thread on **Follow settings** does not settle automatically either. Manual settle, snooze, and
archive still work while it is set to **Never**.

Change these rules in **Settings → Threads**.
They continue to run when your apps are closed. On web and desktop, choose an environment at the
top to change only its rules, or **All environments** to update connected environments together.
Mixed values show where the selected environments disagree. Mobile applies these
rules to connected environments that support shared settings. Offline environments
and older servers keep their previous values. Changing a rule does not reopen
already settled threads.

## Link a pull request

The server finds the PR for each unsettled thread's saved branch, even when your
apps are closed. Settled threads keep their saved links. Update the server if
automatic branch links do not appear.

On web and desktop, right-click a pull request link in a thread and choose
**Link to thread** to select a different PR. Use **Unlink from thread** on the
same link to return to the branch PR, if one exists.
The linked pull request participates in automatic settlement.

## Find and reference work

On web and desktop, open the command palette with `Cmd/Ctrl+K` to search threads
across connected environments by title, branch, pull request, or project.
Threads you open often or recently rank higher, and for three weeks the thread
you last picked for a query ranks higher when you type that query again.
Threads whose messages contain all your words appear below, under **In
messages**, and open at the matching message. Message search needs at least
one word of three or more letters, or two for Chinese, Japanese, and Korean.
On mobile, the thread list search also lists message matches and opens them at
the matching message; on an iPad with a keyboard, `Cmd+K` opens the same
palette.

Use **Settings → Keybindings** to find or customize shortcuts for searching files
and copying a thread reference. A copied reference uses the thread's pull request
link when available, otherwise a link to the thread, which opens it from anywhere
you paste it and pastes into a composer as a thread chip (see
[sharing a thread](./prompt-links.md#share-a-thread)). To copy the thread even
when it has a PR, choose **Copy → Thread** from its context menu, or **Copy
thread** from its long-press menu on mobile.
**Thread ID** copies the bare ID for scripts and the `t3` CLI. See
[keybindings](./keybindings.md) for custom configuration.

## Inspect agent work

**Limited** means the provider stopped on a usage or rate limit. The conversation
keeps the provider's explanation. Retry after the limit resets, or switch to
another provider instance.
Press **Resume** in an empty composer to continue a limited or interrupted turn
manually when the provider supports native continuation, or send a message to continue.
Do this when the provider reports no reset time, because nothing continues the turn on its own.
Queued messages stay saved while the limit blocks the thread. They run after
the continuation finishes. If the queue was held by a restart, resume it then.

When the provider reports a reset time, choose **Resume at reset** to schedule a
continuation. You can cancel it from the thread. Enable **Resume after
usage limits** in **Settings → Threads** to schedule limit stops by default.
The environment must be running when the reset arrives; it resumes overdue
continuations after a restart. Stopping the thread, sending a new message,
archiving, or settling it prevents a pending continuation from starting.

Choose **Snooze until reset** to hide the thread until its allowance returns.
Snooze and auto-resume are independent: snooze alone wakes the thread without
sending a message; enabling both wakes and continues it. **Wake now** cancels
the snooze. Enable **Snooze until limits reset** in thread behavior settings to
snooze limit stops by default. Providers without a reset time offer manual
retry and the normal snooze choices.

On web and desktop, use **Agents** to follow work delegated to subagents.
A subagent started with a role, such as `review` or `implementation`, shows it as
a small label in its parent's rows, in **Related**, and in its own header.
On mobile, open a subagent from its conversation card or **Agents**. On iOS
layouts with an inspector, its thread opens beside the parent. Maximize it to
fill the screen; close the full-screen view to return to the parent and inspector.
Stop on a thread also stops the subagents it delegated to.
Before archiving the parent, wait for its delegated tasks to finish or cancel them.

Subagent threads started by the agent can't take messages; message the parent
thread instead. When such a subagent needs an approval or an answer, the parent
thread asks for it.

Expand a tool call in the conversation to see its full command and output.
Summaries shorten shell wrappers and can still describe the latest call after it
finishes; the call's own result shows its status.

On web and desktop, open **Workspace actions** in the thread header to see the
local servers that the thread's terminals or its Claude agent started, with their ports. Not every one
serves a web page. A server the agent started stays listed after the agent's
turn ends.
Select a server to open it in the browser panel. **Stop** ends the server's job
and keeps the agent, the terminal, and Weavewing running. Stop needs terminal
access to the environment and is not available on Windows.

Use **Workspace actions** to open the working folder in an editor, run project
scripts, manage Git, or work with thread automations. Open **Changes** from the
thread title menu, or select the line counts beside the branch when there are
changes.

The thread details card starts closed. Use **Toggle thread details panel** in
the composer to show it.
To choose what it shows, right-click the card or open
**Settings → Appearance → Thread details**. Hidden rows keep their keyboard
shortcuts, such as Open in editor and project scripts. **Reset to default** brings
back the standard rows.

## Side chats

A side chat lets you ask a question about a thread without adding to it. It starts
with what the thread knows, and the thread keeps working while you ask.

On web and desktop, start a message with `/side` or `/btw`, then your question.
You can also choose **Side chat** from a tile’s **+** menu. The side
chat opens as a tab there, with its own composer. Side chats do not show in the
sidebar. Open **Lineage** in the thread header to find its side chats and subagents.
Click **How conversation context is shared** in Lineage to see how the branch
started. The colored rail in the main chat opens the side chat inline.

Select text in an assistant reply and choose **Drill in** to start a side chat under
that reply. Click its colored rail to expand or collapse the chat. A collapsed chat
keeps its nested branches visible, and you can open them independently. Blue marks
on the timeline rail show where the branches start. **Open as side chat tab** puts
the branch in a tab on the chat you’re viewing. You can also reopen nested branches under **Side chats** in
**Lineage**. **Open full chat** gives the branch its own page. **Jump to source**
takes you back to the passage, or to the fork turn for a side chat opened without a
selection.

A branch starts with context through its fork point. Choose **Get newest context**
in a branch to include recent discussion from elsewhere in the tree with your
next message. Choose it again before sending to cancel the refresh. The main chat
adds a short update from its branches when you send a regular message and there
is new discussion to include.

A side chat works in the same folder as the thread and starts with the permissions,
model, and reasoning level shown in the thread's composer, including for its first
reply. Change them for an individual side chat in its composer. Later changes to the
parent do not change existing side chats.

To use what you learned, choose **Bring back**. This adds a removable reference to
the parent chat’s draft and keeps any text you already typed. The parent receives
the reference when you send the draft.

Closing a side chat you never sent a message in deletes it. To delete one you used,
choose **Delete** at the top of the side chat. Deleting a thread also deletes its
side chats.

### Forks and subagent tabs

Choose **Fork from this response** to start a separate thread with the conversation
through that reply. It opens beside **Main chat** and also appears in the sidebar
and in **Lineage**. Opening a subagent from the chat or **Lineage** also opens a
tab beside **Main chat**.

After sending a message in a fork, choose **Bring back** in its header to add a
removable reference to the source thread’s draft.

On mobile, a thread lists its side chats above the composer. Tap one to open it and
answer its questions.

## Rewind conversation context

On mobile, choose **Rewind conversation context** from **Git controls** in the
thread header while the thread is idle. On web and desktop, send `/clear` for a
fresh session instead, or use **Rewind to here** below.
Messages through the latest finished turn move into **Earlier conversation**. Codex and Claude archives reuse a native copy of that conversation when the archived
range shares one provider session. A range spanning provider sessions uses saved
conversation context instead.
Your next message starts with fresh context. The thread keeps its files and
draft. Earlier checkpoints remain in the thread’s history. Checkpoint restore
works only within the current provider session.

On web and desktop, expand **Earlier conversation** to read the archived
messages inline. Open it as a side chat tab or full chat to continue it. On
mobile, open **Earlier conversation** from the side chat list above the composer.
**Bring back** adds a removable reference to your original thread’s draft, even
before you send a message in the archive.

On web and desktop, **Rewind to here** under a completed Codex or Claude reply keeps the
conversation through that reply and moves later turns into **Earlier
conversation**. The thread keeps its files and draft. Finish queued work first,
then choose a reply with a native turn boundary in the active conversation.

**Rewind to here and keep a summary**, beside it, first asks the agent to
summarize the later turns: what it learned, the files it changed, the commands it
ran, its decisions and what remains. The thread works while the agent writes, then
rewinds as above. The summary shows beside the reply and goes to the agent with
your next message. If the agent does not finish its summary, nothing is rewound.
**Bring back** on **Earlier conversation** adds the archive as a reference the agent
can read; the summary still goes with your next message.

## Snooze until later

To change the choices in the snooze menu, open **Settings → Threads → Snooze options**.
Each option is a duration, such as 3 hours, or a time on a day, such as 9:00 PM
tomorrow. A weekday means the next one after today. Menus list the options soonest
first and hide a today option after its time passes. Saved with **All environments**
selected, the options apply to every connected environment, and the mobile app uses them too.

Choose **Snooze → Custom…** from a thread's menu to pick a date and time in your
local time zone, or a duration in minutes, hours, or days. Durations start when
you confirm; one day means 24 hours. On web and desktop, you can also snooze
several selected threads together. Choose **Wake thread** to bring a thread back early.

A snoozed thread keeps working and stays hidden until its wake time, even while
its agent wakes itself for background work. It comes back early for an approval,
a new question, a failed run, or a message or answer you send. You can snooze an existing
question and answer when the thread wakes; the question stays unanswered.
