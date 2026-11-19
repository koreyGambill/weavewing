import * as Crypto from "node:crypto";
import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";

import { git, type Checkout } from "./checkout.ts";

function inputs(co: Checkout, engine: string) {
  if (git(co.root, "status", "--porcelain")) throw new Error("Full CI reuse requires a clean committed worktree");
  return { tree: git(co.root, "rev-parse", "HEAD^{tree}"), node: co.nodeVersion, engine, platform: process.platform, arch: process.arch };
}

/** Records successful full CI for an exact tree; callers must execute every CI job. */
export async function verifiedCi(
  co: Checkout,
  run: string,
  execute: () => Promise<void>,
  options: { force?: boolean; records?: string; engine?: string } = {},
) {
  const engine = options.engine ?? process.env.SPARKWING_ENGINE_VERSION;
  if (!engine) throw new Error("Full CI reuse requires SPARKWING_ENGINE_VERSION");
  const before = inputs(co, engine);
  const key = Crypto.createHash("sha256").update(JSON.stringify(["full-ci/v1", before])).digest("hex");
  const records = options.records ?? Path.join(OS.homedir(), "evidence/t3code/sparkwing/full-ci");
  const file = Path.join(records, `${key}.json`);
  type Pass = { key: string; passed: true; full: true; commit: string; tree: string; run: string; evidence: string };
  let pass: Pass | undefined;
  if (!options.force) {
    try {
      const value = JSON.parse(FS.readFileSync(file, "utf8"));
      if (value.key === key && value.tree === before.tree && value.passed === true && value.full === true &&
          typeof value.commit === "string" && typeof value.run === "string" && typeof value.evidence === "string" && Path.isAbsolute(value.evidence))
        pass = value;
    } catch {
      // Missing or damaged evidence executes CI again.
    }
  }
  if (!pass) {
    FS.rmSync(file, { force: true });
    await execute();
    if (JSON.stringify(inputs(co, engine)) !== JSON.stringify(before)) throw new Error("Release source changed during full CI");
    pass = { key, passed: true, full: true, commit: git(co.root, "rev-parse", "HEAD"), tree: before.tree, run, evidence: co.evidence };
    FS.mkdirSync(records, { recursive: true });
    const temporary = `${file}.${Crypto.randomUUID()}.tmp`;
    FS.writeFileSync(temporary, JSON.stringify(pass, null, 2));
    FS.renameSync(temporary, file);
  }
  FS.mkdirSync(co.evidence, { recursive: true });
  FS.writeFileSync(Path.join(co.evidence, "ci-result.json"), JSON.stringify(pass, null, 2));
  return pass;
}
