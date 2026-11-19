import {
  KeybindingRule,
  KeybindingsConfigError,
  KeybindingShortcut,
  KeybindingWhenNode,
  MAX_KEYBINDINGS_COUNT,
  ResolvedKeybindingRule,
  ResolvedKeybindingsConfig,
  type ServerRemoveKeybindingInput,
  type ServerUpsertKeybindingInput,
  ServerConfigIssue,
} from "@t3tools/contracts";
import * as Array from "effect/Array";
import * as Cache from "effect/Cache";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Layer from "effect/Layer";
import * as Predicate from "effect/Predicate";
import * as PubSub from "effect/PubSub";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as SchemaIssue from "effect/SchemaIssue";
import * as SchemaTransformation from "effect/SchemaTransformation";
import * as Ref from "effect/Ref";
import * as Context from "effect/Context";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as Semaphore from "effect/Semaphore";
import * as ServerConfig from "./config.ts";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import { fromJsonStringPretty, fromLenientJson } from "@t3tools/shared/schemaJson";
import {
  DEFAULT_KEYBINDINGS,
  CLASSIC_KEYBINDINGS,
  isClassicTileDefault,
  defaultKeybindingsForMode,
  leaderEnabled,
  leaderShortcutKey,
  mergeWithDefaultKeybindings,
  compileResolvedKeybindingRule,
  compileResolvedKeybindingsConfig,
  parseKeybindingShortcut,
  parseKeybindingWhenExpression,
} from "@t3tools/shared/keybindings";

export const ResolvedKeybindingFromConfig = KeybindingRule.pipe(
  Schema.decodeTo(
    Schema.toType(ResolvedKeybindingRule),
    SchemaTransformation.transformEffect({
      decode: (rule) =>
        Effect.succeed(compileResolvedKeybindingRule(rule)).pipe(
          Effect.filterOrFail(
            Predicate.isNotNull,
            () =>
              new SchemaIssue.InvalidValue({
                message: "Invalid keybinding rule",
              }),
          ),
          Effect.map((resolved) => resolved),
        ),

      encode: Effect.fn("keybindings.encode")(function* (resolved) {
        const key = encodeShortcut(resolved.shortcut);
        if (!key) {
          return yield* Effect.fail(
            new SchemaIssue.InvalidValue({
              message: "Resolved shortcut cannot be encoded to key string",
            }),
          );
        }

        const when = resolved.whenAst ? encodeWhenAst(resolved.whenAst) : undefined;
        return {
          key,
          command: resolved.command,
          when,
        };
      }),
    }),
  ),
);

// Settings sends replace/remove targets in its own normalized spelling, which can differ from a
// hand-edited file ("cmd+k" vs "meta+k", "a&&b" vs "a && b"), so compare parsed forms.
function keybindingRuleIdentity(rule: KeybindingRule): string {
  const shortcut = parseKeybindingShortcut(rule.key);
  const key = (shortcut && encodeShortcut(shortcut)) ?? rule.key;
  if (rule.when === undefined) return JSON.stringify([rule.command, key, null]);
  const whenAst = parseKeybindingWhenExpression(rule.when);
  return JSON.stringify([rule.command, key, whenAst ? encodeWhenAst(whenAst) : rule.when]);
}

function isSameKeybindingRule(left: KeybindingRule, right: KeybindingRule): boolean {
  return keybindingRuleIdentity(left) === keybindingRuleIdentity(right);
}

function switchTilePreset(
  rules: readonly KeybindingRule[],
  enabled: boolean,
  capacity = MAX_KEYBINDINGS_COUNT,
): readonly KeybindingRule[] {
  const presets = [...CLASSIC_KEYBINDINGS, ...DEFAULT_KEYBINDINGS];
  const isTileDefault = (rule: KeybindingRule) =>
    (rule.command.startsWith("workspace.tile.") || rule.key.startsWith("leader ")) &&
    presets.some((preset) => isSameKeybindingRule(preset, rule));
  const custom = rules.filter((rule) => !isTileDefault(rule));
  const customizedCommands = new Set(
    rules
      .filter((rule) => !presets.some((preset) => isSameKeybindingRule(preset, rule)))
      .map((rule) => rule.command),
  );
  return [
    ...defaultKeybindingsForMode(enabled)
      .filter(
        (rule) =>
          (rule.command.startsWith("workspace.tile.") || rule.key.startsWith("leader ")) &&
          !customizedCommands.has(rule.command),
      )
      .slice(0, Math.max(0, capacity - custom.length)),
    ...custom,
  ];
}

