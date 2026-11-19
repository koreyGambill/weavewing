import { Extension } from "@tiptap/core";
import { Plugin } from "@tiptap/pm/state";
import { deletionForKey, deletionRange } from "../lineEditing";

export const LineEditingExtension = Extension.create({
  name: "lineEditing",
  priority: 1100,
  addProseMirrorPlugins() {
    return [
      new Plugin({
        props: {
          handleKeyDown(view, event) {
            const deletion = deletionForKey(
              event,
              navigator.platform.toLowerCase().includes("mac"),
            );
            if (!deletion) return false;
            const { selection } = view.state;
            if (!selection.empty) {
              view.dispatch(view.state.tr.deleteSelection().scrollIntoView());
              return true;
            }
            const { $from } = selection;
            const text = $from.parent.textBetween(0, $from.parent.content.size, "\n", "\ufffc");
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
