import {
  ActivityIcon,
  BellIcon,
  CalendarClockIcon,
  CalendarIcon,
  ChartGanttIcon,
  ClipboardCheckIcon,
  FilesIcon,
  IdCardIcon,
  LinkIcon,
  ListChecksIcon,
  UserRoundIcon,
  type LucideIcon,
} from "lucide-react";

import type { ViewId } from "../components/ToolSidebar.logic";

/** Each view's icon, for places that label a view without loading its code, such as a tab. */
export const VIEW_ICONS: { readonly [Id in ViewId]: LucideIcon } = {
  checklist: ListChecksIcon,
  evidence: ClipboardCheckIcon,
  artifacts: FilesIcon,
  links: LinkIcon,
  activity: ChartGanttIcon,
  details: IdCardIcon,
  automations: CalendarClockIcon,
  waiting: UserRoundIcon,
  inbox: BellIcon,
  calendar: CalendarIcon,
  status: ActivityIcon,
};
