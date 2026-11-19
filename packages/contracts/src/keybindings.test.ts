import { assert, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";

import { KeybindingCommand, KeybindingRule, ResolvedKeybindingsConfig } from "./keybindings.ts";

const decode = <S extends Schema.Top>(
  schema: S,
  input: unknown,
): Effect.Effect<Schema.Schema.Type<S>, Schema.SchemaError, never> =>
  Schema.decodeUnknownEffect(schema as never)(input) as Effect.Effect<
    Schema.Schema.Type<S>,
    Schema.SchemaError,
    never
  >;

const shortcut = {
  key: "p",
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  modKey: true,
};

it.effect("drops resolved rules with commands this build does not know", () =>
  Effect.gen(function* () {
    const parsed = yield* decode(ResolvedKeybindingsConfig, [
      { command: "terminal.toggle", shortcut },
      { command: "someFuture.toggle", shortcut },
      { command: "filePicker.toggle", shortcut },
    ]);
    assert.deepEqual(
      parsed.map((rule) => rule.command),
      ["terminal.toggle", "filePicker.toggle"],
    );
  }),
);

it.effect("round-trips resolved Space shortcuts", () =>
  Effect.gen(function* () {
    const codec = Schema.fromJsonString(ResolvedKeybindingsConfig);
    const rules = [
      {
        command: "composer.dictation" as const,
        shortcut: { ...shortcut, key: " ", metaKey: true, modKey: false },
      },
    ];
    const encoded = yield* Schema.encodeEffect(codec)(rules);
    const parsed = yield* decode(codec, encoded);
    assert.deepEqual(parsed, rules);
  }),
);

it.effect("drops malformed resolved rule entries", () =>
  Effect.gen(function* () {
    const parsed = yield* decode(ResolvedKeybindingsConfig, [
      "garbage",
      { command: "terminal.toggle", shortcut },
      null,
    ]);
    assert.deepEqual(
      parsed.map((rule) => rule.command),
      ["terminal.toggle"],
    );
  }),
);

// Command IDs that fork main shipped as defaults. A user's keybindings.json may hold any of them,
// and one unknown ID stops the server from adding new defaults at startup.
const SHIPPED_DEFAULT_COMMANDS = [
  "appearance.cycle",
  "chat.find",
  "chat.new",
  "chat.newLocal",
  "chat.newWithoutProject",
  "commandPalette.toggle",
  "composer.branch",
  "composer.dictation",
  "composer.effort",
  "composer.host",
  "composer.mode",
  "composer.previousWorktree",
  "composer.sendAlternate",
  "composer.sendAndNewThread",
  "composer.sendBackground",
  "composer.stash",
  "composer.workspace",
  "diff.toggle",
  "editor.openFavorite",
  "filePicker.toggle",
  "modelPicker.nextProvider",
  "modelPicker.previousProvider",
  "modelPicker.toggle",
  "navigation.back",
  "navigation.forward",
  "preview.find",
  "preview.focusUrl",
  "preview.refresh",
  "preview.resetZoom",
  "preview.toggle",
  "preview.zoomIn",
  "preview.zoomOut",
  "projectSearch.toggle",
  "pullRequest.copyNumber",
  "sidebar.toggle",
  "terminal.close",
  "terminal.toggle",
  "themeEditor.toggle",
  "theme.select",
  "threadContext.toggle",
  "thread.copyReference",
  "thread.editQueuedMessage",
  "thread.next",
  "threadPanel.toggle",
  "thread.pin",
  "thread.previous",
  "thread.settle",
  "thread.steerQueuedMessage",
  "thread.undo",
  "usage.cost",
  "usage.limits",
  "usage.open",
  "usage.period.day",
  "usage.period.month",
  "usage.period.quarter",
  "usage.period.week",
  "usage.tokens",
  "view.reopenClosed",
  "workspace.focusNext",
  "workspace.focusPrevious",
  "workspace.tile.focusDown",
  "workspace.tile.focusLeft",
  "workspace.tile.focusPair",
  "workspace.tile.focusRight",
  "workspace.tile.focusUp",
  "workspace.tile.maximize",
  "workspace.tile.nextTab",
  "workspace.tile.previousTab",
  "workspace.tile.resize",
  "workspace.tile.splitDown",
  "workspace.tile.splitLeft",
  "workspace.tile.splitRight",
  "workspace.tile.splitUp",
];

it.effect("still decodes every default command ID that main shipped", () =>
  Effect.gen(function* () {
    for (const command of SHIPPED_DEFAULT_COMMANDS) {
      assert.strictEqual(yield* decode(KeybindingCommand, command), command);
    }
  }),
);

it.effect("validates leader sequences and round-trips their resolved prefix", () =>
  Effect.gen(function* () {
    for (const key of [
      "leader %",
      'leader "',
      "leader h",
      "leader space",
      "leader :",
      "leader /",
    ]) {
      assert.equal(
        (yield* decode(KeybindingRule, { key, command: "workspace.tile.splitRight" })).key,
        key,
      );
    }
    for (const key of ["leader", "leader ", "leader h j", "leader ctrl+h", "leader  h"]) {
      assert.isTrue(
        (yield* Effect.exit(decode(KeybindingRule, { key, command: "workspace.tile.splitRight" })))
          ._tag === "Failure",
      );
    }
    const codec = Schema.fromJsonString(ResolvedKeybindingsConfig);
    const rules = [
      {
        command: "workspace.tile.splitRight" as const,
        shortcut: { ...shortcut, modKey: false, key: "leader %", leader: true as const },
      },
    ];
    assert.deepEqual(yield* decode(codec, yield* Schema.encodeEffect(codec)(rules)), rules);
  }),
);
