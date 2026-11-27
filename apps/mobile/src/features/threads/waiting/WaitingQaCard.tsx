import { useAtomValue } from "@effect/atom-react";
import {
  qaCardLead,
  qaCardStatus,
  qaCardTitle,
  qaPresence,
  type QaChange,
} from "@t3tools/client-runtime/qa-card";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  EvidenceChangeQa,
  EvidenceLanding,
  ThreadId,
} from "@t3tools/contracts";
import { useState, type ReactNode } from "react";
import { Pressable, View } from "react-native";

import { SymbolView } from "../../../components/ui/AppSymbol";
import { AppText as Text, AppTextInput as TextInput } from "../../../components/ui/AppText";
import { Button } from "../../../components/ui/Button";
import { FilePreviewModal } from "../../../components/ui/FilePreviewModal";
import { VideoPreviewModal } from "../../../components/ui/VideoPreviewModal";
import { cn } from "../../../lib/cn";
import { evidenceSetQa } from "../../../state/evidence";
import { useAtomCommand } from "../../../state/use-atom-command";
import {
  QA_STATUS_LABEL,
  qaCapturePreview,
  qaCheckLabel,
  qaDiscussRecord,
  qaFullText,
  qaLandedLine,
  qaNoteLabel,
  qaReviewLabel,
} from "./mobileQaCard.logic";
import { addQaDiscuss, removeQaDiscuss } from "./qaDiscuss";

