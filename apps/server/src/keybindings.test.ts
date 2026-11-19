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
      const backgroundRules = Effect.map(readKeybindingsConfig(keybindingsConfigPath), (rules) =>
        rules.filter((entry) => entry.command === "composer.sendBackground"),
      );
      yield* writeKeybindingsConfig(keybindingsConfigPath, [
        existing,
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
        ["workspace.tile.focusLeft", "ctrl+alt+h"],
        ["workspace.tile.focusDown", "ctrl+alt+j"],
        ["workspace.tile.focusUp", "ctrl+alt+k"],
        ["workspace.tile.focusRight", "ctrl+alt+l"],
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

      yield* writeKeybindingsConfig(keybindingsConfigPath, [
        existing,
        { key: "ctrl+alt+arrowleft", command: "workspace.tile.focusLeft" },
      ]);
      yield* keybindings.syncDefaultKeybindingsOnStartup;
      assert.deepStrictEqual(yield* backgroundRules, [existing]);
      assert.deepStrictEqual(
        (yield* readKeybindingsConfig(keybindingsConfigPath)).filter(
          (rule) => rule.command === "workspace.tile.focusLeft",
        ),
        [{ key: "ctrl+alt+arrowleft", command: "workspace.tile.focusLeft" }],
      );
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
      yield* writeKeybindingsConfig(keybindingsConfigPath, [custom]);

      yield* keybindings.syncDefaultKeybindingsOnStartup;
      const persisted = yield* readKeybindingsConfig(keybindingsConfigPath);
      assert.deepStrictEqual(
        persisted.filter((entry) => entry.command === "composer.sendBackground"),
        [custom],
      );
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
        { key: "mod+j", command: "script.custom-action.run", when: "isMac || !terminalFocus" },
      ]);

      yield* Effect.gen(function* () {
        const keybindings = yield* Keybindings.Keybindings;
        yield* keybindings.syncDefaultKeybindingsOnStartup;
      });

      const persisted = yield* readKeybindingsConfig(keybindingsConfigPath);
      assert.isFalse(persisted.some((entry) => entry.command === "terminal.toggle"));
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
});
