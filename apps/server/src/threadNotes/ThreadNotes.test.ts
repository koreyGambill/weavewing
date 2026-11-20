import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import {
  COMPOSER_CONTEXT_REVIEW_TEXT_MAX_CHARS,
  ReviewCommentContextRecord,
  EventId,
  ProjectId,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderDriverKind,
  ProviderSessionId,
  ThreadId,
  type OrchestrationV2ProviderThread,
} from "@t3tools/contracts";
import * as ServerConfig from "../config.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import { emptyProjection } from "../orchestration-v2/ProjectionStore.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as Notes from "./ThreadNotes.ts";

const isReviewComment = Schema.is(ReviewCommentContextRecord);
const threadId = ThreadId.make("notes-thread");
const at = DateTime.makeUnsafe("2026-11-06T12:00:00Z");
const harness = Effect.fn("test.notesHarness")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "thread-notes-test-" });
  const context = yield* Layer.build(ServerConfig.layerTest(root, root));
  const config = Context.get(context, ServerConfig.ServerConfig);
  const projection = emptyProjection({
    id: EventId.make("created"),
    type: "thread.created",
    threadId,
    occurredAt: at,
    payload: {
      id: threadId,
      createdBy: "user",
      creationSource: "web",
      projectId: ProjectId.make("project"),
      title: "Notes",
      providerInstanceId: ProviderInstanceId.make("codex"),
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "default" },
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
      deletedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
    },
  });
  let providerThread: OrchestrationV2ProviderThread | null = null;
  const attempts: ThreadManagement.ThreadManagementSendInput[] = [];
  const dependencies = Layer.mergeAll(
    Layer.succeed(ServerConfig.ServerConfig, config),
    Layer.mock(Orchestrator.OrchestratorV2)({
      getThreadRecords: () =>
        Effect.succeed({
          ...projection,
          thread: { ...projection.thread, activeProviderThreadId: providerThread?.id ?? null },
          providerThreads: providerThread ? [providerThread] : [],
        }),
    }),
    Layer.mock(ThreadManagement.ThreadManagementService)({
      sendToThread: (input) => {
        attempts.push(input);
        return Effect.fail(new ThreadManagement.ThreadManagementThreadArchivedError({ threadId }));
      },
    }),
  );
  const open = Effect.fn("test.openNotes")(function* () {
    const built = yield* Layer.build(Layer.fresh(Notes.layer).pipe(Layer.provide(dependencies)));
    return Context.get(built, Notes.ThreadNotes);
  });
  return {
    fs,
    path,
    root,
    open,
    attempts,
    setProvider: (driver: string, nativeId: string) => {
      const kind = ProviderDriverKind.make(driver);
      providerThread = {
        id: ProviderThreadId.make("native-provider-thread"),
        driver: kind,
        providerInstanceId: ProviderInstanceId.make(driver),
        providerSessionId: ProviderSessionId.make("internal-runtime-id"),
        appThreadId: threadId,
        ownerNodeId: null,
        nativeThreadRef: { driver: kind, nativeId, strength: "strong" },
        nativeConversationHeadRef: null,
        status: "idle",
        firstRunOrdinal: 1,
        lastRunOrdinal: 1,
        handoffIds: [],
        forkedFrom: null,
        pendingBackgroundTasks: [],
        contextUsage: null,
        nativeMetadata: null,
        goal: null,
        createdAt: at,
        updatedAt: at,
      };
    },
    service: yield* open(),
  };
});

