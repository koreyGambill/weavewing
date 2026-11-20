// @effect-diagnostics-next-line nodeBuiltinImport:off -- Content digests remain a pure function shared by file identity and revision checks.
import * as NodeCrypto from "node:crypto";
import {
  COMPOSER_CONTEXT_REVIEW_TEXT_MAX_CHARS,
  CommandId,
  MessageId,
  type ThreadId,
} from "@t3tools/contracts";
import {
  THREAD_NOTES_IMAGE_MAX_BYTES,
  ThreadNotesError,
  type ThreadNote,
  type ThreadNotesGetInput,
  type ThreadNotesSaveImageInput,
  type ThreadNotesSavedImage,
  type ThreadNotesSaveInput,
  type ThreadNotesSendSelectionInput,
  type ThreadNotesSettings,
} from "@t3tools/contracts";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import {
  formatComposerContextHref,
  toComposerContextId,
} from "@t3tools/shared/composerContextReferences";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Base64 from "effect/encoding/Base64";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as ServerConfig from "../config.ts";
import { parseBase64DataUrl } from "../imageMime.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";

export class ThreadNotes extends Context.Service<
  ThreadNotes,
  {
    readonly get: (input: ThreadNotesGetInput) => Effect.Effect<ThreadNote, ThreadNotesError>;
    readonly save: (input: ThreadNotesSaveInput) => Effect.Effect<ThreadNote, ThreadNotesError>;
    readonly settings: () => Effect.Effect<ThreadNotesSettings, ThreadNotesError>;
    readonly updateSettings: (
      input: ThreadNotesSettings,
    ) => Effect.Effect<ThreadNotesSettings, ThreadNotesError>;
    readonly saveImage: (
      input: ThreadNotesSaveImageInput,
    ) => Effect.Effect<ThreadNotesSavedImage, ThreadNotesError>;
    readonly sendSelection: (
      input: ThreadNotesSendSelectionInput,
    ) => Effect.Effect<ThreadNote, ThreadNotesError>;
  }
>()("t3/threadNotes/ThreadNotes") {}

const digest = (text: string) => NodeCrypto.createHash("sha256").update(text).digest("hex");
const shellQuote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
// Raster formats only: an SVG can carry script, and the preview serves these files to the browser.
const IMAGE_EXTENSIONS: Record<string, string> = {
  "image/gif": "gif",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};
