import { useState } from "react";
import { Modal, ScrollView, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { WebView } from "react-native-webview";
import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { Button } from "../../components/ui/Button";
import { NavigationRow } from "../../components/ui/NavigationRow";
import { Chip } from "../../components/ui/Chip";
import { AppText as Text } from "../../components/ui/AppText";
import { threadListAtom, threadArtifactsAtom, threadArtifactAtom } from "../../state/thread-list";
import { SelectableMarkdownText } from "../../native/SelectableMarkdownText";
import { useMarkdownPreviewStyles } from "../files/FileMarkdownPreview";

function ArtifactView(props: { environmentId: EnvironmentId; threadId: ThreadId; id: string }) {
  const artifact = useAtomValue(
    threadArtifactAtom({
      environmentId: props.environmentId,
      input: { threadId: props.threadId, id: props.id },
    }),
  );
  const styles = useMarkdownPreviewStyles();
  if (!AsyncResult.isSuccess(artifact))
    return (
      <Text>
        {AsyncResult.isFailure(artifact) ? "Could not load artifact." : "Loading artifact…"}
      </Text>
    );
  if (artifact.value.format === "html") {
    const escaped = artifact.value.content
      .replaceAll("&", "&amp;")
      .replaceAll('"', "&quot;")
      .replaceAll("<", "&lt;");
    return (
      <View style={{ height: 480 }}>
        <WebView
          source={{
            html: `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; frame-src about:"><iframe sandbox="" style="border:0;width:100%;height:100%" srcdoc="${escaped}"></iframe>`,
          }}
          javaScriptEnabled={false}
          allowFileAccess={false}
          originWhitelist={["about:*"]}
          onShouldStartLoadWithRequest={(request) =>
            request.url === "about:blank" || request.url === "about:srcdoc"
          }
        />
      </View>
    );
  }
  return (
    <View className="w-full max-w-[720px] self-center gap-4">
      <View className="flex-row items-center gap-2">
        <Chip label={`v${artifact.value.version}`} />
        <Chip label="Markdown" />
      </View>
      <SelectableMarkdownText
        markdown={artifact.value.content}
        textStyle={styles.nativeTextStyle}
      />
    </View>
  );
}

function ListContents(props: { environmentId: EnvironmentId; threadId: ThreadId }) {
  const [selected, setSelected] = useState<string | null>(null);
  const list = useAtomValue(
    threadListAtom({
      environmentId: props.environmentId,
      input: { threadId: props.threadId, all: true },
    }),
  );
  const artifacts = useAtomValue(
    threadArtifactsAtom({
      environmentId: props.environmentId,
      input: { threadId: props.threadId },
    }),
  );
  if (selected)
    return (
      <View className="gap-3">
        <Button label="Back to list" tone="text" onPress={() => setSelected(null)} />
        <ArtifactView {...props} id={selected} />
      </View>
    );
  return (
    <View className="gap-4">
      <Text className="text-lg font-semibold">List</Text>
      {AsyncResult.isSuccess(list) ? (
        list.value
          .flatMap((entry) => entry.items)
          .map((item) => (
            <View
              key={item.id}
              className={
                item.parentId
                  ? "ml-4 gap-2 rounded-2xl border border-border-subtle bg-card p-4"
                  : "gap-2 rounded-2xl border border-border-subtle bg-card p-4"
              }
            >
              <Text>{item.text}</Text>
              <Text className="text-foreground-muted">
                {item.state.replaceAll("_", " ")} · {item.owner}
              </Text>
              {item.details ? <Text>{item.details}</Text> : null}
              {item.links
                .filter((link) => link.type !== "artifact")
                .map((link) => (
                  <Text key={`${link.type}:${link.target}`} className="text-foreground-muted">
                    {link.type}: {link.target}
                  </Text>
                ))}
              {item.links
                .filter((link) => link.type === "artifact")
                .map((link) => (
                  <Button
                    key={link.target}
                    label={
                      AsyncResult.isSuccess(artifacts)
                        ? (artifacts.value.find((artifact) => artifact.id === link.target)?.title ??
                          "Open artifact")
                        : "Open artifact"
                    }
                    size="compact"
                    tone="secondary"
                    onPress={() => setSelected(link.target)}
                  />
                ))}
            </View>
          ))
      ) : (
        <Text>{AsyncResult.isFailure(list) ? "Could not load list." : "Loading list…"}</Text>
      )}
      {AsyncResult.isSuccess(list) && !list.value.some((entry) => entry.items.length) ? (
        <Text>No list items.</Text>
      ) : null}
      <Text className="text-lg font-semibold">Artifacts</Text>
      {AsyncResult.isSuccess(artifacts) ? (
        <View className="overflow-hidden rounded-2xl border border-border-subtle">
          {artifacts.value.map((artifact) => (
            <NavigationRow
              key={artifact.id}
              title={artifact.title}
              subtitle={`v${artifact.version}${artifact.unansweredQuestions ? ` · ${artifact.unansweredQuestions} unanswered` : ""}`}
              onPress={() => setSelected(artifact.id)}
            />
          ))}
        </View>
      ) : (
        <Text>
          {AsyncResult.isFailure(artifacts) ? "Could not load artifacts." : "Loading artifacts…"}
        </Text>
      )}
      {AsyncResult.isSuccess(artifacts) && !artifacts.value.length ? (
        <Text>No artifacts.</Text>
      ) : null}
    </View>
  );
}

export function ThreadListPanel(props: { environmentId: EnvironmentId; threadId: ThreadId }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button label="List & artifacts" size="compact" tone="text" onPress={() => setOpen(true)} />
      <Modal visible={open} animationType="slide" onRequestClose={() => setOpen(false)}>
        <SafeAreaView className="flex-1 bg-screen">
          <View className="p-4">
            <Button label="Close" tone="text" onPress={() => setOpen(false)} />
          </View>
          <ScrollView contentContainerStyle={{ padding: 16 }}>
            {open ? <ListContents key={props.threadId} {...props} /> : null}
          </ScrollView>
        </SafeAreaView>
      </Modal>
    </>
  );
}
