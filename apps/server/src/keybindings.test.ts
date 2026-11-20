import { KeybindingCommand, KeybindingRule, KeybindingsConfig } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { assertFailure } from "@effect/vitest/utils";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ServerConfig from "./config.ts";
import * as Keybindings from "./keybindings.ts";
import * as SharedKeybindings from "@t3tools/shared/keybindings";
import { KeybindingsConfigError, MAX_KEYBINDINGS_COUNT } from "@t3tools/contracts";

const KeybindingsConfigJson = Schema.fromJsonString(KeybindingsConfig);
const encodeKeybindingsConfigJson = Schema.encodeEffect(KeybindingsConfigJson);
const decodeKeybindingsConfigJson = Schema.decodeUnknownEffect(KeybindingsConfigJson);
const decodeResolvedBinding = Schema.decodeEffect(Keybindings.ResolvedKeybindingFromConfig);
const encodeResolvedBinding = Schema.encodeEffect(Keybindings.ResolvedKeybindingFromConfig);
const layerKeybindings = () => {
  return Keybindings.layer.pipe(
    Layer.provideMerge(
      Layer.fresh(
        ServerConfig.layerTest(process.cwd(), {
          prefix: "t3code-keybindings-test-",
        }),
      ),
    ),
  );
};

const toDetailResult = <A, R>(effect: Effect.Effect<A, KeybindingsConfigError, R>) =>
  effect.pipe(
    Effect.mapError((error) => error.detail),
    Effect.result,
  );

const writeKeybindingsConfig = (configPath: string, rules: readonly KeybindingRule[]) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const encoded = yield* encodeKeybindingsConfigJson(rules);
    yield* fileSystem.makeDirectory(path.dirname(configPath), { recursive: true });
    yield* fileSystem.writeFileString(configPath, encoded);
  });

const readKeybindingsConfig = (configPath: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const rawConfig = yield* fileSystem.readFileString(configPath);
    return yield* decodeKeybindingsConfigJson(rawConfig);
  });

