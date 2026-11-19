import { ChevronsLeftRightEllipsisIcon, TerminalIcon } from "lucide-react";
import { type ReactNode, useState } from "react";

import { cn } from "../../lib/utils";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { AnimatedHeight } from "../AnimatedHeight";
import type { EnvironmentPresentation } from "~/state/environments";
import { type AddComputerMode, AddComputerFields } from "./AddComputerFields";

/**
 * Another way to reach a computer this app already saved, such as its Tailscale name. Adding a
 * new computer happens in the Connect wizard; this only joins a route to an existing entry.
 */
export function AddRouteDialog({
  routeTarget,
  savedEnvironments,
  onClose,
}: {
  /** The saved computer to add a route to; the dialog is open while it is set. */
  readonly routeTarget: EnvironmentPresentation | null;
  readonly savedEnvironments: ReadonlyArray<EnvironmentPresentation>;
  readonly onClose: () => void;
}) {
  const [mode, setMode] = useState<AddComputerMode>("remote");
  const desktopBridge = window.desktopBridge;
  const modeCard = (input: {
    readonly mode: AddComputerMode;
    readonly title: string;
    readonly description: string;
    readonly icon: ReactNode;
  }) => {
    const selected = mode === input.mode;
    return (
      <button
        type="button"
        aria-pressed={selected}
        className={cn(
          "group flex min-h-24 items-start gap-3 rounded-lg border p-4 text-left",
          selected ? "border-primary/50 bg-primary/5" : "border-border/60 hover:bg-muted/40",
        )}
        onClick={() => setMode(input.mode)}
      >
        <span
          className={cn(
            "mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md border",
            selected
              ? "border-primary/30 bg-primary/10 text-primary"
              : "border-border/70 bg-background text-muted-foreground group-hover:text-foreground",
          )}
        >
          {input.icon}
        </span>
        <span className="min-w-0">
          <span className="block text-sm font-medium text-foreground">{input.title}</span>
          <span className="mt-1 block text-xs leading-relaxed text-muted-foreground">
            {input.description}
          </span>
        </span>
      </button>
    );
  };
  return (
    <Dialog
      open={routeTarget !== null}
      onOpenChange={(open) => {
        if (open) return;
        setMode("remote");
        onClose();
      }}
    >
      <DialogPopup className="max-h-[80dvh] sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Add a route to {routeTarget?.label}</DialogTitle>
          <DialogDescription>
            Pair this machine again over another address, such as its Tailscale name. It joins the
            existing routes instead of adding a second machine.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2">
              {modeCard({
                mode: "remote",
                title: "Link or address",
                description: "Its address and a pairing code from it.",
                icon: <ChevronsLeftRightEllipsisIcon aria-hidden className="size-4" />,
              })}
              {desktopBridge
                ? modeCard({
                    mode: "ssh",
                    title: "SSH",
                    description: "Use local SSH config, agent, and tunnels.",
                    icon: <TerminalIcon aria-hidden className="size-4" />,
                  })
                : null}
            </div>
            <AnimatedHeight>
              {routeTarget !== null ? (
                <AddComputerFields
                  key={mode}
                  mode={mode}
                  routeTarget={routeTarget}
                  savedEnvironments={savedEnvironments}
                  onAdded={() => {
                    setMode("remote");
                    onClose();
                  }}
                />
              ) : null}
            </AnimatedHeight>
          </div>
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
