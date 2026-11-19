// Content headers start right of the fixed title-bar cluster at every sidebar width, so dragging the
// sidebar never moves them; an expanded sidebar is offset with a (possibly negative) margin.
export const COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS =
  "[[data-sidebar-state=collapsed]_&]:pl-[var(--workspace-titlebar-content-left)] md:[[data-sidebar-state=expanded]_&]:pl-0 md:[[data-sidebar-state=expanded]_&]:ml-[calc(var(--workspace-titlebar-content-left)-var(--sidebar-width))] max-md:[[data-sidebar-state=expanded]_&]:pl-[var(--workspace-titlebar-content-left)]";
