// The thread list registers the opener while it is mounted, because only it can expand the
// sidebar; the command palette sits outside the sidebar and calls through here.
let opener: (() => boolean) | null = null;

/** `open` returns false when the row is not on screen to anchor the list. */
export function registerWaitingListOpener(open: () => boolean): () => void {
  opener = open;
  return () => {
    if (opener === open) opener = null;
  };
}

/** Opens the "Waiting on you" list; false when no visible thread list can show it. */
export function openWaitingList(): boolean {
  return opener?.() ?? false;
}
