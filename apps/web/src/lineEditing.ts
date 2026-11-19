export type Deletion = "lineStart" | "lineEnd" | "wordBack" | "wordForward";

export function deletionForKey(
  event: Pick<KeyboardEvent, "key" | "ctrlKey" | "altKey" | "metaKey" | "shiftKey" | "isComposing">,
  mac: boolean,
): Deletion | null {
  if (event.isComposing || event.shiftKey || !["Backspace", "Delete"].includes(event.key))
    return null;
  if (mac)
    return event.metaKey && !event.ctrlKey && !event.altKey && event.key === "Backspace"
      ? "lineStart"
      : null;
  if (event.metaKey || event.ctrlKey === event.altKey) return null;
  return event.ctrlKey
    ? event.key === "Backspace"
      ? "lineStart"
      : "lineEnd"
    : event.key === "Backspace"
      ? "wordBack"
      : "wordForward";
}

export function deletionRange(
  text: string,
  start: number,
  end: number,
  deletion: Deletion,
): [number, number] {
  if (start !== end) return [start, end];
  if (deletion === "lineStart")
    return [start === 0 ? 0 : text.lastIndexOf("\n", start - 1) + 1, end];
  if (deletion === "lineEnd") {
    const newline = text.indexOf("\n", end);
    return [start, newline < 0 ? text.length : newline];
  }
  if (deletion === "wordBack")
    return [start - (text.slice(0, start).match(/\S+\s*$/u)?.[0].length ?? 0), end];
  return [start, end + (text.slice(end).match(/^\s*\S+/u)?.[0].length ?? 0)];
}

/** Ctrl+Left/Right move to the line's start or end outside macOS, where Cmd+arrows already do. */
export function lineMoveForKey(
  event: Pick<KeyboardEvent, "key" | "ctrlKey" | "altKey" | "metaKey" | "isComposing">,
  mac: boolean,
): "lineStart" | "lineEnd" | null {
  if (mac || event.isComposing || !event.ctrlKey || event.altKey || event.metaKey) return null;
  return event.key === "ArrowLeft" ? "lineStart" : event.key === "ArrowRight" ? "lineEnd" : null;
}

export function lineBoundary(text: string, position: number, move: "lineStart" | "lineEnd") {
  if (move === "lineStart") return position === 0 ? 0 : text.lastIndexOf("\n", position - 1) + 1;
  const newline = text.indexOf("\n", position);
  return newline < 0 ? text.length : newline;
}

export function installInputLineEditing() {
  document.addEventListener("keydown", (event) => {
    const target = event.target;
    if (
      !(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) ||
      target.readOnly ||
      target.disabled ||
      target.closest("[data-keybinding-capture], [data-terminal-owner]")
    )
      return;
    if (target.selectionStart === null || target.selectionEnd === null) return;
    const mac = navigator.platform.toLowerCase().includes("mac");
    const move = lineMoveForKey(event, mac);
    if (move) {
      event.preventDefault();
      const backward = target.selectionDirection === "backward";
      const head = backward ? target.selectionStart : target.selectionEnd;
      const anchor = backward ? target.selectionEnd : target.selectionStart;
      const next = lineBoundary(target.value, head, move);
      if (!event.shiftKey) target.setSelectionRange(next, next);
      else if (next < anchor) target.setSelectionRange(next, anchor, "backward");
      else target.setSelectionRange(anchor, next, "forward");
      return;
    }
    const deletion = deletionForKey(event, mac);
    if (!deletion) return;
    event.preventDefault();
    const [start, end] = deletionRange(
      target.value,
      target.selectionStart,
      target.selectionEnd,
      deletion,
    );
    if (start === end) return;
    // execCommand keeps the deletion on the field's native undo stack; setRangeText does not.
    target.setSelectionRange(start, end);
    if (document.execCommand("delete")) return;
    target.setRangeText("", start, end, "end");
    target.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
