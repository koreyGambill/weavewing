import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { Atom, AtomRegistry } from "effect/reactivity";
import { expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";

const fetches = vi.hoisted(() => ({ count: 0 }));

vi.mock("../connection/runtime", () => ({ connectionAtomRuntime: {} }));
// Each evaluation of a query atom stands for one fetch.
vi.mock("@t3tools/client-runtime/state/runtime", () => ({
  createEnvironmentRpcQueryAtomFamily: () => {
    const family = Atom.family((_key: string) => Atom.make(() => ++fetches.count));
    return (target: object) => family(JSON.stringify(target));
  },
  createEnvironmentRpcCommand: (_runtime: unknown, options: unknown) => options,
}));

import { sidebarWorkspaceGet, threadListUpdate } from "./threadWorkspace";

it.effect("a list update refetches the workspace query, so the attention dot follows", () =>
  Effect.gen(function* () {
    const environmentId = EnvironmentId.make("env");
    const input = { threadId: ThreadId.make("thread") };
    const registry = AtomRegistry.make();
    const unmount = registry.mount(sidebarWorkspaceGet({ environmentId, input }));
    expect(fetches.count).toBe(1);

    const { onSuccess } = threadListUpdate as unknown as {
      onSuccess?: (...args: unknown[]) => Effect.Effect<void>;
    };
    yield* onSuccess?.({ environmentId, input }, registry) ?? Effect.void;
    expect(fetches.count).toBe(2);
    unmount();
    registry.dispose();
  }),
);
