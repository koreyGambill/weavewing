import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { Atom, AtomRegistry } from "effect/reactivity";
import { expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";

const fetches = vi.hoisted(() => ({ count: 0 }));

vi.mock("../connection/runtime", () => ({ connectionAtomRuntime: {} }));
// Each evaluation of a query atom stands for one fetch.
vi.mock("@t3tools/client-runtime/state/runtime", () => ({
  createEnvironmentRpcQueryAtomFamily: (options: { readonly label: string }) => {
    const family = Atom.family((_key: string) => Atom.make(() => ++fetches.count));
    return (target: object) => family(`${options.label} ${JSON.stringify(target)}`);
  },
  createEnvironmentRpcCommand: (_runtime: unknown, options: unknown) => options,
}));

import {
  refreshTodos,
  sidebarWorkspaceGet,
  threadListRead,
  threadListUpdate,
  threadWorkspaceGet,
} from "./threadWorkspace";

it.effect(
  "a list update refetches the left strip's workspace query, so the Todos badge follows",
  () =>
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

it.effect("a list write refetches the badge, the open Todos list and the cards' workspace", () =>
  Effect.sync(() => {
    fetches.count = 0;
    const environmentId = EnvironmentId.make("env");
    const threadId = ThreadId.make("thread");
    const registry = AtomRegistry.make();
    const unmount = [
      registry.mount(sidebarWorkspaceGet({ environmentId, input: { threadId } })),
      registry.mount(threadListRead({ environmentId, input: { threadId, all: true } })),
      registry.mount(threadWorkspaceGet({ environmentId, input: { threadId } })),
    ];
    expect(fetches.count).toBe(3);
    // The chat's cards read the last one, so none acts on a stale revision after a write.
    refreshTodos(registry, { environmentId, input: { threadId } });
    expect(fetches.count).toBe(6);
    for (const stop of unmount) stop();
    registry.dispose();
  }),
);
