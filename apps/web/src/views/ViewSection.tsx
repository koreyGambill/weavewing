import { ChevronRightIcon } from "lucide-react";
import { createContext, use, useState, type ReactNode } from "react";
import { observeIntersection } from "../lib/observeIntersection";
import { cn } from "../lib/utils";
import type { ViewSectionId } from "../components/ToolSidebar.logic";
import { useThreadContextSidebarStore } from "../threadContextSidebarStore";

interface SectionGroup {
  readonly mounted: ReadonlySet<ViewSectionId>;
  readonly markMounted: (id: ViewSectionId) => void;
}

const SectionGroupContext = createContext<SectionGroup | null>(null);

/** The sections of one merged view, which mount in order from the top. */
export function ViewSectionGroup({ children }: { children: ReactNode }) {
  const [mounted, setMounted] = useState<ReadonlySet<ViewSectionId>>(() => new Set());
  const [markMounted] = useState(
    () => (id: ViewSectionId) =>
      setMounted((current) => (current.has(id) ? current : new Set([...current, id]))),
  );
  return <SectionGroupContext value={{ mounted, markMounted }}>{children}</SectionGroupContext>;
}

/**
 * One collapsible part of a merged view, under its own heading with its own button row. Its body
 * mounts only while expanded, once it has come into view and once the section named by `after`
 * has mounted or is collapsed: before the first body renders, every heading of a short view is
 * on screen, so without that order all of a view's sections would start their requests at once.
 */
export function ViewSection({
  id,
  title,
  after,
  children,
}: {
  id: ViewSectionId;
  title: string;
  /** The section above this one in its view. */
  after?: ViewSectionId;
  /** The section's content, given the element its buttons portal into. */
  children: (actions: HTMLDivElement | null) => ReactNode;
}) {
  const group = use(SectionGroupContext);
  const collapsed = useThreadContextSidebarStore((state) => state.collapsedSections.includes(id));
  const aboveCollapsed = useThreadContextSidebarStore(
    (state) => after !== undefined && state.collapsedSections.includes(after),
  );
  const aboveDone =
    after === undefined || aboveCollapsed || group === null || group.mounted.has(after);
  const reveal = useThreadContextSidebarStore((state) => state.revealSection === id);
  const [actions, setActions] = useState<HTMLDivElement | null>(null);
  const [seen, setSeen] = useState(false);
  const [placeholderRef] = useState(() => (node: HTMLDivElement | null) => {
    if (!node) return;
    return observeIntersection(node, (entry) => {
      if (!entry.isIntersecting) return;
      setSeen(true);
      group?.markMounted(id);
    });
  });
  const [sectionRef] = useState(() => (node: HTMLElement | null) => {
    if (!node || useThreadContextSidebarStore.getState().revealSection !== id) return;
    node.scrollIntoView({ block: "start" });
    useThreadContextSidebarStore.getState().consumeRevealSection(id);
  });
  const headingId = `view-section-${id}`;
  return (
    <section
      ref={reveal ? sectionRef : undefined}
      aria-labelledby={headingId}
      data-view-section={id}
      className="flex min-w-0 flex-col"
    >
      <div className="sticky top-0 z-[1] flex h-8 shrink-0 items-center gap-1 bg-background ps-1 pe-1">
        <h3 className="min-w-0 flex-1">
          <button
            type="button"
            id={headingId}
            aria-expanded={!collapsed}
            className="flex w-full min-w-0 items-center gap-1 rounded-sm px-1 py-1 text-left text-xs font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
            onClick={() => useThreadContextSidebarStore.getState().toggleSection(id)}
          >
            <ChevronRightIcon
              aria-hidden
              className={cn("size-3.5 shrink-0 transition-transform", !collapsed && "rotate-90")}
            />
            <span className="truncate">{title}</span>
          </button>
        </h3>
        <div ref={setActions} className="flex shrink-0 items-center" />
      </div>
      {collapsed ? null : seen ? (
        children(actions)
      ) : aboveDone ? (
        <div ref={placeholderRef} className="h-16" />
      ) : (
        <div className="h-16" />
      )}
    </section>
  );
}
