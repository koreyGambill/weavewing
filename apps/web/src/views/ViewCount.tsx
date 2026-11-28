import { MenuItemDetail } from "../components/ui/menu";
import type { ViewTarget } from "./viewRegistry";

export interface ViewCountProps {
  readonly target: ViewTarget;
  readonly mark?: "badge" | "dot" | undefined;
}

export function ViewCount({
  children,
  mark,
}: {
  children: number | string;
  mark: ViewCountProps["mark"];
}) {
  if (!mark) return <MenuItemDetail>{children}</MenuItemDetail>;
  if (mark === "dot" || typeof children === "string") {
    return (
      <span
        data-view-mark
        className="pointer-events-none absolute -right-1 -top-1 size-2 rounded-full bg-warning ring-2 ring-background"
      >
        <span className="sr-only">{children}</span>
      </span>
    );
  }
  return (
    <span
      data-view-mark
      className="pointer-events-none absolute -right-2 -top-2 min-w-3.5 rounded-full bg-primary px-0.5 text-center text-3xs leading-3.5 text-primary-foreground ring-2 ring-background"
    >
      {children > 99 ? "99+" : children}
    </span>
  );
}
