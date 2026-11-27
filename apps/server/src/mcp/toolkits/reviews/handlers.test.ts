import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  ThreadWorkspaceError,
  EvidenceError,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { ListCaller } from "../../../threadWorkspace/ThreadWorkspace.ts";
import { McpSchema, McpServer } from "effect/ai";
import { ThreadWorkspace, emptyWorkspace } from "../../../threadWorkspace/ThreadWorkspace.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpHttpServer from "../../McpHttpServer.ts";
import * as EvidenceService from "../../../evidence/EvidenceService.ts";
import * as Invocation from "../../McpInvocationContext.ts";
import { idleThreadProjection, liveThreadShell } from "../../McpToolAccess.testkit.ts";
const threadId = ThreadId.make("list-caller");
const targetId = ThreadId.make("list-target");
const workspace = {
  ...emptyWorkspace(threadId),
  revision: 3,
  items: Array.from({ length: 40 }, (_, index) => ({
    id: `item-${index}`,
    text: `Task ${index}`,
    state: "open" as const,
    owner: "agent" as const,
    links: [],
    doneAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    parentId: null,
    details: "Private migration details ".repeat(100),
  })),
  artifacts: [
    {
      id: "design",
      title: "Design",
      format: "markdown" as const,
      versions: [
        {
          version: 1,
          title: "Design",
          format: "markdown" as const,
          content: "Saved",
          questions: [],
          answers: {
            draft: { chosenOptionIds: [], notes: "Private", submittedAt: null },
            submitted: {
              chosenOptionIds: [],
              notes: "Public",
              submittedAt: "2026-01-01T00:00:00.000Z",
            },
          },
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    },
  ],
};
const mutationWorkspace = (
  changes: ReadonlyArray<{
    readonly id?: string | undefined;
    readonly text?: string | undefined;
    readonly owner?: "agent" | "you" | undefined;
  }>,
) => ({
  ...workspace,
  revision: 4,
  items: [
    ...changes
      .filter((item) => item.id === undefined)
      .map((item, index) => ({
        ...workspace.items[0]!,
        id: `created-${index}`,
        text: item.text ?? "",
        ...(item.owner === "you" ? { owner: "you" as const, ref: "T7" } : {}),
      })),
    ...workspace.items,
  ],
});
const scope: Invocation.McpInvocationScope = {
  environmentId: EnvironmentId.make("review-environment"),
  requestNamespace: "review-session",
  issuedAt: 0,
  capabilities: new Set(["orchestration"]),
  thread: {
    threadId,
    providerSessionId: "review-session",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
};
const client = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "review-test", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "review-test", version: "1" },
  },
  getClient: Effect.die("unused"),
});

// Echoes what the handler resolved, so tests see the thread and project it passed.
const layerEvidence = Layer.mock(EvidenceService.EvidenceService)({
  record: (input) =>
    Effect.succeed({
      landingId: input.id,
      changes: (input.changes ?? []).map((change) => ({
        id: change.id,
        qa: "pending" as const,
        raised: [],
      })),
      warnings: [`${input.threadId} ${input.projectId}`],
    }),
  list: (input) =>
    Effect.succeed({ items: [], next: input.needsQa ? { landedAt: "2026-01-01", id: "x" } : null }),
  get: ({ landingId }) =>
    Effect.fail(
      new EvidenceError({ code: "not_found", message: `No evidence landing ${landingId}.` }),
    ),
});

