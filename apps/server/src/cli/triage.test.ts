// @effect-diagnostics nodeBuiltinImport:off - CLI integration spawns a fake agent from PATH.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { TRIAGE_PROMPT_FILE_NAME } from "@t3tools/contracts";
import * as NetService from "@t3tools/shared/Net";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as TestConsole from "effect/testing/TestConsole";
import { Command } from "effect/cli";
import { vi } from "vite-plus/test";

import { cli } from "../binCli.ts";
import { buildTriageLaunchPrompt } from "../triage/triagePrompt.ts";

const FAILING_AGENT_POSIX = `#!/bin/sh
echo "Error: There is not enough space on the disk. (os error 112)" >&2
exit 1
`;
const FAILING_AGENT_WINDOWS = `@echo Error: There is not enough space on the disk. (os error 112) 1>&2
@exit /b 1
`;

it.live.each(["codex", "claude"])(
  "a failed %s launch keeps traffic defaults and points at its prompt",
  (agent) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-triage-cli-" });
      const binDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-triage-bin-" });
      const codexHome = NodePath.join(baseDir, "codex-home");
      const posix =
        agent === "claude"
          ? FAILING_AGENT_POSIX.replace(
              'echo "Error:',
              `if [ "$CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC" != "1" ]; then exit 2; fi\necho "Error:`,
            )
          : FAILING_AGENT_POSIX;
      const windows =
        agent === "claude"
          ? `@if not "%CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC%"=="1" exit /b 2\r\n${FAILING_AGENT_WINDOWS}`
          : FAILING_AGENT_WINDOWS;
      NodeFS.writeFileSync(NodePath.join(binDir, agent), posix, { mode: 0o755 });
      NodeFS.writeFileSync(NodePath.join(binDir, `${agent}.cmd`), windows);
      yield* Effect.acquireRelease(
        // PATH holds only the fake agent, so a broken fixture can never run a real one.
        Effect.sync(() => {
          vi.stubEnv("PATH", binDir);
          vi.stubEnv("CODEX_HOME", codexHome);
          vi.stubEnv("CLAUDE_CONFIG_DIR", codexHome);
          vi.stubEnv("CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", undefined);
        }),
        () => Effect.sync(() => vi.unstubAllEnvs()),
      );
      const previousExitCode = process.exitCode;
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          process.exitCode = previousExitCode;
        }),
      );

      yield* Command.runWith(cli, { version: "0.0.0" })([
        "triage",
        "--agent",
        agent,
        "--base-dir",
        baseDir,
      ]);
      const output = (yield* TestConsole.logLines).join("\n");

      assert.equal(process.exitCode, 1);
      const promptFilePath = NodeFS.readdirSync(baseDir, { recursive: true, encoding: "utf8" })
        .filter((entry) => NodePath.basename(entry) === TRIAGE_PROMPT_FILE_NAME)
        .map((entry) => NodePath.join(baseDir, entry))[0];
      assert.isDefined(promptFilePath);
      assert.include(output, promptFilePath);
      assert.include(output, buildTriageLaunchPrompt(promptFilePath));
      assert.include(output, NodePath.join(NodePath.dirname(promptFilePath), "context.md"));
      assert.include(
        output,
        `${agent === "claude" ? "Claude Code" : "Codex"} keeps its state in ${codexHome}.`,
      );
      assert.include(
        output,
        `set ${agent === "claude" ? "CLAUDE_CONFIG_DIR" : "CODEX_HOME"} to a folder on another drive`,
      );
    }).pipe(
      Effect.provide(
        Layer.mergeAll(NodeServices.layer, NodeCrypto.layer, NetService.layer, TestConsole.layer),
      ),
    ),
);
