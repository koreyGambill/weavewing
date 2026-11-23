import {
  ASSISTANT_CITATION_MAX_TEXT_LENGTH,
  MessageId,
  type AssistantCitation,
  type ScopedThreadRef,
  type SideChatAnchor,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { BookmarkIcon, GitBranchIcon, ListTodoIcon, QuoteIcon } from "lucide-react";
import { use, useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  captureAssistantTextSelection,
  readAssistantSourceText,
  type AssistantCitationSourceAnchor,
} from "~/lib/assistantTextSelection";
import {
  isSelectionRectVisible,
  observeSelectionActions,
  resolveSelectionMenuPlacement,
} from "~/lib/selectionActions";
import { messageFollowUpsUpdate, useMessageFollowUpUpdate } from "../../state/messageFollowUps";
import { findOverlappingBookmark, bookmarkUpdate } from "../reviews/bookmarks.logic";
import { useMessageBookmarksSupported, useThreadFollowUpList } from "../reviews/FollowUps";
import { Button } from "../ui/button";
import { setSelectionBookmarkToggle } from "./threadBookmarkActions";
import { BackgroundThreadContext } from "./backgroundThread";

export function AssistantSelectionToolbar({
  viewport,
  inFlow,
  threadRef,
  onCite,
  onBranch,
}: {
  viewport: HTMLElement | null;
  inFlow?: boolean;
  threadRef: ScopedThreadRef;
  onCite: (citation: AssistantCitation, sourceAnchor: AssistantCitationSourceAnchor) => boolean;
  onBranch?: ((anchor: SideChatAnchor) => Promise<boolean>) | undefined;
}) {
  const [selection, setSelection] = useState<{
    citation: AssistantCitation;
    layout: Omit<
      Parameters<typeof resolveSelectionMenuPlacement>[0],
      "viewport" | "columnSize" | "rowSize"
    >;
    sourceAnchor: AssistantCitationSourceAnchor;
  } | null>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const bookmarksSupported = useMessageBookmarksSupported(threadRef.environmentId);
  const canBookmark =
    useAtomValue(messageFollowUpsUpdate.permissionAtom(threadRef.environmentId)) &&
    bookmarksSupported;
  const bookmarks = useThreadFollowUpList(bookmarksSupported ? threadRef : null);
  const updateBookmark = useMessageFollowUpUpdate();
  const actionsRef = useRef<ReturnType<typeof observeSelectionActions> | null>(null);
  const backgroundThread = use(BackgroundThreadContext);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- measures the menu in both orientations and places it before paint
  useLayoutEffect(() => {
    const toolbar = toolbarRef.current;
    if (!toolbar || !selection) return;
    const measure = (orientation: "column" | "row") => {
      toolbar.dataset.orientation = orientation;
      const { width, height } = toolbar.getBoundingClientRect();
      return { width, height };
    };
    const placement = resolveSelectionMenuPlacement({
      ...selection.layout,
      viewport: { width: window.innerWidth, height: window.innerHeight },
      columnSize: measure("column"),
      rowSize: measure("row"),
    });
    toolbar.dataset.orientation = placement.orientation;
    toolbar.style.left = `${placement.x}px`;
    toolbar.style.top = `${placement.y}px`;
  }, [selection]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes to document selectionchange and keydown to track text selections in the viewport
  useEffect(() => {
    if (!viewport) return;
    const scrollAncestor = inFlow
      ? viewport.closest<HTMLElement>(".messages-timeline-scroll")
      : null;
    const clear = () => setSelection(null);
    const update = () => {
      const nativeSelection = window.getSelection();
      const captured = captureAssistantTextSelection(viewport, nativeSelection);
      const messageId =
        captured?.source.dataset.assistantCitationSource ?? captured?.source.dataset.bookmarkSource;
      if (
        !captured ||
        !messageId ||
        captured.source.closest("[data-assistant-citation-viewport]") !== viewport
      ) {
        clear();
        return;
      }
      const rect = captured.range.getBoundingClientRect();
      const viewportRect = (scrollAncestor ?? viewport).getBoundingClientRect();
      if (!isSelectionRectVisible(rect, [viewportRect])) {
        clear();
        return;
      }
      // A selection can cross blocks with different clipping ancestors.
      const common = captured.range.commonAncestorContainer;
      const walker = document.createTreeWalker(common, NodeFilter.SHOW_TEXT);
      let node = common.nodeType === Node.TEXT_NODE ? common : walker.nextNode();
      let visible = false;
      for (; node && !visible; node = walker.nextNode()) {
        if (!captured.range.intersectsNode(node)) continue;
        if (node.parentElement && getComputedStyle(node.parentElement).userSelect === "none")
          continue;
        const fragment = document.createRange();
        fragment.selectNodeContents(node);
        if (node === captured.range.startContainer) {
          fragment.setStart(node, captured.range.startOffset);
        }
        if (node === captured.range.endContainer) {
          fragment.setEnd(node, captured.range.endOffset);
        }
        if (!fragment.toString().trim()) continue;
        const lines = Array.from(fragment.getClientRects());
        if (!lines.some((line) => isSelectionRectVisible(line, [viewportRect]))) continue;
        const clips: Pick<DOMRect, "left" | "right" | "top" | "bottom">[] = [viewportRect];
        for (
          let element = node.parentElement;
          element && element !== viewport;
          element = element.parentElement
        ) {
          const style = getComputedStyle(element);
          const clipX = style.overflowX !== "visible";
          const clipY = style.overflowY !== "visible";
          if (!clipX && !clipY) continue;
          const bounds = element.getBoundingClientRect();
          const left = bounds.left + element.clientLeft;
          const top = bounds.top + element.clientTop;
          clips.push({
            left: clipX ? left : -Infinity,
            right: clipX ? left + element.clientWidth : Infinity,
            top: clipY ? top : -Infinity,
            bottom: clipY ? top + element.clientHeight : Infinity,
          });
        }
        visible = lines.some((line) => isSelectionRectVisible(line, clips));
      }
      if (!visible) {
        clear();
        return;
      }
      const rects = Array.from(captured.range.getClientRects()).filter(
        (line) => line.width > 0 && line.height > 0,
      );
      setSelection({
        sourceAnchor: { source: captured.source, range: captured.range, viewport },
        citation: {
          version: 1,
          ...threadRef,
          messageId: MessageId.make(messageId),
          ...captured.selector,
        },
        layout: {
          firstLine: rects[0] ?? rect,
          lastLine: rects.at(-1) ?? rect,
          textColumn: captured.source.getBoundingClientRect(),
          bounds: viewportRect,
        },
      });
    };
    const actions = observeSelectionActions({
      element: viewport,
      scrollAncestor,
      getActionElement: () => toolbarRef.current,
      restoreAfterScroll: true,
      onSelection: update,
      onDismiss: clear,
    });
    actionsRef.current = actions;
    const focusActions = (event: KeyboardEvent) => {
      const toolbar = toolbarRef.current;
      if (
        event.key !== "Tab" ||
        event.shiftKey ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.isComposing ||
        event.defaultPrevented ||
        !toolbar ||
        toolbar.contains(event.target as Node)
      ) {
        return;
      }
      const firstAction = toolbar.querySelector<HTMLButtonElement>("button:not(:disabled)");
      if (!firstAction) return;
      event.preventDefault();
      event.stopPropagation();
      firstAction.focus({ preventScroll: true });
    };
    // Tab belongs to the foreground chat; a background timeline only follows its selection.
    if (!backgroundThread || onBranch) document.addEventListener("keydown", focusActions, true);
    document.addEventListener("selectionchange", actions.selectionChanged);
    return () => {
      document.removeEventListener("keydown", focusActions, true);
      document.removeEventListener("selectionchange", actions.selectionChanged);
      actions.dispose();
      actionsRef.current = null;
    };
  }, [backgroundThread, inFlow, onBranch, threadRef, viewport]);

  const bookmarkSource =
    selection !== null && canBookmark && selection.sourceAnchor.source.dataset.bookmarkSource
      ? selection
      : null;
  const existingBookmark =
    bookmarkSource &&
    findOverlappingBookmark(
      bookmarks,
      bookmarkSource.citation,
      readAssistantSourceText(bookmarkSource.sourceAnchor.source),
    );
  const applyBookmark = (todo: boolean) => {
    if (!bookmarkSource) return;
    const { messageId, text, start, end, prefix, suffix } = bookmarkSource.citation;
    if (!existingBookmark && text.length > ASSISTANT_CITATION_MAX_TEXT_LENGTH) return;
    void updateBookmark(
      threadRef.environmentId,
      existingBookmark
        ? bookmarkUpdate(existingBookmark, "unflag")
        : {
            threadId: threadRef.threadId,
            messageId,
            action: "flag",
            todo,
            anchor: { messageId, text, start, end, prefix, suffix },
          },
    );
    window.getSelection()?.removeAllRanges();
    actionsRef.current?.cancel();
    setSelection(null);
  };
  const applyBookmarkFromShortcut = useEffectEvent(() => applyBookmark(false));
  const shortcutAvailable = bookmarkSource !== null;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- offers this selection's bookmark toggle to the keyboard shortcut while the toolbar shows
  useEffect(
    () =>
      shortcutAvailable ? setSelectionBookmarkToggle(() => applyBookmarkFromShortcut()) : undefined,
    [shortcutAvailable],
  );

  if (!selection) return null;
  const citable = selection.sourceAnchor.source.dataset.assistantCitationSource !== undefined;
  const tooLong = selection.citation.text.length > ASSISTANT_CITATION_MAX_TEXT_LENGTH;
  const dismiss = () => {
    actionsRef.current?.cancel();
    setSelection(null);
  };
  const cite = () => {
    if (tooLong || !onCite(selection.citation, selection.sourceAnchor)) return false;
    window.getSelection()?.removeAllRanges();
    dismiss();
    return true;
  };
  if (!citable && !bookmarkSource) return null;
  const branch =
    !tooLong && onBranch && selection.sourceAnchor.source.hasAttribute("data-side-chat-source")
      ? onBranch
      : null;
  return createPortal(
    <div
      ref={toolbarRef}
      role="group"
      aria-label="Selected text actions"
      data-orientation="column"
      className="group fixed z-50 flex max-w-[calc(100vw-1rem)] gap-0.5 rounded-lg border border-primary/45 bg-popover bg-linear-to-b from-primary/15 to-primary/15 p-0.5 shadow-lg data-[orientation=column]:flex-col data-[orientation=row]:flex-row"
      onPointerDown={(event) => event.preventDefault()}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Escape" && !event.nativeEvent.isComposing) {
          event.preventDefault();
          dismiss();
        }
      }}
    >
      {citable ? (
        <Button
          type="button"
          size="xs"
          variant="ghost"
          disabled={tooLong}
          aria-label={tooLong ? "Selection is too long to cite" : "Cite selection in composer"}
          onClick={cite}
        >
          <QuoteIcon aria-hidden="true" className="size-3.5 text-primary" />
          {tooLong ? "Shorten selection" : "Cite"}
        </Button>
      ) : null}
      {bookmarkSource ? (
        <>
          {citable ? <ToolbarDivider /> : null}
          {existingBookmark ? (
            <Button
              type="button"
              size="xs"
              variant="ghost"
              aria-pressed
              onClick={() => applyBookmark(false)}
            >
              <BookmarkIcon aria-hidden="true" className="size-3.5 fill-current text-warning" />
              Remove bookmark
            </Button>
          ) : (
            <>
              <Button
                type="button"
                size="xs"
                variant="ghost"
                disabled={tooLong}
                onClick={() => applyBookmark(false)}
              >
                <BookmarkIcon aria-hidden="true" className="size-3.5 text-warning" />
                Bookmark
              </Button>
              <Button
                type="button"
                size="xs"
                variant="ghost"
                disabled={tooLong}
                onClick={() => applyBookmark(true)}
              >
                <ListTodoIcon aria-hidden="true" className="size-3.5 text-warning" />
                Bookmark as to-do
              </Button>
            </>
          )}
        </>
      ) : null}
      {branch ? (
        <>
          <ToolbarDivider />
          <Button
            type="button"
            size="xs"
            variant="ghost"
            onClick={() => {
              const { messageId, text, start, end, prefix, suffix } = selection.citation;
              const selected = window.getSelection();
              const activeRange = selected?.rangeCount ? selected.getRangeAt(0) : undefined;
              void branch({ messageId, text, start, end, prefix, suffix }).then((opened) => {
                const current = window.getSelection();
                if (!opened || !current?.rangeCount || current.getRangeAt(0) !== activeRange)
                  return;
                current.removeAllRanges();
                dismiss();
              });
            }}
          >
            <GitBranchIcon aria-hidden="true" className="size-3.5 text-primary" />
            Drill in
          </Button>
        </>
      ) : null}
    </div>,
    document.body,
  );
}

function ToolbarDivider() {
  return (
    <div
      aria-hidden="true"
      className="bg-primary/35 group-data-[orientation=column]:mx-1 group-data-[orientation=column]:h-px group-data-[orientation=row]:my-1 group-data-[orientation=row]:w-px"
    />
  );
}
