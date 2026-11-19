/**
 * The Threads header's two new-thread buttons: one at the default place, one in the current
 * thread's project. With no current project the second starts where the first does, and says so.
 */
export function resolveNewThreadButtons(input: {
  readonly defaultPlaceLabel: string | null;
  readonly currentProjectLabel: string | null;
  readonly newThreadShortcut: string | null | undefined;
  readonly newThreadInProjectShortcut: string | null | undefined;
}) {
  const withKey = (text: string, key: string | null | undefined) =>
    key ? `${text} (${key})` : text;
  const defaultTitle =
    input.defaultPlaceLabel === null ? "New thread" : `New thread in ${input.defaultPlaceLabel}`;
  const fallback =
    input.defaultPlaceLabel === null
      ? "No current project, so this starts a new thread"
      : `No current project, so this starts in ${input.defaultPlaceLabel}`;
  const projectTitle =
    input.currentProjectLabel === null ? null : `New thread in ${input.currentProjectLabel}`;
  return {
    defaultPlace: { label: defaultTitle, tooltip: withKey(defaultTitle, input.newThreadShortcut) },
    currentProject: {
      label: projectTitle ?? "New thread in current project",
      tooltip: withKey(projectTitle ?? fallback, input.newThreadInProjectShortcut),
    },
  };
}
