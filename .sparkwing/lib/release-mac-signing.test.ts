import assert from "node:assert/strict";
import type * as CP from "node:child_process";
import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";
import { test } from "node:test";

import { acquireLock, assertNoNodeTracing, developerIdIdentity, developerIdProof, securityCommand, withSigningKeychain } from "./release-mac-signing.ts";

const hash = "0123456789ABCDEF0123456789ABCDEF01234567";
const listing = `  1) ${hash} "Developer ID Application: Example Org (ABCDE12345)"\n     1 valid identities found\n`;
const keychain = "/tmp/run-1/signing.keychain-db";
const previous = ["/Users/builder/Library/Keychains/login.keychain-db", "/Library/Keychains/System.keychain"];

function scratch(prefix: string) {
  const dir = FS.mkdtempSync(Path.join(OS.tmpdir(), prefix));
  return { dir, [Symbol.dispose]: () => FS.rmSync(dir, { recursive: true, force: true }) };
}

function fakeSecurity(responses: { findIdentity?: string; failOn?: readonly string[] } = {}) {
  const calls: { args: readonly string[]; secrets: readonly string[] }[] = [];
  const security = (args: readonly string[], secrets: readonly string[] = []) => {
    calls.push({ args, secrets });
    const restoring = args[0] === "list-keychains" && args.length > 3 && args[4] !== keychain;
    if (responses.failOn?.includes(restoring ? "restore" : args[0]!)) throw new Error(`${args[0]} failed`);
    if (args[0] === "list-keychains" && args.length === 3) return previous.map((entry) => `    "${entry}"`).join("\n");
    if (args[0] === "find-identity") return responses.findIdentity ?? listing;
    return "";
  };
  return { calls, security };
}

function signingOptions(dir: string) {
  const certificate = Path.join(dir, "certificate.p12");
  FS.writeFileSync(certificate, "p12 bytes");
  return { keychain, password: "kc-secret", certificate, certificatePassword: 'p12 "secret"', teamId: "ABCDE12345" };
}

test("the Developer ID identity is selected by hash and must belong to APPLE_TEAM_ID", () => {
  assert.deepEqual(developerIdIdentity(listing, "ABCDE12345"), { hash, name: "Developer ID Application: Example Org (ABCDE12345)" });
  assert.throws(() => developerIdIdentity(listing, "ZZZZZ99999"), /APPLE_TEAM_ID ZZZZZ99999/);
  assert.throws(() => developerIdIdentity("     0 valid identities found\n", "ABCDE12345"), /found 0/);
  assert.throws(() => developerIdIdentity(`  1) ${hash} "Apple Development: Someone (ABCDE12345)"\n`, "ABCDE12345"), /found 0/);
  const two = `${listing}  2) ${"F".repeat(40)} "Developer ID Application: Other Org (ABCDE12345)"\n`;
  assert.throws(() => developerIdIdentity(two, "ABCDE12345"), /found 2/);
});

test("each security command runs alone, password commands only on stdin, and their failures report only the status", () => {
  const spawned: { args: readonly string[]; input?: string }[] = [];
  let reply = { status: 0 as number | null, stdout: "listing", stderr: "" };
  const spawn = ((_command: string, args: readonly string[], options: { input?: string }) => {
    spawned.push({ args, ...(options.input === undefined ? {} : { input: options.input }) });
    return reply;
  }) as unknown as typeof CP.spawnSync;
  const security = securityCommand({ PATH: "/usr/bin" }, spawn);
  assert.equal(security(["find-identity", "-v"]), "listing");
  security(["import", "/tmp/c.p12", "-P", 'p "w'], ['p "w']);
  assert.deepEqual(spawned, [{ args: ["find-identity", "-v"] }, { args: ["-i"], input: '"import" "/tmp/c.p12" "-P" "p \\"w"\n' }]);
  reply = { status: 1, stdout: 'import -P "p \\"w"', stderr: "security: import -P p\\x22w: MAC verification failed" };
  assert.throws(() => security(["import", "/tmp/c.p12", "-P", 'p "w'], ['p "w']), (error: Error) => error.message === "security import failed (exit 1)");
  reply = { status: 1, stdout: "", stderr: "The specified keychain could not be found." };
  assert.throws(() => security(["set-keychain-settings", "-lut", "21600", keychain]), /security set-keychain-settings failed \(exit 1\): The specified keychain could not be found/);
  const calls = spawned.length;
  for (const password of ["pass\nshow-keychain-info", "pass\rword", "pass\0word"])
    assert.throws(() => security(["unlock-keychain", "-p", password, keychain], [password]), (error: Error) =>
      error.message === "security unlock-keychain: a value contains a line break or NUL");
  assert.equal(spawned.length, calls, "a rejected password never reaches security");
});

