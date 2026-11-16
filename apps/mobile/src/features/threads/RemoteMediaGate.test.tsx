import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

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

import { RemoteMediaGate } from "./RemoteMediaGate";

it("loads a remote image only after a tap, and leaves local sources alone", async () => {
  const container = document.createElement("div");
  const root = createRoot(container);
  const view = (uri: string | null) => (
    <RemoteMediaGate uri={uri}>
      <img alt="shown" />
    </RemoteMediaGate>
  );

  await act(async () => root.render(view("https://cdn.example.com/a.png?phi=1")));
  const gate = container.querySelector("button");
  expect(gate?.getAttribute("aria-label")).toBe("Load image from cdn.example.com");
  expect(container.querySelector("img")).toBeNull();

  await act(async () => gate?.click());
  expect(container.querySelector("img")).not.toBeNull();

  for (const local of ["data:image/png;base64,AAAA", null]) {
    await act(async () => root.render(view(local)));
    expect(container.querySelector("button")).toBeNull();
    expect(container.querySelector("img")).not.toBeNull();
  }
  await act(async () => root.render(view("//other.example.org/b.png")));
  expect(container.querySelector("button")?.getAttribute("aria-label")).toBe(
    "Load image from other.example.org",
  );
  await act(async () => root.unmount());
});
