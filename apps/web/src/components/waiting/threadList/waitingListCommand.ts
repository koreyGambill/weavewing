// The thread list registers the opener while it is mounted, because only it can expand the
// sidebar; the command palette sits outside the sidebar and calls through here.
let opener: (() => void) | null = null;

export function registerWaitingListOpener(open: () => void): () => void {
  opener = open;
  return () => {
    if (opener === open) opener = null;
  };
}

/** Opens the "Waiting on you" list; false when no thread list is mounted to show it. */
export function openWaitingList(): boolean {
  if (opener === null) return false;
  opener();
  return true;
}
