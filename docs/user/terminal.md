# Terminal history

Each terminal keeps up to 5,000 lines and 8 MiB of scrollback on its environment
server. T3 Code removes the oldest output when either limit is reached. A long
line can be shortened at the start. New terminal output is not truncated.

These limits apply when you reconnect and when T3 Code restores saved terminal
history. A client can show less scrollback than the server keeps.

On web and desktop, use Shift+PageUp and Shift+PageDown to read scrollback
without leaving terminal input. Ctrl+Shift+Home and Ctrl+Shift+End jump to the
start and latest output; use Cmd instead of Ctrl on macOS. Full-screen terminal
programs keep these navigation keys.

To copy all retained output, choose Select all in the terminal's context menu,
then copy. Cmd+A on macOS and Ctrl+Shift+A elsewhere select the same output.
Ctrl+A still moves to the beginning of shell input on Windows and Linux.
Jump to latest in the context menu returns to the current output.

On iPhone and iPad, long-press the terminal to paste or to choose Select Text.
Select Text shows the visible output, where you can copy text or tap a link.

## Choosing a machine

Open the drop-down terminal with Ctrl+J or Cmd+J. Click outside it to hide it
while its shells keep running. Use **Run on** to choose a
connected machine or switch to the current thread's machine. Your choice stays
selected as you switch threads. Return to a machine to resume its terminals.
If it disconnects, the drop-down waits for it to reconnect or for you to pick
another machine.

On macOS and Linux, fresh drop-down shells load the destination machine’s login
profile. Open a new terminal tab to pick up profile changes.

New tabs and tiles start in the source terminal's recorded launch directory,
or the machine's default folder when there is no recorded directory. Changes
made with `cd` inside the shell don't change that starting directory.

## Moving terminals

To hand a running drop-down terminal to a thread, choose **Move to thread** in the
terminal's context menu or its tile actions menu. The thread you are viewing is
listed first, then recent threads on the same machine. The shell keeps running
with its scrollback. **Move to drop-down** opens the thread's terminal in the
drop-down for its machine.

## fish

T3 Code starts fish with `no-query-term`, avoiding startup waits for terminal
replies. This disables optional fish features that depend on those replies.
T3 Code's exported `fish_features` also hides any universal flags you set with
`set -U fish_features`.

To preserve those flags or enable queries with `query-term`, include them in
`fish_features` in the environment that launches T3 Code. A shell export applies
when you launch T3 Code from that shell; it does not configure a desktop app
launched from the Dock or Finder. Enabling queries can restore the startup wait.