it.layer(NodeServices.layer)("keybindings", (it) => {
  it.effect(
    "migrates saved tile defaults once and switches presets without losing custom rules",
    () =>
      Effect.gen(function* () {
        const { keybindingsConfigPath } = yield* ServerConfig.ServerConfig;
        const custom: KeybindingRule = {
          key: "ctrl+alt+v",
          command: "workspace.tile.focusLeft",
          when: "terminalFocus",
        };
        yield* writeKeybindingsConfig(keybindingsConfigPath, [
          ...SharedKeybindings.CLASSIC_KEYBINDINGS.filter(
            (rule) => rule.command !== custom.command,
          ),
          custom,
        ]);
        const service = yield* Keybindings.Keybindings;
        yield* service.syncDefaultKeybindingsOnStartup;
        const first = yield* readKeybindingsConfig(keybindingsConfigPath);
        assert.isFalse(first.some(SharedKeybindings.isClassicTileDefault));
        assert.isTrue(first.some((rule) => rule.key === "leader %"));
        assert.isTrue(first.some((rule) => rule.key === custom.key && rule.when === custom.when));
        yield* service.syncDefaultKeybindingsOnStartup;
        assert.deepEqual(yield* readKeybindingsConfig(keybindingsConfigPath), first);
        const classic = yield* service.upsertKeybindingRule({
          command: "keybindings.leader",
          key: "ctrl+a",
          when: "false",
        });
        assert.isFalse(classic.keybindings.some((rule) => rule.shortcut.leader));
        for (const key of ["w", "[", "]"])
          assert.isTrue(
            classic.keybindings.some(
              (rule) => rule.shortcut.key === key && rule.shortcut.ctrlKey && rule.shortcut.altKey,
            ),
          );
        assert.isTrue(
          classic.keybindings.some(
            (rule) =>
              rule.command === "workspace.tile.splitRight" &&
              rule.shortcut.ctrlKey &&
              rule.shortcut.altKey,
          ),
        );
        assert.isTrue(
          classic.keybindings.some(
            (rule) => rule.shortcut.key === "v" && rule.command === custom.command,
          ),
        );
        yield* service.syncDefaultKeybindingsOnStartup;
        const persistedClassic = yield* readKeybindingsConfig(keybindingsConfigPath);
        yield* service.syncDefaultKeybindingsOnStartup;
        assert.deepEqual(yield* readKeybindingsConfig(keybindingsConfigPath), persistedClassic);
        const leader = yield* service.upsertKeybindingRule({
          command: "keybindings.leader",
          key: "ctrl+b",
        });
        assert.isTrue(
          leader.keybindings.some(
            (rule) => rule.shortcut.leader && rule.shortcut.key === "leader %",
          ),
        );
        assert.isFalse(
          leader.keybindings.some(
            (rule) =>
              rule.command.startsWith("workspace.tile.") &&
              rule.shortcut.key !== "v" &&
              rule.shortcut.ctrlKey &&
              rule.shortcut.altKey,
          ),
        );
        assert.isTrue(
          leader.keybindings.some(
            (rule) => rule.shortcut.key === "v" && rule.command === custom.command,
          ),
        );
        const rule: KeybindingRule = {
          key: 'leader "',
          command: "workspace.tile.splitDown",
          when: "terminalFocus",
        };
        const resolved = yield* decodeResolvedBinding(rule);
        const encoded = yield* encodeResolvedBinding(resolved);
        assert.equal(encoded.key, rule.key);
        assert.equal(encoded.when, rule.when);
        yield* service.upsertKeybindingRule(rule);
        assert.isTrue(
          (yield* readKeybindingsConfig(keybindingsConfigPath)).some(
            (entry) => entry.key === rule.key && entry.when === rule.when,
          ),
        );
      }).pipe(Effect.provide(layerKeybindings())),
  );

  it.effect("parses shortcuts including plus key", () =>
    Effect.sync(() => {
      assert.deepEqual(SharedKeybindings.parseKeybindingShortcut("mod+j"), {
        key: "j",
        metaKey: false,
        ctrlKey: false,
        shiftKey: false,
        altKey: false,
        modKey: true,
      });
      assert.deepEqual(SharedKeybindings.parseKeybindingShortcut("mod++"), {
        key: "+",
        metaKey: false,
        ctrlKey: false,
        shiftKey: false,
        altKey: false,
        modKey: true,
      });
    }),
  );

  it.effect("compiles valid rule with parsed when AST", () =>
    Effect.sync(() => {
      const compiled = SharedKeybindings.compileResolvedKeybindingRule({
        key: "mod+d",
        command: "workspace.tile.splitRight",
        when: "terminalOpen && !terminalFocus",
      });

      assert.deepEqual(compiled, {
        command: "workspace.tile.splitRight",
        shortcut: {
          key: "d",
          metaKey: false,
          ctrlKey: false,
          shiftKey: false,
          altKey: false,
          modKey: true,
        },
        whenAst: {
          type: "and",
          left: { type: "identifier", name: "terminalOpen" },
          right: {
            type: "not",
            node: { type: "identifier", name: "terminalFocus" },
          },
        },
      });
    }),
  );

  it.effect("rejects invalid rules", () =>
    Effect.sync(() => {
      assert.isNull(
        SharedKeybindings.compileResolvedKeybindingRule({
          key: "mod+shift+d+o",
          command: "workspace.tile.newTab",
        }),
      );

      assert.isNull(
        SharedKeybindings.compileResolvedKeybindingRule({
          key: "mod+d",
          command: "workspace.tile.splitRight",
          when: "terminalFocus && (",
        }),
      );

      assert.isNull(
        SharedKeybindings.compileResolvedKeybindingRule({
          key: "mod+d",
          command: "workspace.tile.splitRight",
          when: `${"!".repeat(300)}terminalFocus`,
        }),
      );
    }),
  );

  it.effect("silently drops removed Weavewing commands from saved bindings", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { keybindingsConfigPath } = yield* ServerConfig.ServerConfig;
      const removed = [
        "terminal.split",
        "terminal.splitVertical",
        "terminal.new",
        "rightPanel.toggle",
        "rightPanel.toggleMaximized",
        "rightPanel.new",
        "rightPanel.close",
      ];
      yield* fs.writeFileString(
        keybindingsConfigPath,
        JSON.stringify([
          ...removed.map((command) => ({ key: "ctrl+d", command })),
          { key: "mod+b", command: "sidebar.toggle" },
          { key: "mod+j", command: "terminal.toggle", when: "!terminalFocus" },
          { key: "mod+o", command: "editor.openFavorite" },
          { key: "mod+w", command: "terminal.close", when: "terminalFocus" },
          { key: "ctrl+alt+y", command: "terminal.toggle" },
        ]),
      );
      const service = yield* Keybindings.Keybindings;
      const state = yield* service.loadConfigState;
      assert.deepEqual(state.issues, []);
      assert.isFalse(state.keybindings.some((entry) => removed.includes(entry.command)));
      assert.isFalse(state.keybindings.some((entry) => entry.command === "terminal.close"));
      for (const command of ["terminal.toggle", "sidebar.toggle", "editor.openFavorite"]) {
        const oldDefault = state.keybindings.find(
          (entry) => entry.command === command && ["b", "j", "o"].includes(entry.shortcut.key),
        );
        assert.deepEqual(oldDefault?.whenAst, {
          type: "or",
          left: { type: "identifier", name: "isMac" },
          right: { type: "not", node: { type: "identifier", name: "terminalFocus" } },
        });
      }
      assert.isTrue(
        state.keybindings.some(
          (entry) => entry.command === "terminal.toggle" && entry.shortcut.key === "y",
        ),
      );
    }).pipe(Effect.provide(layerKeybindings())),
  );

  it.effect("bootstraps default keybindings when config file is missing", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { keybindingsConfigPath } = yield* ServerConfig.ServerConfig;
      assert.isFalse(yield* fs.exists(keybindingsConfigPath));

      yield* Effect.gen(function* () {
        const keybindings = yield* Keybindings.Keybindings;
        yield* keybindings.syncDefaultKeybindingsOnStartup;
      });

      const persisted = yield* readKeybindingsConfig(keybindingsConfigPath);
      assert.deepEqual(persisted, SharedKeybindings.DEFAULT_KEYBINDINGS);
    }).pipe(Effect.provide(layerKeybindings())),
  );

  it.effect("uses defaults in runtime when config is malformed without overriding file", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { keybindingsConfigPath } = yield* ServerConfig.ServerConfig;
      yield* fs.writeFileString(keybindingsConfigPath, "{ not-json");

      const configState = yield* Effect.gen(function* () {
        const keybindings = yield* Keybindings.Keybindings;
        return yield* keybindings.loadConfigState;
      });

      assert.deepEqual(
        configState.keybindings,
        SharedKeybindings.compileResolvedKeybindingsConfig(SharedKeybindings.DEFAULT_KEYBINDINGS),
      );
      assert.deepEqual(configState.issues, [
        {
          kind: "keybindings.malformed-config",
          message: configState.issues[0]?.message ?? "",
        },
      ]);
      assert.equal(yield* fs.readFileString(keybindingsConfigPath), "{ not-json");
    }).pipe(Effect.provide(layerKeybindings())),
  );

  it.effect("ignores invalid entries in runtime and reports them as issues", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { keybindingsConfigPath } = yield* ServerConfig.ServerConfig;
      yield* fs.writeFileString(
        keybindingsConfigPath,
        JSON.stringify([
          { key: "mod+j", command: "terminal.toggle" },
          { key: "mod+shift+d+o", command: "workspace.tile.newTab" },
          { key: "mod+x", command: "invalid.command" },
        ]),
      );

      const configState = yield* Effect.gen(function* () {
        const keybindings = yield* Keybindings.Keybindings;
        return yield* keybindings.loadConfigState;
      });

      assert.isTrue(configState.keybindings.some((entry) => entry.command === "terminal.toggle"));
      assert.isFalse(
        configState.keybindings.some((entry) => String(entry.command) === "invalid.command"),
      );
      assert.deepEqual(configState.issues, [
        {
          kind: "keybindings.invalid-entry",
          index: 1,
          message: configState.issues[0]?.message ?? "",
        },
        {
          kind: "keybindings.invalid-entry",
          index: 2,
          message: configState.issues[1]?.message ?? "",
        },
      ]);
    }).pipe(Effect.provide(layerKeybindings())),
  );

  it.effect(
    "upserts missing default keybindings on startup without overriding existing command rules",
    () =>
      Effect.gen(function* () {
        const { keybindingsConfigPath } = yield* ServerConfig.ServerConfig;
        yield* writeKeybindingsConfig(keybindingsConfigPath, [
          { key: "mod+shift+y", command: "terminal.toggle" },
          { key: "mod+shift+r", command: "script.run-tests.run" },
          { key: "mod+shift+b", command: "script.custom-panel.run" },
          {
            key: "mod+shift+b",
            command: "script.custom-composer.run",
            when: "composerFocus",
          },
        ]);

        const keybindings = yield* Keybindings.Keybindings;
        yield* keybindings.syncDefaultKeybindingsOnStartup;

        const persisted = yield* readKeybindingsConfig(keybindingsConfigPath);
        const byCommand = new Map(persisted.map((entry) => [entry.command, entry]));

        const persistedToggle = byCommand.get("terminal.toggle");
        assert.isNotNull(persistedToggle);
        assert.equal(persistedToggle?.key, "mod+shift+y");
        assert.isFalse(
          persisted.some((entry) => entry.command === "terminal.toggle" && entry.key === "mod+j"),
        );

        for (const defaultRule of SharedKeybindings.DEFAULT_KEYBINDINGS) {
          assert.isTrue(byCommand.has(defaultRule.command), `expected ${defaultRule.command}`);
        }
        assert.isTrue(byCommand.has("script.run-tests.run"));

        const configState = yield* keybindings.loadConfigState;
        assert.deepEqual(
          configState.keybindings
            .filter((entry) => entry.shortcut.key === "b" && entry.shortcut.shiftKey)
            .map((entry) => entry.command),
          [
            "toolSidebar.toggle",
            "threadPanel.toggle",
            "script.custom-panel.run",
            "script.custom-composer.run",
          ],
        );
      }).pipe(Effect.provide(layerKeybindings())),
  );

  it.effect("adds a late default to an existing command once", () =>
    Effect.gen(function* () {
      const { keybindingsConfigPath } = yield* ServerConfig.ServerConfig;
      const keybindings = yield* Keybindings.Keybindings;
      const when = "composerFocus && draftThreadRoute";
      const existing = { key: "mod+alt+enter", command: "composer.sendBackground", when } as const;
      const closeTab = { key: "ctrl+alt+w", command: "workspace.tile.closeTab" } as const;
      const backgroundRules = Effect.map(readKeybindingsConfig(keybindingsConfigPath), (rules) =>
        rules.filter((entry) => entry.command === "composer.sendBackground"),
      );
      yield* writeKeybindingsConfig(keybindingsConfigPath, [
        existing,
        closeTab,
        { key: "ctrl+alt+arrowleft", command: "workspace.tile.focusLeft" },
        { key: "ctrl+alt+arrowdown", command: "workspace.tile.focusDown" },
        { key: "ctrl+alt+arrowup", command: "workspace.tile.focusUp" },
        { key: "ctrl+alt+arrowright", command: "workspace.tile.focusRight" },
        { key: "ctrl+alt+[", command: "workspace.tile.previousTab" },
        { key: "ctrl+alt+]", command: "workspace.tile.nextTab" },
      ]);

      yield* keybindings.syncDefaultKeybindingsOnStartup;
      const upgraded = yield* readKeybindingsConfig(keybindingsConfigPath);
      for (const [command, key] of [
        ["workspace.tile.focusLeft", "leader h"],
        ["workspace.tile.focusDown", "leader arrowdown"],
        ["workspace.tile.focusUp", "leader k"],
        ["workspace.tile.focusRight", "leader l"],
        ["workspace.tile.previousTab", "ctrl+shift+tab"],
        ["workspace.tile.nextTab", "ctrl+tab"],
      ])
        assert.isTrue(
          upgraded.some((rule) => rule.command === command && rule.key === key),
          `missing ${key}`,
        );
      assert.deepStrictEqual(yield* backgroundRules, [
        { key: "mod+enter", command: "composer.sendBackground", when },
        existing,
      ]);
      assert.deepStrictEqual(
        upgraded.filter((rule) => rule.command === "workspace.tile.closeTab"),
        [
          { key: "mod+w", command: "workspace.tile.closeTab" },
          { key: "leader x", command: "workspace.tile.closeTab" },
        ],
      );

      yield* writeKeybindingsConfig(keybindingsConfigPath, [
        existing,
        closeTab,
        { key: "ctrl+alt+arrowleft", command: "workspace.tile.focusLeft" },
      ]);
      yield* keybindings.syncDefaultKeybindingsOnStartup;
      assert.deepStrictEqual(yield* backgroundRules, [existing]);
      assert.deepStrictEqual(
        (yield* readKeybindingsConfig(keybindingsConfigPath)).filter(
          (rule) => rule.command === "workspace.tile.closeTab",
        ),
        [closeTab],
      );
      assert.deepStrictEqual(
        (yield* readKeybindingsConfig(keybindingsConfigPath)).filter(
          (rule) => rule.command === "workspace.tile.focusLeft",
        ),
        [{ key: "ctrl+alt+arrowleft", command: "workspace.tile.focusLeft" }],
      );
    }).pipe(Effect.provide(layerKeybindings())),
  );

  it.effect.each([
    { name: "leader", enabled: true },
    { name: "classic", enabled: false },
  ])("adds Cmd/Ctrl+T to a migrated $name config once", ({ enabled }) =>
    Effect.gen(function* () {
      const { keybindingsConfigPath } = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const keybindings = yield* Keybindings.Keybindings;
      const modT = { key: "mod+t", command: "workspace.tile.newTab", when: "isDesktop" } as const;
      yield* writeKeybindingsConfig(
        keybindingsConfigPath,
        SharedKeybindings.defaultKeybindingsForMode(enabled).filter(
          (rule) => rule.key !== modT.key,
        ),
      );
      // The ledger of a config saved before Cmd/Ctrl+T existed.
      yield* fs.writeFileString(
        path.join(path.dirname(keybindingsConfigPath), "keybindings-migrations"),
        [
          "composer.sendBackground:mod+enter",
          "workspace.tile.focusLeft:ctrl+alt+h",
          "workspace.tile.focusDown:ctrl+alt+j",
          "workspace.tile.focusUp:ctrl+alt+k",
          "workspace.tile.focusRight:ctrl+alt+l",
          "workspace.tile.previousTab:ctrl+shift+tab",
          "workspace.tile.nextTab:ctrl+tab",
          "weavewing.search-palette.v1",
          "weavewing.terminal-keys.v1",
          "weavewing.leader.v1",
          "weavewing.leader-arrow-left.v1",
          "weavewing.leader-arrow-down.v1",
          "weavewing.leader-arrow-up.v1",
          "weavewing.leader-arrow-right.v1",
          "weavewing.mac-tab-keys.thread-previous.v1",
          "weavewing.mac-tab-keys.tab-previous.v1",
          "weavewing.mac-tab-keys.thread-next.v1",
          "weavewing.mac-tab-keys.tab-next.v1",
          "weavewing.new-thread-mod-n.v2",
          "weavewing.dropdown-mod-j.v1",
          "weavewing.leader-tile-focus.v1",
          "weavewing.mac-ctrl-k.v1",
          "",
        ].join("\n"),
      );

      yield* keybindings.syncDefaultKeybindingsOnStartup;
      yield* keybindings.syncDefaultKeybindingsOnStartup;
      const newTab = (yield* readKeybindingsConfig(keybindingsConfigPath)).filter(
        (rule) => rule.command === "workspace.tile.newTab",
      );
      assert.sameDeepMembers(newTab, [
        modT,
        { key: enabled ? "leader t" : "ctrl+alt+o", command: "workspace.tile.newTab" },
      ]);
    }).pipe(Effect.provide(layerKeybindings())),
  );

  it.effect("leaves a customized command without the late default", () =>
    Effect.gen(function* () {
      const { keybindingsConfigPath } = yield* ServerConfig.ServerConfig;
      const keybindings = yield* Keybindings.Keybindings;
      const custom = {
        key: "alt+b",
        command: "composer.sendBackground",
        when: "composerFocus && draftThreadRoute",
      } as const;
      const customCloseTab = { key: "ctrl+alt+q", command: "workspace.tile.closeTab" } as const;
      yield* writeKeybindingsConfig(keybindingsConfigPath, [custom, customCloseTab]);

      yield* keybindings.syncDefaultKeybindingsOnStartup;
      const persisted = yield* readKeybindingsConfig(keybindingsConfigPath);
      assert.deepStrictEqual(
        persisted.filter((entry) => entry.command === "composer.sendBackground"),
        [custom],
      );
      assert.deepStrictEqual(
        persisted.filter((entry) => entry.command === "workspace.tile.closeTab"),
        [customCloseTab],
      );
    }).pipe(Effect.provide(layerKeybindings())),
  );

  it.effect.each(["mod+w", "ctrl+w", "meta+w"])(
    "preserves a conditional customized %s during the terminal migration",
    (key) =>
      Effect.gen(function* () {
        const { keybindingsConfigPath } = yield* ServerConfig.ServerConfig;
        const keybindings = yield* Keybindings.Keybindings;
        const legacy = {
          key: "meta+w",
          command: "workspace.tile.closeTab",
          when: "isMac",
        } as const;
        const alias = { key: "ctrl+alt+w", command: "workspace.tile.closeTab" } as const;
        const custom = { key, command: "script.custom-close.run", when: "terminalFocus" } as const;
        yield* writeKeybindingsConfig(keybindingsConfigPath, [custom, legacy, alias]);
        yield* keybindings.syncDefaultKeybindingsOnStartup;
        const upgraded = yield* readKeybindingsConfig(keybindingsConfigPath);
        assert.deepEqual(
          upgraded.filter((rule) => rule.command === "workspace.tile.closeTab"),
          [legacy],
        );
        assert.deepInclude(upgraded, custom);
      }).pipe(Effect.provide(layerKeybindings())),
  );

  it.effect("keeps a late default pending while the config is full", () =>
    Effect.gen(function* () {
      const { keybindingsConfigPath } = yield* ServerConfig.ServerConfig;
      const keybindings = yield* Keybindings.Keybindings;
      const when = "composerFocus && draftThreadRoute";
      const existing = { key: "mod+alt+enter", command: "composer.sendBackground", when } as const;
      const fillers = Array.from({ length: MAX_KEYBINDINGS_COUNT - 1 }, (_, index) => ({
        key: "mod+alt+f1",
        command: `script.filler-${index}.run` as const,
      }));
      const hasModEnter = Effect.map(readKeybindingsConfig(keybindingsConfigPath), (rules) =>
        rules.some(
          (entry) => entry.command === "composer.sendBackground" && entry.key === "mod+enter",
        ),
      );

      yield* writeKeybindingsConfig(keybindingsConfigPath, [existing, ...fillers]);
      yield* keybindings.syncDefaultKeybindingsOnStartup;
      assert.isFalse(yield* hasModEnter);
      const beforeToggle = yield* readKeybindingsConfig(keybindingsConfigPath);
      const toggle = yield* toDetailResult(
        keybindings.upsertKeybindingRule({
          command: "keybindings.leader",
          key: "ctrl+a",
          when: "false",
        }),
      );
      assertFailure(toggle, "Remove a keybinding to make room for the leader setting.");
      assert.deepEqual(yield* readKeybindingsConfig(keybindingsConfigPath), beforeToggle);

      yield* writeKeybindingsConfig(keybindingsConfigPath, [existing]);
      yield* keybindings.syncDefaultKeybindingsOnStartup;
      assert.isTrue(yield* hasModEnter);
    }).pipe(Effect.provide(layerKeybindings())),
  );

  it.effect("skips conflicting default keybindings on startup and logs a detailed warning", () => {
    const messages: string[] = [];
    const logger = Logger.make(({ message }) => {
      messages.push(String(message));
    });

    return Effect.gen(function* () {
      const { keybindingsConfigPath } = yield* ServerConfig.ServerConfig;
      yield* writeKeybindingsConfig(keybindingsConfigPath, [
        { key: "mod+j", command: "script.custom-action.run" },
      ]);

      yield* Effect.gen(function* () {
        const keybindings = yield* Keybindings.Keybindings;
        yield* keybindings.syncDefaultKeybindingsOnStartup;
      });

      const persisted = yield* readKeybindingsConfig(keybindingsConfigPath);
      assert.isFalse(persisted.some((entry) => entry.command === "terminal.dropdown"));
      assert.isTrue(persisted.some((entry) => entry.command === "script.custom-action.run"));

      assert.isTrue(
        messages.some((message) =>
          message.includes("skipping default keybinding due to shortcut conflict"),
        ),
      );
    }).pipe(
      Effect.provide(
        Layer.mergeAll(layerKeybindings(), Logger.layer([logger], { mergeWithExisting: false })),
      ),
    );
  });

  it.effect("appends additional custom keybindings for the same command", () =>
    Effect.gen(function* () {
      const { keybindingsConfigPath } = yield* ServerConfig.ServerConfig;
      yield* writeKeybindingsConfig(keybindingsConfigPath, [
        { key: "mod+r", command: "script.run-tests.run" },
      ]);
      yield* Effect.gen(function* () {
        const keybindings = yield* Keybindings.Keybindings;
        return yield* keybindings.upsertKeybindingRule({
          key: "mod+shift+r",
          command: "script.run-tests.run",
        });
      });

      const persisted = yield* readKeybindingsConfig(keybindingsConfigPath);
      const persistedView = persisted.map(({ key, command }) => ({ key, command }));
      assert.deepEqual(persistedView, [
        { key: "mod+r", command: "script.run-tests.run" },
        { key: "mod+shift+r", command: "script.run-tests.run" },
      ]);
    }).pipe(Effect.provide(layerKeybindings())),
  );

  it.effect("replaces only the targeted custom keybinding", () =>
    Effect.gen(function* () {
      const { keybindingsConfigPath } = yield* ServerConfig.ServerConfig;
      yield* writeKeybindingsConfig(keybindingsConfigPath, [
        { key: "mod+r", command: "script.run-tests.run" },
        { key: "mod+shift+r", command: "script.run-tests.run" },
      ]);
      yield* Effect.gen(function* () {
        const keybindings = yield* Keybindings.Keybindings;
        return yield* keybindings.upsertKeybindingRule({
          key: "mod+alt+r",
          command: "script.run-tests.run",
          replace: { key: "mod+r", command: "script.run-tests.run" },
        });
      });

      const persisted = yield* readKeybindingsConfig(keybindingsConfigPath);
      const persistedView = persisted.map(({ key, command }) => ({ key, command }));
      assert.deepEqual(persistedView, [
        { key: "mod+shift+r", command: "script.run-tests.run" },
        { key: "mod+alt+r", command: "script.run-tests.run" },
      ]);
    }).pipe(Effect.provide(layerKeybindings())),
  );

  it.effect("replacing with a rule that already exists elsewhere does not duplicate it", () =>
    Effect.gen(function* () {
      const { keybindingsConfigPath } = yield* ServerConfig.ServerConfig;
      yield* writeKeybindingsConfig(keybindingsConfigPath, [
        { key: "mod+r", command: "script.run-tests.run" },
        { key: "mod+alt+r", command: "script.run-tests.run" },
      ]);
      yield* Effect.gen(function* () {
        const keybindings = yield* Keybindings.Keybindings;
        return yield* keybindings.upsertKeybindingRule({
          key: "mod+alt+r",
          command: "script.run-tests.run",
          replace: { key: "mod+r", command: "script.run-tests.run" },
        });
      });

      const persisted = yield* readKeybindingsConfig(keybindingsConfigPath);
      const persistedView = persisted.map(({ key, command }) => ({ key, command }));
      assert.deepEqual(persistedView, [{ key: "mod+alt+r", command: "script.run-tests.run" }]);
    }).pipe(Effect.provide(layerKeybindings())),
  );

  it.effect("removes only the targeted custom keybinding", () =>
    Effect.gen(function* () {
      const { keybindingsConfigPath } = yield* ServerConfig.ServerConfig;
      yield* writeKeybindingsConfig(keybindingsConfigPath, [
        { key: "mod+r", command: "script.run-tests.run" },
        { key: "mod+shift+r", command: "script.run-tests.run" },
      ]);
      yield* Effect.gen(function* () {
        const keybindings = yield* Keybindings.Keybindings;
        return yield* keybindings.removeKeybindingRule({
          key: "mod+r",
          command: "script.run-tests.run",
        });
      });

      const persisted = yield* readKeybindingsConfig(keybindingsConfigPath);
      const persistedView = persisted.map(({ key, command }) => ({ key, command }));
      assert.deepEqual(persistedView, [{ key: "mod+shift+r", command: "script.run-tests.run" }]);
    }).pipe(Effect.provide(layerKeybindings())),
  );

  it.effect("keeps entries it cannot decode when editing other keybindings", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { keybindingsConfigPath } = yield* ServerConfig.ServerConfig;
      const futureCommand = { key: "mod+shift+k", command: "command.from-a-newer-build" };
      const badShortcut = { key: "mod+shift+d+o", command: "workspace.tile.newTab" };
      yield* fs.writeFileString(
        keybindingsConfigPath,
        JSON.stringify([
          { key: "mod+r", command: "script.run-tests.run" },
          futureCommand,
          badShortcut,
        ]),
      );
      const keybindings = yield* Keybindings.Keybindings;
      const persisted = Effect.map(fs.readFileString(keybindingsConfigPath), JSON.parse);

      const saved = yield* keybindings.upsertKeybindingRule({
        key: "mod+shift+r",
        command: "script.run-tests.run",
      });
      assert.equal(saved.issues.length, 2);
      assert.deepEqual(yield* persisted, [
        { key: "mod+r", command: "script.run-tests.run" },
        futureCommand,
        badShortcut,
        { key: "mod+shift+r", command: "script.run-tests.run" },
      ]);

      const removed = yield* keybindings.removeKeybindingRule({
        key: "mod+r",
        command: "script.run-tests.run",
      });
      assert.deepEqual(yield* persisted, [
        futureCommand,
        badShortcut,
        { key: "mod+shift+r", command: "script.run-tests.run" },
      ]);
      const { issues } = yield* keybindings.loadConfigState;
      assert.deepEqual(removed.issues, issues);
      assert.deepEqual(
        issues.map((issue) => issue.kind === "keybindings.invalid-entry" && issue.index),
        [0, 1],
      );
    }).pipe(Effect.provide(layerKeybindings())),
  );

  it.effect("removes a hand-written keybinding targeted by its settings spelling", () =>
    Effect.gen(function* () {
      const { keybindingsConfigPath } = yield* ServerConfig.ServerConfig;
      yield* writeKeybindingsConfig(keybindingsConfigPath, [
        {
          key: "Shift+Cmd+R",
          command: "script.run-tests.run",
          when: "terminalFocus&&!previewFocus",
        },
        { key: "mod+shift+r", command: "script.run-tests.run" },
        { key: "x\u0000true", command: "script.run-tests.run" },
        { key: "x", command: "script.run-tests.run", when: "true" },
      ]);
      yield* Effect.gen(function* () {
        const keybindings = yield* Keybindings.Keybindings;
        yield* keybindings.removeKeybindingRule({
          key: "meta+shift+r",
          command: "script.run-tests.run",
          when: "terminalFocus && !previewFocus",
        });
        yield* keybindings.removeKeybindingRule({
          key: "x",
          command: "script.run-tests.run",
          when: "true",
        });
      });

      const persisted = yield* readKeybindingsConfig(keybindingsConfigPath);
      assert.deepEqual(persisted, [
        { key: "mod+shift+r", command: "script.run-tests.run" },
        { key: "x\u0000true", command: "script.run-tests.run" },
      ]);
    }).pipe(Effect.provide(layerKeybindings())),
  );

  it.effect("replaces a hand-written keybinding targeted by its settings spelling", () =>
    Effect.gen(function* () {
      const { keybindingsConfigPath } = yield* ServerConfig.ServerConfig;
      yield* writeKeybindingsConfig(keybindingsConfigPath, [
        { key: "escape", command: "script.run-tests.run", when: "a && b && c" },
      ]);
      yield* Effect.gen(function* () {
        const keybindings = yield* Keybindings.Keybindings;
        return yield* keybindings.upsertKeybindingRule({
          key: "mod+alt+r",
          command: "script.run-tests.run",
          replace: { key: "esc", command: "script.run-tests.run", when: "(a && b) && c" },
        });
      });

      const persisted = yield* readKeybindingsConfig(keybindingsConfigPath);
      assert.deepEqual(persisted, [{ key: "mod+alt+r", command: "script.run-tests.run" }]);
    }).pipe(Effect.provide(layerKeybindings())),
  );

  it.effect("refuses to overwrite malformed keybindings config", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { keybindingsConfigPath } = yield* ServerConfig.ServerConfig;
      yield* fs.writeFileString(keybindingsConfigPath, "{ not-json");

      const result = yield* Effect.gen(function* () {
        const keybindings = yield* Keybindings.Keybindings;
        return yield* keybindings.upsertKeybindingRule({
          key: "mod+shift+r",
          command: "script.run-tests.run",
        });
      }).pipe(toDetailResult);
      assertFailure(result, "expected JSON array");

      const persistedRaw = yield* fs.readFileString(keybindingsConfigPath);
      assert.equal(persistedRaw, "{ not-json");
    }).pipe(Effect.provide(layerKeybindings())),
  );

  it.effect("retries a failed config read instead of keeping the failure", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const { keybindingsConfigPath } = yield* ServerConfig.ServerConfig;
      yield* fileSystem.makeDirectory(keybindingsConfigPath, { recursive: true });

      const keybindings = yield* Keybindings.Keybindings;
      const failed = yield* toDetailResult(keybindings.loadConfigState);
      assertFailure(failed, "failed to read keybindings config");

      yield* fileSystem.remove(keybindingsConfigPath, { recursive: true });
      yield* writeKeybindingsConfig(keybindingsConfigPath, [
        { key: "mod+j", command: "terminal.toggle" },
      ]);

      const configState = yield* keybindings.loadConfigState;
      assert.deepEqual(configState.issues, []);
      assert.isTrue(configState.keybindings.some((entry) => entry.command === "terminal.toggle"));
    }).pipe(Effect.provide(layerKeybindings())),
  );

  it.effect("serializes concurrent upserts to avoid lost updates", () =>
    Effect.gen(function* () {
      const { keybindingsConfigPath } = yield* ServerConfig.ServerConfig;
      yield* writeKeybindingsConfig(keybindingsConfigPath, []);

      const commands = Array.from(
        { length: 20 },
        (_, index): KeybindingCommand => `script.concurrent-${index}.run`,
      );
      yield* Effect.gen(function* () {
        const keybindings = yield* Keybindings.Keybindings;
        yield* Effect.forEach(
          commands,
          (command, index) =>
            keybindings.upsertKeybindingRule({
              key: `mod+${String.fromCharCode(97 + index)}`,
              command,
            }),
          { concurrency: "unbounded", discard: true },
        );
      });

      const persisted = yield* readKeybindingsConfig(keybindingsConfigPath);
      const persistedCommands = new Set(persisted.map((entry) => entry.command));
      for (const command of commands) {
        assert.isTrue(persistedCommands.has(command), `expected persisted command ${command}`);
      }
    }).pipe(Effect.provide(layerKeybindings())),
  );

  it.effect(
    "suppresses change emission when revalidating unchanged keybindings configuration",
    () =>
      Effect.gen(function* () {
        const { keybindingsConfigPath } = yield* ServerConfig.ServerConfig;
        yield* writeKeybindingsConfig(keybindingsConfigPath, [
          { key: "mod+j", command: "terminal.toggle" },
        ]);

        const keybindings = yield* Keybindings.Keybindings;
        yield* keybindings.start;

        const changes = yield* keybindings.subscribeChanges;

        // Revalidate when config on disk has not changed (e.g. atime bump on Windows).
        // `revalidate` publishes before it returns, so a wrongly emitted event would be
        // buffered in the subscription ahead of the real change observed below.
        yield* keybindings.revalidate;

        yield* writeKeybindingsConfig(keybindingsConfigPath, [
          { key: "mod+j", command: "terminal.toggle" },
          { key: "mod+k", command: "threadPanel.toggle" },
        ]);
        yield* keybindings.revalidate;

        // The first buffered event must be the real change, not the unchanged state.
        const change = Option.getOrThrow(yield* Stream.runHead(changes));
        assert.isTrue(
          change.keybindings.some(
            (rule) =>
              rule.command === "threadPanel.toggle" &&
              rule.shortcut.key === "k" &&
              rule.shortcut.modKey,
          ),
        );
      }).pipe(Effect.scoped, Effect.provide(layerKeybindings())),
  );

  it.effect.each<{
    readonly name: string;
    readonly saved: ReadonlyArray<KeybindingRule>;
    readonly expected: ReadonlyArray<KeybindingRule>;
  }>([
    {
      name: "keeps a custom binding on the new picker key",
      saved: [
        { key: "mod+shift+o", command: "chat.find", when: "!terminalFocus" },
        { key: "mod+alt+shift+o", command: "projectPicker.open", when: "!terminalFocus" },
      ],
      expected: [
        { key: "mod+shift+o", command: "chat.find", when: "!terminalFocus" },
        { key: "mod+alt+shift+o", command: "projectPicker.open", when: "!terminalFocus" },
      ],
    },
    {
      name: "moves the picker when only the untouched old New thread default held the key",
      saved: [
        { key: "mod+shift+o", command: "chat.new", when: "!terminalFocus" },
        { key: "mod+alt+shift+o", command: "projectPicker.open", when: "!terminalFocus" },
      ],
      expected: [{ key: "mod+shift+o", command: "projectPicker.open", when: "!terminalFocus" }],
    },
    {
      name: "keeps a customized New thread binding on the key",
      saved: [
        { key: "mod+shift+o", command: "chat.new" },
        { key: "mod+alt+shift+o", command: "projectPicker.open", when: "!terminalFocus" },
      ],
      expected: [
        { key: "mod+shift+o", command: "chat.new" },
        { key: "mod+alt+shift+o", command: "projectPicker.open", when: "!terminalFocus" },
      ],
    },
    {
      name: "leaves a customized picker key alone",
      saved: [{ key: "ctrl+p", command: "projectPicker.open" }],
      expected: [{ key: "ctrl+p", command: "projectPicker.open" }],
    },
  ])("picker key migration: $name, and a second run changes nothing", ({ saved, expected }) =>
    Effect.gen(function* () {
      const { keybindingsConfigPath } = yield* ServerConfig.ServerConfig;
      const keybindings = yield* Keybindings.Keybindings;
      const unrelated = { key: "alt+q", command: "workspace.tile.closeAllTabs" } as const;
      yield* writeKeybindingsConfig(keybindingsConfigPath, [...saved, unrelated]);
      yield* keybindings.syncDefaultKeybindingsOnStartup;
      const first = yield* readKeybindingsConfig(keybindingsConfigPath);
      const onPickerKeys = (rules: typeof first) =>
        rules.filter(
          (rule) =>
            rule.command === "projectPicker.open" ||
            ["mod+shift+o", "mod+alt+shift+o"].includes(rule.key),
        );
      assert.deepEqual(onPickerKeys(first), expected);
      assert.deepInclude(first, unrelated);
      yield* keybindings.syncDefaultKeybindingsOnStartup;
      assert.deepEqual(yield* readKeybindingsConfig(keybindingsConfigPath), first);
    }).pipe(Effect.provide(layerKeybindings())),
  );

  const NEW_THREAD_KEY_MIGRATION = "weavewing.new-thread-mod-n.v2";
  const stranded = { key: "mod+alt+n", command: "chat.new", when: "!terminalFocus" } as const;
  const restored = { key: "mod+n", command: "chat.new", when: "!terminalFocus" } as const;
  // The shape of a real saved file: New thread and the removed default-folder command swapped keys.
  const swappedSaved = [
    { key: "ctrl+`", command: "terminal.dropdown" },
    { key: "mod+shift+o", command: "projectPicker.open", when: "!terminalFocus" },
    { key: "mod+n", command: "chat.newWithoutProject", when: "!terminalFocus" },
    { key: "mod+shift+n", command: "chat.newLocal", when: "!terminalFocus" },
    stranded,
    { key: "mod+f", command: "chat.find", when: "!terminalFocus && !previewFocus" },
  ] as const;
  const fullFile = (extra: ReadonlyArray<KeybindingRule>) => [
    ...extra,
    ...Array.from({ length: MAX_KEYBINDINGS_COUNT - extra.length }, (_, index) => ({
      key: "mod+alt+f1",
      command: `script.filler-${index}.run` as const,
    })),
  ];

  it.effect.each<{
    readonly name: string;
    readonly saved: ReadonlyArray<unknown> | null;
    readonly newThreadRules: ReadonlyArray<KeybindingRule>;
  }>([
    {
      name: "stranded on Ctrl+Alt+N with Ctrl+N free: moved in place",
      saved: [
        { key: "mod+b", command: "sidebar.toggle" },
        stranded,
        { key: "mod+f", command: "chat.find" },
      ],
      newThreadRules: [restored],
    },
    {
      name: "the swapped pair keeps both keys on New thread",
      saved: swappedSaved,
      newThreadRules: [restored, stranded],
    },
    {
      name: "a conditional Ctrl+N keeps the Ctrl+Alt+N alternate",
      saved: [{ key: "mod+n", command: "chat.new", when: "terminalFocus" }, stranded],
      newThreadRules: [{ key: "mod+n", command: "chat.new", when: "terminalFocus" }, stranded],
    },
    {
      name: "a customized New thread key gains nothing",
      saved: [{ key: "mod+x", command: "chat.new" }],
      newThreadRules: [{ key: "mod+x", command: "chat.new" }],
    },
    {
      name: "the user's own Ctrl+N keeps the key",
      saved: [{ key: "ctrl+n", command: "sidebar.toggle", when: "terminalFocus" }, stranded],
      newThreadRules: [stranded],
    },
    {
      name: "a full file is repaired in place",
      saved: fullFile([stranded]),
      newThreadRules: [restored],
    },
    {
      name: "a full file with New thread elsewhere gains nothing",
      saved: fullFile([{ key: "ctrl+alt+f1", command: "chat.new" }]),
      newThreadRules: [{ key: "ctrl+alt+f1", command: "chat.new" }],
    },
    {
      name: "a fresh install",
      saved: null,
      newThreadRules: [restored],
    },
  ])(
    "New thread key migration: $name, recorded once, second run unchanged",
    ({ saved, newThreadRules }) =>
      Effect.gen(function* () {
        const { keybindingsConfigPath } = yield* ServerConfig.ServerConfig;
        const keybindings = yield* Keybindings.Keybindings;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const ledger = path.join(path.dirname(keybindingsConfigPath), "keybindings-migrations");
        if (saved) {
          yield* fs.makeDirectory(path.dirname(keybindingsConfigPath), { recursive: true });
          yield* fs.writeFileString(keybindingsConfigPath, JSON.stringify(saved));
        }
        yield* keybindings.syncDefaultKeybindingsOnStartup;
        const first = yield* readKeybindingsConfig(keybindingsConfigPath);
        assert.deepEqual(
          first.filter((rule) => rule.command === "chat.new"),
          newThreadRules,
        );
        assert.include(yield* fs.readFileString(ledger), NEW_THREAD_KEY_MIGRATION);
        yield* keybindings.syncDefaultKeybindingsOnStartup;
        assert.deepEqual(yield* readKeybindingsConfig(keybindingsConfigPath), first);
      }).pipe(Effect.provide(layerKeybindings())),
  );

  const oldToggle = {
    key: "mod+j",
    command: "terminal.toggle",
    when: "isMac || !terminalFocus",
  } as const;
  const oldDropdown = { key: "ctrl+`", command: "terminal.dropdown" } as const;
  const oldFocusDown = { key: "leader j", command: "workspace.tile.focusDown" } as const;
  const arrowDown = { key: "leader arrowdown", command: "workspace.tile.focusDown" } as const;
  const onTerminalKeys = (rules: ReadonlyArray<KeybindingRule>) =>
    rules.filter(
      (rule) =>
        rule.command === "terminal.toggle" ||
        rule.command === "terminal.dropdown" ||
        rule.key === "leader j",
    );

  it.effect.each<{
    readonly name: string;
    readonly saved: ReadonlyArray<KeybindingRule> | null;
    readonly expected: ReadonlyArray<KeybindingRule>;
  }>([
    {
      name: "untouched defaults move",
      saved: [oldToggle, oldDropdown, oldFocusDown, arrowDown],
      expected: [{ key: "mod+j", command: "terminal.dropdown" }, oldFocusDown],
    },
    {
      name: "a custom drop-down key leaves every old key",
      saved: [oldToggle, { key: "f12", command: "terminal.dropdown" }, oldFocusDown, arrowDown],
      expected: [oldToggle, { key: "f12", command: "terminal.dropdown" }, oldFocusDown],
    },
    {
      name: "another command on Ctrl+J, however spelled, leaves every old key",
      saved: [
        oldToggle,
        oldDropdown,
        oldFocusDown,
        arrowDown,
        { key: "mod+ctrl+j", command: "sidebar.toggle", when: "terminalFocus" },
      ],
      expected: [oldToggle, oldDropdown, oldFocusDown],
    },
    {
      name: "Focus Down keeps Leader then j when its arrow key does something else",
      saved: [
        oldToggle,
        oldDropdown,
        oldFocusDown,
        { key: "leader arrowdown", command: "workspace.tile.splitDown" },
      ],
      expected: [oldToggle, oldDropdown, oldFocusDown],
    },
    {
      name: "Focus Down keeps Leader then j when a scoped rule shadows its arrow key",
      saved: [
        oldToggle,
        oldDropdown,
        oldFocusDown,
        arrowDown,
        { key: "leader arrowdown", command: "workspace.tile.splitDown", when: "terminalFocus" },
      ],
      expected: [oldToggle, oldDropdown, oldFocusDown],
    },
    {
      name: "with the leader off, the thread terminal keeps Ctrl/Cmd+J",
      saved: [
        oldToggle,
        oldDropdown,
        oldFocusDown,
        arrowDown,
        { key: "ctrl+a", command: "keybindings.leader", when: "false" },
      ],
      expected: [oldToggle, oldDropdown, oldFocusDown],
    },
    {
      name: "a fresh install",
      saved: null,
      expected: [{ key: "mod+j", command: "terminal.dropdown" }, oldFocusDown],
    },
  ])("drop-down key migration: $name, recorded once", ({ saved, expected }) =>
    Effect.gen(function* () {
      const { keybindingsConfigPath } = yield* ServerConfig.ServerConfig;
      const keybindings = yield* Keybindings.Keybindings;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      if (saved) {
        yield* writeKeybindingsConfig(keybindingsConfigPath, saved);
        // A current saved file has already taken the leader preset.
        yield* fs.writeFileString(
          path.join(path.dirname(keybindingsConfigPath), "keybindings-migrations"),
          `weavewing.leader.v1\n${NEW_THREAD_KEY_MIGRATION}\n`,
        );
      }
      yield* keybindings.syncDefaultKeybindingsOnStartup;
      const first = yield* readKeybindingsConfig(keybindingsConfigPath);
      assert.sameDeepMembers(onTerminalKeys(first), [...expected]);
      assert.include(
        yield* fs.readFileString(
          path.join(path.dirname(keybindingsConfigPath), "keybindings-migrations"),
        ),
        "weavewing.dropdown-mod-j.v1",
      );
      yield* keybindings.syncDefaultKeybindingsOnStartup;
      assert.deepEqual(yield* readKeybindingsConfig(keybindingsConfigPath), first);
    }).pipe(Effect.provide(layerKeybindings())),
  );

  it.effect("upgrades installed leader defaults while keeping custom terminal and tab rules", () =>
    Effect.gen(function* () {
      const { keybindingsConfigPath } = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const keybindings = yield* Keybindings.Keybindings;
      const dropdown = { key: "mod+j", command: "terminal.dropdown" } as const;
      const custom = [
        { key: "leader T", command: "terminal.toggle" },
        { key: "leader 2", command: "workspace.tile.tab.1", when: "terminalFocus" },
        { key: "leader 3", command: "workspace.tile.actions" },
      ] as const;
      yield* writeKeybindingsConfig(keybindingsConfigPath, [
        dropdown,
        arrowDown,
        { key: "leader j", command: "terminal.toggle" },
        { key: "leader 1", command: "workspace.tile.tab.1" },
        { key: "leader 2", command: "workspace.tile.tab.2" },
        { key: "leader 3", command: "workspace.tile.tab.3" },
        { key: "leader 4", command: "workspace.tile.tab.4", when: "false" },
        ...custom,
      ]);
      yield* fs.writeFileString(
        path.join(path.dirname(keybindingsConfigPath), "keybindings-migrations"),
        `weavewing.leader.v1\n${NEW_THREAD_KEY_MIGRATION}\nweavewing.dropdown-mod-j.v1\n`,
      );

      yield* keybindings.syncDefaultKeybindingsOnStartup;
      const first = yield* readKeybindingsConfig(keybindingsConfigPath);
      assert.sameDeepMembers(
        first.filter((rule) =>
          [
            "leader j",
            "leader arrowdown",
            "mod+j",
            "leader T",
            "leader 1",
            "leader 2",
            "leader 3",
            "leader 4",
          ].includes(rule.key),
        ),
        [
          dropdown,
          arrowDown,
          oldFocusDown,
          { key: "leader 1", command: "workspace.tile.focus.1" },
          { key: "leader 2", command: "workspace.tile.focus.2" },
          { key: "leader 4", command: "workspace.tile.tab.4", when: "false" },
          { key: "leader 4", command: "workspace.tile.focus.4", when: "false" },
          ...custom,
        ],
      );
      yield* keybindings.syncDefaultKeybindingsOnStartup;
      assert.deepEqual(yield* readKeybindingsConfig(keybindingsConfigPath), first);
    }).pipe(Effect.provide(layerKeybindings())),
  );

  it.effect("keeps the New thread key migration pending while the file has issues", () =>
    Effect.gen(function* () {
      const { keybindingsConfigPath } = yield* ServerConfig.ServerConfig;
      const keybindings = yield* Keybindings.Keybindings;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const ledger = path.join(path.dirname(keybindingsConfigPath), "keybindings-migrations");
      yield* fs.makeDirectory(path.dirname(keybindingsConfigPath), { recursive: true });
      yield* fs.writeFileString(
        keybindingsConfigPath,
        JSON.stringify([stranded, { key: "ctrl+q", command: "not.a.command" }]),
      );
      yield* keybindings.syncDefaultKeybindingsOnStartup;
      const pending = yield* fs.readFileString(ledger).pipe(Effect.orElseSucceed(() => ""));
      assert.notInclude(pending, NEW_THREAD_KEY_MIGRATION);

      yield* writeKeybindingsConfig(keybindingsConfigPath, [stranded]);
      yield* keybindings.syncDefaultKeybindingsOnStartup;
      assert.deepEqual(
        (yield* readKeybindingsConfig(keybindingsConfigPath)).filter(
          (rule) => rule.command === "chat.new",
        ),
        [restored],
      );
      assert.include(yield* fs.readFileString(ledger), NEW_THREAD_KEY_MIGRATION);
    }).pipe(Effect.provide(layerKeybindings())),
  );

  it.effect.each<{
    readonly name: string;
    readonly saved: ReadonlyArray<unknown>;
    readonly expected: ReadonlyArray<KeybindingRule>;
  }>([
    {
      name: "a removed command with a replacement keeps the user's key and condition",
      saved: [{ key: "ctrl+d", command: "chat.newWithoutProject", when: "!terminalFocus" }],
      expected: [{ key: "ctrl+d", command: "chat.new", when: "!terminalFocus" }],
    },
    {
      name: "a remap that would repeat an existing rule is dropped",
      saved: [
        { key: "mod+alt+n", command: "chat.newWithoutProject", when: "!terminalFocus" },
        stranded,
      ],
      expected: [stranded],
    },
    {
      name: "a removed command without a replacement is dropped",
      saved: [{ key: "ctrl+alt+shift+f9", command: "terminal.split", when: "terminalFocus" }],
      expected: [],
    },
  ])("removed commands: $name", ({ saved, expected }) =>
    Effect.gen(function* () {
      const { keybindingsConfigPath } = yield* ServerConfig.ServerConfig;
      const keybindings = yield* Keybindings.Keybindings;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const unrelated = { key: "alt+q", command: "workspace.tile.closeAllTabs" } as const;
      const ledger = path.join(path.dirname(keybindingsConfigPath), "keybindings-migrations");
      yield* fs.makeDirectory(path.dirname(keybindingsConfigPath), { recursive: true });
      // Keeps the New thread key migration out of the way of the remap under test.
      yield* fs.writeFileString(ledger, `${NEW_THREAD_KEY_MIGRATION}\n`);
      yield* fs.writeFileString(keybindingsConfigPath, JSON.stringify([...saved, unrelated]));
      const runtime = yield* keybindings.loadConfigState;
      assert.deepEqual(runtime.issues, []);
      yield* keybindings.syncDefaultKeybindingsOnStartup;
      const first = yield* readKeybindingsConfig(keybindingsConfigPath);
      const savedKeys = new Set(saved.map((entry) => (entry as KeybindingRule).key));
      const touched = (rules: ReadonlyArray<KeybindingRule>) =>
        rules.filter((rule) => savedKeys.has(rule.key));
      assert.deepEqual(touched(first), expected);
      assert.deepInclude(first, unrelated);
      yield* keybindings.syncDefaultKeybindingsOnStartup;
      assert.deepEqual(yield* readKeybindingsConfig(keybindingsConfigPath), first);
    }).pipe(Effect.provide(layerKeybindings())),
  );

  it.effect("upgrades the old Mac close backfill once and preserves later edits", () =>
    Effect.gen(function* () {
      const { keybindingsConfigPath } = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const keybindings = yield* Keybindings.Keybindings;
      const legacy = { key: "meta+w", command: "workspace.tile.closeTab", when: "isMac" } as const;
      const custom = { key: "alt+q", command: "workspace.tile.closeAllTabs" } as const;
      yield* writeKeybindingsConfig(keybindingsConfigPath, [
        legacy,
        custom,
        { key: "f6", command: "workspace.focusNext" },
        { key: "mod+6", command: "thread.jump.6", when: "!modelPickerOpen && isDesktop" },
        { key: "mod+shift+j", command: "preview.toggle" },
        { key: "mod+shift+o", command: "chat.new", when: "!terminalFocus" },
        { key: "mod+alt+shift+o", command: "projectPicker.open", when: "!terminalFocus" },
      ]);
      yield* fs.writeFileString(
        path.join(path.dirname(keybindingsConfigPath), "keybindings-migrations"),
        "workspace.tile.closeTab:meta+w\n",
      );
      yield* keybindings.syncDefaultKeybindingsOnStartup;
      const upgraded = yield* readKeybindingsConfig(keybindingsConfigPath);
      assert.deepEqual(
        upgraded.filter((rule) => rule.command === "workspace.tile.closeTab"),
        [
          { key: "mod+w", command: "workspace.tile.closeTab" },
          { key: "leader x", command: "workspace.tile.closeTab" },
        ],
      );
      assert.deepEqual(
        upgraded.filter((rule) => rule.command === "workspace.tile.closeAllTabs"),
        [custom],
      );
      assert.deepInclude(upgraded, {
        key: "f6",
        command: "workspace.focusNext",
        when: "!terminalFocus",
      });
      assert.deepInclude(upgraded, {
        key: "mod+6",
        command: "thread.jump.6",
        when: "!modelPickerOpen && isDesktop && (isMac || !terminalFocus)",
      });
      assert.deepInclude(upgraded, {
        key: "mod+shift+j",
        command: "preview.toggle",
        when: "isMac || !terminalFocus",
      });
      // The old second New thread key becomes the project picker's.
      assert.deepEqual(
        upgraded.filter((rule) => rule.key === "mod+shift+o" || rule.key === "mod+alt+shift+o"),
        [{ key: "mod+shift+o", command: "projectPicker.open", when: "!terminalFocus" }],
      );
      const oldPickerKey = {
        key: "mod+alt+shift+o",
        command: "projectPicker.open",
        when: "!terminalFocus",
      } as const;
      yield* writeKeybindingsConfig(keybindingsConfigPath, [legacy, custom, oldPickerKey]);
      yield* keybindings.syncDefaultKeybindingsOnStartup;
      const later = yield* readKeybindingsConfig(keybindingsConfigPath);
      assert.deepEqual(
        later.filter((rule) => rule.command === "workspace.tile.closeTab"),
        [legacy],
      );
      // The picker key moves even after the terminal-key migration has run.
      assert.deepEqual(
        later.filter((rule) => rule.command === "projectPicker.open"),
        [{ ...oldPickerKey, key: "mod+shift+o" }],
      );
    }).pipe(Effect.provide(layerKeybindings())),
  );
});

