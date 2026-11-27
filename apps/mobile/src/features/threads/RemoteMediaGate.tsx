import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { useState, type ReactNode } from "react";
import { Pressable } from "react-native";

import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import {
  autoLoadRemoteMediaAtom,
  loadRemoteMedia,
  remoteMediaAllowed,
  remoteMediaSite,
} from "./remoteMediaConsent";

/** Remote media waits for a tap unless its environment allows automatic loading. */
export function RemoteMediaGate(props: {
  readonly environmentId: EnvironmentId | null;
  readonly uri: string | null;
  readonly kind: "image" | "video";
  readonly children: ReactNode;
}) {
  const autoLoad = useAtomValue(autoLoadRemoteMediaAtom(props.environmentId));
  const [tappedUri, setTappedUri] = useState<string | null>(null);
  const { uri } = props;
  if (
    uri === null ||
    autoLoad ||
    tappedUri === uri ||
    remoteMediaAllowed(props.environmentId, uri)
  ) {
    return props.children;
  }
  const label = `Load ${props.kind} from ${remoteMediaSite(uri)}`;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      className="flex-row items-center gap-2 self-start rounded-[10px] border border-foreground-muted/50 bg-md-code-bg px-3 py-2 active:opacity-70"
      onPress={() => {
        loadRemoteMedia(uri);
        setTappedUri(uri);
      }}
    >
      <SymbolView
        name={props.kind === "video" ? "play" : "photo"}
        size={14}
        tintColorClassName="accent-foreground"
      />
      <Text numberOfLines={1} className="shrink text-xs text-foreground">
        {label}
      </Text>
    </Pressable>
  );
}
