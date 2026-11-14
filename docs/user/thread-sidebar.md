# Working with threads

Use a new thread for a separate task. Choose **New worktree** when its code changes
need a separate branch and working directory.

On web and desktop, **Settings → General → Thread glyph alerts** controls the
one-second glyph flash when a thread replies or needs attention. It appears over
the whole application, including when you are viewing that thread, and respects
reduced motion. A dot on the thread's glyph marks an unread reply or a request
that still needs attention. System notifications and sounds have separate controls.

## Start a thread

On web and desktop, **New thread** opens the project picker when you have more than one
open project in the default or project-grouped sidebar. Archived projects don't count. **Shift-click** to start in
the current project, or use a project's own new-thread action. A new thread carries
your model and mode selections, unless the destination project has its own model default.
Its branch and workspace mode come from your configured defaults. To continue in
an existing worktree, use **New thread in this worktree** from the branch toolbar.

On mobile, **New thread** starts in the current thread's project, or else in the
last project you opened or chose on that device. If neither is available, the
project picker opens. Turn off **Settings → General → Use last project** to
choose a project every time. When you pick a project that is on more than one
machine, the thread starts on a connected one if any is connected.

When you change a new thread's project, T3 Code stays in the current environment
if that project exists there. Otherwise it selects an environment that has it.

### Start without a project

A thread does not need a project. To start one without a project, click **or
start without a project** under a new thread's heading, pick **No project** from
the project menu in that heading or from **New thread in...** in the command
palette, or press `mod+alt+n`. On mobile, pick **No project** from the project
list. It starts on your current machine; before sending, pick another machine
from the machine menu to move it there. To move a draft into a project, pick the
project in the heading.

Threads without a project start in the server machine's `~/code` folder. Set
`scratchStartDirectory` in that server's settings to use another existing folder.
If the folder does not exist, T3 Code uses the `scratch` folder in its data directory.
The start folder must sit outside a Git repository and cannot be your home, `~/.xwing`, or a parent of T3 Code's data folder. Threads share it without
creating a separate visible folder per thread. Sandboxed agents run from a private
thread folder and can read the shared folder. Full-access agents run there directly.
Older threads keep their existing folders. Deleting a thread keeps its files.

File search in the shared start folder lists only its immediate files and folders.
Choose a repository folder to search inside it. Ask the agent to create its own
Xwing environment for code changes and keep throwaway files in `/tmp`.
Sandboxed agents can edit linked worktrees but need approval to commit.

Choose **Change folder** from a thread's menu or details to work somewhere else.
Pick a recent folder, a project, or a linked Xwing environment, or enter a path.
The thread keeps its history. Its next turn starts a new agent session in that
folder with the conversation carried over. Finish or stop any work before moving.

The left sidebar also holds tools for the current thread: Todos, Artifacts,
Links, Related, Timeline, Details, Environments and Inspect, plus the Inbox. Pick a tool from the strip beside the thread list; pick it again, or
**Threads** at the top of the strip, to return to your threads. `Cmd+Alt+I` on macOS or `Ctrl+Alt+I`
on Windows and Linux switches between your threads and the last tool, and opens
a hidden sidebar on that tool. While the sidebar is hidden, its toggle shows when
something needs you, such as an unanswered question or a status alert. The tools
follow the focused tile; pin them to keep one thread while you move between
tiles. Hide tools you don't use from the bottom of the strip. Opening a hidden
tool from elsewhere, such as an artifact reminder, shows it again.

The **Inbox**, the bell under Threads in the strip, collects notifications that
automations and agents raise, newest first. Its badge counts unread ones and turns
red for critical or amber for a warning. Open one to read it; it then counts as
read. Snooze one to have it come back later, or dismiss it once it's handled. The
Snoozed and Dismissed tabs show those, where you can unsnooze or restore them. The
Status row opens your status sources. Critical notifications also send a desktop
notification and play a sound, and warnings do when T3 Code is in the background,
following your settings under **Settings → General → Notifications**.

Links, Artifacts and Related have a filter box, and each row can copy its link,
ticket ID or thread link. Links also filters by service, sorts, and copies every
shown link at once.

**Todos** holds the commitments you and agents track for a thread. New items are
yours; give one to the agent before adding it, or change who is responsible from
the item's menu. Items nest up to three levels: indent and outdent from the item's
menu, or press Tab and Shift+Tab while editing its text. Select an item's text to
edit it and its note. Filter the list to your items or the agent's, and show done
and dropped items when you need them. These choices stay on this device.

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

On web and desktop, the list also animates section changes made with thread actions such as
**Pin**, **Settle**, and **Snooze**. These transitions respect your system's reduced-motion
preference. While dragging, rows follow the insertion gap without replaying a second transition
after the drop.

New threads appear above the active threads you have arranged. Settling clears a thread's active
position, so using **Un-settle** returns it to the top. Pinning and snoozing preserve its active
position until you move it again. Thread activity does not change the order. The settled shelf
continues to use settlement time.

If dragging is unavailable for one environment, update the T3 Code server running in that
environment. Pinned and active reordering require server support. Threads from older servers keep
their default order until the server is updated.

To generate a fresh title from the conversation, open a thread's menu and choose
**Regenerate title**. The action is unavailable while title generation is in progress
or when the connected environment needs a server update.

To change how titles are written, add **Thread title instructions** in **Settings → Threads →
Text generation**, under Advanced, such as a length limit or an identifier to put first. They apply to new and
regenerated titles. Select a project to give it its own instructions.

Agents connected through T3 Code can use the same server-owned metadata workflow to
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
manually. Do this when the provider reports no reset time, because nothing
continues the turn on its own.
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

On web and desktop, the thread details card lists the local servers that the
thread's terminals or its Claude agent started, with their ports. Not every one
serves a web page. A server the agent started stays listed after the agent's
turn ends.
Select a server to open it in the browser panel. **Stop** ends the server's job
and keeps the agent, the terminal, and T3 Code running. Stop needs terminal
access to the environment and is not available on Windows.

To choose what the thread details card shows, right-click the card or open
**Settings → Appearance → Thread details**. Hidden rows keep their keyboard
shortcuts, such as Open in editor and project scripts. **Reset to default** brings
back the standard rows.

## Side chats

A side chat lets you ask a question about a thread without adding to it. It starts
with what the thread knows, and the thread keeps working while you ask.

On web and desktop, start a message with `/side` or `/btw`, then your question.
You can also choose **Side chat** from the **+** menu in the right panel. The side
chat opens as a tab there, with its own composer. Side chats do not show in the
sidebar. Find one again under **Side chats** in thread details.

A side chat works in the same folder as the thread and starts with the permissions,
model, and reasoning level shown in the thread's composer, including for its first
reply. Change them for an individual side chat in its composer. Later changes to the
parent do not change existing side chats.

To use what you learned, choose **Bring back**. The thread gets the side chat with
your next message there. Bring back is available while the thread is idle.

Closing a side chat you never sent a message in deletes it. To delete one you used,
choose **Delete** at the top of the side chat. Deleting a thread also deletes its
side chats.

On mobile, a thread lists its side chats above the composer. Tap one to open it and
answer its questions.

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
