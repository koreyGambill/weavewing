import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { ChevronDownIcon, ChevronUpIcon, XIcon } from "lucide-react";

import { Button } from "../ui/button";
import { InputGroup, InputGroupAddon, InputGroupInput } from "../ui/input-group";
import { cn } from "~/lib/utils";
import {
  initialTerminalMatchIndex,
  stepTerminalMatchIndex,
  type TerminalFindMatch,
} from "~/terminal/ghostty/find";
import type { GhosttyTerminalSurface } from "~/terminal/ghostty/surface";

interface TerminalFindBarProps {
  readonly terminalId: string;
  readonly surface: () => GhosttyTerminalSurface | null;
  readonly focusRequestId: number;
  readonly isFindShortcut: (event: globalThis.KeyboardEvent) => boolean;
  readonly onClose: () => void;
}

function sameMatch(left: TerminalFindMatch | undefined, right: TerminalFindMatch | undefined) {
  return left !== undefined && left.row === right?.row && left.start === right.start;
}

export function TerminalFindBar({
  terminalId,
  surface,
  focusRequestId,
  isFindShortcut,
  onClose,
}: TerminalFindBarProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<{ active: number; matches: number } | null>(null);
  const currentRef = useRef<TerminalFindMatch | undefined>(undefined);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- focuses and selects the input DOM node when the bar opens or a find shortcut fires
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Each find shortcut bumps the request id, so an already-open bar refocuses and reselects its query.
  }, [focusRequestId]);

  const reveal = (matches: readonly TerminalFindMatch[], index: number) => {
    const terminal = surface();
    const match = matches[index];
    currentRef.current = match;
    if (!terminal) return;
    if (match) terminal.revealMatch(match);
    else terminal.clearSelection();
    setResult({ active: index + 1, matches: matches.length });
  };

  const handleQueryChange = (next: string) => {
    setQuery(next);
    const terminal = surface();
    if (next.length === 0 || !terminal) {
      currentRef.current = undefined;
      setResult(null);
      terminal?.clearSelection();
      return;
    }
    const matches = terminal.findMatches(next);
    reveal(matches, initialTerminalMatchIndex(matches, terminal.viewportTop()));
  };

  const step = (forward: boolean) => {
    const terminal = surface();
    if (query.length === 0 || !terminal) return;
    // Output may have moved or added rows since the last search.
    const matches = terminal.findMatches(query);
    const current = matches.findIndex((match) => sameMatch(match, currentRef.current));
    reveal(matches, stepTerminalMatchIndex(matches.length, current, forward));
  };

  const close = () => {
    surface()?.clearSelection();
    onClose();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
    if (event.key === "Enter") {
      event.preventDefault();
      event.stopPropagation();
      step(!event.shiftKey);
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
    } else if (isFindShortcut(event.nativeEvent)) {
      event.preventDefault();
      event.stopPropagation();
      inputRef.current?.select();
    }
  };

  const hasQuery = query.length > 0;
  const noResults = hasQuery && result !== null && result.matches === 0;
  const label = hasQuery && result ? `${result.active}/${result.matches}` : "";
  const navigationDisabled = !result || result.matches === 0;

  return (
    <div
      data-terminal-find={terminalId}
      className="absolute top-3 right-3 z-40 w-[min(22rem,calc(100%-1.5rem))]"
    >
      <InputGroup
        variant="popover"
        size="lg"
        role="search"
        aria-label="Find in terminal"
        className="w-full"
      >
        <InputGroupInput
          ref={inputRef}
          type="search"
          size="sm"
          value={query}
          aria-label="Find in terminal"
          placeholder="Find in terminal"
          maxLength={200}
          spellCheck={false}
          autoComplete="off"
          onChange={(event) => handleQueryChange(event.target.value)}
          onKeyDown={handleKeyDown}
        />
        <InputGroupAddon align="inline-end" inset="pill">
          <span
            aria-live="polite"
            className={cn(
              "min-w-10 text-center text-xs tabular-nums",
              noResults ? "text-destructive" : "text-muted-foreground",
            )}
          >
            {label}
          </span>
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label="Previous match"
            disabled={navigationDisabled}
            onClick={() => step(false)}
          >
            <ChevronUpIcon />
          </Button>
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label="Next match"
            disabled={navigationDisabled}
            onClick={() => step(true)}
          >
            <ChevronDownIcon />
          </Button>
          <Button size="icon-xs" variant="ghost" aria-label="Close find" onClick={close}>
            <XIcon />
          </Button>
        </InputGroupAddon>
      </InputGroup>
    </div>
  );
}
