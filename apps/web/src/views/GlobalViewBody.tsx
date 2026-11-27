import type { ReactNode } from "react";
import { cn } from "../lib/utils";

/** A view that spans threads, scrolling and padded unless it lays out its own. */
export function GlobalViewBody({
  title,
  flush = false,
  children,
}: {
  title: string;
  flush?: boolean;
  children?: ReactNode;
}) {
  return (
    <section
      aria-label={title}
      className={cn("flex min-h-0 min-w-0 flex-1 flex-col", !flush && "overflow-auto p-2.5")}
    >
      {children}
    </section>
  );
}
