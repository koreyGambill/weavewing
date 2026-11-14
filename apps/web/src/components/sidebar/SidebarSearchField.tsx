import { SearchIcon, XIcon } from "lucide-react";
import { type ComponentProps, type RefObject, useRef } from "react";

import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { SidebarInput } from "../ui/sidebar";

/** The sidebar's search box: the thread search and every strip view's filter share it. */
export function SidebarSearchField({
  value,
  onValueChange,
  onClear,
  clearLabel = "Clear search",
  inputRef,
  className,
  ...inputProps
}: Omit<
  ComponentProps<typeof SidebarInput>,
  "value" | "onChange" | "ref" | "type" | "className"
> & {
  value: string;
  onValueChange: (value: string) => void;
  onClear?: () => void;
  clearLabel?: string;
  inputRef?: RefObject<HTMLInputElement | null>;
  className?: string;
}) {
  const ownRef = useRef<HTMLInputElement>(null);
  const ref = inputRef ?? ownRef;
  return (
    <div
      className={cn(
        "flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-sm font-medium text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-within:bg-sidebar-row-hover focus-within:text-sidebar-foreground focus-within:ring-1 focus-within:ring-inset focus-within:ring-ring/70",
        className,
      )}
    >
      <SearchIcon className="size-4 shrink-0 text-(--sidebar-icon-color)" />
      <SidebarInput
        ref={ref}
        nativeInput
        type="search"
        placeholder="Search"
        value={value}
        onChange={(event) => onValueChange(event.currentTarget.value)}
        className="min-w-0 flex-1"
        {...inputProps}
      />
      {onClear && value.trim() !== "" ? (
        <Button
          type="button"
          size="icon-micro"
          variant="ghost-muted"
          className="shrink-0"
          aria-label={clearLabel}
          onClick={() => {
            onClear();
            ref.current?.focus();
          }}
        >
          <XIcon className="size-3" />
        </Button>
      ) : null}
    </div>
  );
}