it.effect("moves shipped search shortcuts and preserves customized chords and conditions", () =>
  Effect.gen(function* () {
    const { keybindingsConfigPath } = yield* ServerConfig.ServerConfig;
    const keybindings = yield* Keybindings.Keybindings;
    const custom = { key: "alt+p", command: "filePicker.toggle", when: "terminalFocus" } as const;
    yield* writeKeybindingsConfig(keybindingsConfigPath, [
      { key: "mod+k", command: "commandPalette.toggle", when: "!terminalFocus" },
      { key: "mod+p", command: "filePicker.toggle", when: "!terminalFocus" },
      custom,
    ]);
    yield* keybindings.syncDefaultKeybindingsOnStartup;
    const upgraded = yield* readKeybindingsConfig(keybindingsConfigPath);
    assert.deepEqual(
      upgraded.filter((rule) =>
        ["search.toggle", "commandPalette.toggle", "filePicker.toggle"].includes(rule.command),
      ),
      [
        { key: "ctrl+k", command: "search.toggle", when: "isMac" },
        { key: "leader /", command: "search.toggle" },
        { key: "leader :", command: "commandPalette.toggle" },
        { key: "mod+k", command: "search.toggle" },
        { key: "mod+p", command: "commandPalette.toggle" },
        custom,
      ],
    );
    yield* keybindings.syncDefaultKeybindingsOnStartup;
    assert.deepEqual(yield* readKeybindingsConfig(keybindingsConfigPath), upgraded);
    for (const enabled of [false, true]) {
      yield* keybindings.upsertKeybindingRule({
        key: "ctrl+a",
        command: "keybindings.leader",
        ...(enabled ? {} : { when: "false" }),
      });
      yield* keybindings.syncDefaultKeybindingsOnStartup;
      const preset = yield* readKeybindingsConfig(keybindingsConfigPath);
      assert.deepEqual(
        preset.filter((rule) => rule.key === "mod+k" || rule.key === "mod+p"),
        [
          { key: "mod+k", command: "search.toggle" },
          { key: "mod+p", command: "commandPalette.toggle" },
        ],
      );
      assert.deepInclude(preset, custom);
      yield* keybindings.syncDefaultKeybindingsOnStartup;
      assert.deepEqual(yield* readKeybindingsConfig(keybindingsConfigPath), preset);
    }
    const rebound = { key: "mod+k", command: "commandPalette.toggle" } as const;
    yield* writeKeybindingsConfig(keybindingsConfigPath, [rebound, custom]);
    yield* keybindings.syncDefaultKeybindingsOnStartup;
    assert.deepInclude(yield* readKeybindingsConfig(keybindingsConfigPath), rebound);
  }).pipe(Effect.provide(layerKeybindings().pipe(Layer.provideMerge(NodeServices.layer)))),
);

