import type { ProviderInstanceEnvironment } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";

import { expandHomeVariable } from "./pathExpansion.ts";

// Child providers must create their own identity instead of inheriting the server's launcher.
const AGENT_IDENTITY_VARIABLES = new Set([
  "CLAUDECODE",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_HOST_SESSION_ID",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_SESSION_ATTENDED",
  "CLAUDE_CODE_MESSAGING_SOCKET",
  "CLAUDE_CODE_MESSAGING_TOKEN",
  "CLAUDE_CODE_EXECPATH",
  "CLAUDE_CODE_DESKTOP_APP_VERSION",
  "CLAUDE_EFFORT",
  "CLAUDE_PID",
  "CLAUDE_AGENT_SDK_VERSION",
  "CODEX_THREAD_ID",
  "CODEX_SESSION_ID",
  "AI_AGENT",
]);

const QUIET_ENVIRONMENT_DEFAULTS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  claudeAgent: { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" },
  grok: { GROK_DISABLE_AUTOUPDATER: "1", DISABLE_TELEMETRY: "1", DISABLE_ERROR_REPORTING: "1" },
  opencode: { OPENCODE_DISABLE_AUTOUPDATE: "1" },
  pi: { PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0" },
  muse: { MUSE_NO_AUTO_UPDATE: "1" },
};

/** Apply traffic defaults to automatic checks below inherited and configured values. */
export function withProviderEnvironmentDefaults(
  driver: string | undefined,
  environment: NodeJS.ProcessEnv,
  purpose: "probe" | "turn",
  windows = HostProcess.Platform.defaultValue() === "win32",
): NodeJS.ProcessEnv {
  const next = { ...environment };
  if (purpose === "turn") return next;
  for (const [name, value] of Object.entries(QUIET_ENVIRONMENT_DEFAULTS[driver ?? ""] ?? {})) {
    const supplied = windows
      ? Object.keys(next).some((key) => key.toUpperCase() === name && next[key] !== undefined)
      : next[name] !== undefined;
    if (!supplied) next[name] = value;
  }
  return next;
}

export const mergeProviderInstanceEnvironment = Effect.fn(function* (
  environment: ProviderInstanceEnvironment | undefined,
  baseEnv: NodeJS.ProcessEnv = process.env,
  driver?: string,
  purpose: "probe" | "turn" = "turn",
) {
  const home = yield* HostProcess.HomeDirectory;
  const windows = (yield* HostProcess.Platform) === "win32";
  const next = withProviderEnvironmentDefaults(driver, baseEnv, purpose, windows);
  for (const name of Object.keys(next)) {
    if (AGENT_IDENTITY_VARIABLES.has(name.toUpperCase())) next[name] = "";
  }
  for (const variable of environment ?? []) {
    // An unresolved secret reference carries no value; the registry resolves it for the provider.
    if (typeof variable.value !== "string") continue;
    // Windows reads names without regard to case, and a child gets the first spelling in sort
    // order. Upper case sorts first, so the configured value wins even where a spawn merges the
    // parent environment back in.
    const name = windows ? variable.name.toUpperCase() : variable.name;
    if (windows) {
      for (const inherited of Object.keys(next)) {
        if (inherited.toUpperCase() === name) delete next[inherited];
      }
    }
    next[name] = expandHomeVariable(name, variable.value, home);
  }
  return next;
});
