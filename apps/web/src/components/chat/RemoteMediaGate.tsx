import { remoteMediaHost } from "@t3tools/shared/weavewingOutbound";
import { ImageIcon } from "lucide-react";
import { useState, type ReactNode } from "react";

// Rows remount as the timeline virtualizes; a loaded URL stays loaded for the session.
const loadedRemoteMedia = new Set<string>();

/** Remote media waits for a click, so an agent-written URL cannot send data on render. */
export function RemoteMediaGate(props: {
  readonly uri: string | null;
  readonly kind: "image" | "video" | "audio";
  readonly alt: string;
  readonly copyMarkdown?: string | undefined;
  readonly children: ReactNode;
}) {
  const [, setLoaded] = useState(false);
  const { uri } = props;
  const host = uri === null ? null : remoteMediaHost(uri);
  if (uri === null || host === null || loadedRemoteMedia.has(uri)) return props.children;
  const label = `Load ${props.kind} from ${host}`;
  return (
    <button
      type="button"
      data-markdown-copy={props.copyMarkdown}
      data-thread-find-ignore
      aria-label={label}
      className="inline-flex! max-w-full cursor-pointer items-center gap-1.5 rounded-md border border-border/40 bg-muted/40 px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
      onClick={(event) => {
        // A linked image would otherwise follow its link on the same click.
        event.preventDefault();
        event.stopPropagation();
        loadedRemoteMedia.add(uri);
        setLoaded(true);
      }}
    >
      <ImageIcon aria-hidden className="size-3.5 shrink-0" />
      <span className="min-w-0 truncate">{label}</span>
    </button>
  );
}
