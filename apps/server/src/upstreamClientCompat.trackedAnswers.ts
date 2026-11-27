import {
  CommandId,
  EnvironmentId,
  EventId,
  MessageId,
  OrchestrationV2AppThread,
  OrchestrationV2ConversationMessage,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  RunId,
  ServerConfig,
  ThreadId,
  TurnItemId,
  waitingMirror,
  type OrchestrationV2ProviderSession,
  type OrchestrationV2TurnItem,
  type TrackedAsk,
} from "@t3tools/contracts";
import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts/settings";
import { compileResolvedKeybindingsConfig } from "@t3tools/shared/keybindings";
import * as DateTime from "effect/DateTime";
import { CodexProviderCapabilitiesV2 } from "./orchestration-v2/Adapters/CodexAdapterV2.ts";
import { emptyProjection, threadShellFromProjection } from "./orchestration-v2/ProjectionStore.ts";

export function trackedAnswerWireSamples() {
  const at = DateTime.makeUnsafe("2026-11-27T12:00:00Z");
  const timestamp = DateTime.formatIso(at);
  const threadId = ThreadId.make("tracked-answers");
  const instanceId = ProviderInstanceId.make("codex");
  const plainContext = { version: 1 as const, records: [] };
  const message = OrchestrationV2ConversationMessage.make({
    id: MessageId.make("question"),
    threadId,
    runId: null,
    nodeId: null,
    role: "user",
    createdBy: "user",
    creationSource: "web",
    text: "What resets the counter?",
    context: plainContext,
    attachments: [],
    streaming: false,
    createdAt: at,
    updatedAt: at,
  });
  const edited = { ...message, id: MessageId.make("edited"), text: "Keep this in the queue." };
  const markedMessage = {
    ...message,
    context: { ...plainContext, trackedAsk: { question: message.text }, discussAnswers: ["A2"] },
  };
  const clearedMessage = {
    ...edited,
    context: { ...plainContext, clearTrackedAsk: true as const, discussAnswers: [] },
  };
  const ask = {
    createdAt: timestamp,
    closedAt: null,
    followUps: [],
  };
  const trackedAsks = [
    {
      ...ask,
      id: "A1",
      askedInMessageId: message.id,
      question: message.text,
      state: "owed",
      answers: [],
    },
    {
      ...ask,
      id: "A2",
      askedInMessageId: MessageId.make("earlier-question"),
      question: "Where is the cache?",
      state: "answered",
      answers: [{ n: 1, text: "The local cache directory.", answeredAt: timestamp, runId: null }],
    },
  ] as const satisfies ReadonlyArray<TrackedAsk>;
  const waiting = [
    { kind: "question", key: "Q1", ref: "Q1", title: "Which test?", state: "open" },
  ] as const;
  const thread = OrchestrationV2AppThread.make({
    id: threadId,
    projectId: ProjectId.make("project"),
    title: "Tracked answers",
    createdBy: "user",
    creationSource: "web",
    providerInstanceId: instanceId,
    modelSelection: { instanceId, model: "test-model" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
    forkedFrom: null,
    createdAt: at,
    updatedAt: at,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
    ...waitingMirror(waiting),
  });
  const trackedThread = {
    ...thread,
    ...waitingMirror(
      waiting,
      trackedAsks.map(({ id, question, state }) => ({
        ref: id,
        title: question,
        state,
      })),
    ),
    trackedAnswersRevision: 3,
  };
  const driver = ProviderDriverKind.make("codex");
  const providerSession = {
    id: ProviderSessionId.make("session"),
    driver,
    providerInstanceId: instanceId,
    status: "ready",
    cwd: "/work",
    model: "test-model",
    capabilities: CodexProviderCapabilitiesV2,
    extensionStatuses: [],
    createdAt: at,
    updatedAt: at,
    lastError: null,
  } satisfies OrchestrationV2ProviderSession;
  const trackedSession = { ...providerSession, trackedAnswersAvailable: true };
  const item = {
    id: TurnItemId.make("user-message"),
    threadId,
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 1,
    type: "user_message",
    createdBy: "user",
    creationSource: "web",
    status: "completed",
    title: null,
    messageId: message.id,
    inputIntent: "turn_start",
    text: message.text,
    context: plainContext,
    attachments: [],
    startedAt: at,
    completedAt: at,
    updatedAt: at,
  } satisfies OrchestrationV2TurnItem;
  const markedItem = { ...item, context: markedMessage.context };
  const editedItem = {
    ...item,
    id: TurnItemId.make("edited-message"),
    ordinal: 2,
    messageId: edited.id,
    text: edited.text,
  };
  const clearedItem = { ...editedItem, context: clearedMessage.context };
  const visible = (item: OrchestrationV2TurnItem) => ({
    position: item.ordinal,
    sourceThreadId: threadId,
    sourceItemId: item.id,
    visibility: "local" as const,
    item,
  });
  const event = { id: EventId.make("event"), threadId, occurredAt: at };
  const projection = {
    ...emptyProjection({ ...event, type: "thread.created", payload: thread }),
    messages: [message, edited],
    providerSessions: [providerSession],
    turnItems: [item, editedItem],
    visibleTurnItems: [visible(item), visible(editedItem)],
  };
  const trackedProjection = {
    ...projection,
    thread: trackedThread,
    messages: [markedMessage, clearedMessage],
    providerSessions: [trackedSession],
    turnItems: [markedItem, clearedItem],
    visibleTurnItems: [visible(markedItem), visible(clearedItem)],
  };
  const config = ServerConfig.make({
    environment: {
      environmentId: EnvironmentId.make("environment"),
      label: "Development",
      platform: { os: "linux", arch: "x64" },
      serverVersion: "1.0.0",
      capabilities: { repositoryIdentity: false },
    },
    auth: {
      policy: "loopback-browser",
      bootstrapMethods: ["one-time-token"],
      sessionMethods: ["browser-session-cookie"],
      sessionCookieName: "test_session",
    },
    cwd: "/work",
    keybindingsConfigPath: "/work/keybindings.json",
    keybindings: compileResolvedKeybindingsConfig([
      { key: "mod+p", command: "commandPalette.toggle" },
    ]),
    issues: [],
    providers: [
      {
        instanceId,
        driver,
        enabled: true,
        installed: true,
        version: "1.0.0",
        status: "ready",
        auth: { status: "authenticated" },
        checkedAt: timestamp,
        models: [],
        slashCommands: [],
        skills: [],
      },
    ],
    availableEditors: [],
    observability: {
      logsDirectoryPath: "/work/logs",
      localTracingEnabled: false,
      otlpTracesEnabled: false,
      otlpMetricsEnabled: false,
      otlpLogsEnabled: false,
    },
    settings: DEFAULT_SERVER_SETTINGS,
  });
  return {
    event,
    threadId,
    trackedAsks,
    projection,
    trackedProjection,
    shell: threadShellFromProjection(projection),
    trackedShell: threadShellFromProjection(trackedProjection),
    commands: [
      {
        type: "message.dispatch",
        commandId: CommandId.make("send-question"),
        threadId,
        messageId: message.id,
        text: message.text,
        createdBy: "user",
        creationSource: "web",
        dispatchMode: { type: "start_immediately" },
        attachments: [],
        context: plainContext,
      },
      {
        type: "queued-run.edit",
        commandId: CommandId.make("edit-queued-question"),
        threadId,
        runId: RunId.make("queued"),
        text: edited.text,
        context: plainContext,
      },
    ] as const,
    config,
    trackedConfig: {
      ...config,
      providers: config.providers.map((provider) => ({
        ...provider,
        supportsTrackedAnswers: true,
      })),
      keybindings: [
        ...config.keybindings,
        ...compileResolvedKeybindingsConfig([
          { key: "mod+shift+y", command: "composer.trackAnswer", when: "composerFocus" },
        ]),
      ],
    },
  };
}