const LATE_DEFAULT_KEYBINDINGS: ReadonlyArray<{
  readonly id: string;
  readonly alongside: KeybindingRule;
  readonly rule: KeybindingRule;
}> = [
  {
    id: "weavewing.leader-arrow-left.v1",
    alongside: { key: "leader h", command: "workspace.tile.focusLeft" },
    rule: { key: "leader arrowleft", command: "workspace.tile.focusLeft" },
  },
  {
    id: "weavewing.leader-arrow-down.v1",
    alongside: { key: "leader j", command: "workspace.tile.focusDown" },
    rule: { key: "leader arrowdown", command: "workspace.tile.focusDown" },
  },
  {
    id: "weavewing.leader-arrow-up.v1",
    alongside: { key: "leader k", command: "workspace.tile.focusUp" },
    rule: { key: "leader arrowup", command: "workspace.tile.focusUp" },
  },
  {
    id: "weavewing.leader-arrow-right.v1",
    alongside: { key: "leader l", command: "workspace.tile.focusRight" },
    rule: { key: "leader arrowright", command: "workspace.tile.focusRight" },
  },
  {
    id: "composer.sendBackground:mod+enter",
    alongside: {
      key: "mod+alt+enter",
      command: "composer.sendBackground",
      when: "composerFocus && draftThreadRoute",
    },
    rule: {
      key: "mod+enter",
      command: "composer.sendBackground",
      when: "composerFocus && draftThreadRoute",
    },
  },
  {
    id: "workspace.tile.focusLeft:ctrl+alt+h",
    alongside: { key: "ctrl+alt+arrowleft", command: "workspace.tile.focusLeft" },
    rule: { key: "ctrl+alt+h", command: "workspace.tile.focusLeft" },
  },
  {
    id: "workspace.tile.focusDown:ctrl+alt+j",
    alongside: { key: "ctrl+alt+arrowdown", command: "workspace.tile.focusDown" },
    rule: { key: "ctrl+alt+j", command: "workspace.tile.focusDown" },
  },
  {
    id: "workspace.tile.focusUp:ctrl+alt+k",
    alongside: { key: "ctrl+alt+arrowup", command: "workspace.tile.focusUp" },
    rule: { key: "ctrl+alt+k", command: "workspace.tile.focusUp" },
  },
  {
    id: "workspace.tile.focusRight:ctrl+alt+l",
    alongside: { key: "ctrl+alt+arrowright", command: "workspace.tile.focusRight" },
    rule: { key: "ctrl+alt+l", command: "workspace.tile.focusRight" },
  },
  {
    id: "workspace.tile.previousTab:ctrl+shift+tab",
    alongside: { key: "ctrl+alt+[", command: "workspace.tile.previousTab" },
    rule: { key: "ctrl+shift+tab", command: "workspace.tile.previousTab" },
  },
  {
    id: "workspace.tile.nextTab:ctrl+tab",
    alongside: { key: "ctrl+alt+]", command: "workspace.tile.nextTab" },
    rule: { key: "ctrl+tab", command: "workspace.tile.nextTab" },
  },
  ...(
    [
      ["previous", "["],
      ["next", "]"],
    ] as const
  ).flatMap(([direction, bracket]) => {
    const alongside = {
      key: `mod+shift+${bracket}`,
      command: `thread.${direction}`,
      when: "!isMac",
    } as const;
    return [
      {
        id: `weavewing.mac-tab-keys.thread-${direction}.v1`,
        alongside,
        rule: { key: `ctrl+meta+${bracket}`, command: `thread.${direction}`, when: "isMac" },
      },
      {
        id: `weavewing.mac-tab-keys.tab-${direction}.v1`,
        alongside,
        rule: {
          key: `mod+shift+${bracket}`,
          command: `workspace.tile.${direction}Tab`,
          when: "isMac",
        },
      },
    ] as const;
  }),
  {
    id: "weavewing.search-palette.v1",
    alongside: { key: "mod+k", command: "commandPalette.toggle", when: "!terminalFocus" },
    rule: { key: "mod+k", command: "search.toggle" },
  },
  {
    id: "weavewing.terminal-keys.v1",
    alongside: { key: "ctrl+alt+w", command: "workspace.tile.closeTab" },
    rule: { key: "mod+w", command: "workspace.tile.closeTab" },
  },
];

const NEW_THREAD_KEY_MIGRATION = "weavewing.new-thread-mod-n.v2";
const newThreadKey: KeybindingRule = { key: "mod+n", command: "chat.new", when: "!terminalFocus" };
// What a saved file that swapped New thread with the removed default-folder command kept.
const strandedNewThreadKey: KeybindingRule = { ...newThreadKey, key: "mod+alt+n" };

function takesNewThreadKey(rule: KeybindingRule): boolean {
  const shortcut = parseKeybindingShortcut(rule.key);
  return (
    shortcut !== null &&
    shortcut.leader !== true &&
    shortcut.key === "n" &&
    !shortcut.altKey &&
    !shortcut.shiftKey &&
    (shortcut.modKey || shortcut.ctrlKey || shortcut.metaKey)
  );
}

/** Moves the exact stranded New thread rule back to Ctrl/Cmd+N when nothing holds that key. */
function restoreNewThreadKey(rules: readonly KeybindingRule[]): readonly KeybindingRule[] {
  const stranded = rules.findIndex((rule) => isSameKeybindingRule(rule, strandedNewThreadKey));
  if (stranded === -1 || rules.some(takesNewThreadKey)) return rules;
  return rules.with(stranded, newThreadKey);
}

const DROPDOWN_KEY_MIGRATION = "weavewing.dropdown-mod-j.v1";
const dropdownKey: KeybindingRule = { key: "mod+j", command: "terminal.dropdown" };

/**
 * Moves the untouched drop-down key to Ctrl/Cmd+J, which the thread terminal gives up for the
 * leader then j. Each rule moves only when its new key is free or held by the rule it replaces.
 */
/** Whether a rule fires on plain Ctrl+<key> or Cmd+<key> on some platform, however it is spelled. */
function takesModKey(rule: KeybindingRule, key: string): boolean {
  const shortcut = parseKeybindingShortcut(rule.key);
  if (shortcut === null || shortcut.leader === true || shortcut.key !== key) return false;
  if (shortcut.altKey || shortcut.shiftKey) return false;
  return [true, false].some((mac) => {
    const meta = shortcut.metaKey || (shortcut.modKey && mac);
    const ctrl = shortcut.ctrlKey || (shortcut.modKey && !mac);
    return mac ? meta && !ctrl : ctrl && !meta;
  });
}

/**
 * Moves the drop-down to Ctrl/Cmd+J and the thread terminal to Leader then j, only for a file that
 * still holds every old default involved and nothing else on those keys. Anything else is left
 * as saved, so no command loses a working key.
 */
