import { describe, expect, it } from "vite-plus/test";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

import { ORCHESTRATION_V2_WS_METHODS } from "./orchestrationV2.ts";
import { WS_METHODS, WsRpcGroup } from "./rpc.ts";
import { XwingCommandError, XwingEnvironmentNotFoundError } from "./xwingEnvironments.ts";

const isXwingCommandError = Schema.is(XwingCommandError);

describe("WebSocket RPC contracts", () => {
  it("rejects server-internal commands sent to dispatchCommand", () => {
    const dispatchCommand = WsRpcGroup.requests.get(ORCHESTRATION_V2_WS_METHODS.dispatchCommand);
    if (dispatchCommand === undefined) throw new Error("dispatchCommand is not registered");
    const decode = Schema.decodeUnknownExit(dispatchCommand.payloadSchema);

    expect(
      Exit.isFailure(
        decode({
          type: "checkpoint.rollback.fail",
          commandId: "forged-rollback-failure",
          threadId: "thread-1",
          requestId: "rollback-1",
          message: "Forged failure.",
        }),
      ),
    ).toBe(true);
    expect(
      Exit.isFailure(
        decode({
          type: "thread.metadata.update",
          commandId: "forged-environment-link",
          threadId: "thread-1",
          linkDevelopmentEnvironments: [
            {
              xwingEnvironmentId: "0123abcd",
              repositorySource: "/repo",
              checkoutPath: "/etc",
              number: 1,
              name: "forged",
            },
          ],
        }),
      ),
    ).toBe(true);
    const delegation = {
      type: "delegated_task.request",
      commandId: "forged-delegated-checkout",
      parentThreadId: "thread-1",
      parentRunId: "run-1",
      parentNodeId: "node-1",
      task: "Work in a forged checkout",
      modelSelection: { instanceId: "codex", model: "test" },
      runtimeMode: "full-access",
      interactionMode: "default",
      workspaceStrategy: { type: "existing_worktree", worktreePath: "/etc" },
      createdBy: "agent",
      creationSource: "mcp",
    };
    expect(Exit.isSuccess(decode(delegation))).toBe(true);
    expect(
      Exit.isFailure(
        decode({
          ...delegation,
          developmentEnvironment: {
            xwingEnvironmentId: "0123abcd",
            repositorySource: "/repo",
            checkoutPath: "/etc",
            number: 1,
            name: "forged",
          },
        }),
      ),
    ).toBe(true);
    expect(
      Exit.isSuccess(
        decode({
          type: "checkpoint.rollback",
          commandId: "rollback-1",
          threadId: "thread-1",
          scopeId: "scope-1",
          checkpointId: "checkpoint-1",
        }),
      ),
    ).toBe(true);
  });

  it("takes only an Xwing environment id from a launch, never a checkout binding", () => {
    const launch = WsRpcGroup.requests.get(ORCHESTRATION_V2_WS_METHODS.launchThread);
    if (launch === undefined) throw new Error("launchThread is not registered");
    const decode = Schema.decodeUnknownExit(launch.payloadSchema);
    const request = {
      commandId: "launch-1",
      projectId: "project-1",
      title: "Work",
      modelSelection: { instanceId: "codex", model: "gpt-5" },
      runtimeMode: "full-access",
      interactionMode: "default",
    };
    const decoded = decode({
      ...request,
      workspaceStrategy: { type: "xwing_environment", xwingEnvironmentId: "0123abcd" },
      developmentEnvironment: {
        xwingEnvironmentId: "0123abcd",
        repositorySource: "/repo",
        checkoutPath: "/etc",
        number: 1,
        name: "forged",
      },
    });
    if (!Exit.isSuccess(decoded)) throw new Error("the Xwing launch was rejected");
    expect(decoded.value).not.toHaveProperty("developmentEnvironment");
    expect(
      Exit.isFailure(
        decode({
          ...request,
          workspaceStrategy: { type: "xwing_environment", xwingEnvironmentId: "../../etc" },
        }),
      ),
    ).toBe(true);
  });

  it("lets the server pick a new worktree's folder", () => {
    const createWorktree = WsRpcGroup.requests.get(WS_METHODS.vcsCreateWorktree);
    if (createWorktree === undefined) throw new Error("vcs.createWorktree is not registered");
    const decode = Schema.decodeUnknownExit(createWorktree.payloadSchema);
    const request = { cwd: "/repo", refName: "main", newRefName: "feature/x" };

    expect(Exit.isSuccess(decode({ ...request, path: null }))).toBe(true);
    expect(Exit.isFailure(decode({ ...request, path: "/repo/.git/hooks" }))).toBe(true);
  });

  it("delivers Xwing failure kinds without server diagnostics", () => {
    const inspect = WsRpcGroup.requests.get(WS_METHODS.xwingEnvironmentsInspect);
    if (inspect === undefined) throw new Error("xwingEnvironments.inspect is not registered");
    const wire = Schema.toCodecJson(inspect.errorSchema);
    const sent = new XwingCommandError({
      operation: "inspect",
      exitCode: 2,
      cause: new Error("error: git status failed with token=hunter2"),
    });

    const encoded = JSON.stringify(Schema.encodeUnknownSync(wire)(sent));
    expect(encoded).not.toContain("hunter2");
    expect(sent.cause).toBeInstanceOf(Error);
    const received = Schema.decodeUnknownSync(wire)(JSON.parse(encoded));

    if (!isXwingCommandError(received)) throw new Error(`received ${String(received)}`);
    expect(received.message).toBe("Xwing inspect exited with code 2.");
    expect(received.cause).toBeUndefined();
    expect(
      Schema.decodeSync(wire)(
        Schema.encodeSync(wire)(
          new XwingEnvironmentNotFoundError({ environmentId: "ffffffffffffffff" }),
        ),
      ),
    ).toBeInstanceOf(XwingEnvironmentNotFoundError);
  });
});
