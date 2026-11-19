import { createLeaderHandler } from "./shortcuts/leader";
import { assert, describe, it } from "vite-plus/test";
import {
  compileResolvedKeybindingsConfig,
  DEFAULT_RESOLVED_KEYBINDINGS,
  mergeWithDefaultKeybindings,
  defaultKeybindingsForMode,
} from "@t3tools/shared/keybindings";

import {
  STATIC_KEYBINDING_COMMANDS,
  type KeybindingCommand,
  type KeybindingShortcut,
  type KeybindingWhenNode,
  type ResolvedKeybindingsConfig,
} from "@t3tools/contracts";
import {
  effectiveShortcutsForCommand,
  formatShortcutLabel,
  isRichTextBoldShortcut,
  resolveChatShortcutCommand,
  resolveShortcutCommand,
  shouldShowThreadJumpHintsForModifiers,
  shortcutLabelForCommand,
  terminalNavigationShortcutData,
  type ShortcutEventLike,
} from "./keybindings";

function event(overrides: Partial<ShortcutEventLike> = {}): ShortcutEventLike {
  return {
    key: "j",
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    ...overrides,
  };
}

describe("terminal word navigation", () => {
  it.each([
    ["Backspace", "ctrlKey", "Win32", "\x15"],
    ["Backspace", "altKey", "Linux", "\x1b\x7f"],
    ["Delete", "ctrlKey", "Linux", "\x0b"],
    ["Delete", "altKey", "Win32", "\x1bd"],
    ["Backspace", "metaKey", "MacIntel", "\x15"],
    ["Backspace", "altKey", "MacIntel", null],
  ])("translates %s with %s on %s", (key, modifier, platform, expected) => {
    assert.equal(
      terminalNavigationShortcutData(event({ key: key!, [modifier!]: true }), platform!),
      expected,
    );
  });
  it.each(["Win32", "Linux x86_64"])(
    "leaves Ctrl+Arrow to the terminal encoder on %s",
    (platform) => {
      for (const key of ["ArrowLeft", "ArrowRight"]) {
        assert.equal(terminalNavigationShortcutData(event({ key, ctrlKey: true }), platform), null);
      }
    },
  );

  it.each(["Win32", "Linux x86_64", "MacIntel"])(
    "preserves Alt+Arrow word navigation on %s",
    (platform) => {
      assert.equal(
        terminalNavigationShortcutData(event({ key: "ArrowLeft", altKey: true }), platform),
        "\u001bb",
      );
      assert.equal(
        terminalNavigationShortcutData(event({ key: "ArrowRight", altKey: true }), platform),
        "\u001bf",
      );
    },
  );
});

function modShortcut(
  key: string,
  overrides: Partial<Omit<KeybindingShortcut, "key">> = {},
): KeybindingShortcut {
  return {
    key,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    modKey: true,
    ...overrides,
  };
}

function whenIdentifier(name: string): KeybindingWhenNode {
  return { type: "identifier", name };
}

interface TestBinding {
  shortcut: KeybindingShortcut;
  command: KeybindingCommand;
  whenAst?: KeybindingWhenNode;
}

function compile(bindings: TestBinding[]): ResolvedKeybindingsConfig {
  return bindings.map((binding) => ({
    command: binding.command,
    shortcut: binding.shortcut,
    ...(binding.whenAst ? { whenAst: binding.whenAst } : {}),
  }));
}

const DEFAULT_BINDINGS = DEFAULT_RESOLVED_KEYBINDINGS;

describe("effectiveShortcutsForCommand", () => {
  it("passes only effective preview shortcuts to the desktop bridge", () => {
    const reopen = modShortcut("t", { shiftKey: true });
    const second = modShortcut("y", { shiftKey: true });
    const keybindings = compile([
      { shortcut: reopen, command: "view.reopenClosed" },
      {
        shortcut: second,
        command: "view.reopenClosed",
        whenAst: whenIdentifier("previewFocus"),
      },
      {
        shortcut: reopen,
        command: "preview.toggle",
        whenAst: whenIdentifier("previewFocus"),
      },
    ]);
    assert.deepEqual(
      effectiveShortcutsForCommand(keybindings, "view.reopenClosed", {
        platform: "MacIntel",
        context: { previewFocus: true, previewOpen: true },
      }),
      [second],
    );
    assert.deepEqual(
      effectiveShortcutsForCommand(keybindings, "view.reopenClosed", {
        platform: "MacIntel",
        context: { previewFocus: false },
      }),
      [reopen],
    );
  });
});

describe("settle thread shortcut", () => {
  it("does not intercept the terminal", () => {
    assert.isNull(
      resolveShortcutCommand(event({ key: "s", ctrlKey: true, shiftKey: true }), DEFAULT_BINDINGS, {
        platform: "Win32",
        context: { terminalFocus: true },
      }),
    );
  });
});

