import type { ReactNode } from "react";

export interface SheetProps {
  readonly title: string;
  readonly children: ReactNode;
  readonly onClose: () => void;
  /** Blocks the close button and the swipe, such as while a submit is in flight. */
  readonly dismissDisabled?: boolean;
  /** False dismisses the sheet with its animation; `onClose` runs once it is gone. */
  readonly open?: boolean;
}
