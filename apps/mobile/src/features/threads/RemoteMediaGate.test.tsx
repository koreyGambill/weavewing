import { RegistryContext } from "@effect/atom-react";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { ReactNode } from "react";
import { act, useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

const harness = vi.hoisted(async () => {
  const { Atom, AtomRegistry } = await import("effect/reactivity");
  return {
    registry: AtomRegistry.make(),
    configValueAtom: Atom.family((_environmentId: string) =>
      Atom.make<{ settings: { autoLoadRemoteMedia: boolean } } | null>(null),
    ),
  };
});

vi.mock("react-native", () => ({
  Pressable: (props: {
    accessibilityLabel?: string;
    onPress?: () => void;
    children?: ReactNode;
  }) => (
    <button type="button" aria-label={props.accessibilityLabel} onClick={props.onPress}>
      {props.children}
    </button>
  ),
}));
vi.mock("../../components/ui/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("../../components/ui/AppText", () => ({
  AppText: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
}));
vi.mock("../../state/atom-registry", async () => ({
  appAtomRegistry: (await harness).registry,
}));
vi.mock("../../state/server", async () => ({
  serverEnvironment: { configValueAtom: (await harness).configValueAtom },
}));

import { RemoteMediaGate } from "./RemoteMediaGate";
import {
  loadPendingRemoteMedia,
  loadRemoteMedia,
  remoteMediaSite,
  useRemoteMediaImageSource,
} from "./remoteMediaConsent";
import { messageImageGallery } from "./messageImageGallery";
import type { MarkdownImageSourceResolver } from "../../native/SelectableMarkdownText.types";

async function setAutoLoad(environmentId: EnvironmentId, autoLoadRemoteMedia: boolean) {
  const { registry, configValueAtom } = await harness;
  registry.set(configValueAtom(environmentId), { settings: { autoLoadRemoteMedia } });
}

async function renderGates(environmentId: EnvironmentId, uris: ReadonlyArray<string | null>) {
  const { registry } = await harness;
  const container = document.createElement("div");
  const root = createRoot(container);
  await act(async () =>
    root.render(
      <RegistryContext.Provider value={registry}>
        {uris.map((uri) => (
          <RemoteMediaGate key={uri ?? "none"} environmentId={environmentId} uri={uri} kind="image">
            <img alt={uri ?? "none"} />
          </RemoteMediaGate>
        ))}
      </RegistryContext.Provider>,
    ),
  );
  return { container, root };
}

it("shows the host instead of a remote image and loads only the tapped one", async () => {
  const environmentId = EnvironmentId.make("env-gated");
  const { container, root } = await renderGates(environmentId, [
    "https://cdn.example.com/a.png?q=1",
    "//other.example.org/b.png",
  ]);
  const gates = [...container.querySelectorAll("button")];
  expect(gates.map((gate) => gate.getAttribute("aria-label"))).toEqual([
    "Load image from cdn.example.com",
    "Load image from other.example.org",
  ]);
  expect(container.querySelector("img")).toBeNull();

  await act(async () => gates[0]?.click());
  expect([...container.querySelectorAll("img")].map((image) => image.alt)).toEqual([
    "https://cdn.example.com/a.png?q=1",
  ]);
  expect(container.querySelector("button")?.getAttribute("aria-label")).toBe(
    "Load image from other.example.org",
  );
  await act(async () => root.unmount());
});

it("loads remote media directly when its environment allows automatic loading", async () => {
  const environmentId = EnvironmentId.make("env-auto");
  await setAutoLoad(environmentId, true);
  const { container, root } = await renderGates(environmentId, ["https://cdn.example.com/c.png"]);
  expect(container.querySelector("button")).toBeNull();
  expect(container.querySelector("img")).not.toBeNull();
  await act(async () => root.unmount());
});

it("always loads local and server-resolved sources", async () => {
  const environmentId = EnvironmentId.make("env-local");
  await setAutoLoad(environmentId, false);
  const { container, root } = await renderGates(environmentId, [
    "data:image/png;base64,AAAA",
    "docs/shot.png",
    "/tmp/shot.png",
    "file:///tmp/shot.png",
    null,
  ]);
  expect(container.querySelector("button")).toBeNull();
  expect(container.querySelectorAll("img")).toHaveLength(5);
  await act(async () => root.unmount());
});