const callers: ListCaller[] = [];
// What the service reports a write changed and filed, as the locked mutation does.
const listWrite = (changes: Parameters<typeof mutationWorkspace>[0], threadId?: ThreadId) => {
  const written = { ...mutationWorkspace(changes), ...(threadId ? { threadId } : {}) };
  const requested = new Set(changes.flatMap((change) => (change.id ? [change.id] : [])));
  const changed = written.items.filter(
    (item) => requested.has(item.id) || item.id.startsWith("created-"),
  );
  return {
    workspace: written,
    changedIds: changed.map((item) => item.id),
    filedTasks: changed.flatMap((item) => ("ref" in item && item.ref ? [item.ref] : [])),
  };
};
const call = (
  name: string,
  args: Record<string, unknown>,
  invocation = scope,
  missingOwner = false,
) =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    return yield* server
      .callTool({ name, arguments: args })
      .pipe(
        Effect.provideService(Invocation.McpInvocationContext, invocation),
        Effect.provideService(McpSchema.McpServerClient, client),
      );
  }).pipe(
    Effect.provide(
      McpHttpServer.layerReviewToolkit.pipe(
        Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
        Layer.provide(layerEvidence),
        Layer.provide(
          Layer.mock(ThreadWorkspace)({
            get: () => Effect.succeed(workspace),
            listRead: ({ allThreads }) =>
              Effect.succeed([
                {
                  threadId: allThreads ? targetId : threadId,
                  threadTitle: "List",
                  revision: 3,
                  items: [],
                  summaryNotes: "",
                  childPreamble: "",
                },
              ]),
            update: ({ threadId, expectedRevision, changes }, caller) =>
              (callers.push(caller), expectedRevision === 3)
                ? Effect.succeed(listWrite(changes, threadId))
                : Effect.fail(
                    new ThreadWorkspaceError({ code: "conflict", message: "Read again." }),
                  ),
            rewrite: ({ items }) => Effect.succeed(listWrite(items)),
            artifactWrite: () => Effect.succeed({ ...workspace, revision: 4 }),
            artifactList: () =>
              Effect.succeed([
                {
                  id: "design",
                  title: "Design",
                  format: "markdown",
                  version: 2,
                  unansweredQuestions: 0,
                  createdAt: "2026-01-01T00:00:00.000Z",
                },
              ]),
            artifactRead: ({ version }) =>
              Effect.succeed({
                questions: [],
                answers: {},
                version: version ?? 2,
                title: "Design",
                format: "markdown",
                content: "Saved",
                createdAt: "2026-01-01T00:00:00.000Z",
              }),
          }),
        ),
        Layer.provide(
          Layer.mock(ThreadManagement.ThreadManagementService)({
            getThreadShell: (id) =>
              Effect.succeed(
                missingOwner && id === targetId
                  ? null
                  : liveThreadShell(
                      id,
                      id === threadId
                        ? { runtimeMode: "approval-required", interactionMode: "plan" }
                        : {},
                    ),
              ),
            getProjectThreadRecords: ({ threadId: id }) =>
              Effect.succeed(idleThreadProjection(liveThreadShell(id))),
          }),
        ),
      ),
    ),
  );

const failureCode = (result: McpSchema.CallToolResult) => {
  const block = result.content[0];
  return result.isError && block?.type === "text" ? JSON.parse(block.text).code : undefined;
};

it.effect("reads and updates the calling thread and reports revision conflicts", () =>
  Effect.gen(function* () {
    const read = yield* call("list_read", {});
    expect(read.structuredContent).toMatchObject([{ threadId, revision: 3 }]);
    const update = yield* call("list_update", { expectedRevision: 3, changes: [{ text: "Ship" }] });
    expect(update.structuredContent).toMatchObject({ revision: 4 });
    expect(failureCode(yield* call("list_update", { expectedRevision: 2, changes: [] }))).toBe(
      "invalid_request",
    );
  }),
);
it.effect("checks every thread in an all-threads read", () =>
  Effect.gen(function* () {
    const read = yield* call("list_read", { allThreads: true }, scope, true);
    expect(failureCode(read)).toBe("thread_not_found");
    expect(read.structuredContent).toBeUndefined();
  }),
);
it.effect("checks cross-thread write mode limits and read-only access", () =>
  Effect.gen(function* () {
    expect(
      failureCode(
        yield* call("list_rewrite", { threadId: targetId, expectedRevision: 3, items: [] }),
      ),
    ).toBe("runtime_mode_escalation_denied");
    const invocation: Invocation.McpInvocationScope = {
      ...scope,
      thread: undefined,
      client: { sessionId: "reader", label: "Reader", access: "read-only" },
    };
    expect(
      failureCode(
        yield* call(
          "artifact_write",
          { threadId, expectedRevision: 3, title: "Design", format: "markdown", content: "Saved" },
          invocation,
        ),
      ),
    ).toBe("capability_denied");
    expect(
      (yield* call("artifact_read", { threadId, id: "design", version: 1 }, invocation))
        .structuredContent,
    ).toMatchObject({ version: 1, content: "Saved" });
  }),
);
it.effect("exposes only the list and artifact schemas", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const tools = server.tools
      .map(({ tool }) => tool)
      .filter((tool) => /^(list_|artifact_|thread_workspace_|review_|evidence_)/.test(tool.name));
    // Agents record evidence, read QA and record the user's QA from chat.
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "artifact_list",
      "artifact_read",
      "artifact_write",
      "evidence_qa_update",
      "evidence_read",
      "evidence_record",
      "list_read",
      "list_rewrite",
      "list_update",
    ]);
    expect(
      tools.find((tool) => tool.name === "artifact_write")?.inputSchema.properties,
    ).toHaveProperty("format");
  }).pipe(
    Effect.provide(
      McpHttpServer.layerReviewToolkit.pipe(
        Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
        Layer.provide(Layer.mock(ThreadWorkspace)({})),
        Layer.provide(Layer.mock(EvidenceService.EvidenceService)({})),
        Layer.provide(Layer.mock(ThreadManagement.ThreadManagementService)({})),
      ),
    ),
  ),
);

