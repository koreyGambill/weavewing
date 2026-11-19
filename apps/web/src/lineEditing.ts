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
    const deletion = deletionForKey(event, navigator.platform.toLowerCase().includes("mac"));
    if (!deletion || target.selectionStart === null || target.selectionEnd === null) return;
    event.preventDefault();
    const [start, end] = deletionRange(
      target.value,
      target.selectionStart,
      target.selectionEnd,
      deletion,
    );
    target.setRangeText("", start, end, "end");
    target.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