const settingsCodec = Schema.fromJsonString(Schema.Struct({ directory: Schema.String }));
const encodeSettings = Schema.encodeEffect(settingsCodec);
const decodeSettings = Schema.decodeEffect(settingsCodec);
const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const lock = yield* Semaphore.make(1);
  const settingsPath = path.join(config.stateDir, "thread-notes-settings.json");
  const storage = (cause: unknown) =>
    new ThreadNotesError({
      code: "storage",
      message: "Could not access thread notes. Check the directory and file permissions.",
      cause,
    });
  const readOptional = Effect.fn("ThreadNotes.readOptional")(function* (filePath: string) {
    return yield* fs.readFileString(filePath).pipe(
      Effect.catchIf(
        (error) => error.reason._tag === "NotFound",
        () => Effect.succeed(null),
      ),
      Effect.mapError(storage),
    );
  });
  const write = Effect.fn("ThreadNotes.write")(function* (filePath: string, contents: string) {
    yield* writeFileStringAtomically({ filePath, contents }).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
      Effect.mapError(storage),
    );
  });
  const settings = Effect.fn("ThreadNotes.settings")(function* () {
    const raw = yield* readOptional(settingsPath);
    return raw === null
      ? { directory: path.join(config.stateDir, "thread-notes") }
      : yield* decodeSettings(raw).pipe(Effect.mapError(storage));
  });
  const owner = Effect.fn("ThreadNotes.owner")(function* (threadId: ThreadId) {
    const records = yield* orchestrator.getThreadRecords(threadId, ["providerThreads"]).pipe(
      Effect.mapError(
        (cause) =>
          new ThreadNotesError({
            code: "thread",
            message: "Could not load the notes' thread.",
            cause,
          }),
      ),
    );
    if (records.thread.deletedAt !== null)
      return yield* new ThreadNotesError({ code: "thread", message: "This thread was deleted." });
    const provider = records.providerThreads.find(
      (entry) => entry.id === records.thread.activeProviderThreadId,
    );
    const nativeId = provider?.nativeThreadRef?.nativeId;
    const driver = provider?.driver;
    const resumeCommand =
      nativeId && driver === "codex"
        ? `codex resume ${shellQuote(nativeId)}`
        : nativeId && driver === "claudeAgent"
          ? `claude --resume ${shellQuote(nativeId)}`
          : null;
    return {
      thread: records.thread,
      resumeCommand,
      resumeExplanation: resumeCommand
        ? "Run in this thread's project directory on the owning environment. Avoid running the same session in two clients at once."
        : "Terminal resume is unavailable until this provider has a supported native session ID (Codex or Claude Code).",
    };
  });
  const get = Effect.fn("ThreadNotes.get")(function* ({ threadId }: ThreadNotesGetInput) {
    const info = yield* owner(threadId);
    const { directory } = yield* settings();
    const key = digest(threadId);
    const filePath = path.join(directory, `thread-${key.slice(0, 20)}.md`);
    const marker = `<!-- t3-thread-note:${key} -->`;
    const fileInfo = yield* fs.lstat(filePath).pipe(
      Effect.catchIf(
        (cause) => cause.reason._tag === "NotFound",
        () => Effect.succeed(null),
      ),
      Effect.mapError(storage),
    );
    if (fileInfo?.type === "SymbolicLink")
      return yield* new ThreadNotesError({
        code: "storage",
        message:
          "Notes files cannot be symbolic links. Choose a directory with regular Markdown files.",
      });
    const raw = yield* readOptional(filePath);
    const normalized = raw?.replace(/\r\n/g, "\n") ?? null;
    if (normalized !== null && !normalized.startsWith(`${marker}\n`))
      return yield* new ThreadNotesError({
        code: "conflict",
        message:
          "The notes path contains an unrelated file. Choose another notes directory; this file was not changed.",
      });
    const delimiter = "\n<!-- notes -->\n";
    const bodyAt = normalized?.indexOf(delimiter) ?? -1;
    if (raw !== null && bodyAt < 0)
      return yield* new ThreadNotesError({
        code: "conflict",
        message:
          "The note's metadata separator was removed. Restore <!-- notes --> before editing in T3.",
      });
    return {
      threadId,
      path: filePath,
      text: normalized === null ? "" : normalized.slice(bodyAt + delimiter.length),
      revision: raw === null ? null : digest(raw),
      includeThreadId:
        normalized === null
          ? true
          : normalized.slice(0, bodyAt).split("\n").includes(`Thread ID: ${threadId}`),
      resumeCommand: info.resumeCommand,
      resumeExplanation: info.resumeExplanation,
    } satisfies ThreadNote;
  });
  const save = Effect.fn("ThreadNotes.save")(function* (input: ThreadNotesSaveInput) {
    return yield* lock.withPermit(
      Effect.gen(function* () {
        const note = yield* get(input);
        if (note.revision !== input.expectedRevision)
          return yield* new ThreadNotesError({
            code: "conflict",
            message:
              "This note changed outside this editor. Reload the saved note before saving your changes.",
          });
        const info = yield* owner(input.threadId);
        const header = [
          `<!-- t3-thread-note:${digest(input.threadId)} -->`,
          `# Thread notes: ${info.thread.title.replace(/[\r\n]+/g, " ").trim()}`,
          ...(input.includeThreadId ? [`Thread ID: ${input.threadId}`] : []),
          "",
          "Terminal resume:",
          ...(info.resumeCommand
            ? [`\`\`\`sh\n${info.resumeCommand}\n\`\`\``, info.resumeExplanation]
            : [info.resumeExplanation]),
          "",
          "<!-- notes -->",
          "",
        ].join("\n");
        yield* write(note.path, header + input.text);
        return yield* get(input);
      }),
    );
  });
  const updateSettings = Effect.fn("ThreadNotes.updateSettings")(function* (
    input: ThreadNotesSettings,
  ) {
    if (!path.isAbsolute(input.directory) || input.directory.includes("\0"))
      return yield* new ThreadNotesError({
        code: "invalid",
        message: "Choose an absolute directory on this environment.",
      });
    return yield* lock.withPermit(
      Effect.gen(function* () {
        yield* fs
          .makeDirectory(input.directory, { recursive: true })
          .pipe(Effect.mapError(storage));
        yield* write(
          settingsPath,
          yield* encodeSettings({ directory: path.normalize(input.directory) }).pipe(
            Effect.mapError(storage),
          ),
        );
        return yield* settings();
      }),
    );
  });
  const sendSelection = Effect.fn("ThreadNotes.sendSelection")(function* (
    input: ThreadNotesSendSelectionInput,
  ) {
    const note = yield* get(input);
    if (note.revision !== input.expectedRevision)
      return yield* new ThreadNotesError({
        code: "conflict",
        message: "Save or reload the current note before sharing a selection.",
      });
    if (input.endIndex <= input.startIndex || input.endIndex > note.text.length)
      return yield* new ThreadNotesError({
        code: "invalid",
        message: "Select text from this note first.",
      });
    const selection = note.text.slice(input.startIndex, input.endIndex);
    const id = digest(`${input.threadId}:${note.revision}:${input.startIndex}:${input.endIndex}`);
    const contextId = toComposerContextId(`note-${id}`);
    const info = yield* owner(input.threadId);
    yield* threads
      .sendToThread({
        origin: { kind: "user" },
        projectId: info.thread.projectId,
        threadId: input.threadId,
        commandId: CommandId.make(`note:${id}`),
        messageId: MessageId.make(`note:${id}`),
        text: `[Personal note](${formatComposerContextHref("review-comment", contextId)})\n\n${selection}`,
        attachments: [],
        context: {
          version: 1,
          records: [
            {
              version: 1,
              kind: "review-comment",
              contextId,
              label: "Personal note",
              sectionId: `note-${digest(input.threadId).slice(0, 20)}`,
              sectionTitle: "Personal notes",
              filePath: note.path,
              startIndex: input.startIndex,
              endIndex: input.endIndex,
              rangeLabel:
                selection.length > COMPOSER_CONTEXT_REVIEW_TEXT_MAX_CHARS
                  ? "Selected note text (preview truncated)"
                  : "Selected note text",
              text: selection.slice(0, COMPOSER_CONTEXT_REVIEW_TEXT_MAX_CHARS),
              diff: "",
              fenceLanguage: "markdown",
            },
          ],
        },
        mode: "queue",
        createdBy: "user",
        creationSource: "web",
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new ThreadNotesError({
              code: "send",
              message: "Could not send the note selection. Your note is saved; retry sending.",
              cause,
            }),
        ),
      );
    return note;
  });
  const saveImage = Effect.fn("ThreadNotes.saveImage")(function* (
    input: ThreadNotesSaveImageInput,
  ) {
    const invalid = (message: string) => new ThreadNotesError({ code: "invalid", message });
    const parsed = parseBase64DataUrl(input.dataUrl);
    const extension = parsed && IMAGE_EXTENSIONS[parsed.mimeType];
    if (!parsed || !extension)
      return yield* invalid("Notes can hold PNG, JPEG, GIF, or WebP images.");
    const bytes = yield* Effect.fromResult(Base64.decode(parsed.base64)).pipe(
      Effect.mapError(() => invalid("The image data is not valid.")),
    );
    if (bytes.byteLength > THREAD_NOTES_IMAGE_MAX_BYTES)
      return yield* invalid("Images in notes must be 10 MB or smaller.");
    const note = yield* get(input);
    const directory = path.dirname(note.path);
    const folder = `${path.basename(note.path, ".md")}-images`;
    const fileName = `${NodeCrypto.createHash("sha256").update(bytes).digest("hex").slice(0, 20)}.${extension}`;
    const folderInfo = yield* fs.lstat(path.join(directory, folder)).pipe(
      Effect.catchIf(
        (cause) => cause.reason._tag === "NotFound",
        () => Effect.succeed(null),
      ),
      Effect.mapError(storage),
    );
    if (folderInfo !== null && folderInfo.type !== "Directory")
      return yield* new ThreadNotesError({
        code: "storage",
        message: `${folder} must be a regular directory beside the note.`,
      });
    yield* fs
      .makeDirectory(path.join(directory, folder), { recursive: true })
      .pipe(Effect.mapError(storage));
    // Renamed into place so a content-hash name never holds a partial write.
    const target = path.join(directory, folder, fileName);
    const temporary = `${target}.${NodeCrypto.randomUUID()}.tmp`;
    yield* fs.writeFile(temporary, bytes).pipe(
      Effect.andThen(fs.rename(temporary, target)),
      Effect.tapError(() => fs.remove(temporary).pipe(Effect.ignore)),
      Effect.mapError(storage),
    );
    return { path: `${folder}/${fileName}` } satisfies ThreadNotesSavedImage;
  });
  return ThreadNotes.of({ get, save, settings, updateSettings, saveImage, sendSelection });
});
export const layer = Layer.effect(ThreadNotes, make);
