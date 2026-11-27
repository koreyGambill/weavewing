import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";
import { useComposerDraftStore } from "../../composerDraftStore";
import { buildMessageContext } from "../../lib/composerContextRecords";
import { snapshotComposerSend } from "../ChatView.logic";
import type { ChatComposerHandle } from "./ChatComposer";
import { useMultipleModelSend } from "./useMultipleModelSend";

const mocks = vi.hoisted(() => ({ startThreadTurn: vi.fn() }));
vi.mock("../../state/use-orchestration-command", () => ({
  useOrchestrationCommand: () => mocks.startThreadTurn,
}));

it("restores the tracked mark and discussions with a failed multiple-model prompt", async () => {
  mocks.startThreadTurn.mockReset().mockResolvedValue({
    _tag: "Failure",
    cause: Cause.fail(new Error("The server refused the start.")),
  });
  const target = scopeThreadRef(EnvironmentId.make("environment"), ThreadId.make("fanout"));
  const store = useComposerDraftStore.getState();
  const prompt = "Which port?";
  const trackedAnswer = { track: true, discuss: [{ id: "A1", question: "Which host?" }] };
  store.setPrompt(target, prompt);
  store.setTrackedAnswer(target, trackedAnswer);
  const contents = {
    terminalContexts: [],
    previewAnnotations: [],
    reviewComments: [],
    threadContexts: [],
    environmentContexts: [],
    waitingItems: [],
    artifactAnswers: [],
  };
  const context = buildMessageContext({
    ...contents,
    trackedAnswer: { text: prompt, draft: trackedAnswer },
  });
  const selections = ["one", "two"].map((model) => ({
    instanceId: ProviderInstanceId.make("provider"),
    model,
  }));
  function Composer() {
    const send = useMultipleModelSend({
      environmentId: target.environmentId,
      routeThreadKey: "fanout-tracked",
      currentRouteThreadKeyRef: { current: "fanout-tracked" },
      draftId: null,
      composerDraftTarget: target,
      composerRef: { current: { resetCursorState: () => {} } as ChatComposerHandle },
      promptRef: { current: prompt },
      runtimeMode: "full-access",
      startFromOrigin: false,
      resetLocalDispatch: () => {},
      setThreadError: () => {},
    });
    return (
      <button
        type="button"
        onClick={() => {
          void send({
            threadId: target.threadId,
            project: {
              id: ProjectId.make("project"),
              workspaceRoot: "/work",
            } as EnvironmentProject,
            branch: "main",
            selections,
            targets: selections.map((selection) => ({ selection, text: prompt })),
            sendSnapshot: snapshotComposerSend({
              ...contents,
              prompt,
              images: [],
              files: [],
              sendableTerminalContexts: [],
              replyTo: null,
            }),
            createdAt: "2026-11-27T00:00:00.000Z",
            attachmentsPromise: Promise.resolve([]),
            usesAttachmentUploads: false,
            readFileBlockReason: () => null,
            buildOutgoingMessageContext: () => context,
            isCurrentSend: () => true,
            draftChangedDuringPreparation: () => false,
          });
        }}
      >
        Send to models
      </button>
    );
  }
  try {
    await using screen = await render(<Composer />);
    await screen.getByRole("button", { name: "Send to models" }).click();
    await vi.waitFor(() => expect(mocks.startThreadTurn).toHaveBeenCalledTimes(2));
    expect(mocks.startThreadTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({ message: expect.objectContaining({ context }) }),
      }),
    );
    await vi.waitFor(() =>
      expect(store.getComposerDraft(target)).toMatchObject({ prompt, trackedAnswer }),
    );
  } finally {
    store.clearComposerContent(target);
  }
});
