import { Extension } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, TextSelection } from "@tiptap/pm/state";
import { deletionForKey, deletionRange, lineBoundary, lineMoveForKey } from "../lineEditing";

// One character per leaf keeps text offsets equal to positions; a hard break ends a line.
const lineLeafText = (node: ProseMirrorNode) => (node.type.name === "hardBreak" ? "\n" : "\ufffc");

export const LineEditingExtension = Extension.create({
  name: "lineEditing",
  priority: 1100,
  addProseMirrorPlugins() {
    return [
      new Plugin({
        props: {
          handleKeyDown(view, event) {
            const mac = navigator.platform.toLowerCase().includes("mac");
            const move = lineMoveForKey(event, mac);
            if (move) {
              const { selection, doc } = view.state;
              const $head = selection.$head;
              const text = $head.parent.textBetween(
                0,
                $head.parent.content.size,
                "\n",
                lineLeafText,
              );
              const next = $head.start() + lineBoundary(text, $head.parentOffset, move);
              view.dispatch(
                view.state.tr
                  .setSelection(
                    TextSelection.create(doc, event.shiftKey ? selection.anchor : next, next),
                  )
                  .scrollIntoView(),
              );
              return true;
            }
            const deletion = deletionForKey(event, mac);
            if (!deletion) return false;
            const { selection } = view.state;
            if (!selection.empty) {
              view.dispatch(view.state.tr.deleteSelection().scrollIntoView());
              return true;
            }
            const { $from } = selection;
            const text = $from.parent.textBetween(0, $from.parent.content.size, "\n", lineLeafText);
            const [start, end] = deletionRange(
              text,
              $from.parentOffset,
              $from.parentOffset,
              deletion,
            );
            view.dispatch(
              view.state.tr.delete($from.start() + start, $from.start() + end).scrollIntoView(),
            );
            return true;
          },
        },
      }),
    ];
  },
});
