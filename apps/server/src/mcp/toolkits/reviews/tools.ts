import {
  OrchestratorMcpFailure,
  ThreadId,
  ThreadWorkspace,
  ThreadListEntry,
  ListItem,
  ThreadListReadInput,
  ThreadListUpdateInput,
  ThreadListRewriteInput,
  ThreadArtifactWriteInput,
  ThreadArtifactReadInput,
  ThreadArtifactVersion,
  ThreadArtifactMetadata,
  EvidenceLanding,
  EvidenceListInput,
  EvidenceListResult,
  EvidenceRecordInput,
  EvidenceRecordResult,
  EvidenceSlug,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";
import { ThreadWorkspace as ThreadWorkspaceService } from "../../../threadWorkspace/ThreadWorkspace.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as EvidenceService from "../../../evidence/EvidenceService.ts";

const dependencies = [
  ThreadWorkspaceService,
  ThreadManagement.ThreadManagementService,
  McpInvocationContext.McpInvocationContext,
  EvidenceService.EvidenceService,
];
const common = { failure: OrchestratorMcpFailure, failureMode: "return" as const, dependencies };
const optionalThread = { threadId: Schema.optional(ThreadId) };
const listMutationResult = Schema.Struct({
  revision: ThreadWorkspace.fields.revision,
  items: Schema.Array(
    Schema.Struct({
      id: ListItem.fields.id,
      text: ListItem.fields.text,
      state: ListItem.fields.state,
      owner: ListItem.fields.owner,
      links: ListItem.fields.links,
      needsQa: ListItem.fields.needsQa,
      doneAt: ListItem.fields.doneAt,
    }),
  ),
});
const artifactWriteResult = Schema.Struct({
  threadId: ThreadId,
  revision: ThreadWorkspace.fields.revision,
  ...ThreadArtifactMetadata.fields,
});
// These tools change thread presentation rather than checkout files.
export const ReviewToolkit = Toolkit.make(
  Tool.make("list_read", {
    ...common,
    description:
      "Read the thread list and revision. Defaults to open and handed-off items; all includes history. allThreads searches accessible threads; needsQa filters the QA queue. Omit threadId for this thread.",
    parameters: ThreadListReadInput,
    success: Schema.Array(ThreadListEntry),
  }).annotate(Tool.Readonly, true),
  Tool.make("list_update", {
    ...common,
    description:
      "Batch add or edit list items using the read revision. Omit id to create; omitted fields stay unchanged. owner you is the human's work. Use handed_off for linked work in progress. Moving an item keeps its subtree; parent state changes leave children alone. childPreamble applies to future delegates. Omit threadId for this thread.",
    parameters: Schema.Struct({ ...ThreadListUpdateInput.fields, ...optionalThread }),
    success: listMutationResult,
  }).annotate(Tool.Readonly, true),
  Tool.make("list_rewrite", {
    ...common,
    description:
      "Replace open list items using the read revision. Finished and handed-off history stays at every depth; children of removed items attach to the nearest surviving ancestor. Omit threadId for this thread.",
    parameters: Schema.Struct({ ...ThreadListRewriteInput.fields, ...optionalThread }),
    success: listMutationResult,
  }).annotate(Tool.Readonly, true),
  Tool.make("artifact_write", {
    ...common,
    description:
      "Save a thread Markdown or sandboxed-HTML document. Omit id to create; supply id to update. Every write keeps a version. Markdown questions use fenced t3-question JSON: {id,prompt,options:[{id,label,description}],recommendedOptionIds:[],multiSelect:false}; recommendations stay unselected. Use the list revision; omit threadId for this thread.",
    parameters: Schema.Struct({ ...ThreadArtifactWriteInput.fields, ...optionalThread }),
    success: artifactWriteResult,
  }).annotate(Tool.Readonly, true),
  Tool.make("artifact_read", {
    ...common,
    description:
      "Read a thread artifact's latest version or a numbered version. Omit threadId for this thread.",
    parameters: Schema.Struct({ ...ThreadArtifactReadInput.fields, ...optionalThread }),
    success: ThreadArtifactVersion,
  }).annotate(Tool.Readonly, true),
  Tool.make("artifact_list", {
    ...common,
    description:
      "List a thread's artifact titles, formats and latest versions. Omit threadId for this thread.",
    parameters: Schema.Struct(optionalThread),
    success: Schema.Array(ThreadArtifactMetadata),
  }).annotate(Tool.Readonly, true),
  Tool.make("evidence_record", {
    ...common,
    description:
      "After work lands on the target branch, record its proof for the user to QA: one landing per merge or batch, one change per ask, with the user's ask, commits, review verdict, gate results, captures under ~/evidence and unproven gaps. Recording an id again replaces it and keeps the user's QA. Omit threadId for this thread.",
    parameters: EvidenceRecordInput,
    success: EvidenceRecordResult,
  }).annotate(Tool.Readonly, true),
  Tool.make("evidence_read", {
    ...common,
    description:
      "Read recorded landings: summaries newest first (filter needsQa or threadId; pass `next` as `before` for the next page), or one landing by landingId with each change's QA state and the user's note. Only the user sets QA.",
    parameters: Schema.Struct({
      ...EvidenceListInput.fields,
      landingId: Schema.optional(EvidenceSlug),
    }),
    success: Schema.Union([EvidenceListResult, EvidenceLanding]),
  }).annotate(Tool.Readonly, true),
);
