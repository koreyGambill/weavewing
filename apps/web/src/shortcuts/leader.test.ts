import { expect, it, vi } from "vite-plus/test";
import {
  compileResolvedKeybindingsConfig,
  DEFAULT_RESOLVED_KEYBINDINGS,
} from "@t3tools/shared/keybindings";
import { createLeaderHandler } from "./leader";

const event = (key: string, ctrlKey = false, repeat = false) => ({
  key,
  ctrlKey,
  repeat,
  altKey: false,
  metaKey: false,
  shiftKey: false,
});

it.each(["Linux", "Win32", "MacIntel"])(
  "handles timeout, cancellation and double-tap passthrough on %s",
  (platform) => {
    vi.useFakeTimers();
    using stack = new DisposableStack();
    stack.defer(() => vi.useRealTimers());
    let keybindings = DEFAULT_RESOLVED_KEYBINDINGS;
    const changed = vi.fn();
    const handler = createLeaderHandler({
      keybindings: () => keybindings,
      platform: () => platform,
      changed,
    });
    stack.defer(handler.cancel);
    expect(handler.handle(event("a", true))).toBe("prefix");
    expect(changed).toHaveBeenLastCalledWith(true);
    expect(handler.handle(event("a", true, true))).toBe("prefix");
    expect(handler.handle(event("a", true))).toBe("passthrough");
    expect(changed).toHaveBeenLastCalledWith(false);
    expect(handler.handle(event("a", true))).toBe("prefix");
    vi.advanceTimersByTime(100);
    expect(handler.handle(event("Shift"))).toBeNull();
    expect(handler.handle({ ...event("%"), shiftKey: true })).toBe("sequence");
    expect(handler.handle(event("a", true))).toBe("prefix");
    expect(handler.handle(event("Escape"))).toBe("cancel");
    expect(handler.handle(event("h"))).toBeNull();
    expect(handler.handle(event("a", true))).toBe("prefix");
    vi.advanceTimersByTime(199);
    expect(changed).toHaveBeenLastCalledWith(true);
    vi.advanceTimersByTime(1);
    expect(changed).toHaveBeenLastCalledWith(false);
    expect(handler.handle(event("h"))).toBeNull();
    keybindings = compileResolvedKeybindingsConfig([
      { key: "ctrl+a", command: "keybindings.leader", when: "false" },
    ]);
    expect(handler.handle(event("a", true))).toBeNull();
    keybindings = compileResolvedKeybindingsConfig([
      { key: "ctrl+b", command: "keybindings.leader" },
    ]);
    expect(handler.handle(event("a", true))).toBeNull();
    expect(handler.handle(event("b", true))).toBe("prefix");
    handler.cancel();
    expect(handler.handle(event("h"))).toBeNull();
  },
);

it("abandons a pending prefix when the configured Leader is disabled or rebound", () => {
  vi.useFakeTimers();
  using stack = new DisposableStack();
  stack.defer(() => vi.useRealTimers());
  let keybindings = DEFAULT_RESOLVED_KEYBINDINGS;
  const write = vi.fn();
  const handler = createLeaderHandler({
    keybindings: () => keybindings,
    platform: () => "Linux",
    changed: vi.fn(),
    prepareDefaultTimeout: () => write,
  });
  stack.defer(handler.cancel);

  expect(handler.handle(event("a", true))).toBe("prefix");
  keybindings = compileResolvedKeybindingsConfig([
    { key: "ctrl+a", command: "keybindings.leader", when: "false" },
  ]);
  vi.advanceTimersByTime(200);
  expect(write).not.toHaveBeenCalled();

  keybindings = DEFAULT_RESOLVED_KEYBINDINGS;
  expect(handler.handle(event("a", true))).toBe("prefix");
  keybindings = compileResolvedKeybindingsConfig([
    { key: "ctrl+b", command: "keybindings.leader" },
  ]);
  expect(handler.handle(event("b", true))).toBe("prefix");
  expect(handler.handle(event("h"))).toBe("sequence");
  vi.advanceTimersByTime(200);
  expect(write).not.toHaveBeenCalled();
});