describe("thread undo shortcut", () => {
  it("leaves native undo alone inside text fields and terminals", () => {
    assert.isNull(
      resolveShortcutCommand(event({ key: "z", ctrlKey: true }), DEFAULT_RESOLVED_KEYBINDINGS, {
        platform: "Win32",
        context: { editableFocus: true },
      }),
    );
    assert.isNull(
      resolveShortcutCommand(event({ key: "z", ctrlKey: true }), DEFAULT_RESOLVED_KEYBINDINGS, {
        platform: "Win32",
        context: { terminalFocus: true },
      }),
    );
  });
});

describe("shortcutLabelForCommand", () => {
  it("returns null for commands shadowed by a later conflicting shortcut", () => {
    const bindings = compile([
      { shortcut: modShortcut("1", { shiftKey: true }), command: "thread.jump.1" },
      { shortcut: modShortcut("1", { shiftKey: true }), command: "thread.jump.7" },
    ]);

    assert.isNull(shortcutLabelForCommand(bindings, "thread.jump.1", "MacIntel"));
    assert.strictEqual(shortcutLabelForCommand(bindings, "thread.jump.7", "MacIntel"), "⇧⌘1");
  });

  it("respects when-context while resolving labels", () => {
    const bindings = compile([
      { shortcut: modShortcut("d"), command: "diff.toggle" },
      {
        shortcut: modShortcut("d"),
        command: "workspace.tile.splitRight",
        whenAst: whenIdentifier("terminalFocus"),
      },
    ]);

    assert.strictEqual(
      shortcutLabelForCommand(bindings, "diff.toggle", {
        platform: "Linux",
        context: { terminalFocus: false },
      }),
      "Ctrl+D",
    );
    assert.isNull(
      shortcutLabelForCommand(bindings, "diff.toggle", {
        platform: "Linux",
        context: { terminalFocus: true },
      }),
    );
    assert.strictEqual(
      shortcutLabelForCommand(bindings, "workspace.tile.splitRight", {
        platform: "Linux",
        context: { terminalFocus: true },
      }),
      "Ctrl+D",
    );
  });
});

describe("thread navigation helpers", () => {
  it("never shows jump hints while the terminal is focused, even with an unrestricted binding", () => {
    const unrestricted = compile([{ shortcut: modShortcut("1"), command: "thread.jump.1" }]);
    assert.isFalse(
      shouldShowThreadJumpHintsForModifiers(event({ metaKey: true }), unrestricted, {
        platform: "MacIntel",
        context: { terminalFocus: true },
      }),
    );
    assert.isTrue(
      shouldShowThreadJumpHintsForModifiers(event({ metaKey: true }), unrestricted, {
        platform: "MacIntel",
        context: { terminalFocus: false },
      }),
    );
  });

  it("keeps default thread jumps off the web so the browser can switch tabs", () => {
    const input = event({ key: "1", metaKey: true });
    assert.isNull(
      resolveShortcutCommand(input, DEFAULT_RESOLVED_KEYBINDINGS, {
        platform: "MacIntel",
        context: { isDesktop: false },
      }),
    );
    assert.strictEqual(
      resolveShortcutCommand(input, DEFAULT_RESOLVED_KEYBINDINGS, {
        platform: "MacIntel",
        context: { isDesktop: true },
      }),
      "thread.jump.1",
    );
    assert.isFalse(
      shouldShowThreadJumpHintsForModifiers(
        event({ metaKey: true }),
        DEFAULT_RESOLVED_KEYBINDINGS,
        {
          platform: "MacIntel",
          context: { isDesktop: false },
        },
      ),
    );
    assert.isTrue(
      shouldShowThreadJumpHintsForModifiers(
        event({ metaKey: true }),
        DEFAULT_RESOLVED_KEYBINDINGS,
        {
          platform: "MacIntel",
          context: { isDesktop: true },
        },
      ),
    );
  });
});

describe("model picker navigation helpers", () => {
  it("keeps default model jumps off the web even while the picker is open", () => {
    const input = event({ key: "3", metaKey: true });
    assert.isNull(
      resolveShortcutCommand(input, DEFAULT_RESOLVED_KEYBINDINGS, {
        platform: "MacIntel",
        context: { isDesktop: false, modelPickerOpen: true },
      }),
    );
    assert.strictEqual(
      resolveShortcutCommand(input, DEFAULT_RESOLVED_KEYBINDINGS, {
        platform: "MacIntel",
        context: { isDesktop: true, modelPickerOpen: true },
      }),
      "modelPicker.jump.3",
    );
    assert.strictEqual(
      resolveShortcutCommand(input, DEFAULT_RESOLVED_KEYBINDINGS, {
        platform: "MacIntel",
        context: { isDesktop: true, modelPickerOpen: false },
      }),
      "thread.jump.3",
    );
  });
});