test("the signing keychain joins the search list for the build, then the list is restored and the keychain deleted", async () => {
  using work = scratch("weavewing-keychain-");
  const options = signingOptions(work.dir);
  const { calls, security } = fakeSecurity();
  const seen: string[] = [];
  const result = await withSigningKeychain(security, options, (identity) => {
    seen.push(identity.hash);
    assert.equal(FS.existsSync(options.certificate), false, "the certificate is deleted once imported");
    return "built";
  });
  assert.equal(result, "built");
  assert.deepEqual(seen, [hash]);
  assert.deepEqual(calls.map((call) => [call.args[0], call.secrets.length > 0]), [
    ["list-keychains", false], ["create-keychain", true], ["set-keychain-settings", false], ["unlock-keychain", true], ["import", true],
    ["set-key-partition-list", true], ["list-keychains", false], ["find-identity", false], ["list-keychains", false], ["delete-keychain", false],
  ]);
  assert.deepEqual(calls[2]!.args, ["set-keychain-settings", "-lut", "21600", keychain]);
  assert.deepEqual(calls[6]!.args, ["list-keychains", "-d", "user", "-s", keychain, ...previous]);
  assert.deepEqual(calls.at(-2)!.args, ["list-keychains", "-d", "user", "-s", ...previous]);
  for (const call of calls)
    for (const arg of call.args)
      if (arg.includes("secret")) assert.ok(call.secrets.includes(arg), `${call.args[0]} marks its password as a secret`);
});

test("a failed keychain step stops signing, and cleanup still restores the search list and deletes the certificate", async () => {
  for (const [failOn, body, expected] of [
    [[], () => { throw new Error("electron-builder failed"); }, /electron-builder failed/],
    [["set-keychain-settings"], () => "unreachable", /set-keychain-settings failed/],
    [["import"], () => "unreachable", /import failed/],
    [[], undefined, /found 0/],
  ] as const) {
    using work = scratch("weavewing-keychain-");
    const options = signingOptions(work.dir);
    const { calls, security } = fakeSecurity({ failOn, ...(body ? {} : { findIdentity: "     0 valid identities found\n" }) });
    await assert.rejects(withSigningKeychain(security, options, body ?? (() => "unreachable")), expected);
    const commands = calls.map((call) => call.args[0]);
    if (failOn.length) assert.equal(commands.includes("set-key-partition-list"), false, `${failOn[0]} stops the remaining steps`);
    assert.deepEqual(calls.slice(-2).map((call) => call.args), [["list-keychains", "-d", "user", "-s", ...previous], ["delete-keychain", keychain]]);
    assert.equal(FS.existsSync(options.certificate), false);
  }
});

test("keychain cleanup failures are reported, beside a build failure rather than instead of it", async () => {
  using work = scratch("weavewing-keychain-");
  const failed = fakeSecurity({ failOn: ["restore", "delete-keychain"] });
  await assert.rejects(withSigningKeychain(failed.security, signingOptions(work.dir), () => { throw new Error("electron-builder failed"); }), (error: AggregateError) =>
    error instanceof AggregateError && error.errors.map((cause: Error) => cause.message).join("|") === "electron-builder failed|list-keychains failed|delete-keychain failed");
  const deleteFails = fakeSecurity({ failOn: ["delete-keychain"] });
  await assert.rejects(withSigningKeychain(deleteFails.security, signingOptions(work.dir), () => "built"), (error: AggregateError) =>
    error instanceof AggregateError && /cleanup failed/.test(error.message));
});

