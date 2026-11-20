import type { Editor } from "@pierre/diffs/edit";
import type { CodeViewHandle } from "@pierre/diffs/react";
import { XIcon } from "lucide-react";
import { useState, type RefObject } from "react";

import { StyledDiffCodeView } from "../diffs/StyledDiffCodeView";
import { resolveDiffThemeName } from "../../lib/diffRendering";
import { PREFERRED_HIGHLIGHTER } from "../../lib/syntaxHighlighting";
import { isMacPlatform } from "../../lib/utils";
import { FileSurfaceAction } from "./fileSurfaceChrome";

/** The standalone editor exposes its search actions as keyboard commands. */
export function openEditorFind(
  editor: Pick<Editor<"file">, "focus">,
  mode: "find" | "replace",
): void {
  editor.focus({ preventScroll: true });
  const target = document.activeElement?.shadowRoot?.activeElement;
  if (!target) return;
  const mac = isMacPlatform(navigator.platform);
  // Keep the forwarded command inside the editor's shadow root.
  target.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "f",
      code: "KeyF",
      metaKey: mac,
      ctrlKey: !mac,
      altKey: mode === "replace",
      bubbles: true,
      cancelable: true,
    }),
  );
}

export function SearchableSource(props: {
  readonly name: string;
  readonly text: string;
  readonly theme: "light" | "dark";
  readonly wordWrap: boolean;
  readonly searchRef: RefObject<{ openSearch(options: { mode: "find" }): void } | null>;
  readonly onClose: () => void;
}) {
  const [attach] = useState(() => (view: CodeViewHandle<undefined, undefined> | null) => {
    props.searchRef.current = view;
    view?.openSearch({ mode: "find", scope: "all" });
  });
  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between border-b ps-2 text-xs text-muted-foreground">
        Find in source
        <FileSurfaceAction label="Close file find" onPress={props.onClose}>
          <XIcon className="size-3.5" />
        </FileSurfaceAction>
      </div>
      <StyledDiffCodeView
        viewerRef={attach}
        items={[{ id: props.name, type: "file", file: { name: props.name, contents: props.text } }]}
        className="min-h-0 flex-1 overflow-auto"
        options={{
          disableFileHeader: true,
          theme: resolveDiffThemeName(props.theme),
          themeType: props.theme,
          preferredHighlighter: PREFERRED_HIGHLIGHTER,
          overflow: props.wordWrap ? "wrap" : "scroll",
        }}
      />
    </div>
  );
}
