import { CheckIcon, CopyIcon } from "lucide-react";
import { useRef, useState, type ComponentProps } from "react";

import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import {
  serializeTableElementToCsv,
  serializeTableElementToFixedWidth,
  serializeTableElementToMarkdown,
  tableWidestCellWidth,
} from "../../markdown-clipboard";
import { Button } from "../ui/button";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "../ui/menu";
import { ScrollArea } from "../ui/scroll-area";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { reportMarkdownActionFailure } from "./markdownActionFailure";

type TableCopyFormat = "markdown" | "csv" | "fixed-width" | "fixed-width-wrapped";

// Wrapping is offered once a cell outgrows the narrowest width that still reads as prose.
const WRAP_OFFER_WIDTH = 30;
const WRAP_WIDTHS = [20, 30, 40, 60];

export function MarkdownTable({ children, ...props }: ComponentProps<"table">) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const { copyToClipboard, isCopied: copied } = useCopyToClipboard<TableCopyFormat>({
    timeout: 1200,
    onError: (cause, format) =>
      reportMarkdownActionFailure({ operation: "copy-table", format }, cause),
  });
  const [widestCell, setWidestCell] = useState(0);
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

  const handleCopyWrapped = (wrapWidth: number) => {
    const table = tableElement();
    if (!table) return;
    copyToClipboard(serializeTableElementToFixedWidth(table, wrapWidth), "fixed-width-wrapped");
  };

  const wrapWidths = WRAP_WIDTHS.filter((width) => width < widestCell);

  return (
    <div ref={containerRef} className="chat-markdown-table-container">
      <ScrollArea radius="none" chainVerticalScroll scrollFade className="w-full max-w-full">
        <table {...props}>{children}</table>
      </ScrollArea>
      {/* Stays within the row's px-1: the chat lane clips sideways overflow. */}
      <div className="mt-0.5 -mx-1 flex items-center justify-end select-none">
        <Menu
          onOpenChange={(open) => {
            const table = tableElement();
            if (open && table) setWidestCell(tableWidestCellWidth(table));
          }}
        >
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
            {widestCell > WRAP_OFFER_WIDTH && (
              <MenuSub>
                <MenuSubTrigger>Copy as fixed width, wrapped</MenuSubTrigger>
                <MenuSubPopup>
                  {wrapWidths.map((width) => (
                    <MenuItem key={width} onClick={() => handleCopyWrapped(width)}>
                      Wrap at {width} characters
                    </MenuItem>
                  ))}
                </MenuSubPopup>
              </MenuSub>
            )}
          </MenuPopup>
        </Menu>
      </div>
    </div>
  );
}
