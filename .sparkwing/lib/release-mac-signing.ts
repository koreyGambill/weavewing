import * as CP from "node:child_process";
import * as FS from "node:fs";
import * as Path from "node:path";

// Long enough for a full Mac build plus notarization waits; the keychain locks only after this much inactivity.
const KEYCHAIN_LOCK_SECONDS = 21600;

/** Node prints child process inputs, such as secret payloads, when these are set, and clearing them at runtime is too late. */
export function assertNoNodeTracing(env: Readonly<Record<string, string | undefined>>) {
  const set = ["NODE_DEBUG", "NODE_DEBUG_NATIVE"].filter((name) => env[name]);
  if (set.length) throw new Error(`Unset ${set.join(" and ")} before running a release helper; Node would log secret inputs`);
}

export interface SigningIdentity {
  hash: string;
  name: string;
}

/** The single Developer ID Application identity in `security find-identity -v -p codesigning` output, checked against the team. */
export function developerIdIdentity(listing: string, teamId: string): SigningIdentity {
  const identities = [...listing.matchAll(/^\s*\d+\)\s+([0-9A-F]{40})\s+"(Developer ID Application: [^"]+)"/gm)]
    .map((match) => ({ hash: match[1]!, name: match[2]! }));
  if (identities.length !== 1)
    throw new Error(`APPLE_CSC_LINK must hold exactly one Developer ID Application identity; found ${identities.length}`);
  const identity = identities[0]!;
  if (!identity.name.endsWith(`(${teamId})`)) throw new Error(`The Developer ID Application certificate does not belong to APPLE_TEAM_ID ${teamId}`);
  return identity;
}

/**
 * Runs one `security` command and returns stdout, throwing on a non-zero exit. A command given `secrets`
 * goes alone through `security -i` on stdin, so its own status is checked, and its failure reports only the
 * command and status because tool output can echo an escaped password.
 */
export type Security = (args: readonly string[], secrets?: readonly string[]) => string;

export function securityCommand(env: Readonly<Record<string, string>>, spawn: typeof CP.spawnSync = CP.spawnSync): Security {
  const q = (value: string) => `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
  return (args, secrets = []) => {
    // A line break would end the stdin command early and run the rest as another command.
    if (secrets.length && args.some((arg) => /[\n\r\0]/.test(arg))) throw new Error(`security ${args[0]}: a value contains a line break or NUL`);
    const result = spawn("security", secrets.length ? ["-i"] : args, {
      env, encoding: "utf8", stdio: "pipe",
      ...(secrets.length ? { input: `${args.map(q).join(" ")}\n` } : {}),
    });
    if (result.error || result.status !== 0) {
      const detail = secrets.length ? "" : String(result.stderr ?? "").trim();
      throw new Error(`security ${args[0]} failed (${result.error ? "could not start" : `exit ${result.status}`})${detail ? `: ${detail}` : ""}`);
    }
    return String(result.stdout ?? "");
  };
}

function keychainList(output: string): string[] {
  return output.split("\n").map((line) => line.trim().replace(/^"(.*)"$/, "$1")).filter(Boolean);
}

function attempt(errors: unknown[], step: () => void) {
  try {
    step();
  } catch (error) {
    errors.push(error);
  }
}

/**
 * Imports a Developer ID certificate into a temporary keychain that codesign can find by identity and runs `body`.
 * The certificate file is deleted once imported. Afterwards, also on failure, the user keychain search list is
 * restored and the keychain deleted; cleanup failures are reported beside a build failure instead of hiding it.
 */
export async function withSigningKeychain<T>(
  security: Security,
  options: { keychain: string; password: string; certificate: string; certificatePassword: string; teamId: string },
  body: (identity: SigningIdentity) => T | Promise<T>,
): Promise<T> {
  const { keychain, password, certificate, certificatePassword, teamId } = options;
  const removeCertificate = () => FS.rmSync(certificate, { force: true });
  let previous: string[];
  try {
    previous = keychainList(security(["list-keychains", "-d", "user"]));
  } catch (error) {
    removeCertificate();
    throw error;
  }
  const cleanup = () => {
    const errors: unknown[] = [];
    attempt(errors, removeCertificate);
    attempt(errors, () => security(["list-keychains", "-d", "user", "-s", ...previous]));
    attempt(errors, () => security(["delete-keychain", keychain]));
    return errors;
  };
  let result: T;
  try {
    security(["create-keychain", "-p", password, keychain], [password]);
    security(["set-keychain-settings", "-lut", String(KEYCHAIN_LOCK_SECONDS), keychain]);
    security(["unlock-keychain", "-p", password, keychain], [password]);
    try {
      security(["import", certificate, "-k", keychain, "-P", certificatePassword, "-T", "/usr/bin/codesign"], [certificatePassword]);
    } finally {
      removeCertificate();
    }
    security(["set-key-partition-list", "-S", "apple-tool:,apple:,codesign:", "-s", "-k", password, keychain], [password]);
    // A bare `codesign --sign <identity>` searches only the user keychain search list.
    security(["list-keychains", "-d", "user", "-s", keychain, ...previous.filter((entry) => entry !== keychain)]);
    result = await body(developerIdIdentity(security(["find-identity", "-v", "-p", "codesigning", keychain]), teamId));
  } catch (error) {
    const errors = cleanup();
    throw errors.length ? new AggregateError([error, ...errors], "Signing failed and keychain cleanup also failed") : error;
  }
  const errors = cleanup();
  if (errors.length) throw new AggregateError(errors, "Keychain cleanup failed");
  return result;
}

/**
 * Takes the signing lock with one atomic mkdir and records its owner. An existing lock fails with the manual
 * recovery instead of being taken over; the returned release removes the lock only while this owner holds it.
 */
export function acquireLock(dir: string, owner = `${process.pid} ${new Date().toISOString()}`): () => void {
  const file = Path.join(dir, "owner");
  const recorded = () => {
    try {
      return FS.readFileSync(file, "utf8");
    } catch {
      return undefined;
    }
  };
  try {
    FS.mkdirSync(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const [pid = "unknown", started = "unknown"] = recorded()?.split(" ") ?? [];
    throw new Error(`Another Mac signing build holds ${dir} (PID ${pid}, started ${started}). If \`ps -p ${pid}\` shows no Weavewing build, clear it with: rm -rf ${dir}`);
  }
  FS.writeFileSync(file, owner);
  return () => {
    if (recorded() === owner) FS.rmSync(dir, { recursive: true, force: true });
  };
}