function moveDropdownKey(
  rules: readonly KeybindingRule[],
  leaderOn: boolean,
): readonly KeybindingRule[] {
  const oldToggle: KeybindingRule = {
    key: "mod+j",
    command: "terminal.toggle",
    when: "isMac || !terminalFocus",
  };
  const oldDropdown: KeybindingRule = { key: "ctrl+`", command: "terminal.dropdown" };
  const oldFocusDown: KeybindingRule = { key: "leader j", command: "workspace.tile.focusDown" };
  const leaderArrowDown: KeybindingRule = {
    key: "leader arrowdown",
    command: "workspace.tile.focusDown",
  };
  const leaderToggle: KeybindingRule = { key: "leader j", command: "terminal.toggle" };
  const involved = [oldToggle, oldDropdown, oldFocusDown, leaderArrowDown];
  const isInvolved = (rule: KeybindingRule) =>
    [...involved, leaderToggle].some((entry) => isSameKeybindingRule(rule, entry));
  const contested = rules.some(
    (rule) =>
      !isInvolved(rule) &&
      (takesModKey(rule, "j") ||
        encodedShortcut(rule) === encodedShortcut(oldFocusDown) ||
        encodedShortcut(rule) === encodedShortcut(leaderArrowDown)),
  );
  if (
    !leaderOn ||
    contested ||
    !involved.every((entry) => rules.some((rule) => isSameKeybindingRule(rule, entry)))
  )
    return rules;
  // The leader preset may already have added the new thread-terminal rule.
  const hasToggle = rules.some((rule) => isSameKeybindingRule(rule, leaderToggle));
  return rules
    .filter(
      (rule) =>
        !isSameKeybindingRule(rule, oldToggle) &&
        !(hasToggle && isSameKeybindingRule(rule, oldFocusDown)),
    )
    .map((rule) =>
      isSameKeybindingRule(rule, oldDropdown)
        ? dropdownKey
        : isSameKeybindingRule(rule, oldFocusDown)
          ? leaderToggle
          : rule,
    );
}

function encodedShortcut(rule: KeybindingRule): string | null {
  const parsed = parseKeybindingShortcut(rule.key);
  return parsed ? encodeShortcut(parsed) || null : null;
}

function keybindingShortcutContext(rule: KeybindingRule): string | null {
  const encoded = encodedShortcut(rule);
  return encoded === null ? null : `${encoded}\u0000${rule.when ?? ""}`;
}

function hasSameShortcutContext(left: KeybindingRule, right: KeybindingRule): boolean {
  const leftContext = keybindingShortcutContext(left);
  const rightContext = keybindingShortcutContext(right);
  if (!leftContext || !rightContext) return false;
  return leftContext === rightContext;
}

function keybindingRuleFromInput(input: ServerRemoveKeybindingInput): KeybindingRule {
  return input.when === undefined
    ? { key: input.key, command: input.command }
    : { key: input.key, command: input.command, when: input.when };
}

function replaceTargetFromUpsertInput(input: ServerUpsertKeybindingInput): KeybindingRule | null {
  if (!input.replace) return null;
  return input.replace.when === undefined
    ? { key: input.replace.key, command: input.replace.command }
    : { key: input.replace.key, command: input.replace.command, when: input.replace.when };
}

function encodeShortcut(shortcut: KeybindingShortcut): string | null {
  if (shortcut.leader)
    return `leader ${leaderShortcutKey(shortcut) === " " ? "space" : leaderShortcutKey(shortcut)}`;
  const modifiers: string[] = [];
  if (shortcut.modKey) modifiers.push("mod");
  if (shortcut.metaKey) modifiers.push("meta");
  if (shortcut.ctrlKey) modifiers.push("ctrl");
  if (shortcut.altKey) modifiers.push("alt");
  if (shortcut.shiftKey) modifiers.push("shift");
  if (!shortcut.key) return null;
  if (shortcut.key !== "+" && shortcut.key.includes("+")) return null;
  const key = shortcut.key === " " ? "space" : shortcut.key;
  return [...modifiers, key].join("+");
}

function encodeWhenAst(node: KeybindingWhenNode): string {
  switch (node.type) {
    case "identifier":
      return node.name;
    case "not":
      return `!(${encodeWhenAst(node.node)})`;
    case "and":
      return `(${encodeWhenAst(node.left)} && ${encodeWhenAst(node.right)})`;
    case "or":
      return `(${encodeWhenAst(node.left)} || ${encodeWhenAst(node.right)})`;
  }
}

const removedWeavewingCommands = new Set([
  "terminal.split",
  "terminal.splitVertical",
  "terminal.new",
  "rightPanel.toggle",
  "rightPanel.toggleMaximized",
  "rightPanel.new",
  "rightPanel.close",
  "chat.newWithoutProject",
]);
// A removed command with an exact replacement keeps the user's key and condition. The others
// have none: terminal splits and the right panel drawer went away with their surfaces.
const removedWeavewingCommandReplacements: ReadonlyMap<string, KeybindingRule["command"]> = new Map(
  [["chat.newWithoutProject", "chat.new"]],
);

function decodedRule(entry: unknown): KeybindingRule | null {
  const decoded = decodeKeybindingRuleExit(entry);
  return decoded._tag === "Success" ? decoded.value : null;
}

/** Same length as `entries`; a remap that would repeat an existing rule stays removed. */
function remapRemovedWeavewingBindings(entries: ReadonlyArray<unknown>): ReadonlyArray<unknown> {
  const remapped = entries.map((entry) => {
    if (typeof entry !== "object" || entry === null || !("command" in entry)) return entry;
    const replacement =
      typeof entry.command === "string"
        ? removedWeavewingCommandReplacements.get(entry.command)
        : undefined;
    return replacement ? { ...entry, command: replacement } : entry;
  });
  return remapped.map((entry, index) => {
    if (entry === entries[index]) return entry;
    const rule = decodedRule(entry);
    const repeats = remapped.some((other, otherIndex) => {
      if (otherIndex === index || (otherIndex > index && other !== entries[otherIndex]))
        return false;
      const otherRule = decodedRule(other);
      return rule !== null && otherRule !== null && isSameKeybindingRule(rule, otherRule);
    });
    return repeats ? entries[index] : entry;
  });
}

