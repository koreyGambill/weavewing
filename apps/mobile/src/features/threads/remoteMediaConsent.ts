import type { EnvironmentId } from "@t3tools/contracts";
import { normalizeMarkdownLinkDestination } from "@t3tools/shared/markdownLinks";
import { Atom } from "effect/reactivity";
import { createContext, useEffect, useMemo, useState } from "react";

import type { FilePreviewItem } from "../../components/ui/FilePreviewModal.types";
import type { MarkdownImageSourceResolver } from "../../native/SelectableMarkdownText.types";
import { appAtomRegistry } from "../../state/atom-registry";
import { serverEnvironment } from "../../state/server";

/** The environment whose consent setting governs media rendered below it. */
export const RemoteMediaEnvironmentContext = createContext<EnvironmentId | null>(null);

// Consent belongs to the content's environment, and is off until its server says otherwise.
export const autoLoadRemoteMediaAtom = Atom.family((environmentId: EnvironmentId | null) =>
  Atom.make(
    (get) =>
      environmentId !== null &&
      get(serverEnvironment.configValueAtom(environmentId))?.settings.autoLoadRemoteMedia === true,
  ).pipe(Atom.withLabel("mobile:auto-load-remote-media")),
);

/**
 * The site a media source would contact, or null for local sources (relative and absolute
 * paths, file:, data: and blob:). Any other scheme counts as remote, so a source this cannot
 * parse stays held.
 */
export function remoteMediaSite(uri: string): string | null {
  const source = normalizeMarkdownLinkDestination(uri);
  const scheme = /^([a-z][a-z\d+.-]*):/i.exec(source)?.[1]?.toLowerCase();
  const local =
    !source.startsWith("//") &&
    (scheme === undefined ||
      scheme === "file" ||
      scheme === "data" ||
      scheme === "blob" ||
      /^[a-z]:[\\/]/i.test(source));
  if (local) return null;
  try {
    return new URL(source.startsWith("//") ? `https:${source}` : source).host || "an unknown site";
  } catch {
    return "an unknown site";
  }
}

// Feed rows unmount as they scroll; a loaded URL stays loaded for the session.
const loadedRemoteMedia = new Set<string>();

type Waiter = { readonly environmentId: EnvironmentId | null; readonly release: () => void };
const waitingRemoteMedia = new Map<string, Set<Waiter>>();
const watchedEnvironments = new Set<EnvironmentId>();

function releaseWaiters(uri: string, release: (waiter: Waiter) => boolean) {
  const waiters = waitingRemoteMedia.get(uri);
  if (!waiters) return;
  for (const waiter of waiters) {
    if (!release(waiter)) continue;
    waiters.delete(waiter);
    waiter.release();
  }
  if (waiters.size === 0) waitingRemoteMedia.delete(uri);
}

function forgetWaiter(uri: string, waiter: Waiter) {
  const waiters = waitingRemoteMedia.get(uri);
  waiters?.delete(waiter);
  if (waiters?.size === 0) waitingRemoteMedia.delete(uri);
}

export function loadRemoteMedia(uri: string) {
  loadedRemoteMedia.add(uri);
  releaseWaiters(uri, () => true);
}

function watchAutoLoad(environmentId: EnvironmentId | null) {
  if (environmentId === null || watchedEnvironments.has(environmentId)) return;
  watchedEnvironments.add(environmentId);
  appAtomRegistry.subscribe(autoLoadRemoteMediaAtom(environmentId), (autoLoad) => {
    if (!autoLoad) return;
    for (const uri of waitingRemoteMedia.keys()) {
      releaseWaiters(uri, (waiter) => waiter.environmentId === environmentId);
    }
  });
}

/** Whether `uri` may be fetched now: it is local, the user loaded it, or its environment allows it. */
export function remoteMediaAllowed(environmentId: EnvironmentId | null, uri: string): boolean {
  return (
    remoteMediaSite(uri) === null ||
    loadedRemoteMedia.has(uri) ||
    appAtomRegistry.get(autoLoadRemoteMediaAtom(environmentId))
  );
}

/**
 * Drops held remote images from a preview gallery, because the viewer downloads every page
 * when it opens. The tapped image is added back by the gallery itself.
 */
export function allowedRemoteMediaItems<Item extends FilePreviewItem>(
  environmentId: EnvironmentId | null,
  items: readonly Item[],
): Item[] {
  return items.filter((item) => !("uri" in item) || remoteMediaAllowed(environmentId, item.uri));
}

/**
 * Loads a natively rendered remote image the user tapped. Returns false when no image waits on
 * `uri`, so the caller handles the tap as usual.
 */
export function loadPendingRemoteMedia(uri: string): boolean {
  if (!waitingRemoteMedia.has(uri)) return false;
  loadRemoteMedia(uri);
  return true;
}

const loadMarkdownUrl: MarkdownImageSourceResolver = () => null;

/**
 * Holds images the native Markdown renderer loads itself (inline, list, table and link images)
 * until the user allows their site. The renderer keeps its placeholder and requests nothing
 * while the returned promise is pending. Holds end with the component that owns them.
 */
export function useRemoteMediaImageSource(
  environmentId: EnvironmentId | null,
  resolve: MarkdownImageSourceResolver = loadMarkdownUrl,
): MarkdownImageSourceResolver {
  const [held] = useState(
    () => new Map<string, { href: string; waiter: Waiter; consent: Promise<void> }>(),
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- drops this owner's holds from the shared consent registry when it unmounts
  useEffect(
    () => () => {
      for (const { href, waiter } of held.values()) forgetWaiter(href, waiter);
      held.clear();
    },
    [held],
  );
  return useMemo(() => {
    const consent = (href: string): Promise<void> => {
      if (remoteMediaAllowed(environmentId, href)) return Promise.resolve();
      const key = `${environmentId}\n${href}`;
      const existing = held.get(key);
      if (existing) return existing.consent;
      watchAutoLoad(environmentId);
      let waiter: Waiter | undefined;
      const promise = new Promise<void>((release) => {
        waiter = { environmentId, release };
      });
      const waiters = waitingRemoteMedia.get(href) ?? new Set<Waiter>();
      waiters.add(waiter!);
      waitingRemoteMedia.set(href, waiters);
      held.set(key, { href, waiter: waiter!, consent: promise });
      void promise.then(() => held.delete(key));
      return promise;
    };
    return async (image) => {
      await consent(image.href);
      return resolve(image);
    };
  }, [environmentId, resolve, held]);
}
