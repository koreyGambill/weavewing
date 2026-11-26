import {
  NavigationContext,
  type NavigationProp,
  type ParamListBase,
} from "@react-navigation/native";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

vi.mock("@react-navigation/native", async () => {
  const { createRequire } = await import("node:module");
  const { realpathSync } = await import("node:fs");
  const require = createRequire(import.meta.url);
  const nativeRequire = createRequire(
    realpathSync(require.resolve("@react-navigation/native/package.json")),
  );
  // Use the shipped focus hook without importing the React Native view layer.
  const { NavigationContext, useFocusEffect }: typeof import("@react-navigation/native") =
    nativeRequire("@react-navigation/core");
  return { NavigationContext, useFocusEffect };
});
const appState = vi.hoisted(() => ({
  current: "active",
  listeners: new Set<(state: string) => void>(),
}));
vi.mock("react-native", () => ({
  AppState: {
    get currentState() {
      return appState.current;
    },
    addEventListener: (_event: "change", listener: (state: string) => void) => {
      appState.listeners.add(listener);
      return { remove: () => appState.listeners.delete(listener) };
    },
  },
}));

import { useFocusedQuestionsRefresh } from "./useFocusedQuestionsRefresh";

function Probe(props: { readonly refresh: () => void; readonly label: string }) {
  useFocusedQuestionsRefresh(props.refresh);
  return props.label;
}

function setup() {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  appState.current = "active";
  const listeners = { focus: new Set<() => void>(), blur: new Set<() => void>() };
  let focused = true;
  const navigation = {
    isFocused: () => focused,
    addListener: (event: keyof typeof listeners, listener: () => void) => {
      listeners[event].add(listener);
      return () => listeners[event].delete(listener);
    },
  } as unknown as NavigationProp<ParamListBase>;
  const refresh = vi.fn();
  const root = createRoot(document.createElement("div"));
  const render = (label: string) =>
    act(() =>
      root.render(
        <NavigationContext.Provider value={navigation}>
          <Probe refresh={refresh} label={label} />
        </NavigationContext.Provider>,
      ),
    );
  render("first");
  return {
    refresh,
    render,
    focus(next: boolean) {
      focused = next;
      act(() => {
        for (const listener of listeners[next ? "focus" : "blur"]) listener();
      });
    },
    moveApp(state: "active" | "background") {
      appState.current = state;
      act(() => {
        for (const listener of appState.listeners) listener(state);
      });
    },
    [Symbol.dispose]() {
      act(() => root.unmount());
    },
  };
}

it("does not refetch on ordinary rerenders", () => {
  using screen = setup();
  screen.render("second");
  screen.render("third");
  expect(screen.refresh).not.toHaveBeenCalled();
});

it("refetches on refocus and on return to the foreground only while focused", () => {
  using screen = setup();
  screen.focus(false);
  screen.focus(true);
  expect(screen.refresh).toHaveBeenCalledTimes(1);
  screen.moveApp("background");
  screen.moveApp("active");
  expect(screen.refresh).toHaveBeenCalledTimes(2);
  screen.focus(false);
  screen.moveApp("background");
  screen.moveApp("active");
  expect(screen.refresh).toHaveBeenCalledTimes(2);
});
