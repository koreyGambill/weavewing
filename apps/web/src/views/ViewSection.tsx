import { ChevronRightIcon } from "lucide-react";
import { createContext, use, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { holdScrollTarget } from "../lib/holdScrollTarget";
import { observeIntersection } from "../lib/observeIntersection";
import { cn } from "../lib/utils";
import type { ViewSectionId } from "../components/ToolSidebar.logic";
import { useThreadContextSidebarStore } from "../threadContextSidebarStore";
import { useToolSidebarStore } from "../toolSidebarStore";

interface SectionGroup {
  readonly order: ReadonlyArray<ViewSectionId>;
  readonly mounted: ReadonlySet<ViewSectionId>;
  readonly markMounted: (id: ViewSectionId) => void;
}

const SectionGroupContext = createContext<SectionGroup | null>(null);

/** The sections of one merged view, which mount in order from the top. */
export function ViewSectionGroup({
  order,
  children,
}: {
  order: ReadonlyArray<ViewSectionId>;
  children: ReactNode;
}) {
  const [mounted, setMounted] = useState<ReadonlySet<ViewSectionId>>(() => new Set());
  const [markMounted] = useState(
    () => (id: ViewSectionId) =>
      setMounted((current) => (current.has(id) ? current : new Set([...current, id]))),
  );
  return (
    <SectionGroupContext value={{ order, mounted, markMounted }}>{children}</SectionGroupContext>
  );
}

/**
 * Keeps expanded sections lazy in reading order. An explicit reveal mounts the sections above
 * its destination first so their bodies take up space before scrolling.
 */
export function ViewSection({
  id,
  title,
  children,
}: {
  id: ViewSectionId;
  title: string;
  /** The section's content, given the element its buttons portal into. */
  children: (actions: HTMLDivElement | null) => ReactNode;
}) {
  const group = use(SectionGroupContext);
  const collapsedSections = useThreadContextSidebarStore((state) => state.collapsedSections);
  const requestedSection = useToolSidebarStore((state) => state.revealSection);
  const reveal = requestedSection === id;
  const collapsed = !reveal && collapsedSections.includes(id);
  const order = group?.order ?? [];
  const index = order.indexOf(id);
  const revealIndex = requestedSection === null ? -1 : order.indexOf(requestedSection);
  const aboveDone = order
    .slice(0, index)
    .every((above) => collapsedSections.includes(above) || group?.mounted.has(above));
  const [actions, setActions] = useState<HTMLDivElement | null>(null);
  const [seen, setSeen] = useState(false);
  const section = useRef<HTMLElement>(null);
  const stopHolding = useRef<(() => void) | null>(null);
  const forceMount = group !== null && aboveDone && (reveal || index < revealIndex);
  const bodyMounted = !collapsed && (seen || forceMount || group?.mounted.has(id));
  const [placeholderRef] = useState(() => (node: HTMLDivElement | null) => {
    if (!node) return;
    return observeIntersection(node, (entry) => {
      if (entry.isIntersecting) setSeen(true);
    });
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Record committed bodies before a reveal measures the sections below them.
  useLayoutEffect(() => {
    if (bodyMounted && group && !group.mounted.has(id)) group.markMounted(id);
  }, [bodyMounted, group, id]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- The scroll hold stays active until input or this view unmounts.
  useLayoutEffect(() => () => stopHolding.current?.(), []);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- The destination can only be measured after the preceding section bodies have committed.
  useLayoutEffect(() => {
    if (requestedSection === null) return;
    stopHolding.current?.();
    stopHolding.current = null;
    const target = section.current;
    const scroller = target?.parentElement;
    if (requestedSection !== id || !aboveDone || !target || !scroller) return;
    stopHolding.current = holdScrollTarget(target, scroller, () => 0);
    const preferences = useThreadContextSidebarStore.getState();
    if (preferences.collapsedSections.includes(id)) preferences.toggleSection(id);
    useToolSidebarStore.getState().consumeRevealSection(id);
  }, [requestedSection, aboveDone, id]);
  const headingId = `view-section-${id}`;
  return (
    <section
      ref={section}
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
      {collapsed ? null : bodyMounted ? (
        children(actions)
      ) : aboveDone ? (
        <div ref={placeholderRef} className="h-16" />
      ) : (
        <div className="h-16" />
      )}
    </section>
  );
}
