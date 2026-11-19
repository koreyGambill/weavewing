import { ClaudeSettings, CodexSettings, type ProviderInstanceConfig } from "@t3tools/contracts";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { makeIsServerInternalPath } from "../auth/serverInternalPaths.ts";
import { resolveClaudeHomePath } from "../provider/Drivers/ClaudeHome.ts";
import {
  resolveCodexHomeLayout,
  withEnvironmentCodexHome,
} from "../provider/Drivers/CodexHomeLayout.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { FILE_CONVENTIONS, resolveInstructionFiles } from "./instructionFiles.ts";

const decodeClaudeSettings = Schema.decodeOption(ClaudeSettings);
const decodeCodexSettings = Schema.decodeOption(CodexSettings);

/** The folder an instance launches its provider with, resolved as its driver does. */
export const providerConfigDir = Effect.fn("InstructionFileAllowlist.providerConfigDir")(function* (
  driver: string,
  entry: ProviderInstanceConfig | undefined,
  home: string,
) {
  const path = yield* Path.Path;
  const env = yield* mergeProviderInstanceEnvironment(
    entry?.environment,
    yield* HostProcess.Environment,
  );
  if (driver === "claudeAgent") {
    const config = decodeClaudeSettings(entry?.config ?? {});
    return yield* resolveClaudeHomePath(
      { homePath: Option.isSome(config) ? config.value.homePath : "" },
      env,
    );
  }
  const config = Option.getOrUndefined(decodeCodexSettings(entry?.config ?? {}));
  if (config === undefined) return env.CODEX_HOME || path.join(home, ".codex");
  const layout = yield* resolveCodexHomeLayout(withEnvironmentCodexHome(config, env));
  return layout.effectiveHomePath ?? layout.sharedHomePath;
});

// Credential folders under ~/.config whose files stay read-only even when an instruction file links them.
const CREDENTIAL_CONFIG = /\/\.config\/(gh|hub|gcloud|op|rclone|sops|age|github-copilot)\//;

// Credential folders and files directly under the home folder.
const HOME_CREDENTIALS =
  /^(\.ssh|\.gnupg|\.aws|\.kube)(\/|$)|^(\.docker\/config\.json|\.netrc|\.git-credentials)$/;

/** Credential files stay read-only, whatever links or grants reach them. */
export const isCredentialPath = (filePath: string, home: string) => {
  const file = filePath.replaceAll("\\", "/");
  const root = home.replaceAll("\\", "/").replace(/\/+$/, "");
  return (
    CREDENTIAL_CONFIG.test(file) ||
    (file.startsWith(`${root}/`) && HOME_CREDENTIALS.test(file.slice(root.length + 1)))
  );
};

/**
 * Host files the Files tile may edit: `.md` files the Default view reads as instruction
 * files for a workspace, reached at a path under a provider's config folder or
 * ~/.config. A writable file can link any other, so the fixed roots bound what an edit
 * can make writable. Nothing else outside the workspace is writable.
 */
export class InstructionFileAllowlist extends Context.Service<
  InstructionFileAllowlist,
  {
    /** The real path to write, or null when `file` is not on the allowlist for `cwd`. */
    readonly editablePath: (cwd: string, file: string) => Effect.Effect<string | null>;
  }
>()("t3/threadInsights/InstructionFileAllowlist") {}

const make = Effect.gen(function* () {
  const settings = yield* ServerSettingsService;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const isServerInternal = yield* makeIsServerInternalPath;

  return InstructionFileAllowlist.of({
    editablePath: Effect.fn("InstructionFileAllowlist.editablePath")(function* (cwd, file) {
      const realPath = yield* fs.realPath(file).pipe(Effect.orElseSucceed(() => null));
      if (realPath === null || !/\.md$/i.test(realPath) || !path.isAbsolute(cwd)) return null;
      const home = yield* HostProcess.HomeDirectory;
      const within = (root: string, target: string) => {
        const relative = path.relative(root, target);
        return (
          relative === "" ||
          (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
        );
      };
      const isRepo = (dir: string) =>
        fs.exists(path.join(dir, ".git")).pipe(Effect.orElseSucceed(() => false));
      const real = (dir: string) => fs.realPath(dir).pipe(Effect.orElseSucceed(() => dir));
      // As DefaultContext resolves it: $HOME or a folder above it is never the repository.
      let workspaceRepo: string | null = null;
      for (let dir = yield* real(cwd); !within(dir, home); dir = path.dirname(dir)) {
        if (yield* isRepo(dir)) {
          workspaceRepo = dir;
          break;
        }
        if (path.dirname(dir) === dir) break;
      }
      /** Under a fixed root, and in no repository below it other than this workspace's. */
      const writableAt = Effect.fnUntraced(function* (documented: string, roots: string[]) {
        const root = roots.find((candidate) => within(candidate, documented));
        if (
          root === undefined ||
          isCredentialPath(documented, home) ||
          isCredentialPath(realPath, home)
        )
          return false;
        // Only the file itself may be a symlink: a linked folder could lead into another repository.
        const folder = path.dirname(documented);
        if ((yield* real(folder)) !== path.join(yield* real(root), path.relative(root, folder)))
          return false;
        for (let dir = path.dirname(documented); dir !== root; dir = path.dirname(dir)) {
          if (yield* isRepo(dir))
            return workspaceRepo !== null && (yield* real(dir)) === workspaceRepo;
        }
        return true;
      });
      const platform = yield* HostProcess.Platform;
      const configured = (yield* settings.getSettings.pipe(Effect.option)).pipe(
        Option.map((value) => value.providerInstances),
        Option.getOrElse(() => ({})),
      );
      // Built-in instances use their driver's name and need no settings entry.
      const instances = new Map<string, ProviderInstanceConfig | undefined>(
        Object.keys(FILE_CONVENTIONS).map((driver) => [driver, undefined]),
      );
      for (const [id, entry] of Object.entries(configured)) instances.set(id, entry);
      for (const [id, entry] of instances) {
        const driver = entry?.driver ?? id;
        const convention = FILE_CONVENTIONS[driver];
        if (convention === undefined) continue;
        const configDir = yield* providerConfigDir(driver, entry, home).pipe(
          Effect.provideService(Path.Path, path),
        );
        const { files } = yield* resolveInstructionFiles(
          convention,
          cwd,
          { home, platform, configDir },
          (candidate) => isServerInternal(candidate).pipe(Effect.orElseSucceed(() => true)),
        ).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, path),
        );
        const found = files.find(
          (candidate) => candidate.status === "expected" && candidate.realPath === realPath,
        );
        if (
          found !== undefined &&
          (yield* writableAt(path.resolve(found.path), [
            path.resolve(configDir),
            path.join(home, ".config"),
          ]))
        )
          return realPath;
      }
      return null;
    }),
  });
});

export const layer = Layer.effect(InstructionFileAllowlist, make);