describe("chat/editor shortcuts", () => {
  it("toggles the thread panel by default without taking terminal keystrokes", () => {
    for (const platform of ["MacIntel", "Win32", "Linux"]) {
      const input = event({
        key: "b",
        metaKey: platform === "MacIntel",
        ctrlKey: platform !== "MacIntel",
        shiftKey: true,
      });
      assert.strictEqual(
        resolveShortcutCommand(input, DEFAULT_RESOLVED_KEYBINDINGS, {
          platform,
          context: { terminalFocus: false, editableFocus: true },
        }),
        "threadPanel.toggle",
      );
      assert.isNull(
        resolveShortcutCommand(input, DEFAULT_RESOLVED_KEYBINDINGS, {
          platform,
          context: { terminalFocus: true },
        }),
      );
    }
  });

  it("preserves a user-configured thread panel shortcut instead of its default", () => {
    const bindings = mergeWithDefaultKeybindings(
      compile([
        {
          shortcut: modShortcut("b", { altKey: true, shiftKey: true }),
          command: "threadPanel.toggle",
        },
      ]),
    );

    assert.strictEqual(
      resolveShortcutCommand(
        event({ key: "b", metaKey: true, altKey: true, shiftKey: true }),
        bindings,
        { platform: "MacIntel" },
      ),
      "threadPanel.toggle",
    );
    assert.isNull(
      resolveShortcutCommand(event({ key: "b", metaKey: true, shiftKey: true }), bindings, {
        platform: "MacIntel",
      }),
    );
  });
});

describe("resolveChatShortcutCommand", () => {
  it("runs the active environment's script shortcut instead of the primary environment's", () => {
    const primary = compile([{ shortcut: modShortcut("r"), command: "script.setup.run" }]);
    const active = compile([{ shortcut: modShortcut("t"), command: "script.setup.run" }]);

    assert.strictEqual(
      resolveChatShortcutCommand(event({ key: "t", ctrlKey: true }), primary, active, {
        platform: "Linux",
      }),
      "script.setup.run",
    );
    assert.isNull(
      resolveChatShortcutCommand(event({ key: "r", ctrlKey: true }), primary, active, {
        platform: "Linux",
      }),
    );
  });

  it("does not run primary scripts before the active environment's bindings arrive", () => {
    const primary = compile([{ shortcut: modShortcut("r"), command: "script.setup.run" }]);

    assert.isNull(
      resolveChatShortcutCommand(event({ key: "r", ctrlKey: true }), primary, [], {
        platform: "Linux",
      }),
    );
  });

  it("keeps primary app commands ahead of conflicting active script shortcuts", () => {
    const primary = compile([{ shortcut: modShortcut("k"), command: "commandPalette.toggle" }]);
    const active = compile([{ shortcut: modShortcut("k"), command: "script.setup.run" }]);

    assert.strictEqual(
      resolveChatShortcutCommand(event({ key: "k", ctrlKey: true }), primary, active, {
        platform: "Linux",
      }),
      "commandPalette.toggle",
    );
  });

  it("keeps app shortcuts on the primary environment when the active environment remaps them", () => {
    const primary = compile([{ shortcut: modShortcut("j"), command: "terminal.toggle" }]);
    const active = compile([{ shortcut: modShortcut("t"), command: "terminal.toggle" }]);

    assert.strictEqual(
      resolveChatShortcutCommand(event({ key: "j", ctrlKey: true }), primary, active, {
        platform: "Linux",
      }),
      "terminal.toggle",
    );
    assert.isNull(
      resolveChatShortcutCommand(event({ key: "t", ctrlKey: true }), primary, active, {
        platform: "Linux",
      }),
    );
  });

  it.each([false, true])(
    "preserves active binding precedence with terminalFocus=%s",
    (terminalFocus) => {
      const primary = compile([{ shortcut: modShortcut("r"), command: "script.setup.run" }]);
      const active = compile([
        { shortcut: modShortcut("r"), command: "script.deploy.run" },
        {
          shortcut: modShortcut("r"),
          command: "workspace.tile.newTab",
          whenAst: whenIdentifier("terminalFocus"),
        },
      ]);
      const options = { platform: "Linux", context: { terminalFocus } };
      const shortcut = event({ key: "r", ctrlKey: true });

      assert.strictEqual(
        resolveChatShortcutCommand(shortcut, primary, active, options),
        terminalFocus ? null : "script.deploy.run",
      );
      assert.strictEqual(
        resolveChatShortcutCommand(shortcut, active, active, options),
        resolveShortcutCommand(shortcut, active, options),
      );
    },
  );
});

