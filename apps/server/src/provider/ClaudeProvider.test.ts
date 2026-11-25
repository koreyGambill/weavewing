import * as NodeNet from "node:net";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ClaudeSettings } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import { makeClaudeMcpServersProbe } from "./ClaudeProvider.ts";

const decodeClaudeSettings = Schema.decodeSync(ClaudeSettings);

// Connects to the test's socket so the test sees it start and exit, ignores SIGTERM, and never
// initializes.
const SILENT_CLAUDE = `#!/usr/bin/env node
process.on("SIGTERM", () => {});
require("node:net").connect(process.env.FAKE_CLAUDE_SOCKET).write(String(process.pid));
process.stdin.resume();
`;

it.effect("ends a Claude process that never initializes and ignores SIGTERM by the deadline", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-claude-mcp-probe-" });
    const binaryPath = path.join(dir, "claude");
    yield* fileSystem.writeFileString(binaryPath, SILENT_CLAUDE);
    yield* fileSystem.chmod(binaryPath, 0o755);
    const socketPath = path.join(dir, "probe.sock");
    const started = yield* Deferred.make<number>();
    const exited = yield* Deferred.make<void>();
    yield* Effect.acquireRelease(
      Effect.callback<NodeNet.Server>((resume) => {
        const server = NodeNet.createServer((socket) => {
          socket.once("data", (pid) => Deferred.doneUnsafe(started, Exit.succeed(Number(pid))));
          socket.on("close", () => Deferred.doneUnsafe(exited, Exit.void));
        });
        server.listen(socketPath, () => resume(Effect.succeed(server)));
      }),
      (server) =>
        Effect.callback<void>((resume) => {
          server.close(() => resume(Effect.void));
        }),
    );
    const probe = yield* makeClaudeMcpServersProbe(decodeClaudeSettings({ binaryPath }), {
      ...process.env,
      FAKE_CLAUDE_SOCKET: socketPath,
    });

    const listing = yield* probe(dir).pipe(Effect.exit, Effect.forkChild);
    const pid = yield* Deferred.await(started);
    yield* TestClock.adjust("26 seconds");

    assert.isTrue(Exit.isFailure(yield* Fiber.join(listing)));
    // The probe returns only after its child has exited.
    assert.throws(() => process.kill(pid, 0), /ESRCH/);
    yield* Deferred.await(exited);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