it.effect(
  "persists readable notes, optional thread identity, directory settings and restart state",
  () =>
    Effect.gen(function* () {
      const h = yield* harness();
      const fresh = yield* h.service.get({ threadId });
      expect(fresh.revision).toBeNull();
      expect(fresh.resumeCommand).toBeNull();
      const saved = yield* h.service.save({
        threadId,
        expectedRevision: null,
        text: "My private note\n",
        includeThreadId: true,
      });
      const raw = yield* h.fs.readFileString(saved.path);
      expect(raw).toContain("Thread ID: notes-thread");
      expect(raw).toContain("Terminal resume:");
      expect(raw).toContain("# Thread notes: Notes");
      expect(raw).toContain(fresh.resumeExplanation);
      expect(raw).toContain("My private note");
      const reopened = yield* h.open();
      expect((yield* reopened.get({ threadId })).text).toBe("My private note\n");
      const hidden = yield* reopened.save({
        threadId,
        expectedRevision: saved.revision,
        text: saved.text,
        includeThreadId: false,
      });
      expect(yield* h.fs.readFileString(hidden.path)).not.toContain("Thread ID:");
      const directory = h.path.join(h.root, "my-workspace");
      yield* reopened.updateSettings({ directory });
      expect((yield* (yield* h.open()).settings()).directory).toBe(directory);
      expect((yield* reopened.get({ threadId })).text).toBe("");
      expect(yield* h.fs.readFileString(hidden.path)).toContain("My private note");
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("detects stale editors and external edits without overwriting either", () =>
  Effect.gen(function* () {
    const h = yield* harness();
    const note = yield* h.service.save({
      threadId,
      expectedRevision: null,
      text: "first",
      includeThreadId: false,
    });
    const raw = yield* h.fs.readFileString(note.path);
    yield* h.fs.writeFileString(note.path, raw.replace("first", "external").replace(/\n/g, "\r\n"));
    const attempt = yield* Effect.result(
      h.service.save({
        threadId,
        expectedRevision: note.revision,
        text: "stale",
        includeThreadId: false,
      }),
    );
    expect(Result.isFailure(attempt) && attempt.failure.code).toBe("conflict");
    const refreshed = yield* h.service.get({ threadId });
    expect(refreshed.text).toBe("external");
    yield* h.service.save({
      threadId,
      expectedRevision: refreshed.revision,
      text: "reconciled",
      includeThreadId: false,
    });
    expect((yield* h.service.get({ threadId })).text).toBe("reconciled");
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("refuses unrelated files, relative directories and invalid selections", () =>
  Effect.gen(function* () {
    const h = yield* harness();
    const note = yield* h.service.get({ threadId });
    yield* h.fs.makeDirectory(h.path.dirname(note.path), { recursive: true });
    yield* h.fs.writeFileString(note.path, "unrelated private document");
    const unrelated = yield* Effect.result(
      h.service.save({ threadId, expectedRevision: null, text: "replace", includeThreadId: false }),
    );
    expect(Result.isFailure(unrelated) && unrelated.failure.code).toBe("conflict");
    expect(yield* h.fs.readFileString(note.path)).toBe("unrelated private document");
    const relative = yield* Effect.result(h.service.updateSettings({ directory: "relative" }));
    expect(Result.isFailure(relative) && relative.failure.code).toBe("invalid");
    yield* h.fs.remove(note.path);
    const saved = yield* h.service.save({
      threadId,
      expectedRevision: null,
      text: "hello",
      includeThreadId: false,
    });
    const invalid = yield* Effect.result(
      h.service.sendSelection({
        threadId,
        expectedRevision: saved.revision ?? "missing",
        startIndex: 0,
        endIndex: 50,
      }),
    );
    expect(Result.isFailure(invalid) && invalid.failure.code).toBe("invalid");
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "uses native CLI identity and shares only the selected quote with native source context",
  () =>
    Effect.gen(function* () {
      const h = yield* harness();
      h.setProvider("codex", "native-codex-id");
      expect((yield* h.service.get({ threadId })).resumeCommand).toBe(
        "codex resume 'native-codex-id'",
      );
      h.setProvider("claudeAgent", "native-claude-id");
      expect((yield* h.service.get({ threadId })).resumeCommand).toBe(
        "claude --resume 'native-claude-id'",
      );
      h.setProvider("unknown", "unsupported");
      expect((yield* h.service.get({ threadId })).resumeCommand).toBeNull();
      const note = yield* h.service.save({
        threadId,
        expectedRevision: null,
        text: "private before. share this. private after.",
        includeThreadId: false,
      });
      if (note.revision === null) throw new Error("Missing saved revision");
      yield* Effect.result(
        h.service.sendSelection({
          threadId,
          expectedRevision: note.revision,
          startIndex: 16,
          endIndex: 26,
        }),
      );
      expect(h.attempts).toHaveLength(1);
      expect(h.attempts[0]?.text).toContain("share this");
      expect(h.attempts[0]?.text).not.toContain("private");
      expect(h.attempts[0]?.context?.records[0]).toMatchObject({
        kind: "review-comment",
        text: "share this",
        filePath: note.path,
      });
      const stale = yield* Effect.result(
        h.service.sendSelection({
          threadId,
          expectedRevision: "stale",
          startIndex: 16,
          endIndex: 26,
        }),
      );
      expect(Result.isFailure(stale) && stale.failure.code).toBe("conflict");
      expect(h.attempts).toHaveLength(1);
      const fullSelection = "n".repeat(COMPOSER_CONTEXT_REVIEW_TEXT_MAX_CHARS + 1);
      h.setProvider("codex", "native-resume");
      const large = yield* h.service.save({
        threadId,
        expectedRevision: note.revision,
        text: fullSelection + "private outside",
        includeThreadId: false,
      });
      const metadata = yield* h.fs.readFileString(large.path);
      expect(metadata).toContain("codex resume 'native-resume'");
      expect(metadata).toContain(large.resumeExplanation);
      yield* Effect.result(
        h.service.sendSelection({
          threadId,
          expectedRevision: large.revision ?? "missing",
          startIndex: 0,
          endIndex: fullSelection.length,
        }),
      );
      expect(h.attempts[1]?.text).toContain(fullSelection);
      expect(h.attempts[1]?.text).not.toContain("private outside");
      const record = h.attempts[1]?.context?.records[0];
      expect(isReviewComment(record)).toBe(true);
      if (isReviewComment(record))
        expect(record.text.length).toBe(COMPOSER_CONTEXT_REVIEW_TEXT_MAX_CHARS);
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("stores pasted images beside the note and refuses scriptable formats", () =>
  Effect.gen(function* () {
    const h = yield* harness();
    const dataUrl = `data:image/png;base64,${Buffer.from("png-bytes").toString("base64")}`;
    const first = yield* h.service.saveImage({ threadId, dataUrl });
    const note = yield* h.service.get({ threadId });
    expect(first.notePath).toBe(note.path);
    const stored = h.path.join(h.path.dirname(note.path), first.path);
    const firstInode = (yield* h.fs.stat(stored)).ino;
    const again = yield* h.service.saveImage({ threadId, dataUrl });
    expect(again.path).toBe(first.path);
    expect((yield* h.fs.stat(stored)).ino).toEqual(firstInode);
    expect(first.path).toMatch(/^thread-[0-9a-f]{20}-images\/[0-9a-f]{20}\.png$/);
    expect(Buffer.from(yield* h.fs.readFile(stored)).toString()).toBe("png-bytes");
    const svg = yield* Effect.result(
      h.service.saveImage({ threadId, dataUrl: "data:image/svg+xml;base64,PHN2Zy8+" }),
    );
    expect(Result.isFailure(svg) && svg.failure.code).toBe("invalid");
  }).pipe(Effect.provide(NodeServices.layer)),
);