function isRemovedWeavewingBinding(entry: unknown): boolean {
  return (
    typeof entry === "object" &&
    entry !== null &&
    "command" in entry &&
    typeof entry.command === "string" &&
    (removedWeavewingCommands.has(entry.command) ||
      (entry.command === "terminal.close" &&
        "key" in entry &&
        entry.key === "mod+w" &&
        "when" in entry &&
        entry.when === "terminalFocus"))
  );
}

// These exact defaults shipped before terminals kept shell control keys.
function migrateWeavewingBinding(entry: unknown): unknown {
  if (typeof entry !== "object" || entry === null || !("command" in entry) || !("key" in entry))
    return entry;
  if (
    ((entry.command === "terminal.toggle" && entry.key === "mod+j") ||
      (entry.command === "sidebar.toggle" && entry.key === "mod+b") ||
      (entry.command === "editor.openFavorite" && entry.key === "mod+o")) &&
    (!("when" in entry) || entry.when === "!terminalFocus")
  ) {
    return { ...entry, when: "isMac || !terminalFocus" };
  }
  return entry;
}

const RawKeybindingsEntries = fromLenientJson(Schema.Array(Schema.Unknown));
const RawKeybindingsEntriesPrettyJson = fromJsonStringPretty(Schema.Array(Schema.Unknown));
const decodeKeybindingRuleExit = Schema.decodeUnknownExit(KeybindingRule);
const decodeResolvedKeybindingFromConfigExit = Schema.decodeExit(ResolvedKeybindingFromConfig);
const decodeRawKeybindingsEntriesExit = Schema.decodeUnknownExit(RawKeybindingsEntries);
const encodeRawKeybindingsEntriesPrettyJson = Schema.encodeEffect(RawKeybindingsEntriesPrettyJson);

export interface KeybindingsConfigState {
  readonly keybindings: ResolvedKeybindingsConfig;
  readonly issues: readonly ServerConfigIssue[];
}

const isSameKeybindingsConfigState = Schema.toEquivalence(
  Schema.Struct({
    keybindings: ResolvedKeybindingsConfig,
    issues: Schema.Array(ServerConfigIssue),
  }),
);

export interface KeybindingsChangeEvent {
  readonly keybindings: ResolvedKeybindingsConfig;
  readonly issues: readonly ServerConfigIssue[];
}

function trimIssueMessage(message: string): string {
  const trimmed = message.trim();
  return trimmed.length > 0 ? trimmed : "Invalid keybindings configuration.";
}

function malformedConfigIssue(detail: string): ServerConfigIssue {
  return {
    kind: "keybindings.malformed-config",
    message: trimIssueMessage(detail),
  };
}

function invalidEntryIssue(index: number, detail: string): ServerConfigIssue {
  return {
    kind: "keybindings.invalid-entry",
    index,
    message: trimIssueMessage(detail),
  };
}

export class Keybindings extends Context.Service<
  Keybindings,
  {
    readonly start: Effect.Effect<void, KeybindingsConfigError>;

    readonly ready: Effect.Effect<void, KeybindingsConfigError>;

    readonly syncDefaultKeybindingsOnStartup: Effect.Effect<void, KeybindingsConfigError>;

    readonly loadConfigState: Effect.Effect<KeybindingsConfigState, KeybindingsConfigError>;

    readonly getSnapshot: Effect.Effect<KeybindingsConfigState, KeybindingsConfigError>;

    readonly streamChanges: Stream.Stream<KeybindingsChangeEvent>;

    readonly revalidate: Effect.Effect<void, KeybindingsConfigError>;

    /** Acquire before reading a snapshot to buffer changes until the stream starts. */
    readonly subscribeChanges: Effect.Effect<
      Stream.Stream<KeybindingsChangeEvent>,
      never,
      Scope.Scope
    >;

    /**
     * Writes config atomically and enforces the max rule count by truncating
     * oldest entries when needed.
     */
    readonly upsertKeybindingRule: (
      input: ServerUpsertKeybindingInput,
    ) => Effect.Effect<KeybindingsConfigState, KeybindingsConfigError>;

    readonly removeKeybindingRule: (
      input: ServerRemoveKeybindingInput,
    ) => Effect.Effect<KeybindingsConfigState, KeybindingsConfigError>;
  }
>()("t3/keybindings") {}