export interface CheckResult {
  status: number | null;
  output: string;
}

function codesignDetails(check: CheckResult) {
  const flags = /^CodeDirectory .*\bflags=0x[0-9a-f]+\(([^)]*)\)/m.exec(check.output)?.[1]?.split(",") ?? [];
  return { valid: check.status === 0, hardenedRuntime: flags.includes("runtime"), teamId: /^TeamIdentifier=(.*)$/m.exec(check.output)?.[1]?.trim() };
}

/**
 * Judges a Developer ID build from `spctl -a -vv -t exec`, `xcrun stapler validate` and `codesign -dv`
 * on the app and the CLI executable. The build is proven only when `failures` is empty.
 */
export function developerIdProof(teamId: string, checks: { gatekeeper: CheckResult; stapler: CheckResult; app: CheckResult; cli: CheckResult }) {
  const gatekeeperSource = /^source=(.*)$/m.exec(checks.gatekeeper.output)?.[1]?.trim() ?? null;
  const app = codesignDetails(checks.app);
  const cli = codesignDetails(checks.cli);
  const failures: string[] = [];
  if (checks.gatekeeper.status !== 0 || gatekeeperSource !== "Notarized Developer ID")
    failures.push(`spctl did not accept the app as Notarized Developer ID (source: ${gatekeeperSource ?? "none"})`);
  if (checks.stapler.status !== 0) failures.push("xcrun stapler validate found no valid stapled ticket on the app");
  for (const [label, details] of [["app", app], ["CLI executable", cli]] as const) {
    if (!details.valid) failures.push(`codesign could not read the ${label} signature`);
    if (!details.hardenedRuntime) failures.push(`the ${label} is not signed with the hardened runtime`);
    if (details.teamId !== teamId) failures.push(`the ${label} TeamIdentifier is ${details.teamId ?? "missing"}, not APPLE_TEAM_ID ${teamId}`);
  }
  return { gatekeeperSource, stapled: checks.stapler.status === 0, app, cli, failures };
}
