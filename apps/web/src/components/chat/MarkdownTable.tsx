import { CheckIcon, CopyIcon } from "lucide-react";
import { useRef, useState, type ComponentProps } from "react";

import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import {
  serializeTableElementToCsv,
  serializeTableElementToFixedWidth,
  serializeTableElementToMarkdown,
} from "../../markdown-clipboard";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { ScrollArea } from "../ui/scroll-area";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { reportMarkdownActionFailure } from "./markdownActionFailure";

type TableCopyFormat = "markdown" | "csv" | "fixed-width" | "fixed-width-wrapped";

const DEFAULT_WRAP_WIDTH = 30;
const MIN_WRAP_WIDTH = 5;
const MAX_WRAP_WIDTH = 200;

export function MarkdownTable({ children, ...props }: ComponentProps<"table">) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const { copyToClipboard, isCopied: copied } = useCopyToClipboard<TableCopyFormat>({
    timeout: 1200,
    onError: (cause, format) =>
      reportMarkdownActionFailure({ operation: "copy-table", format }, cause),
  });
  const [menuOpen, setMenuOpen] = useState(false);
  const [customWrap, setCustomWrap] = useState(String(DEFAULT_WRAP_WIDTH));
  const copyLabel = copied ? "Copied" : "Copy table";
  const tableElement = () => containerRef.current?.querySelector("table") ?? null;

  const handleCopy = (format: Exclude<TableCopyFormat, "fixed-width-wrapped">) => {
    const table = tableElement();
    if (!table) return;
    const serialize = {
      markdown: serializeTableElementToMarkdown,
      csv: serializeTableElementToCsv,
      "fixed-width": serializeTableElementToFixedWidth,
    }[format];
    copyToClipboard(serialize(table), format);
  };

  const copyWrapped = () => {
    const table = tableElement();
    if (!table) return;
    const typed = Number.parseInt(customWrap, 10);
    const wrapWidth = Number.isNaN(typed)
      ? DEFAULT_WRAP_WIDTH
      : Math.min(MAX_WRAP_WIDTH, Math.max(MIN_WRAP_WIDTH, typed));
    copyToClipboard(serializeTableElementToFixedWidth(table, wrapWidth), "fixed-width-wrapped");
    setMenuOpen(false);
  };

  return (
    <div ref={containerRef} className="chat-markdown-table-container">
      <ScrollArea radius="none" chainVerticalScroll scrollFade className="w-full max-w-full">
        <table {...props}>{children}</table>
      </ScrollArea>
      {/* Stays within the row's px-1: the chat lane clips sideways overflow. */}
      <div className="mt-0.5 -mx-1 flex items-center justify-end select-none">
        <Menu open={menuOpen} onOpenChange={setMenuOpen}>
          <Tooltip>
            <TooltipTrigger
              render={
                <MenuTrigger
                  render={
                    <Button
                      type="button"
                      variant="ghost-muted"
                      size="icon-xs"
                      aria-label={copyLabel}
                    />
                  }
                />
              }
            >
              {copied ? <CheckIcon className="size-3" /> : <CopyIcon className="size-3" />}
            </TooltipTrigger>
            <TooltipPopup side="top">{copyLabel}</TooltipPopup>
          </Tooltip>
          <MenuPopup align="end">
            <MenuItem onClick={() => handleCopy("markdown")}>Copy as Markdown</MenuItem>
            <MenuItem onClick={() => handleCopy("csv")}>Copy as CSV</MenuItem>
            <MenuItem onClick={() => handleCopy("fixed-width")}>Copy as fixed width</MenuItem>
            <MenuItem onClick={copyWrapped}>
              Copy as fixed width, wrapped at
              <Input
                type="number"
                inputMode="numeric"
                min={MIN_WRAP_WIDTH}
                max={MAX_WRAP_WIDTH}
                size="sm"
                className="ms-auto w-12"
                aria-label="Wrap width in characters"
                value={customWrap}
                onValueChange={setCustomWrap}
                // The field edits the width; only the rest of the row copies.
                onClick={(event) => event.stopPropagation()}
                onKeyDown={(event) => {
                  // Menu typeahead and item navigation would otherwise take the keys.
                  if (event.key !== "Escape") event.stopPropagation();
                  if (event.key === "Enter") copyWrapped();
                }}
              />
            </MenuItem>
          </MenuPopup>
        </Menu>
      </div>
    </div>
  );
}