describe("resolveShortcutCommand", () => {
  it.each(["Linux", "Win32", "MacIntel"])(
    "opens the project picker without taking the tile shortcut on %s",
    (platform) => {
      const mac = platform === "MacIntel";
      assert.equal(
        resolveShortcutCommand(
          event({ key: "o", ctrlKey: !mac, metaKey: mac, altKey: true, shiftKey: true }),
          DEFAULT_RESOLVED_KEYBINDINGS,
          { platform },
        ),
        "projectPicker.open",
      );
      assert.equal(
        resolveShortcutCommand(
          event({ key: "o", ctrlKey: true, altKey: true }),
          compileResolvedKeybindingsConfig(defaultKeybindingsForMode(false)),
          { platform },
        ),
        "workspace.tile.newTab",
      );
    },
  );

  it("closes the selected tile tab with Cmd+W on macOS", () => {
    const closeEvent = event({ key: "w", metaKey: true });
    assert.strictEqual(
      resolveShortcutCommand(closeEvent, DEFAULT_BINDINGS, {
        platform: "MacIntel",
        context: { terminalFocus: true },
      }),
      "workspace.tile.closeTab",
    );
    assert.strictEqual(
      resolveShortcutCommand(closeEvent, DEFAULT_BINDINGS, {
        platform: "MacIntel",
        context: { terminalFocus: false },
      }),
      "workspace.tile.closeTab",
    );
  });

  it.each(["Win32", "Linux", "MacIntel"])(
    "routes tiled workspace chords while editing or using a terminal on %s",
    (platform) => {
      const chords = [
        ["ArrowLeft", false, "workspace.tile.focusLeft"],
        ["ArrowRight", false, "workspace.tile.focusRight"],
        ["ArrowUp", false, "workspace.tile.focusUp"],
        ["ArrowDown", false, "workspace.tile.focusDown"],
        ["ArrowLeft", true, "workspace.tile.splitLeft"],
        ["ArrowRight", true, "workspace.tile.splitRight"],
        ["ArrowUp", true, "workspace.tile.splitUp"],
        ["ArrowDown", true, "workspace.tile.splitDown"],
        ["Enter", false, "workspace.tile.maximize"],
        ["[", false, "workspace.tile.previousTab"],
        ["]", false, "workspace.tile.nextTab"],
        ["f", false, "workspace.tile.focusPair"],
        ["s", false, "workspace.tile.swap"],
        ["p", false, "workspace.tile.float"],
        ["o", false, "workspace.tile.newTab"],
        ["w", false, "workspace.tile.closeTab"],
        [".", false, "workspace.tile.actions"],
      ] as const;
      for (const [key, shiftKey, command] of chords) {
        const input = event({ key, ctrlKey: true, altKey: true, shiftKey });
        for (const terminalFocus of [false, true]) {
          assert.strictEqual(
            resolveShortcutCommand(
              input,
              compileResolvedKeybindingsConfig(defaultKeybindingsForMode(false)),
              {
                platform,
                context: { terminalFocus, editableFocus: !terminalFocus },
              },
            ),
            command,
          );
        }
      }
      // AltGr text (German AltGr+8 types "[", Polish AltGr+S and AltGr+L type "ś" and "ł").
      for (const [key, code] of [
        ["[", "Digit8"],
        ["ś", "KeyS"],
        ["ł", "KeyL"],
      ] as const)
        assert.isNull(
          resolveShortcutCommand(
            event({ key, code, ctrlKey: true, altKey: true, getModifierState: () => true }),
            compileResolvedKeybindingsConfig(defaultKeybindingsForMode(false)),
            { platform: "Win32" },
          ),
        );
    },
  );

  it("navigates history with mod+[ and mod+] outside the terminal", () => {
    const back = event({ key: "[", code: "BracketLeft", metaKey: true });
    const forward = event({ key: "]", code: "BracketRight", ctrlKey: true });
    assert.strictEqual(
      resolveShortcutCommand(back, DEFAULT_RESOLVED_KEYBINDINGS, { platform: "MacIntel" }),
      "navigation.back",
    );
    assert.strictEqual(
      resolveShortcutCommand(forward, DEFAULT_RESOLVED_KEYBINDINGS, { platform: "Linux" }),
      "navigation.forward",
    );
    assert.isNull(
      resolveShortcutCommand(back, DEFAULT_RESOLVED_KEYBINDINGS, {
        platform: "MacIntel",
        context: { terminalFocus: true },
      }),
    );
  });

  it("matches punctuation shortcuts by physical key across keyboard layouts", () => {
    const keybindings = compile([
      { shortcut: modShortcut("'", { shiftKey: true }), command: "diff.toggle" },
    ]);

    assert.strictEqual(
      resolveShortcutCommand(
        event({ key: "@", code: "Quote", metaKey: true, shiftKey: true }),
        keybindings,
        { platform: "MacIntel" },
      ),
      "diff.toggle",
    );
    assert.isNull(
      resolveShortcutCommand(
        event({ key: '"', code: "Digit2", metaKey: true, shiftKey: true }),
        keybindings,
        { platform: "MacIntel" },
      ),
    );
  });

  it('matches Ctrl+layout "+" as itself unless Shift, Alt or the number row is involved', () => {
    assert.isNull(
      resolveShortcutCommand(
        event({ key: "+", code: "BracketRight", ctrlKey: true }),
        DEFAULT_RESOLVED_KEYBINDINGS,
        { platform: "Linux", context: { terminalFocus: false } },
      ),
    );
    assert.strictEqual(
      resolveShortcutCommand(
        event({ key: "+", code: "Minus", ctrlKey: true }),
        DEFAULT_RESOLVED_KEYBINDINGS,
        { platform: "Linux", context: { previewFocus: true } },
      ),
      "preview.zoomIn",
    );
    assert.strictEqual(
      resolveShortcutCommand(
        event({ key: "+", code: "Digit1", ctrlKey: true }),
        DEFAULT_RESOLVED_KEYBINDINGS,
        { platform: "Linux", context: { isDesktop: true } },
      ),
      "thread.jump.1",
    );
    assert.strictEqual(
      resolveShortcutCommand(
        event({ key: "+", code: "BracketRight", altKey: true }),
        compile([
          {
            shortcut: modShortcut("]", { modKey: false, altKey: true }),
            command: "terminal.toggle",
          },
        ]),
        { platform: "Linux" },
      ),
      "terminal.toggle",
    );
    assert.strictEqual(
      resolveShortcutCommand(
        event({ key: "+", code: "Equal", ctrlKey: true, shiftKey: true }),
        compile([{ shortcut: modShortcut("=", { shiftKey: true }), command: "terminal.toggle" }]),
        { platform: "Linux" },
      ),
      "terminal.toggle",
    );
  });

  it("does not let a punctuation position shadow a Latin layout key", () => {
    const keybindings = compile([
      { shortcut: modShortcut("m"), command: "diff.toggle" },
      { shortcut: modShortcut(";"), command: "sidebar.toggle" },
    ]);

    assert.strictEqual(
      resolveShortcutCommand(event({ key: "m", code: "Semicolon", metaKey: true }), keybindings, {
        platform: "MacIntel",
      }),
      "diff.toggle",
    );
  });

  it("matches Option-modified letters using the physical key code on macOS", () => {
    assert.strictEqual(
      resolveShortcutCommand(
        event({ key: "∫", code: "KeyB", metaKey: true, altKey: true, shiftKey: true }),
        DEFAULT_BINDINGS,
        { platform: "MacIntel" },
      ),
      "toolSidebar.toggle",
    );
  });

  it("matches non-Latin layout letters using the physical key code", () => {
    const keybindings = compile([{ shortcut: modShortcut("d"), command: "diff.toggle" }]);

    assert.strictEqual(
      resolveShortcutCommand(event({ key: "в", code: "KeyD", metaKey: true }), keybindings, {
        platform: "MacIntel",
      }),
      "diff.toggle",
    );
  });

  it("ignores the physical key code when the layout types a different Latin letter", () => {
    const keybindings = compile([{ shortcut: modShortcut("d"), command: "diff.toggle" }]);

    assert.isNull(
      resolveShortcutCommand(event({ key: "a", code: "KeyD", metaKey: true }), keybindings, {
        platform: "MacIntel",
      }),
    );
    assert.strictEqual(
      resolveShortcutCommand(event({ key: "d", code: "KeyL", metaKey: true }), keybindings, {
        platform: "MacIntel",
      }),
      "diff.toggle",
    );
  });
});

