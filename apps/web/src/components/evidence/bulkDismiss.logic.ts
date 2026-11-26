/** `YYYY-MM-DD` for a date input, in the user's own time zone. */
export function localDateInputValue(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * The instant a bulk dismissal stops at: the start of the chosen day in the user's time zone, so
 * nothing that landed on that day is dismissed. Null for a value that is not a date.
 */
export function bulkDismissBefore(day: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (match === null) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Number.isNaN(date.getTime()) || localDateInputValue(date) !== day
    ? null
    : date.toISOString();
}

/**
 * What a bulk dismissal reports: how many it dismissed, and how many of the counted changes had
 * changed meanwhile, without claiming what they are now.
 */
export function bulkDismissOutcome(counted: number, dismissed: number): string {
  const skipped = counted - dismissed;
  const done = `Dismissed ${dismissed} ${dismissed === 1 ? "change" : "changes"}.`;
  if (skipped <= 0) return done;
  return `${done} ${skipped} had already changed and ${skipped === 1 ? "was left as it is" : "were left as they are"}.`;
}
