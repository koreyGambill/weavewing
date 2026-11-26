import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vite-plus/test";

vi.mock("react-native", () => ({
  View: (props: { readonly children?: ReactNode }) => <div>{props.children}</div>,
  Keyboard: { dismiss: () => {} },
  BackHandler: { addEventListener: () => ({ remove: () => {} }) },
}));
// React Navigation throws this outside a navigator, as for the Arrange threads sheet.
vi.mock("@react-navigation/native", () => ({
  useIsFocused: () => {
    throw new Error("Couldn't find a navigation object.");
  },
}));
vi.mock("./AndroidScreenHeader.android", () => ({
  AndroidScreenHeader: (props: { readonly title: string }) => <h1>{props.title}</h1>,
}));
const workspaceBar = vi.hoisted(() => ({ present: false }));
vi.mock("./WorkspaceAppBar.android", () => ({
  useHasWorkspaceAppBar: () => workspaceBar.present,
  WorkspaceAppBar: (props: { readonly trailing?: ReactNode }) => <nav>{props.trailing}</nav>,
}));
vi.mock("./Menu", () => ({ Menu: (props: { readonly children?: ReactNode }) => props.children }));
vi.mock("./ScreenHeaderButton.android", () => ({ ScreenHeaderButton: () => null }));
vi.mock("./SearchField", () => ({ SearchField: () => null }));
vi.mock("./Button", () => ({ Button: () => null }));
vi.mock("../../features/layout/adaptive-workspace-context", () => ({
  useAdaptiveWorkspaceLayout: () => ({ layout: { usesSplitView: false } }),
}));
vi.mock("./useToolbarLayout", () => ({
  useToolbarLayout: () => ({ height: 48, paddingTop: 0, paddingBottom: 0 }),
}));
vi.mock("../../native/StackHeader", () => ({ NativeStackScreenOptions: () => null }));
vi.mock("../../features/layout/useSidebarToggle", () => ({ useSidebarToggle: () => null }));
vi.mock("../../features/settings/appearance/AppearancePreferencesProvider", () => ({
  useAppearancePreferences: () => ({ themeVariables: {} }),
}));

import { AppBar } from "./AppBar.android";

const roots: Root[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.innerHTML = "";
  workspaceBar.present = false;
});

it("renders a sheet bar without search outside a navigation container", () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);

  act(() => root.render(<AppBar sheet title="Arrange threads" />));

  expect(container.textContent).toBe("Arrange threads");
});

it("hands its trailing content to the workspace bar it projects into", () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  workspaceBar.present = true;
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);

  act(() =>
    root.render(<AppBar title="Threads" trailing={<button type="button">Inbox</button>} />),
  );

  expect(container.querySelector("nav button")?.textContent).toBe("Inbox");
});