describe("isRichTextBoldShortcut", () => {
  const selected = { isCollapsed: false };

  it("matches the B key on non-Latin layouts, like the sidebar toggle does", () => {
    const cyrillicB = event({ key: "и", code: "KeyB", ctrlKey: true });
    assert.isTrue(isRichTextBoldShortcut(cyrillicB, selected));
    assert.strictEqual(
      resolveShortcutCommand(cyrillicB, DEFAULT_BINDINGS, { platform: "Win32" }),
      "sidebar.toggle",
    );
  });

  it("follows the letter a Latin layout types, not the physical key", () => {
    assert.isFalse(
      isRichTextBoldShortcut(event({ key: "x", code: "KeyB", ctrlKey: true }), selected),
    );
    assert.isTrue(
      isRichTextBoldShortcut(event({ key: "b", code: "KeyN", ctrlKey: true }), selected),
    );
  });

  it("leaves the chord to the sidebar toggle when no text is selected", () => {
    const modB = event({ key: "b", metaKey: true });
    assert.isFalse(isRichTextBoldShortcut(modB, { isCollapsed: true }));
    assert.isFalse(isRichTextBoldShortcut(modB, null));
  });
});

describe("composer and pull request shortcuts", () => {
  it("uses the dictation chord outside the terminal and preserves shell input", () => {
    const chord = event({ key: "d", ctrlKey: true, shiftKey: true });
    assert.strictEqual(
      resolveShortcutCommand(chord, DEFAULT_RESOLVED_KEYBINDINGS, {
        platform: "Linux",
        context: { terminalFocus: false },
      }),
      "composer.dictation",
    );
    assert.strictEqual(
      resolveShortcutCommand(chord, DEFAULT_RESOLVED_KEYBINDINGS, {
        platform: "Linux",
        context: { terminalFocus: true },
      }),
      null,
    );
  });
  it("fills missing number shortcuts without replacing the saved URL binding", () => {
    const olderServerBindings = DEFAULT_RESOLVED_KEYBINDINGS.filter(
      (binding) =>
        binding.command !== "pullRequest.copyNumber" && binding.command !== "thread.copyReference",
    );
    const bindings = mergeWithDefaultKeybindings([
      ...olderServerBindings,
      ...compileResolvedKeybindingsConfig([
        { key: "mod+shift+8", command: "thread.copyReference", when: "!terminalFocus" },
      ]),
    ]);
    for (const [key, command] of [
      ["k", "pullRequest.copyNumber"],
      ["8", "thread.copyReference"],
      ["c", null],
      ["y", null],
    ] as const) {
      assert.strictEqual(
        resolveShortcutCommand(event({ key, metaKey: true, shiftKey: true }), bindings, {
          platform: "MacIntel",
        }),
        command,
      );
    }
  });

  it.each(["MacIntel", "Win32", "Linux"])(
    "reserves the alternate send chord for the focused composer on %s",
    (platform) => {
      const modifier = {
        metaKey: platform === "MacIntel",
        ctrlKey: platform !== "MacIntel",
      };
      const shiftedEnter = event({ key: "Enter", shiftKey: true, ...modifier });
      for (const composerRequiresModifier of [false, true]) {
        const context = {
          composerFocus: true,
          turnRunning: true,
          composerRequiresModifier,
        };
        assert.strictEqual(
          resolveShortcutCommand(shiftedEnter, DEFAULT_RESOLVED_KEYBINDINGS, {
            platform,
            context,
          }),
          composerRequiresModifier ? "composer.sendAlternate" : "thread.steerQueuedMessage",
        );
        assert.strictEqual(
          shortcutLabelForCommand(DEFAULT_RESOLVED_KEYBINDINGS, "composer.sendAlternate", {
            platform,
            context,
          }),
          formatShortcutLabel(
            modShortcut("enter", { shiftKey: composerRequiresModifier }),
            platform,
          ),
        );
        assert.strictEqual(
          resolveShortcutCommand(shiftedEnter, DEFAULT_RESOLVED_KEYBINDINGS, {
            platform,
            context: { ...context, composerFocus: false },
          }),
          "thread.steerQueuedMessage",
        );
      }
    },
  );

  const altEffortBindings = compileResolvedKeybindingsConfig([
    { key: "mod+alt+e", command: "composer.effort", when: "!terminalFocus" },
  ]);

  it("leaves AltGr text entry alone with a custom Alt binding", () => {
    for (const platform of ["Win32", "Linux"]) {
      const input = event({
        key: "€",
        code: "KeyE",
        ctrlKey: true,
        altKey: true,
        getModifierState: (key) => key === "AltGraph",
      });
      assert.isNull(resolveShortcutCommand(input, altEffortBindings, { platform }));
      assert.strictEqual(
        resolveShortcutCommand({ ...input, getModifierState: () => false }, altEffortBindings, {
          platform,
        }),
        "composer.effort",
      );
    }
  });

  it("keeps Firefox modifier reporting usable on Windows and macOS", () => {
    const getModifierState = (key: string) => key === "AltGraph";
    assert.strictEqual(
      resolveShortcutCommand(
        event({ key: "e", ctrlKey: true, altKey: true, getModifierState }),
        altEffortBindings,
        { platform: "Win32" },
      ),
      "composer.effort",
    );
    assert.strictEqual(
      resolveShortcutCommand(
        event({ key: "´", code: "KeyE", metaKey: true, altKey: true, getModifierState }),
        altEffortBindings,
        { platform: "MacIntel" },
      ),
      "composer.effort",
    );
  });
});

