import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { FileIcon, PlayIcon } from "lucide-react";
import { useState } from "react";

import { useAssetUrlState } from "../../assets/assetUrls";
import { ExpandedImageDialog } from "../chat/ExpandedImageDialog";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { captureKind } from "./evidence.logic";

/** One evidence capture: a thumbnail that opens full size, or a named tile when it cannot load. */
export function CaptureTile({
  environmentId,
  threadId,
  path,
  caption,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  path: string;
  caption: string;
}) {
  const kind = captureKind(path);
  const asset = useAssetUrlState(environmentId, { _tag: "media-file", threadId, path });
  const [broken, setBroken] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const url = asset._tag === "Success" ? asset.url : null;
  const missing = broken || asset._tag === "Failure";
  const name = path.split(/[\\/]/).at(-1) ?? path;
  return (
    <figure className="min-w-0 space-y-0.5">
      <button
        type="button"
        aria-label={`Open capture: ${caption}`}
        disabled={url === null || missing}
        className="relative flex aspect-[16/10] w-full items-center justify-center overflow-hidden rounded-md border border-border bg-muted/40 text-muted-foreground outline-hidden ring-ring focus-visible:ring-2 focus-visible:ring-inset disabled:cursor-default"
        onClick={() => {
          if (url !== null && kind === "file") window.open(url, "_blank", "noopener,noreferrer");
          else setExpanded(true);
        }}
      >
        {missing ? (
          <span className="min-w-0 px-1 text-center text-2xs">
            Missing
            <span className="block truncate">{name}</span>
          </span>
        ) : kind === "image" && url ? (
          <img
            src={url}
            alt=""
            loading="lazy"
            decoding="async"
            className="size-full object-cover object-top"
            onError={() => setBroken(true)}
          />
        ) : kind === "video" ? (
          <PlayIcon aria-hidden className="size-4" />
        ) : kind === "file" ? (
          <FileIcon aria-hidden className="size-4" />
        ) : null}
      </button>
      <Tooltip>
        <TooltipTrigger render={<figcaption className="truncate text-2xs text-muted-foreground" />}>
          {caption}
        </TooltipTrigger>
        <TooltipPopup side="top" className="max-w-72">
          {caption}
        </TooltipPopup>
      </Tooltip>
      {expanded && url ? (
        <ExpandedImageDialog
          preview={{
            images: [{ src: url, name: caption, ...(kind === "video" ? { type: "video" } : {}) }],
            index: 0,
          }}
          onClose={() => setExpanded(false)}
        />
      ) : null}
    </figure>
  );
}
