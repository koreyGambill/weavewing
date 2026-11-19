import { ArrowUp, FolderSymlink, House } from "lucide-react";
import { type FormEvent, type ReactNode, useRef, useState } from "react";

import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { InputGroup, InputGroupInput } from "~/components/ui/input-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";

import { filesTabRoot, parentHostFolder } from "./filesRoot";

function RootBarButton(props: {
  label: string;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          // aria-disabled keeps focus on a button that a press just disabled.
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={props.label}
            aria-disabled={props.disabled ?? false}
            onClick={() => {
              if (!props.disabled) props.onClick();
            }}
          />
        }
      >
        {props.children}
      </TooltipTrigger>
      <TooltipPopup>{props.label}</TooltipPopup>
    </Tooltip>
  );
}

/** Root navigation for one Files tab: up, back to the workspace, a path box and "new tab here". */
export function FilesRootBar(props: {
  /** Absolute root the tree shows; the workspace root when the tab is not re-rooted. */
  treeRoot: string;
  workspaceRoot: string;
  outsideWorkspace: boolean;
  /** A typed or absolute folder to resolve on the environment, or null for the workspace root. */
  onChangeRoot: (folder: string | null) => void;
  onOpenTabHere: () => void;
}) {
  const { treeRoot, workspaceRoot, onChangeRoot } = props;
  const inputRef = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState(treeRoot);
  const [editing, setEditing] = useState(false);
  const parent = parentHostFolder(treeRoot);
  const atWorkspaceRoot = filesTabRoot(treeRoot, workspaceRoot) === null;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (draft.trim() !== "") onChangeRoot(draft);
    inputRef.current?.blur();
  };

  return (
    <form
      onSubmit={submit}
      aria-label="Files root"
      className="flex h-8 min-h-8 shrink-0 items-center gap-0.5 border-b border-border/60 bg-background px-2 in-data-[preview-panel-mode=inline]:h-7 in-data-[preview-panel-mode=inline]:min-h-7"
      data-files-root-bar
    >
      <RootBarButton
        label="Up one folder"
        disabled={parent === null}
        onClick={() => {
          if (parent !== null) onChangeRoot(parent);
        }}
      >
        <ArrowUp />
      </RootBarButton>
      <RootBarButton
        label="Back to workspace root"
        disabled={atWorkspaceRoot}
        onClick={() => onChangeRoot(null)}
      >
        <House />
      </RootBarButton>
      <InputGroup variant="ghost" className="h-7 min-w-0 flex-1">
        <InputGroupInput
          ref={inputRef}
          size="sm"
          value={editing ? draft : treeRoot}
          aria-label="Files root folder"
          title={treeRoot}
          spellCheck={false}
          onChange={(event) => setDraft(event.target.value)}
          onFocus={() => {
            setDraft(treeRoot);
            setEditing(true);
            queueMicrotask(() => inputRef.current?.select());
          }}
          onBlur={() => setEditing(false)}
          onKeyDown={(event) => {
            if (event.key !== "Escape") return;
            event.preventDefault();
            setDraft(treeRoot);
            inputRef.current?.blur();
          }}
        />
      </InputGroup>
      {props.outsideWorkspace ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <Badge variant="outline" size="sm" tabIndex={0}>
                Outside workspace
              </Badge>
            }
          />
          <TooltipPopup>
            Files opened from here follow the editing rules for paths outside this workspace.
          </TooltipPopup>
        </Tooltip>
      ) : null}
      <RootBarButton label="New Files tab from here" onClick={props.onOpenTabHere}>
        <FolderSymlink />
      </RootBarButton>
    </form>
  );
}
