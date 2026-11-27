import { createMemoryHistory } from "@tanstack/react-router";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import type * as Context from "effect/Context";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { AppRoot } from "~/AppRoot";
// Load ChatView before the test timeout starts.
import "~/components/ChatView";
import { __setClientSettingsForTests } from "~/hooks/useSettings";
import { getRouter } from "~/router";
import {
  CODEX_PROVIDER,
  ENVIRONMENT_ID,
  dispatchedCommands,
  installFakeEnvironment,
  rejectPendingCommand,
  threadWithHistory,
  type FakeDriver,
} from "../../test/fakeEnvironment";
import { render } from "../../test/render";

vi.mock("../../../../packages/client-runtime/src/connection/driver.ts", async (importOriginal) => {
  const [actual, { fakeDriver }, Layer] = await Promise.all([
    importOriginal<{ readonly ConnectionDriver: Context.Key<unknown, FakeDriver> }>(),
    import("../../test/fakeEnvironment"),
    import("effect/Layer"),
  ]);
  return { ...actual, layer: Layer.succeed(actual.ConnectionDriver, fakeDriver) };
});

it("restores the prompt when a tracked send is rejected", async () => {
  const thread = threadWithHistory("rejected-tracked-send", 1);
  using _environment = installFakeEnvironment([thread], {
    acceptCommands: true,
    holdCommand: (command) => command.type === "message.dispatch",
    providers: [{ ...CODEX_PROVIDER, supportsTrackedAnswers: true }],
  });
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  const router = getRouter(
    createMemoryHistory({ initialEntries: [`/${ENVIRONMENT_ID}/${thread.id}`] }),
  );
  await router.load();
  await using screen = await render(<AppRoot router={router} />, {
    // AppRoot brings its own router.
    router: false,
  });
  const trackAnswer = screen.getByRole("button", { name: "Track answer" });
  await trackAnswer.click();
  const editor = screen.getByTestId("composer-editor");
  await editor.click();
  await userEvent.keyboard("What resets the counter?{Enter}");
  await vi.waitFor(() =>
    expect(dispatchedCommands()).toContainEqual(
      expect.objectContaining({
        type: "message.dispatch",
        context: expect.objectContaining({ trackedAsk: { question: "What resets the counter?" } }),
      }),
    ),
  );
  await expect.element(editor).not.toHaveTextContent("What resets the counter?");

  await rejectPendingCommand("This message was rejected.");

  await expect.element(page.getByText("This message was rejected.")).toBeVisible();
  await expect.element(editor).toHaveTextContent("What resets the counter?");
  await expect.element(trackAnswer).toHaveAttribute("aria-pressed", "true");
});
