import { withProviderEnvironmentDefaults } from "@t3tools/provider-core/server/instanceEnvironment";
import { providerProbeEnvironment } from "@t3tools/provider-core/server/snapshotProbe";

/** Keep background probes under the same traffic defaults as turns. */
export function grokProbeEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return providerProbeEnvironment(withProviderEnvironmentDefaults("grok", environment));
}
