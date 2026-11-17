import { withProviderEnvironmentDefaults } from "@t3tools/provider-core/server/instanceEnvironment";
import { providerProbeEnvironment } from "@t3tools/provider-core/server/snapshotProbe";

/** Suppress probe-time updater consoles on Windows; preserve update settings for other invocations. */
export function grokProbeEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...providerProbeEnvironment(withProviderEnvironmentDefaults("grok", environment, "probe")),
    GROK_DISABLE_AUTOUPDATER: "1",
  };
}
