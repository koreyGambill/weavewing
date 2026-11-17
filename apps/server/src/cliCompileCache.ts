// @effect-diagnostics nodeBuiltinImport:off -- Runs before the CLI's Effect runtime loads.
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSea from "node:sea";

export function enableCliCompileCache(): void {
  try {
    const directory = NodeSea.isSea()
      ? // Runtime pruning must also remove modules cached under that runtime's absolute paths.
        NodePath.join(NodePath.dirname(process.execPath), "compile-cache")
      : NodePath.join(
          process.env.XDG_CACHE_HOME ||
            // oxlint-disable-next-line t3code/no-global-process-runtime -- Runs before the CLI's Effect runtime loads.
            (process.platform === "linux"
              ? NodePath.join(NodeOS.homedir(), ".cache")
              : NodeOS.tmpdir()),
          "t3code",
          "compile-cache",
        );
    if (process.env.APPIMAGE) {
      // AppImage paths change each launch. Older shims cached anyway, filling Node's engine folders.
      for (const entry of NodeFS.readdirSync(directory, { withFileTypes: true })) {
        if (entry.isDirectory() && /^v\d/.test(entry.name)) {
          NodeFS.rmSync(NodePath.join(directory, entry.name), { recursive: true, force: true });
        }
      }
      return;
    }
    NodeModule.enableCompileCache(directory);
  } catch {}
}