it.effect.each(["list_update", "list_rewrite", "artifact_write"])(
  "%s omits artifact contents and answer history",
  (name) =>
    Effect.gen(function* () {
      const result = yield* call(name, {
        expectedRevision: 3,
        ...(name === "list_update"
          ? { changes: [] }
          : name === "list_rewrite"
            ? { items: [] }
            : { title: "Design", format: "markdown", content: "Saved" }),
      });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).not.toHaveProperty("artifacts");
      expect(result.structuredContent).not.toHaveProperty("answers");
      expect(result.structuredContent).not.toHaveProperty("content");
      if (name === "artifact_write")
        expect(result.structuredContent).toEqual({
          threadId,
          revision: 4,
          id: "design",
          title: "Design",
          format: "markdown",
          version: 1,
          createdAt: "2026-01-01T00:00:00.000Z",
          unansweredQuestions: 0,
        });
      else expect(result.structuredContent).toEqual({ revision: 4, items: [] });
      expect(JSON.stringify(result.structuredContent)).not.toContain("Private");
    }),
);

it.effect.each(["list_update", "list_rewrite"])(
  "%s returns compact changed items in a 40-item list",
  (name) =>
    Effect.gen(function* () {
      const changes = [{ id: "item-39", text: "Task 39" }];
      const result = yield* call(name, {
        expectedRevision: 3,
        ...(name === "list_update" ? { changes } : { items: changes }),
      });
      expect(result.structuredContent).toEqual({
        revision: 4,
        items: [
          {
            id: "item-39",
            text: "Task 39",
            state: "open",
            owner: "agent",
            links: [],
            doneAt: null,
          },
        ],
      });
      expect(JSON.stringify(result.structuredContent).length).toBe(114);
      const batch = Array.from({ length: 11 }, (_, index) => ({
        id: `item-${index + 29}`,
        text: `Task ${index + 29}`,
      }));
      const updated = yield* call(name, {
        expectedRevision: 3,
        ...(name === "list_update" ? { changes: batch } : { items: batch }),
      });
      expect(JSON.stringify(updated.structuredContent).length).toBe(1014);
      const additions = [{ text: "New item" }];
      const created = yield* call(name, {
        expectedRevision: 3,
        ...(name === "list_update" ? { changes: additions } : { items: additions }),
      });
      expect(created.structuredContent).toMatchObject({
        revision: 4,
        items: [{ id: "created-0", text: "New item" }],
      });
      expect(JSON.stringify(created.structuredContent)).not.toContain("details");
    }),
);

it.effect("passes the calling thread to the service, which reads that turn's user message", () =>
  Effect.gen(function* () {
    callers.length = 0;
    yield* call("list_update", {
      expectedRevision: 3,
      changes: [{ id: "item-1", state: "done", settledFromUser: true }],
    });
    expect(callers).toEqual([{ by: "agent", threadId }]);
  }),
);

it.effect("names the user tasks a call filed so their cards go at the call", () =>
  Effect.gen(function* () {
    const result = yield* call("list_update", {
      expectedRevision: 3,
      changes: [{ text: "Rotate the staging webhook secret", owner: "you" }],
    });
    expect(result.structuredContent).toMatchObject({ filedTasks: ["T7"] });
    const edit = yield* call("list_update", {
      expectedRevision: 3,
      changes: [{ id: "item-1", text: "Ship" }],
    });
    expect(edit.structuredContent).not.toHaveProperty("filedTasks");
  }),
);

it.effect("records evidence on the calling thread and reads summaries or one landing", () =>
  Effect.gen(function* () {
    const landing = {
      id: "batch-1",
      title: "Batch",
      target: { branch: "main", sha: "abc1234" },
      verifications: [{ label: "gate", result: "pass" }],
      changes: [
        {
          id: "bw-1",
          ask: "Fix it",
          commits: ["abc1234"],
          summary: "Fixed",
          review: { verdict: "approved" },
          captures: [],
          gaps: [],
        },
      ],
    };
    // The project always comes from the thread; an agent cannot name another.
    const refused = yield* Effect.flip(
      call("evidence_record", { ...landing, projectId: "elsewhere" }),
    );
    expect(refused.message).toContain('Unknown argument "projectId"');
    const recorded = yield* call("evidence_record", landing);
    const shell = liveThreadShell(threadId);
    expect(recorded.structuredContent).toEqual({
      landingId: "batch-1",
      changes: [{ id: "bw-1", qa: "pending", raised: [] }],
      warnings: [`${threadId} ${shell.projectId}`],
    });
    const reader: Invocation.McpInvocationScope = {
      ...scope,
      thread: undefined,
      client: { sessionId: "reader", label: "Reader", access: "read-only" },
    };
    expect((yield* call("evidence_read", { needsQa: true }, reader)).structuredContent).toEqual({
      items: [],
      next: { landedAt: "2026-01-01", id: "x" },
    });
    const missing = yield* call("evidence_read", { landingId: "nope" }, reader);
    expect(failureCode(missing)).toBe("invalid_request");
    expect(failureCode(yield* call("evidence_record", landing, reader))).toBe("capability_denied");
  }),
);