const make = Effect.gen(function* () {
  const { keybindingsConfigPath } = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const upsertSemaphore = yield* Semaphore.make(1);
  const resolvedConfigCacheKey = "resolved" as const;
  const changesPubSub = yield* PubSub.unbounded<KeybindingsChangeEvent>();
  const lastEmittedStateRef = yield* Ref.make<KeybindingsConfigState | null>(null);
  const startedRef = yield* Ref.make(false);
  const startedDeferred = yield* Deferred.make<void, KeybindingsConfigError>();
  const watcherScope = yield* Scope.make("sequential");
  yield* Effect.addFinalizer(() => Scope.close(watcherScope, Exit.void));
  const emitChange = Effect.fn("keybindings.emitChange")(function* (
    configState: KeybindingsConfigState,
  ) {
    yield* Ref.set(lastEmittedStateRef, configState);
    yield* PubSub.publish(changesPubSub, configState);
  });

  const readConfigExists = fs.exists(keybindingsConfigPath).pipe(
    Effect.mapError(
      (cause) =>
        new KeybindingsConfigError({
          configPath: keybindingsConfigPath,
          detail: "failed to access keybindings config",
          cause,
        }),
    ),
  );

  const readRawConfig = fs.readFileString(keybindingsConfigPath).pipe(
    Effect.mapError(
      (cause) =>
        new KeybindingsConfigError({
          configPath: keybindingsConfigPath,
          detail: "failed to read keybindings config",
          cause,
        }),
    ),
  );

  // Entries this build cannot decode, such as a typo or a command from a newer
  // build, are written back unchanged so editing another shortcut keeps them.
  const loadWritableCustomKeybindingsConfig = Effect.fn(function* (): Effect.fn.Return<
    ReadonlyArray<{ readonly value: unknown; readonly rule: KeybindingRule | null }>,
    KeybindingsConfigError
  > {
    if (!(yield* readConfigExists)) {
      return [];
    }

    const rawConfig = yield* readRawConfig.pipe(
      Effect.flatMap(Schema.decodeEffect(RawKeybindingsEntries)),
      Effect.mapError(
        (cause) =>
          new KeybindingsConfigError({
            configPath: keybindingsConfigPath,
            detail: "expected JSON array",
            cause,
          }),
      ),
    );

    return remapRemovedWeavewingBindings(rawConfig)
      .map(migrateWeavewingBinding)
      .filter((entry) => !isRemovedWeavewingBinding(entry))
      .map((entry) => {
        const decodedRule = decodeKeybindingRuleExit(entry);
        if (
          decodedRule._tag === "Success" &&
          decodeResolvedKeybindingFromConfigExit(decodedRule.value)._tag === "Success"
        ) {
          return { value: decodedRule.value, rule: decodedRule.value };
        }
        return { value: entry, rule: null };
      });
  });

  const loadRuntimeCustomKeybindingsConfig = Effect.fn(function* (): Effect.fn.Return<
    {
      readonly keybindings: readonly KeybindingRule[];
      readonly issues: readonly ServerConfigIssue[];
      /** The file still names removed commands, so writing it back changes it. */
      readonly hasRemovedCommands: boolean;
    },
    KeybindingsConfigError
  > {
    if (!(yield* readConfigExists)) {
      return { keybindings: [], issues: [], hasRemovedCommands: false };
    }

    const rawConfig = yield* readRawConfig;
    const decodedEntries = decodeRawKeybindingsEntriesExit(rawConfig);
    if (decodedEntries._tag === "Failure") {
      const detail = `expected JSON array (${Cause.pretty(decodedEntries.cause)})`;
      return {
        keybindings: [],
        issues: [malformedConfigIssue(detail)],
        hasRemovedCommands: false,
      };
    }

    const keybindings: KeybindingRule[] = [];
    const issues: ServerConfigIssue[] = [];
    for (const [index, rawEntry] of remapRemovedWeavewingBindings(decodedEntries.value).entries()) {
      const entry = migrateWeavewingBinding(rawEntry);
      if (isRemovedWeavewingBinding(entry)) continue;
      const decodedRule = decodeKeybindingRuleExit(entry);
      if (decodedRule._tag === "Failure") {
        const detail = Cause.pretty(decodedRule.cause);
        issues.push(invalidEntryIssue(index, detail));
        yield* Effect.logWarning("ignoring invalid keybinding entry", {
          path: keybindingsConfigPath,
          index,
          entry,
          error: detail,
        });
        continue;
      }

      const resolvedRule = decodeResolvedKeybindingFromConfigExit(decodedRule.value);
      if (resolvedRule._tag === "Failure") {
        const detail = Cause.pretty(resolvedRule.cause);
        issues.push(invalidEntryIssue(index, detail));
        yield* Effect.logWarning("ignoring invalid keybinding entry", {
          path: keybindingsConfigPath,
          index,
          entry,
          error: detail,
        });
        continue;
      }
      keybindings.push(decodedRule.value);
    }

    const hasRemovedCommands = decodedEntries.value.some((entry) =>
      isRemovedWeavewingBinding(migrateWeavewingBinding(entry)),
    );
    return { keybindings, issues, hasRemovedCommands };
  });

  const appliedMigrationsPath = path.join(
    path.dirname(keybindingsConfigPath),
    "keybindings-migrations",
  );
  const readAppliedMigrationIds = fs.readFileString(appliedMigrationsPath).pipe(
    Effect.map((contents) => new Set(contents.split("\n").filter((line) => line.length > 0))),
    Effect.orElseSucceed(() => new Set<string>()),
  );
  const recordAppliedMigrations = (ids: Iterable<string>) =>
    writeFileStringAtomically({
      filePath: appliedMigrationsPath,
      contents: `${[...new Set(ids)].join("\n")}\n`,
    }).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
      Effect.mapError(
        (cause) =>
          new KeybindingsConfigError({
            configPath: keybindingsConfigPath,
            detail: "failed to record keybinding migrations",
            cause,
          }),
      ),
    );

  const writeConfigAtomically = (entries: ReadonlyArray<unknown>) => {
    return encodeRawKeybindingsEntriesPrettyJson(entries).pipe(
      Effect.map((encoded) => `${encoded}\n`),
      Effect.flatMap((encoded) =>
        writeFileStringAtomically({
          filePath: keybindingsConfigPath,
          contents: encoded,
        }).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, path),
        ),
      ),
      Effect.mapError(
        (cause) =>
          new KeybindingsConfigError({
            configPath: keybindingsConfigPath,
            detail: "failed to write keybindings config",
            cause,
          }),
      ),
    );
  };

  const loadConfigStateFromDisk = loadRuntimeCustomKeybindingsConfig().pipe(
    Effect.map(({ keybindings, issues }) => ({
      keybindings: mergeWithDefaultKeybindings(compileResolvedKeybindingsConfig(keybindings)),
      issues,
    })),
  );

  const resolvedConfigCache = yield* Cache.makeWith<
    typeof resolvedConfigCacheKey,
    KeybindingsConfigState,
    KeybindingsConfigError
  >(() => loadConfigStateFromDisk, {
    capacity: 1,
    timeToLive: (exit) => (Exit.isSuccess(exit) ? Duration.infinity : Duration.zero),
  });

  const loadConfigStateFromCacheOrDisk = Cache.get(resolvedConfigCache, resolvedConfigCacheKey);

  const reloadConfigState = Effect.gen(function* () {
    yield* Cache.invalidate(resolvedConfigCache, resolvedConfigCacheKey);
    return yield* loadConfigStateFromCacheOrDisk;
  });

  const reloadAndEmit = Effect.gen(function* () {
    const configState = yield* reloadConfigState;
    yield* emitChange(configState);
    return configState;
  });

  const revalidateAndEmit = upsertSemaphore.withPermits(1)(
    Effect.gen(function* () {
      const previousState = yield* Ref.get(lastEmittedStateRef);
      const configState = yield* reloadConfigState;
      if (!(previousState && isSameKeybindingsConfigState(previousState, configState))) {
        yield* emitChange(configState);
      }
      return configState;
    }),
  );

  const syncDefaultKeybindingsOnStartup = upsertSemaphore.withPermits(1)(
    Effect.gen(function* () {
      const appliedMigrationIds = yield* readAppliedMigrationIds;
      const pendingLateDefaults = LATE_DEFAULT_KEYBINDINGS.filter(
        (late) => !appliedMigrationIds.has(late.id),
      );
      const configExists = yield* readConfigExists;
      if (!configExists) {
        yield* writeConfigAtomically(DEFAULT_KEYBINDINGS);
        if (
          pendingLateDefaults.length > 0 ||
          !appliedMigrationIds.has(NEW_THREAD_KEY_MIGRATION) ||
          !appliedMigrationIds.has(DROPDOWN_KEY_MIGRATION)
        ) {
          yield* recordAppliedMigrations([
            ...appliedMigrationIds,
            ...LATE_DEFAULT_KEYBINDINGS.map((late) => late.id),
            "weavewing.leader.v1",
            NEW_THREAD_KEY_MIGRATION,
            DROPDOWN_KEY_MIGRATION,
          ]);
        }
        yield* Cache.invalidate(resolvedConfigCache, resolvedConfigCacheKey);
        return;
      }

      const runtimeConfig = yield* loadRuntimeCustomKeybindingsConfig();
      if (runtimeConfig.issues.length > 0) {
        yield* Effect.logWarning(
          "skipping startup keybindings default sync because config has issues",
          {
            path: keybindingsConfigPath,
            issues: runtimeConfig.issues,
          },
        );
        yield* Cache.invalidate(resolvedConfigCache, resolvedConfigCacheKey);
        return;
      }
      const migrateTerminalKeys = pendingLateDefaults.some(
        (late) => late.id === "weavewing.terminal-keys.v1",
      );
      const closeConflict = runtimeConfig.keybindings.some((rule) => {
        const shortcut = parseKeybindingShortcut(rule.key);
        return (
          rule.command !== "workspace.tile.closeTab" &&
          shortcut?.key === "w" &&
          !shortcut.altKey &&
          !shortcut.shiftKey &&
          (shortcut.modKey || shortcut.ctrlKey || shortcut.metaKey)
        );
      });
      const oldNewThreadKey: KeybindingRule = {
        key: "mod+shift+o",
        command: "chat.new",
        when: "!terminalFocus",
      };
      const oldPickerKey: KeybindingRule = {
        key: "mod+alt+shift+o",
        command: "projectPicker.open",
        when: "!terminalFocus",
      };
      const pickerKey: KeybindingRule = { ...oldPickerKey, key: "mod+shift+o" };
      // A user's own binding on the new key wins, whatever its condition: the picker keeps its old key.
      const pickerKeyTaken = runtimeConfig.keybindings.some(
        (rule) =>
          !isSameKeybindingRule(rule, oldNewThreadKey) &&
          !isSameKeybindingRule(rule, oldPickerKey) &&
          encodedShortcut(rule) === encodedShortcut(pickerKey),
      );
      const migrateSearchKeys = pendingLateDefaults.some(
        (late) => late.id === "weavewing.search-palette.v1",
      );
      const migrateMacTabKeys = pendingLateDefaults.some((late) =>
        late.id.startsWith("weavewing.mac-tab-keys."),
      );
      const migrateLeader = !appliedMigrationIds.has("weavewing.leader.v1");
      const enabled = leaderEnabled(compileResolvedKeybindingsConfig(runtimeConfig.keybindings));
      const defaults = defaultKeybindingsForMode(enabled);
      let customConfig = runtimeConfig.keybindings
        .filter((rule) => !(migrateLeader && enabled && isClassicTileDefault(rule)))
        // The untouched old second New thread key gives way to the project picker.
        .filter((rule) => !isSameKeybindingRule(rule, oldNewThreadKey))
        .map((rule) => {
          if (!pickerKeyTaken && isSameKeybindingRule(rule, oldPickerKey)) return pickerKey;
          if (migrateSearchKeys && (rule.when === undefined || rule.when === "!terminalFocus")) {
            if (rule.command === "commandPalette.toggle" && rule.key === "mod+k")
              return { key: "mod+k", command: "search.toggle" } as const;
            if (rule.command === "filePicker.toggle" && rule.key === "mod+p")
              return { key: "mod+p", command: "commandPalette.toggle" } as const;
          }
          if (
            migrateMacTabKeys &&
            rule.when === undefined &&
            ((rule.command === "thread.previous" && rule.key === "mod+shift+[") ||
              (rule.command === "thread.next" && rule.key === "mod+shift+]"))
          )
            return { ...rule, when: "!isMac" };
          if (!migrateTerminalKeys) return rule;
          if (
            !closeConflict &&
            isSameKeybindingRule(rule, {
              key: "meta+w",
              command: "workspace.tile.closeTab",
              when: "isMac",
            })
          )
            return { key: "mod+w", command: rule.command };
          if (
            ((rule.command === "workspace.focusNext" && rule.key === "f6") ||
              (rule.command === "workspace.focusPrevious" && rule.key === "shift+f6")) &&
            rule.when === undefined
          )
            return { ...rule, when: "!terminalFocus" };
          if (
            /^thread\.jump\.[1-9]$/.test(rule.command) &&
            rule.key === `mod+${rule.command.at(-1)}` &&
            rule.when === "!modelPickerOpen && isDesktop"
          )
            return { ...rule, when: "!modelPickerOpen && isDesktop && (isMac || !terminalFocus)" };
          if (
            ((rule.command === "view.reopenClosed" && rule.key === "mod+shift+t") ||
              (rule.command === "preview.toggle" && rule.key === "mod+shift+j")) &&
            rule.when === undefined
          )
            return { ...rule, when: "isMac || !terminalFocus" };
          return rule;
        });
      if (migrateLeader) customConfig = [...switchTilePreset(customConfig, enabled)];
      // Reached only with a clean config, so the id below records a repair or a file needing none.
      const migrateNewThreadKey = !appliedMigrationIds.has(NEW_THREAD_KEY_MIGRATION);
      if (migrateNewThreadKey) customConfig = [...restoreNewThreadKey(customConfig)];
      const existingCommands = new Set(customConfig.map((entry) => entry.command));
      const missingDefaults: KeybindingRule[] = [];
      const shortcutConflictWarnings: Array<{
        defaultCommand: KeybindingRule["command"];
        conflictingCommand: KeybindingRule["command"];
        key: string;
        when: string | null;
      }> = [];
      for (const defaultRule of defaults) {
        if (existingCommands.has(defaultRule.command)) {
          continue;
        }
        const conflictingEntry = customConfig.find((entry) =>
          hasSameShortcutContext(entry, defaultRule),
        );
        if (conflictingEntry) {
          shortcutConflictWarnings.push({
            defaultCommand: defaultRule.command,
            conflictingCommand: conflictingEntry.command,
            key: defaultRule.key,
            when: defaultRule.when ?? null,
          });
          continue;
        }
        missingDefaults.push(defaultRule);
      }
      for (const { id, alongside, rule } of pendingLateDefaults) {
        if (enabled && isClassicTileDefault(rule)) continue;
        if (id === "weavewing.terminal-keys.v1" && closeConflict) continue;
        if (
          customConfig.some((entry) => isSameKeybindingRule(entry, alongside)) &&
          !customConfig.some((entry) => hasSameShortcutContext(entry, rule))
        ) {
          missingDefaults.push(rule);
        }
      }
      // After the late defaults, which still find the old Leader then j beside its arrow key.
      const migrateDropdownKey = !appliedMigrationIds.has(DROPDOWN_KEY_MIGRATION);
      if (migrateDropdownKey) customConfig = [...moveDropdownKey(customConfig, enabled)];
      for (const conflict of shortcutConflictWarnings) {
        yield* Effect.logWarning("skipping default keybinding due to shortcut conflict", {
          path: keybindingsConfigPath,
          defaultCommand: conflict.defaultCommand,
          conflictingCommand: conflict.conflictingCommand,
          key: conflict.key,
          when: conflict.when,
          reason: "shortcut context already used by existing rule",
        });
      }
      if (missingDefaults.length > 0) {
        const matchingDefaults = Array.filterMap(DEFAULT_KEYBINDINGS, (defaultRule) =>
          customConfig.some((entry) => isSameKeybindingRule(entry, defaultRule))
            ? Result.succeed(defaultRule.command)
            : Result.failVoid,
        );
        if (matchingDefaults.length > 0) {
          yield* Effect.logWarning("default keybinding rule already defined in user config", {
            path: keybindingsConfigPath,
            commands: matchingDefaults,
          });
        }
      }

      // Put defaults before persisted rules so custom shortcuts win overlapping conditions.
      const availableSlots = Math.max(0, MAX_KEYBINDINGS_COUNT - customConfig.length);
      const defaultsToAppend = missingDefaults.slice(0, availableSlots);
      const skippedDefaults = missingDefaults.slice(availableSlots);
      if (skippedDefaults.length > 0) {
        yield* Effect.logWarning("skipping default keybinding backfill at max entries", {
          path: keybindingsConfigPath,
          maxEntries: MAX_KEYBINDINGS_COUNT,
          commands: skippedDefaults.map((rule) => rule.command),
        });
      }
      if (
        defaultsToAppend.length > 0 ||
        runtimeConfig.hasRemovedCommands ||
        customConfig.length !== runtimeConfig.keybindings.length ||
        customConfig.some((rule, index) => rule !== runtimeConfig.keybindings[index])
      ) {
        yield* writeConfigAtomically([...defaultsToAppend, ...customConfig]);
      }
      const settledLateDefaults = pendingLateDefaults.filter(
        (late) => !skippedDefaults.includes(late.rule),
      );
      if (
        settledLateDefaults.length > 0 ||
        migrateLeader ||
        migrateNewThreadKey ||
        migrateDropdownKey
      ) {
        yield* recordAppliedMigrations([
          ...appliedMigrationIds,
          ...settledLateDefaults.map((late) => late.id),
          "weavewing.leader.v1",
          NEW_THREAD_KEY_MIGRATION,
          DROPDOWN_KEY_MIGRATION,
        ]);
      }
      yield* Cache.invalidate(resolvedConfigCache, resolvedConfigCacheKey);
    }),
  );

  const startWatcher = Effect.gen(function* () {
    const keybindingsConfigDir = path.dirname(keybindingsConfigPath);
    const keybindingsConfigFile = path.basename(keybindingsConfigPath);
    const keybindingsConfigPathResolved = path.resolve(keybindingsConfigPath);

    yield* fs.makeDirectory(keybindingsConfigDir, { recursive: true }).pipe(
      Effect.mapError(
        (cause) =>
          new KeybindingsConfigError({
            configPath: keybindingsConfigPath,
            detail: "failed to prepare keybindings config directory",
            cause,
          }),
      ),
    );

    const revalidateAndEmitSafely = revalidateAndEmit.pipe(Effect.ignoreCause({ log: true }));

    // Saves emit multiple events; fs.watch may fire before content is flushed.
    const debouncedKeybindingsEvents = fs.watch(keybindingsConfigDir).pipe(
      Stream.filter((event) => {
        return (
          event.path === keybindingsConfigFile ||
          event.path === keybindingsConfigPath ||
          path.resolve(keybindingsConfigDir, event.path) === keybindingsConfigPathResolved
        );
      }),
      Stream.debounce(Duration.millis(100)),
    );

    yield* Stream.runForEach(debouncedKeybindingsEvents, () => revalidateAndEmitSafely).pipe(
      Effect.ignoreCause({ log: true }),
      Effect.forkIn(watcherScope),
      Effect.asVoid,
    );
  });

  const start = Effect.gen(function* () {
    const alreadyStarted = yield* Ref.get(startedRef);
    if (alreadyStarted) {
      return yield* Deferred.await(startedDeferred);
    }

    yield* Ref.set(startedRef, true);
    const startup = Effect.gen(function* () {
      yield* startWatcher;
      yield* syncDefaultKeybindingsOnStartup;
      yield* Cache.invalidate(resolvedConfigCache, resolvedConfigCacheKey);
      const initialState = yield* loadConfigStateFromCacheOrDisk;
      yield* Ref.set(lastEmittedStateRef, initialState);
    });

    const startupExit = yield* Effect.exit(startup);
    if (startupExit._tag === "Failure") {
      yield* Deferred.failCause(startedDeferred, startupExit.cause).pipe(Effect.orDie);
      return yield* Effect.failCause(startupExit.cause);
    }

    yield* Deferred.succeed(startedDeferred, undefined).pipe(Effect.orDie);
  });

  return {
    start,
    ready: Deferred.await(startedDeferred),
    syncDefaultKeybindingsOnStartup,
    loadConfigState: loadConfigStateFromCacheOrDisk,
    getSnapshot: loadConfigStateFromCacheOrDisk,
    revalidate: revalidateAndEmit,
    get streamChanges() {
      return Stream.fromPubSub(changesPubSub);
    },
    get subscribeChanges() {
      return PubSub.subscribe(changesPubSub).pipe(Effect.map(Stream.fromSubscription));
    },
    upsertKeybindingRule: (input) =>
      upsertSemaphore.withPermits(1)(
        Effect.gen(function* () {
          let customConfig = yield* loadWritableCustomKeybindingsConfig();
          const rule = keybindingRuleFromInput(input);
          const replaceTarget = replaceTargetFromUpsertInput(input);
          const switchingMode =
            rule.command === "keybindings.leader" &&
            leaderEnabled(
              compileResolvedKeybindingsConfig(
                customConfig.flatMap((entry) => (entry.rule ? [entry.rule] : [])),
              ),
            ) !==
              (rule.when !== "false");
          if (switchingMode) {
            const unknownEntries = customConfig.filter((entry) => !entry.rule);
            const migrated = switchTilePreset(
              customConfig.flatMap((entry) =>
                entry.rule && entry.rule.command !== "keybindings.leader" ? [entry.rule] : [],
              ),
              rule.when !== "false",
              MAX_KEYBINDINGS_COUNT - unknownEntries.length - 1,
            );
            customConfig = [...unknownEntries, ...migrated.map((rule) => ({ value: rule, rule }))];
          }
          const nextConfig = [
            ...customConfig.filter(({ rule: entry }) => {
              if (!entry) return true;
              if (rule.command === "keybindings.leader" && entry.command === "keybindings.leader")
                return false;
              if (replaceTarget) {
                return (
                  !isSameKeybindingRule(entry, replaceTarget) && !isSameKeybindingRule(entry, rule)
                );
              }
              return !isSameKeybindingRule(entry, rule);
            }),
            { value: rule, rule },
          ];
          if (rule.command === "keybindings.leader" && nextConfig.length > MAX_KEYBINDINGS_COUNT) {
            return yield* new KeybindingsConfigError({
              configPath: keybindingsConfigPath,
              detail: "Remove a keybinding to make room for the leader setting.",
            });
          }
          const cappedConfig =
            nextConfig.length > MAX_KEYBINDINGS_COUNT
              ? nextConfig.slice(-MAX_KEYBINDINGS_COUNT)
              : nextConfig;
          if (nextConfig.length > MAX_KEYBINDINGS_COUNT) {
            yield* Effect.logWarning("truncating keybindings config to max entries", {
              path: keybindingsConfigPath,
              maxEntries: MAX_KEYBINDINGS_COUNT,
            });
          }
          yield* writeConfigAtomically(cappedConfig.map(({ value }) => value));
          return yield* reloadAndEmit;
        }),
      ),
    removeKeybindingRule: (input) =>
      upsertSemaphore.withPermits(1)(
        Effect.gen(function* () {
          const customConfig = yield* loadWritableCustomKeybindingsConfig();
          const target = keybindingRuleFromInput(input);
          const nextConfig = customConfig.filter(
            ({ rule }) => !rule || !isSameKeybindingRule(rule, target),
          );
          yield* writeConfigAtomically(nextConfig.map(({ value }) => value));
          return yield* reloadAndEmit;
        }),
      ),
  } satisfies Keybindings["Service"];
});

export const layer = Layer.effect(Keybindings, make);