/** One capture: its caption, opening the file in the app's image, video or document viewer. */
function CaptureLink(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly path: string;
  readonly caption: string;
}) {
  const [open, setOpen] = useState(false);
  const preview = qaCapturePreview(props.path);
  // Read through the landing's own thread, which may be a delegated child's, as web reads it.
  const resource = { _tag: "media-file" as const, threadId: props.threadId, path: props.path };
  const label = props.caption || preview.name;
  if (preview.kind === "unavailable")
    return (
      <Text selectable className="font-sans text-sm text-foreground">
        {label}
        <Text className="text-foreground-muted"> · no preview for {preview.name}</Text>
      </Text>
    );
  const kind = preview.kind;
  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Open capture: ${label}`}
        onPress={() => setOpen(true)}
        className="min-h-11 flex-row items-center gap-2 active:opacity-70"
      >
        <SymbolView name="arrow.up.right" size={14} tintColorClassName="accent-primary-text" />
        <Text className="min-w-0 shrink font-sans text-sm text-primary-text">{label}</Text>
      </Pressable>
      {kind === "video" ? (
        <VideoPreviewModal
          source={
            open
              ? {
                  type: "media",
                  name: label,
                  mimeType: preview.mimeType,
                  environmentId: props.environmentId,
                  resource,
                }
              : null
          }
          onRequestClose={() => setOpen(false)}
        />
      ) : (
        <FilePreviewModal
          source={
            open
              ? {
                  kind,
                  name: preview.name,
                  mimeType: preview.mimeType,
                  environmentId: props.environmentId,
                  resource,
                }
              : null
          }
          onRequestClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

function Detail(props: { readonly label: string; readonly children: ReactNode }) {
  return (
    <View className="gap-0.5">
      <Text className="font-sans text-xs text-foreground-muted">{props.label}</Text>
      {props.children}
    </View>
  );
}

const detailText = "font-sans text-sm text-foreground";

/**
 * One landed change's QA: what landed, its review, checks, captures, gaps and note, with Looks
 * good, Discuss and Dismiss while it waits, and Reopen once settled. A problem is the agent's to
 * fix, so it is read-only.
 */
export function WaitingQaCard(props: {
  readonly environmentId: EnvironmentId;
  readonly landing: EvidenceLanding;
  readonly change: QaChange;
  /** The thread's composer draft, where Discuss puts its reference; null hides Discuss. */
  readonly draftKey: string | null;
  readonly inComposer: boolean;
  /** Discuss added its reference, so the user writes next. */
  readonly onDiscuss: () => void;
}) {
  const { environmentId, landing, change } = props;
  const canAct = useAtomValue(evidenceSetQa.permissionAtom(environmentId));
  const setQa = useAtomCommand(evidenceSetQa, { reportFailure: false });
  // The server's answer shows at once; the thread's next read replaces it.
  const [answered, setAnswered] = useState<EvidenceChangeQa | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [evidenceOpen, setEvidenceOpen] = useState(false);
  const lead = qaCardLead(change);
  const [reason, setReason] = useState<string | null>(null);
  const qa = answered !== null && answered.updatedAt > change.qa.updatedAt ? answered : change.qa;
  const quiet = qaPresence(qa) === "quiet";
  const status = qaCardStatus(qa, props.inComposer);
  const waiting = qa.state === "pending" || quiet;
  const usable = canAct && !busy;
  const record = qaDiscussRecord(landing, change);
  const note = qa.note.trim();
  const noteLabel = qaNoteLabel(qa);
  const fullSummary = qaFullText(change.summary);
  const fullAsk = qaFullText(change.ask);

  const answer = async (state: "pending" | "confirmed" | "waived", nextNote?: string) => {
    setBusy(true);
    setError(null);
    const result = await setQa({
      environmentId,
      input: {
        landingId: landing.id,
        changeId: change.id,
        state,
        ...(nextNote === undefined ? {} : { note: nextNote }),
      },
    });
    setBusy(false);
    if (result._tag === "Success") {
      setAnswered(result.value);
      return true;
    }
    if (!isAtomCommandInterrupted(result))
      setError(`Could not save: ${String(squashAtomCommandFailure(result))}`);
    return false;
  };
  const settle = async (state: "confirmed" | "waived") => {
    if (!(await answer(state))) return;
    if (props.draftKey !== null && props.inComposer) removeQaDiscuss(props.draftKey, record);
  };
  const discuss = () => {
    if (props.draftKey === null) return;
    if (props.inComposer) {
      removeQaDiscuss(props.draftKey, record);
      return;
    }
    if (addQaDiscuss(props.draftKey, record)) props.onDiscuss();
    else setError("The message has too many references to add this one.");
  };
  const saveReason = async () => {
    if (reason === null) return;
    if (reason.trim() === note || (await answer("waived", reason.trim()))) setReason(null);
  };

  return (
    <View
      className={cn(
        "gap-3 px-3.5 py-3",
        !quiet && "rounded-2xl border border-border-subtle bg-card",
      )}
    >
      {quiet ? null : (
        <View className="flex-row items-start gap-2">
          <Text selectable className="min-w-0 flex-1 font-t3-bold text-sm text-foreground">
            {qaCardTitle(change)}
          </Text>
          <Text
            className={cn(
              "shrink-0 font-t3-medium text-xs",
              status === "agent-fixing" || status === "discussing"
                ? "text-warning-foreground"
                : "text-foreground-muted",
            )}
          >
            {QA_STATUS_LABEL[status]}
          </Text>
        </View>
      )}
      {lead.kind === "check" ? (
        lead.rows.map(({ label, text }) => (
          <Detail key={label} label={label}>
            <Text selectable className={detailText}>
              {text}
            </Text>
          </Detail>
        ))
      ) : (
        <Text className={detailText}>{lead.text}</Text>
      )}
      {noteLabel === null ? null : (
        <Detail label={noteLabel}>
          <Text selectable className={detailText}>
            {note}
          </Text>
        </Detail>
      )}
      {error === null ? null : (
        <Text selectable className="font-sans text-sm text-danger-foreground">
          {error}
        </Text>
      )}
      {reason !== null ? (
        <View className="gap-2">
          <TextInput
            accessibilityLabel="Why it was dismissed"
            placeholder="Why dismiss it? (optional)"
            value={reason}
            onChangeText={setReason}
            maxLength={2000}
            multiline
            autoFocus
            editable={!busy}
            className="min-h-16 rounded-xl border border-input-border bg-input px-3 py-2 font-sans text-sm text-foreground"
          />
          <View className="flex-row flex-wrap justify-end gap-2">
            <Button label="Cancel" tone="text" onPress={() => setReason(null)} />
            <Button
              label="Save reason"
              tone="primary"

              loading={busy}
              disabled={!usable}
              onPress={() => void saveReason()}
            />
          </View>
        </View>
      ) : status === "agent-fixing" ? null : waiting ? (
        <View className="flex-row flex-wrap justify-end gap-2">
          {quiet ? (
            <Button
              label="Needs me"
              accessibilityLabel={`Needs me: ${record.ref}`}
              accessibilityHint="Shows it as a QA card in its thread."
              disabled={!usable}
              onPress={() => void answer("pending")}
            />
          ) : null}
          <Button
            label="Dismiss"
            accessibilityLabel={`Dismiss ${record.ref}`}
            accessibilityHint="Closes it without checking. Nothing is sent to the agent."

            disabled={!usable}
            onPress={() => void settle("waived")}
          />
          {props.draftKey === null ? null : (
            <Button
              label={props.inComposer ? "Remove from message" : "Discuss"}
              accessibilityLabel={`${props.inComposer ? "Stop discussing" : "Discuss"} ${record.ref}`}
              accessibilityHint={
                props.inComposer
                  ? "Takes the reference to this change out of your message."
                  : "Puts a reference to this change in your message, to write about it there."
              }

              disabled={!canAct}
              onPress={discuss}
            />
          )}
          <Button
            label="Looks good"
            accessibilityLabel={`Looks good: ${record.ref}`}
            accessibilityHint="You checked it and it works. Nothing is sent to the agent."
            tone="primary"

            loading={busy}
            disabled={!usable}
            onPress={() => void settle("confirmed")}
          />
        </View>
      ) : (
        <View className="flex-row flex-wrap justify-end gap-2">
          {qa.state === "waived" && qa.by !== "agent" ? (
            <Button
              label={note ? "Edit reason" : "Add reason"}

              disabled={!usable}
              onPress={() => setReason(qa.note)}
            />
          ) : null}
          <Button
            label="Reopen"
            accessibilityLabel={`Reopen ${record.ref}`}
            accessibilityHint="Opens it again so you can check it. Nothing is sent to the agent."

            loading={busy}
            disabled={!usable}
            onPress={() => void answer("pending")}
          />
        </View>
      )}
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: evidenceOpen }}
        onPress={() => setEvidenceOpen(!evidenceOpen)}
      >
        <Text className={detailText}>Evidence</Text>
      </Pressable>
      {evidenceOpen ? (
        <View className="gap-2">
          <Text selectable className="font-sans text-xs text-foreground-secondary">
            {qaLandedLine(landing, change)}
          </Text>
          {fullSummary === null ? null : (
            <Detail label="Summary">
              <Text selectable className={detailText}>
                {fullSummary}
              </Text>
            </Detail>
          )}
          {fullAsk === null ? null : (
            <Detail label="Ask">
              <Text selectable className={detailText}>
                {fullAsk}
              </Text>
            </Detail>
          )}
          <Detail label="Review">
            <Text selectable className={detailText}>
              {qaReviewLabel(change.review)}
            </Text>
          </Detail>
          {landing.verifications.length > 0 ? (
            <Detail label="Checks">
              {landing.verifications.map((check, index) => (
                <Text
                  // oxlint-disable-next-line react/no-array-index-key -- Records may repeat a check label.
                  key={index}
                  selectable
                  className={cn(
                    detailText,
                    check.result === "fail" && "text-danger-foreground",
                    check.result === "skipped" && "text-foreground-secondary",
                  )}
                >
                  {qaCheckLabel(check)}
                </Text>
              ))}
            </Detail>
          ) : null}
          {change.captures.length > 0 ? (
            <Detail label="Captures">
              {change.captures.map((capture, index) => (
                <CaptureLink
                  // oxlint-disable-next-line react/no-array-index-key -- Records may repeat a capture path.
                  key={`${index}:${capture.path}`}
                  environmentId={environmentId}
                  threadId={landing.threadId}
                  path={capture.path}
                  caption={capture.caption}
                />
              ))}
            </Detail>
          ) : null}
          {change.gaps.length > 0 ? (
            <Detail label="Gaps">
              {change.gaps.map((gap, index) => (
                <Text
                  // oxlint-disable-next-line react/no-array-index-key -- Records may repeat a gap.
                  key={`${index}:${gap}`}
                  selectable
                  className={detailText}
                >
                  {gap}
                </Text>
              ))}
            </Detail>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}
