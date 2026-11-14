import type { ThreadMark } from "@t3tools/contracts";

/** Every word of the filter appears somewhere in the row's fields, ignoring case. */
export function matchesToolFilter(
  fields: ReadonlyArray<string | null | undefined>,
  filter: string,
): boolean {
  const haystack = fields.filter(Boolean).join(" ").toLowerCase();
  return filter
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((word) => haystack.includes(word));
}

export function markTimestamp(value: string, utc: boolean, hour24: boolean): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const part = (local: number, universal: number) => (utc ? universal : local);
  const pad = (number: number) => String(number).padStart(2, "0");
  const hour = part(date.getHours(), date.getUTCHours());
  return `${part(date.getFullYear(), date.getUTCFullYear())}-${pad(part(date.getMonth(), date.getUTCMonth()) + 1)}-${pad(part(date.getDate(), date.getUTCDate()))} ${pad(hour24 ? hour : hour % 12 || 12)}:${pad(part(date.getMinutes(), date.getUTCMinutes()))}${hour24 ? "" : hour < 12 ? " AM" : " PM"}`;
}

export type LinkSort = "newest" | "oldest" | "service" | "link";

/** Links from the conversation after the filter box, the service filter and the sort. */
export function visibleMarks<
  Mark extends Pick<ThreadMark, "url" | "service" | "timestamp" | "description" | "name">,
>(
  marks: ReadonlyArray<Mark>,
  options: {
    readonly filter: string;
    readonly service: string;
    readonly sort: LinkSort;
    readonly hour24: boolean;
  },
): Mark[] {
  return marks
    .filter(
      (mark) =>
        (options.service === "all" || mark.service === options.service) &&
        matchesToolFilter(
          [
            mark.url,
            mark.name,
            mark.service,
            mark.description,
            markTimestamp(mark.timestamp, false, options.hour24),
            markTimestamp(mark.timestamp, true, options.hour24),
          ],
          options.filter,
        ),
    )
    .toSorted((left, right) => {
      switch (options.sort) {
        case "newest":
          return right.timestamp.localeCompare(left.timestamp);
        case "oldest":
          return left.timestamp.localeCompare(right.timestamp);
        case "service":
          return left.service.localeCompare(right.service) || left.url.localeCompare(right.url);
        case "link":
          return left.url.localeCompare(right.url);
      }
    });
}

/** The text "Copy shown links" puts on the clipboard: one line per ticket, pull request and link, in view order. */
export function linksCopyText(shown: {
  readonly tickets: ReadonlyArray<{ ticket: string; label?: string; url?: string }>;
  readonly pullRequests: ReadonlyArray<{ url: string; title?: string }>;
  readonly marks: ReadonlyArray<string>;
}): string {
  return [
    ...shown.tickets.map(({ ticket, label, url }) =>
      [ticket, label, url].filter(Boolean).join(" "),
    ),
    ...shown.pullRequests.map(({ url, title }) => [url, title].filter(Boolean).join(" ")),
    ...shown.marks,
  ].join("\n");
}
