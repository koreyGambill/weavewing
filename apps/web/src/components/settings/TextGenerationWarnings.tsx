import {
  type EnvironmentId,
  isManagedSettingPath,
  PROVIDER_DISPLAY_NAMES,
  ProviderDriverKind,
  type ProjectId,
  type ServerSettings,
  textGeneratorForSelection,
} from "@t3tools/contracts";
import {
  type TextGenerationPurpose,
  unusableTextGenerationPurposes,
} from "@t3tools/shared/serverSettings";
import { AlertTriangleIcon } from "lucide-react";

import { useServerConfigs } from "../../state/entities";
import { useEnvironmentProviders } from "../../state/environments";
import { textGeneratorDisplayName } from "../../textGenerators";
import { InlineButton } from "../ui/button";

const PURPOSE_SETTING: Record<TextGenerationPurpose, keyof ServerSettings> = {
  titles: "textGenerationModelSelection",
  summaries: "incomingCardSummaries",
  sourceControl: "sourceControlWriterModelSelection",
  reviewGuides: "reviewGuideModelSelection",
  transcripts: "speechPostProcessingModelSelection",
};

export interface TextGenerationWarning {
  readonly key: string;
  readonly environmentId: EnvironmentId;
  readonly machine: string;
  readonly agent: string;
  /** The organization whose policy locks the setting, so only it can choose another model. */
  readonly managedBy: string | undefined;
}

/** One warning per environment whose `purpose` model cannot run there. */
export function useTextGenerationWarnings(
  purpose: TextGenerationPurpose,
  targets: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly label: string;
    readonly projectId: ProjectId | null;
    readonly settings: ServerSettings;
  }>,
): ReadonlyArray<TextGenerationWarning> {
  const providersByEnvironment = useEnvironmentProviders();
  const serverConfigs = useServerConfigs();
  const warnings = new Map<string, TextGenerationWarning>();
  for (const target of targets) {
    const providers = providersByEnvironment.get(target.environmentId);
    const unusable = unusableTextGenerationPurposes(target.settings, providers, target.projectId);
    const selection = unusable.find((entry) => entry.purpose === purpose)?.selection;
    if (selection === undefined) continue;
    const key = `${target.environmentId}:${selection.instanceId}`;
    if (warnings.has(key)) continue;
    const generator = textGeneratorForSelection(target.settings, selection.instanceId);
    const provider = providers?.find((candidate) => candidate.instanceId === selection.instanceId);
    const policy = serverConfigs.get(target.environmentId)?.managedPolicy;
    warnings.set(key, {
      key,
      environmentId: target.environmentId,
      machine: target.label,
      agent: generator
        ? textGeneratorDisplayName(generator)
        : (provider?.displayName ??
          PROVIDER_DISPLAY_NAMES[
            provider?.driver ?? ProviderDriverKind.make(selection.instanceId)
          ] ??
          selection.instanceId),
      managedBy: isManagedSettingPath(policy, PURPOSE_SETTING[purpose])
        ? policy?.organization
        : undefined,
    });
  }
  return [...warnings.values()];
}

export function TextGenerationWarnings({
  warnings,
  purpose,
  onChoose,
}: {
  readonly warnings: ReadonlyArray<TextGenerationWarning>;
  readonly purpose: TextGenerationPurpose;
  readonly onChoose?: () => void;
}) {
  return (
    <span className="flex flex-col gap-1">
      {warnings.map((warning) => (
        <span key={warning.key} role="status" className="flex items-start gap-1.5 text-warning">
          <AlertTriangleIcon aria-hidden className="size-3.5 h-lh shrink-0" />
          <span className="min-w-0 text-pretty break-words">
            {warning.agent} isn't available on {warning.machine}
            {purpose === "summaries" ? (
              ", so summaries use another ready agent."
            ) : warning.managedBy !== undefined ? (
              `. Ask ${warning.managedBy} to choose another model.`
            ) : onChoose ? (
              <>
                {". "}
                <InlineButton tone="inherit" onClick={onChoose}>
                  Choose a model
                </InlineButton>
              </>
            ) : (
              "."
            )}
          </span>
        </span>
      ))}
    </span>
  );
}