async function mountResolver(environmentId: EnvironmentId, inner?: MarkdownImageSourceResolver) {
  const { registry } = await harness;
  let resolve: MarkdownImageSourceResolver | undefined;
  function Probe() {
    const resolver = useRemoteMediaImageSource(environmentId, inner);
    useLayoutEffect(() => {
      resolve = resolver;
    });
    return null;
  }
  const root = createRoot(document.createElement("div"));
  await act(async () =>
    root.render(
      <RegistryContext.Provider value={registry}>
        <Probe />
      </RegistryContext.Provider>,
    ),
  );
  const settled: string[] = [];
  return {
    settled,
    request: (href: string) => Promise.resolve(resolve!({ href, alt: null, title: null })),
    hold: (href: string) => {
      void Promise.resolve(resolve!({ href, alt: null, title: null })).then(() =>
        settled.push(href),
      );
    },
    unmount: () => act(async () => root.unmount()),
  };
}

it("holds natively rendered remote images until a tap or the setting allows them", async () => {
  const environmentId = EnvironmentId.make("env-native");
  const asked: string[] = [];
  const resolver = await mountResolver(environmentId, async (image) => {
    asked.push(image.href);
    return { uri: `https://server.test/api/assets/${image.href}` };
  });

  await expect(resolver.request("docs/local.png")).resolves.toEqual({
    uri: "https://server.test/api/assets/docs/local.png",
  });
  resolver.hold("https://cdn.example.com/inline.png");
  resolver.hold("https://cdn.example.com/list.png");
  await act(async () => {});
  expect(asked).toEqual(["docs/local.png"]);

  expect(loadPendingRemoteMedia("https://cdn.example.com/inline.png")).toBe(true);
  await act(async () => {});
  expect(resolver.settled).toEqual(["https://cdn.example.com/inline.png"]);
  expect(loadPendingRemoteMedia("https://cdn.example.com/unrequested.png")).toBe(false);

  await setAutoLoad(environmentId, true);
  await act(async () => {});
  expect(resolver.settled).toEqual([
    "https://cdn.example.com/inline.png",
    "https://cdn.example.com/list.png",
  ]);
  expect(asked).toEqual([
    "docs/local.png",
    "https://cdn.example.com/inline.png",
    "https://cdn.example.com/list.png",
  ]);
  await resolver.unmount();
});

it("keeps another environment's images held when one environment allows automatic loading", async () => {
  const allowing = await mountResolver(EnvironmentId.make("env-allowing"));
  const holding = await mountResolver(EnvironmentId.make("env-holding"));
  allowing.hold("https://cdn.example.com/allowing.png");
  holding.hold("https://cdn.example.com/holding.png");

  await setAutoLoad(EnvironmentId.make("env-allowing"), true);
  await act(async () => {});
  expect(allowing.settled).toEqual(["https://cdn.example.com/allowing.png"]);
  expect(holding.settled).toEqual([]);
  await allowing.unmount();
  await holding.unmount();
});

it("forgets an owner's held images when it unmounts", async () => {
  const resolver = await mountResolver(EnvironmentId.make("env-unmount"));
  resolver.hold("https://cdn.example.com/unmounted.png");
  await act(async () => {});
  await resolver.unmount();
  expect(loadPendingRemoteMedia("https://cdn.example.com/unmounted.png")).toBe(false);
});

it("treats every source that is not plainly local as remote", () => {
  expect(
    [
      "https://cdn.example.com/a.png",
      " <https://cdn.example.com/b.png> ",
      "//cdn.example.com/c.png",
      "https://exa mple.com/d.png",
      "ftp://cdn.example.com/e.png",
    ].map(remoteMediaSite),
  ).toEqual([
    "cdn.example.com",
    "cdn.example.com",
    "cdn.example.com",
    "an unknown site",
    "cdn.example.com",
  ]);
  expect(
    [
      "docs/a.png",
      "/tmp/a.png",
      "C:\\work\\a.png",
      "file:///tmp/a.png",
      "data:image/png;base64,AAAA",
      "blob:abc",
    ].map(remoteMediaSite),
  ).toEqual([null, null, null, null, null, null]);
});

it("leaves held remote images out of a message's preview gallery", () => {
  const environmentId = EnvironmentId.make("env-gallery");
  const gallery = () =>
    messageImageGallery(
      {
        text: "![held](https://cdn.example.com/gallery.png)\n\n![local](data:image/png;base64,AAAA)",
      },
      { environmentId, threadId: ThreadId.make("thread-gallery"), workspaceRoot: "/work" },
    ).map((item) => ("uri" in item ? item.uri : item.kind));
  expect(gallery()).toEqual(["data:image/png;base64,AAAA"]);
  loadRemoteMedia("https://cdn.example.com/gallery.png");
  expect(gallery()).toEqual(["https://cdn.example.com/gallery.png", "data:image/png;base64,AAAA"]);
});
