import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, EvidenceLandingSummary } from "@t3tools/contracts";
import { useState } from "react";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { evidenceSetQa } from "../../state/evidence";
import { useAtomCommand } from "../../state/use-atom-command";
import { landingNoteRemainder } from "./evidence.logic";

export function EvidenceNotePreview(props: {
  readonly environmentId: EnvironmentId;
  readonly landingId: string;
  readonly note: NonNullable<EvidenceLandingSummary["notes"]>[number];
  readonly onOpen: () => void;
}) {
  const { environmentId, landingId, note } = props;
  const canSet = useAtomValue(evidenceSetQa.permissionAtom(environmentId));
  const setQa = useAtomCommand(evidenceSetQa);
  const [raising, setRaising] = useState(false);
  const remainder = landingNoteRemainder(note);
  const raise = async () => {
    setRaising(true);
    await setQa({ environmentId, input: { landingId, changeId: note.id, state: "pending" } });
    setRaising(false);
  };
  return (
    <View className="flex-row items-start gap-1">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={[`Open note: ${note.title}`, ...note.gapPreviews, ...remainder].join(
          ", ",
        )}
        onPress={props.onOpen}
        className="min-h-11 min-w-0 flex-1 gap-1 rounded-xl px-2 py-2.5 active:bg-subtle"
      >
        <Text className="font-t3-medium text-sm text-foreground">{note.title}</Text>
        {note.gapPreviews.map((gap, index) => (
          <Text
            // oxlint-disable-next-line react/no-array-index-key -- Records may repeat a gap.
            key={`${index}:${gap}`}
            className="font-sans text-xs text-foreground-muted"
          >
            {gap}
          </Text>
        ))}
        {remainder.map((detail) => (
          <Text key={detail} className="font-sans text-xs text-foreground-muted">
            {detail}
          </Text>
        ))}
      </Pressable>
      <Button
        label="Needs me"
        accessibilityLabel={`Needs me: ${note.title}`}
        accessibilityHint="Shows it as a QA card in its thread."
        disabled={!canSet}
        loading={raising}
        onPress={() => void raise()}
      />
    </View>
  );
}
