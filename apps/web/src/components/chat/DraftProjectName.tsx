export function DraftProjectName({
  value,
  singleLine = false,
  truncateStart = false,
}: {
  value: string;
  singleLine?: boolean;
  /** For paths: the folder name at the end stays visible. */
  truncateStart?: boolean;
}) {
  return (
    <span
      aria-label={value}
      className={`min-w-0 ${singleLine || truncateStart ? "block truncate text-left" : "line-clamp-2 whitespace-normal [overflow-wrap:anywhere]"}`}
      {...(truncateStart ? { dir: "rtl" } : {})}
    >
      {truncateStart ? <bdi>{value}</bdi> : value}
    </span>
  );
}
