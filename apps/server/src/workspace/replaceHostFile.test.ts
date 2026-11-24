// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { expect, it } from "@effect/vitest";

import { replaceHostFile } from "./replaceHostFile.ts";

const sha256 = (text: string) => NodeCrypto.createHash("sha256").update(text).digest("hex");

it("refuses to replace a file whose text no longer matches the expected hash", async () => {
  const folder = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "replace-host-file-"));
  try {
    const file = NodePath.join(folder, "AGENTS.md");
    await NodeFSP.writeFile(file, "edited elsewhere\n");
    await expect(
      replaceHostFile(file, "mine\n", { expectedSha256: sha256("as opened\n") }),
    ).rejects.toMatchObject({ _tag: "HostFileChangedError" });
    expect(await NodeFSP.readFile(file, "utf8")).toBe("edited elsewhere\n");
    await replaceHostFile(file, "mine\n", { expectedSha256: sha256("edited elsewhere\n") });
    expect(await NodeFSP.readFile(file, "utf8")).toBe("mine\n");
  } finally {
    await NodeFSP.rm(folder, { recursive: true, force: true });
  }
});