test("the signing lock admits one owner, names it when held, and is released only by that owner", () => {
  using work = scratch("weavewing-lock-");
  const lock = Path.join(work.dir, "signing.lock");
  const release = acquireLock(lock, "101 2026-11-25T10:00:00.000Z");
  assert.throws(() => acquireLock(lock, "202 2026-11-25T11:00:00.000Z"), (error: Error) =>
    error.message.includes(`holds ${lock} (PID 101, started 2026-11-25T10:00:00.000Z)`) && error.message.includes(`ps -p 101`) && error.message.endsWith(`rm -rf ${lock}`));
  assert.equal(FS.readFileSync(Path.join(lock, "owner"), "utf8"), "101 2026-11-25T10:00:00.000Z", "a refused contender leaves the lock alone");
  FS.rmSync(lock, { recursive: true });
  const successor = acquireLock(lock, "303 2026-11-25T12:00:00.000Z");
  release();
  assert.equal(FS.existsSync(lock), true, "a former owner cannot release its successor's lock");
  successor();
  assert.deepEqual(FS.readdirSync(work.dir), []);
});

test("release helpers refuse Node debug tracing, which would log their secret inputs", () => {
  assert.throws(() => assertNoNodeTracing({ NODE_DEBUG: "child_process" }), /NODE_DEBUG/);
  assert.throws(() => assertNoNodeTracing({ NODE_DEBUG_NATIVE: "*" }), /NODE_DEBUG_NATIVE/);
  assertNoNodeTracing({ NODE_DEBUG: "", PATH: "/usr/bin" });
});

const notarized = {
  gatekeeper: { status: 0, output: "/Volumes/W/Weavewing.app: accepted\nsource=Notarized Developer ID\norigin=Developer ID Application: Example Org (ABCDE12345)\n" },
  stapler: { status: 0, output: "Processing: /Volumes/W/Weavewing.app\nThe validate action worked!\n" },
  app: { status: 0, output: "Identifier=dev.wingstack.weavewing.desktop\nCodeDirectory v=20500 size=1234 flags=0x10000(runtime) hashes=28+7 location=embedded\nAuthority=Developer ID Application: Example Org (ABCDE12345)\nTeamIdentifier=ABCDE12345\n" },
  cli: { status: 0, output: "Identifier=t3\nCodeDirectory v=20500 size=99 flags=0x10000(runtime) hashes=3+7 location=embedded\nTeamIdentifier=ABCDE12345\n" },
};

test("a Developer ID build is proven only by a notarized assessment, a stapled ticket, hardened runtime and the configured team", () => {
  const proof = developerIdProof("ABCDE12345", notarized);
  assert.deepEqual(proof.failures, []);
  assert.equal(proof.gatekeeperSource, "Notarized Developer ID");
  const adHoc = { status: 0, output: "Identifier=t3\nCodeDirectory v=20400 size=99 flags=0x20002(adhoc,linker-signed) hashes=3+0 location=embedded\nSignature=adhoc\nTeamIdentifier=not set\n" };
  const cases = [
    [{ gatekeeper: { status: 3, output: "rejected\nsource=Unnotarized Developer ID\n" } }, /Notarized Developer ID \(source: Unnotarized Developer ID\)/],
    [{ gatekeeper: { status: 0, output: "accepted\nsource=Developer ID\n" } }, /source: Developer ID\)/],
    [{ stapler: { status: 65, output: "does not have a ticket stapled to it" } }, /stapled ticket/],
    [{ cli: adHoc }, /CLI executable is not signed with the hardened runtime.*TeamIdentifier is not set/],
    [{ app: { ...notarized.app, output: notarized.app.output.replace("ABCDE12345\n", "OTHER12345\n") } }, /app TeamIdentifier is OTHER12345/],
    [{ app: { status: 1, output: "code object is not signed at all" } }, /could not read the app signature/],
  ] as const;
  for (const [override, failure] of cases)
    assert.match(developerIdProof("ABCDE12345", { ...notarized, ...override }).failures.join("; "), failure);
});
