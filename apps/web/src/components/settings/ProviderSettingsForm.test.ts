import { describe, expect, it } from "vite-plus/test";
import {
  makeProviderSettingsSchema,
  ProviderDriverKind,
  SettingsSecretValue,
  TrimmedString,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { providerClients } from "./providerDriverMeta";
import {
  checklistOptionChecked,
  checklistPresetApplied,
  deriveProviderSettingsFields,
  nextProviderConfigWithChecklist,
  nextProviderConfigWithChecklistOption,
  nextProviderConfigWithFieldValue,
  nextProviderConfigWithPreset,
  readChecklistSelection,
  reconcileRowsDraft,
  seedRowsDraft,
} from "./ProviderSettingsForm";

describe("ProviderSettingsForm helpers", () => {
  it("keeps every masked field as a stored secret and offers a reference only where typed so", () => {
    const settingsSchema = makeProviderSettingsSchema({
      token: TrimmedString.pipe(
        Schema.annotateKey({ providerSettingsForm: { control: "password" } }),
      ),
      apiKey: SettingsSecretValue,
    });

    expect(
      deriveProviderSettingsFields({ settingsSchema }).map(
        ({ key, secret, acceptsSecretReference }) => ({ key, secret, acceptsSecretReference }),
      ),
    ).toEqual([
      { key: "token", secret: true, acceptsSecretReference: undefined },
      { key: "apiKey", secret: true, acceptsSecretReference: true },
    ]);
  });

  it("preserves unknown config keys while omitting empty configurable fields", () => {
    const opencode = providerClients.get(ProviderDriverKind.make("opencode"));
    expect(opencode).toBeDefined();

    const serverUrl = deriveProviderSettingsFields(opencode!).find(
      (field) => field.key === "serverUrl",
    );
    expect(serverUrl).toBeDefined();

    const next = nextProviderConfigWithFieldValue(
      { forkOwned: 1, serverUrl: "http://127.0.0.1:4096" },
      serverUrl!,
      "",
    );

    expect(next).toEqual({ forkOwned: 1 });
  });

  it("does not store a text value its field's schema rejects", () => {
    const claude = providerClients.get(ProviderDriverKind.make("claudeAgent"));
    expect(claude).toBeDefined();
    const autoCompactWindow = deriveProviderSettingsFields(claude!).find(
      (field) => field.key === "autoCompactWindow",
    );
    expect(autoCompactWindow).toBeDefined();

    for (const invalid of ["300k", "50000"]) {
      expect(
        nextProviderConfigWithFieldValue({ launchArgs: "--x" }, autoCompactWindow!, invalid),
      ).toEqual({ launchArgs: "--x" });
    }
    expect(
      nextProviderConfigWithFieldValue({ launchArgs: "--x" }, autoCompactWindow!, "300000"),
    ).toEqual({ launchArgs: "--x", autoCompactWindow: "300000" });
  });

  it("offers Claude's removable built-in tools as a checklist that saves a cleared list", () => {
    const claude = providerClients.get(ProviderDriverKind.make("claudeAgent"));
    const field = deriveProviderSettingsFields(claude!).find(
      (candidate) => candidate.key === "omittedBuiltinTools",
    );
    expect(field?.control).toBe("checklist");
    expect(field?.options?.map((option) => option.value)).not.toContain("ToolSearch");
    expect(field?.options?.map((option) => option.value)).not.toContain("Skill");
    expect(field?.checklistStores).toBe("unchecked");
    expect(field?.presets?.map((preset) => preset.label)).toEqual([
      "Recommended",
      "Artifact tools only",
      "All tools",
    ]);

    const next = nextProviderConfigWithChecklist({ launchArgs: "--x" }, field!, [
      "Workflow",
      "Artifact",
      "ToolSearch",
    ]);
    expect(next).toEqual({ launchArgs: "--x", omittedBuiltinTools: ["Artifact", "Workflow"] });
    const cleared = nextProviderConfigWithChecklist(next, field!, []);
    expect(cleared).toEqual({ launchArgs: "--x", omittedBuiltinTools: [] });
    expect(readChecklistSelection(cleared, field!)).toEqual([]);
  });

  it("shows all seven built-in tools unticked when nothing is saved", () => {
    const claude = providerClients.get(ProviderDriverKind.make("claudeAgent"));
    const field = deriveProviderSettingsFields(claude!).find(
      (candidate) => candidate.key === "omittedBuiltinTools",
    )!;
    const options = field.options!.map((option) => option.value);
    expect(options).toHaveLength(7);
    expect(options.filter((option) => checklistOptionChecked(undefined, field, option))).toEqual(
      [],
    );
    expect(readChecklistSelection({ launchArgs: "--x" }, field)).toEqual(options);
  });

  it("removes a ticked built-in tool from the left-out list and adds an unticked one", () => {
    const claude = providerClients.get(ProviderDriverKind.make("claudeAgent"));
    const field = deriveProviderSettingsFields(claude!).find(
      (candidate) => candidate.key === "omittedBuiltinTools",
    )!;
    const ticked = nextProviderConfigWithChecklistOption(
      { launchArgs: "--x" },
      field,
      "Task",
      true,
    );
    expect(ticked).toEqual({
      launchArgs: "--x",
      omittedBuiltinTools: [
        "Artifact",
        "ArtifactData",
        "ArtifactComments",
        "Workflow",
        "ScheduleWakeup",
        "ReportFindings",
      ],
    });
    expect(checklistOptionChecked(ticked, field, "Task")).toBe(true);
    const unticked = nextProviderConfigWithChecklistOption(
      { omittedBuiltinTools: [] },
      field,
      "Workflow",
      false,
    );
    expect(unticked).toEqual({ omittedBuiltinTools: ["Workflow"] });
    expect(checklistOptionChecked(unticked, field, "Workflow")).toBe(false);
    expect(checklistOptionChecked(unticked, field, "Artifact")).toBe(true);
  });

  it("returns the built-in tools to the default by removing the saved list", () => {
    const claude = providerClients.get(ProviderDriverKind.make("claudeAgent"));
    const field = deriveProviderSettingsFields(claude!).find(
      (candidate) => candidate.key === "omittedBuiltinTools",
    )!;
    const [recommended, artifactToolsOnly, allTools] = field.presets!;
    const saved = { launchArgs: "--x", omittedBuiltinTools: ["Artifact", "Workflow"] };

    expect(checklistPresetApplied(saved, field, recommended!)).toBe(false);
    const reset = nextProviderConfigWithPreset(saved, field, recommended!);
    expect(reset).toEqual({ launchArgs: "--x" });
    expect(checklistPresetApplied(reset, field, recommended!)).toBe(true);
    expect(nextProviderConfigWithPreset({ omittedBuiltinTools: [] }, field, recommended!)).toBe(
      undefined,
    );
    // An explicit list of all seven still differs from following the default.
    const allSeven = { omittedBuiltinTools: field.options!.map((option) => option.value) };
    expect(checklistPresetApplied(allSeven, field, recommended!)).toBe(false);

    const artifactsOnly = nextProviderConfigWithPreset(reset, field, artifactToolsOnly!);
    expect(artifactsOnly).toEqual({
      launchArgs: "--x",
      omittedBuiltinTools: ["Task", "Workflow", "ScheduleWakeup", "ReportFindings"],
    });
    expect(checklistOptionChecked(artifactsOnly, field, "Artifact")).toBe(true);
    // All tools saves an empty left-out list rather than returning to the default.
    expect(nextProviderConfigWithPreset(reset, field, allTools!)).toEqual({
      launchArgs: "--x",
      omittedBuiltinTools: [],
    });
  });

  it("stores false boolean fields when true is the default", () => {
    const next = nextProviderConfigWithFieldValue(
      undefined,
      {
        key: "experimental",
        control: "switch",
        label: "Experimental",
        clearWhenEmpty: "omit",
        defaultBooleanValue: true,
      },
      false,
    );

    expect(next).toEqual({ experimental: false });
  });
});

describe("reconcileRowsDraft", () => {
  let nextId = 0;
  const toRows = (values: ReadonlyArray<string>) =>
    values.map((value) => ({ id: nextId++, value }));
  const equal = (left: ReadonlyArray<string>, right: ReadonlyArray<string>) =>
    left.length === right.length && left.every((value, index) => value === right[index]);

  it("keeps rows when an equal value arrives with a new identity", () => {
    const draft = seedRowsDraft(["a"], toRows);
    expect(reconcileRowsDraft(draft, ["a"], equal, toRows)).toBe(draft);
  });

  it("keeps row ids when the published value echoes back", () => {
    const seeded = seedRowsDraft(["a"], toRows);
    const edited = { rows: [...seeded.rows, { id: 99, value: "" }], seen: seeded.seen };
    const draft = { ...edited, lastPublished: ["a", ""] };
    const next = reconcileRowsDraft(draft, ["a", ""], equal, toRows);
    expect(next.rows).toBe(draft.rows);
    expect(next.seen).toEqual(["a", ""]);
    expect(next.lastPublished).toBeUndefined();
  });

  it("reseeds rows when the value changes from outside", () => {
    const draft = { ...seedRowsDraft(["a"], toRows), lastPublished: ["b"] };
    const next = reconcileRowsDraft(draft, ["c"], equal, toRows);
    expect(next.rows.map((row) => row.value)).toEqual(["c"]);
    expect(next.lastPublished).toBeUndefined();
  });
});
