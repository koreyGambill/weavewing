import { remoteMediaHost } from "@t3tools/shared/weavewingOutbound";
import { useState, type ReactNode } from "react";
import { Pressable } from "react-native";

import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";

// Feed rows unmount as they scroll; a loaded URL stays loaded for the session.
const loadedRemoteMedia = new Set<string>();

/** Remote media waits for a tap, so a URL in a message cannot send data on render. */
export function RemoteMediaGate(props: {
  readonly uri: string | null;
  readonly kind?: "image" | "video";
  readonly children: ReactNode;
}) {
  const [, setLoaded] = useState(false);
  const { uri } = props;
  const host = uri === null ? null : remoteMediaHost(uri);
  if (uri === null || host === null || loadedRemoteMedia.has(uri)) return props.children;
  const label = `Load ${props.kind ?? "image"} from ${host}`;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      className="flex-row items-center gap-2 self-start rounded-[10px] bg-md-code-bg px-3 py-2"
      onPress={() => {
        loadedRemoteMedia.add(uri);
        setLoaded(true);
      }}
    >
      <SymbolView name="photo" size={14} tintColorClassName="accent-foreground-muted" />
      <Text numberOfLines={1} className="shrink text-xs text-foreground-muted">
        {label}
      </Text>
    </Pressable>
  );
}