describe("Usage shortcuts", () => {
  it.each(["Linux", "MacIntel"])(
    "preserves desktop numbered thread shortcuts on Usage on %s",
    (platform) => {
      const shortcut = event({
        key: "2",
        ctrlKey: platform === "Linux",
        metaKey: platform === "MacIntel",
      });
      assert.strictEqual(
        resolveShortcutCommand(shortcut, DEFAULT_RESOLVED_KEYBINDINGS, {
          platform,
          context: { usagePageOpen: true, isDesktop: true },
        }),
        "thread.jump.2",
      );
      assert.isNotNull(
        shortcutLabelForCommand(DEFAULT_RESOLVED_KEYBINDINGS, "thread.jump.2", {
          platform,
          context: { usagePageOpen: true, isDesktop: true },
        }),
      );
    },
  );

  it("matches shifted number keys for periods and only on Usage", () => {
    const shortcut = event({ key: "!", code: "Digit1", ctrlKey: true, shiftKey: true });
    assert.strictEqual(
      resolveShortcutCommand(shortcut, DEFAULT_RESOLVED_KEYBINDINGS, {
        platform: "Linux",
        context: { usagePageOpen: true },
      }),
      "usage.period.day",
    );
    assert.isNull(
      resolveShortcutCommand(shortcut, DEFAULT_RESOLVED_KEYBINDINGS, {
        platform: "Linux",
      }),
    );
  });
});

