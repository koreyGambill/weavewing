import { RELEASE_REPOSITORY } from "@t3tools/shared/releaseIdentity";

import { cn } from "~/lib/utils";

import { CommandBlock } from "./CommandBlock";

/** Setup steps for another computer: install Weavewing, then run `command`. */
export function InstallT3Commands({
  command,
  className,
}: {
  readonly command: string;
  readonly className?: string;
}) {
  return (
    <div className={cn("space-y-2", className)}>
      <p className="text-xs text-muted-foreground">
        Download the <code className="font-mono">t3</code> archive for your platform from{" "}
        <a
          className="underline underline-offset-2 hover:text-foreground"
          href={`https://github.com/${RELEASE_REPOSITORY}/releases`}
          target="_blank"
          rel="noreferrer noopener"
        >
          Weavewing Releases
        </a>
        .
      </p>
      <p className="text-xs text-muted-foreground">
        Unpack it, keep the folder together, and add it to PATH.
      </p>
      <p className="text-xs text-muted-foreground">Then</p>
      <CommandBlock command={command} />
      <p className="text-xs text-muted-foreground">
        Skip the install if Weavewing’s <code className="font-mono">t3</code> is already on your
        PATH.
      </p>
    </div>
  );
}