it.effect("moves shipped thread bracket keys off Mac tab cycling and keeps customized ones", () =>
  Effect.gen(function* () {
    const { keybindingsConfigPath } = yield* ServerConfig.ServerConfig;
    const keybindings = yield* Keybindings.Keybindings;
    const customNext = {
      key: "mod+shift+]",
      command: "thread.next",
      when: "!terminalFocus",
    } as const;
    yield* writeKeybindingsConfig(keybindingsConfigPath, [
      { key: "mod+shift+[", command: "thread.previous" },
      customNext,
    ]);
    yield* keybindings.syncDefaultKeybindingsOnStartup;
    const upgraded = yield* readKeybindingsConfig(keybindingsConfigPath);
    const bracketRules = (rules: typeof upgraded) =>
      rules.filter((rule) => rule.key.endsWith("[") || rule.key.endsWith("]"));
    assert.deepEqual(
      bracketRules(upgraded).filter(
        (rule) => rule.command.startsWith("thread.") || rule.key.startsWith("mod+shift+"),
      ),
      [
        { key: "ctrl+meta+[", command: "thread.previous", when: "isMac" },
        { key: "mod+shift+[", command: "workspace.tile.previousTab", when: "isMac" },
        { key: "mod+shift+]", command: "workspace.tile.nextTab", when: "isMac" },
        { key: "mod+shift+[", command: "thread.previous", when: "!isMac" },
        customNext,
      ],
    );
    yield* keybindings.syncDefaultKeybindingsOnStartup;
    assert.deepEqual(yield* readKeybindingsConfig(keybindingsConfigPath), upgraded);
  }).pipe(Effect.provide(layerKeybindings().pipe(Layer.provideMerge(NodeServices.layer)))),
);