it("keeps removed terminal and panel commands out of Weavewing", () => {
  for (const command of [
    "terminal.split",
    "terminal.splitVertical",
    "terminal.new",
    "rightPanel.toggle",
    "rightPanel.toggleMaximized",
    "rightPanel.new",
    "rightPanel.close",
  ]) {
    assert.isFalse(STATIC_KEYBINDING_COMMANDS.some((entry) => String(entry) === command));
    assert.isFalse(DEFAULT_RESOLVED_KEYBINDINGS.some((entry) => String(entry.command) === command));
  }
  for (const platform of ["Linux x86_64", "Win32", "MacIntel"]) {
    for (const key of "abcdefghijklmnopqrstuvwxyz") {
      for (const shiftKey of [false, true]) {
        const leader = createLeaderHandler({
          keybindings: () => DEFAULT_RESOLVED_KEYBINDINGS,
          platform: () => platform,
          changed: () => {},
        });
        assert.equal(
          leader.handle(event({ key, ctrlKey: true, shiftKey })),
          key === "a" && !shiftKey ? "prefix" : null,
        );
        leader.cancel();
        assert.equal(
          resolveShortcutCommand(
            event({ key, ctrlKey: true, shiftKey }),
            DEFAULT_RESOLVED_KEYBINDINGS,
            {
              platform,
              context: { terminalFocus: true, terminalOpen: true },
            },
          ),
          key === "w" && platform !== "MacIntel"
            ? shiftKey
              ? "workspace.tile.closeAllTabs"
              : "workspace.tile.closeTab"
            : !shiftKey && platform !== "MacIntel" && key === "k"
              ? "search.toggle"
              : !shiftKey && platform !== "MacIntel" && key === "p"
                ? "commandPalette.toggle"
                : null,
          `Ctrl+${shiftKey ? "Shift+" : ""}${key} resolves to the documented terminal action on ${platform}`,
        );
      }
    }
  }
});

it.each([
  ["b", "sidebar.toggle"],
  ["j", "terminal.toggle"],
  ["o", "editor.openFavorite"],
])("keeps Cmd+%s working in a focused terminal on macOS", (key, command) => {
  assert.equal(
    resolveShortcutCommand(event({ key, metaKey: true }), DEFAULT_BINDINGS, {
      platform: "MacIntel",
      context: { terminalFocus: true },
    }),
    command,
  );
});

it.each(["Linux x86_64", "Win32", "MacIntel"])(
  "preserves vim input in focused terminals on %s",
  (platform) => {
    const context = { terminalFocus: true, terminalOpen: true, isDesktop: true };
    const passthrough = [
      event({ key: "Escape" }),
      event({ key: "[", ctrlKey: true }),
      event({ key: " ", ctrlKey: true }),
      event({ key: "]", ctrlKey: true }),
      event({ key: "^", code: "Digit6", ctrlKey: true, shiftKey: true }),
      event({ key: "6", code: "Digit6", ctrlKey: true }),
      event({ key: "Tab" }),
      event({ key: "Tab", shiftKey: true }),
      ...Array.from({ length: 24 }, (_, i) => event({ key: `F${i + 1}` })),
      ...[..."abcdefgimnopqrstuvwxyz"].map((key) => event({ key, altKey: true })),
    ];
    for (const input of passthrough) {
      assert.equal(
        resolveShortcutCommand(input, DEFAULT_BINDINGS, { platform, context }),
        null,
        JSON.stringify(input),
      );
    }
    for (const [shiftKey, command] of [
      [false, "workspace.tile.closeTab"],
      [true, "workspace.tile.closeAllTabs"],
    ] as const) {
      assert.equal(
        resolveShortcutCommand(
          event({
            key: "w",
            shiftKey,
            ctrlKey: platform !== "MacIntel",
            metaKey: platform === "MacIntel",
          }),
          DEFAULT_BINDINGS,
          { platform, context },
        ),
        command,
      );
    }
  },
);

