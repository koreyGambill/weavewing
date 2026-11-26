import { RELEASE_REPOSITORY } from "@t3tools/shared/releaseIdentity";

import { Dialog, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "../ui/dialog";
import { Button } from "../ui/button";

const sections = [
  [
    "Tool tips",
    [
      "Arrange work in tiles and tabs. Cmd/Ctrl+T opens a new tab with the default bindings. Leader shortcuts run in sequence: press the leader, release it, then press the next key.",
      "Use the command palette to find actions and the shortcut reference to see your configured keys. Settings → Keybindings holds your shortcut configuration.",
      "Keep a thread for the main task and use side chats for tangents. Cite adds an exact reference; Drill in opens a focused discussion about a selection.",
    ],
  ],
  [
    "AI habits",
    [
      "Give the agent a clear outcome, constraints, and a way to check its work. Ask for exact file or source citations when a claim matters.",
      "Use drill-ins for tangents, then bring useful results back. Review diffs and checkpoints before accepting changes.",
      "Choose a model for the task. Larger models and longer conversations can cost more; a smaller model can handle routine work.",
    ],
  ],
  [
    "Context management",
    [
      "A thread is your durable conversation; a provider session is the history the model receives. Each model has a context window. Watch the context meter and compact when the conversation needs more room.",
      "Prompt caches can discount repeated input. Discounts and cache lifetimes vary by provider and model; copying a native session does not guarantee a cache hit.",
      "Native conversation history copies the provider's session. A portable transcript flattens the conversation into text and starts without the original session's cache. Automatic can fall back to a transcript; Require native conversation history refuses that fallback.",
      "Codex and Claude side chats can fork native history, including from a running parent. Fork from a completed reply to choose a boundary. Bring back returns a side chat's result; Get newest context refreshes it from its parent.",
      "Rewind keeps your files and drafts and archives later turns as an Earlier conversation side chat. Use it to restart from an earlier point without losing the later discussion. Native preservation depends on the provider and history involved.",
      "Use /clear for a fresh provider session in the same thread. Hand off summary starts a new thread with a condensed account: use it for a new phase or a smaller working context. A summary leaves details behind, so review it before continuing.",
    ],
  ],
] as const;

const guides = ["composer", "portable-handoffs", "thread-sidebar", "keybindings", "faq"] as const;

export default function QuickHelp({
  onClose,
  onShortcuts,
}: {
  onClose: () => void;
  onShortcuts: () => void;
}) {
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Quick help</DialogTitle>
        </DialogHeader>
        <DialogPanel>
          <div className="space-y-4">
            <Button variant="outline" onClick={onShortcuts}>
              Shortcut reference
            </Button>
            {sections.map(([title, paragraphs]) => (
              <details key={title}>
                <summary className="cursor-pointer font-medium">{title}</summary>
                <div className="space-y-3 pt-3 text-sm text-muted-foreground">
                  {paragraphs.map((paragraph) => (
                    <p key={paragraph}>{paragraph}</p>
                  ))}
                </div>
              </details>
            ))}
            <details>
              <summary className="cursor-pointer font-medium">Learn more</summary>
              <ul className="space-y-2 pt-3 text-sm">
                {guides.map((guide) => (
                  <li key={guide}>
                    <a
                      className="underline"
                      href={`https://github.com/${RELEASE_REPOSITORY}/blob/main/docs/user/${guide}.md`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {guide.replaceAll("-", " ")}
                    </a>
                  </li>
                ))}
              </ul>
            </details>
          </div>
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