it.each(["Linux", "Win32", "MacIntel"])(
  "resolves leader sequences and classic defaults separately on %s",
  (platform) => {
    const classic = compileResolvedKeybindingsConfig(defaultKeybindingsForMode(false));
    const sequences = [
      ["%", "workspace.tile.splitRight"],
      ['"', "workspace.tile.splitDown"],
      ["h", "workspace.tile.focusLeft"],
      ["ArrowLeft", "workspace.tile.focusLeft"],
      ["ArrowDown", "workspace.tile.focusDown"],
      ["ArrowUp", "workspace.tile.focusUp"],
      ["ArrowRight", "workspace.tile.focusRight"],
      ["j", "workspace.tile.focusDown"],
      ["k", "workspace.tile.focusUp"],
      ["l", "workspace.tile.focusRight"],
      ["x", "workspace.tile.closeTab"],
      ["m", "workspace.tile.maximize"],
      ["0", "workspace.tile.swap"],
      [" ", "workspace.tile.rotate"],
      ["t", "workspace.tile.newTab"],
      ["n", "workspace.tile.nextTab"],
      ["p", "workspace.tile.previousTab"],
      ["f", "workspace.tile.float"],
      ["r", "workspace.tile.resize"],
      [".", "workspace.tile.actions"],
      ["/", "search.toggle"],
      [":", "commandPalette.toggle"],
      ...([1, 2, 3, 4, 5, 6, 7, 8, 9] as const).map((n) => [`${n}`, `workspace.tile.tab.${n}`]),
    ];
    for (const [key, command] of sequences) {
      const input = event({ key: key!, shiftKey: key === "%" || key === '"' || key === ":" });
      for (const terminalFocus of [false, true]) {
        const options = {
          platform,
          context: { terminalFocus, editableFocus: !terminalFocus },
          leader: true,
        };
        assert.equal(resolveShortcutCommand(input, DEFAULT_BINDINGS, options), command);
        assert.isNull(resolveShortcutCommand(input, classic, options));
        assert.isNull(
          resolveShortcutCommand(input, DEFAULT_BINDINGS, { ...options, leader: false }),
        );
      }
    }
    for (const [key, command] of [
      ["h", "workspace.tile.resizeLeft"],
      ["j", "workspace.tile.resizeDown"],
      ["k", "workspace.tile.resizeUp"],
      ["l", "workspace.tile.resizeRight"],
    ]) {
      assert.equal(
        resolveShortcutCommand(event({ key: key!, altKey: true }), DEFAULT_BINDINGS, {
          platform,
          context: { terminalFocus: true },
        }),
        command,
      );
    }
    assert.isNull(
      resolveShortcutCommand(event({ key: "h", ctrlKey: true, altKey: true }), DEFAULT_BINDINGS, {
        platform,
      }),
    );
    assert.equal(
      resolveShortcutCommand(event({ key: "h", ctrlKey: true, altKey: true }), classic, {
        platform,
      }),
      "workspace.tile.focusLeft",
    );
    const [sequence] = compileResolvedKeybindingsConfig([
      { key: "leader h", command: "workspace.tile.focusLeft" },
    ]);
    assert.isDefined(sequence);
    const { leader: _leader, ...legacyShortcut } = sequence!.shortcut;
    assert.isNull(
      resolveShortcutCommand(event({ key: "h" }), [{ ...sequence!, shortcut: legacyShortcut }], {
        platform,
      }),
    );
    const conditional = compileResolvedKeybindingsConfig([
      { key: "leader H", command: "workspace.tile.focusLeft", when: "terminalFocus" },
    ]);
    assert.isNull(
      resolveShortcutCommand(event({ key: "h" }), conditional, { platform, leader: true }),
    );
    assert.equal(
      resolveShortcutCommand(event({ key: "h" }), conditional, {
        platform,
        leader: true,
        context: { terminalFocus: true },
      }),
      "workspace.tile.focusLeft",
    );
  },
);

describe("search and palette defaults", () => {
  it.each(["Linux", "Win32", "MacIntel"])(
    "opens both dialogs even with terminal focus on %s",
    (platform) => {
      for (const leaderEnabled of [false, true]) {
        const bindings = compileResolvedKeybindingsConfig(defaultKeybindingsForMode(leaderEnabled));
        assert.isFalse(bindings.some((rule) => rule.command === "filePicker.toggle"));
        for (const terminalFocus of [false, true]) {
          const modifier = platform === "MacIntel" ? { metaKey: true } : { ctrlKey: true };
          for (const [key, command] of [
            ["k", "search.toggle"],
            ["p", "commandPalette.toggle"],
          ] as const) {
            assert.equal(
              resolveShortcutCommand(event({ key, ...modifier }), bindings, {
                platform,
                context: { terminalFocus },
              }),
              command,
            );
          }
        }
      }
    },
  );
});
