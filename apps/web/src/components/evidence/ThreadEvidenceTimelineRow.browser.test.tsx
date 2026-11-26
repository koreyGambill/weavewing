import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { type EnvironmentId, ThreadId } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";

import "~/index.css";

import { render } from "../../../test/render";
import { ThreadEvidenceContext } from "./ThreadEvidenceContext";
import { ThreadEvidenceTimelineRow } from "./ThreadEvidenceTimelineRow";

const threadRef = scopeThreadRef("env-1" as EnvironmentId, ThreadId.make("thread-1"));

const read = (requested: ReadonlyArray<string>) =>
  ({
    data: { landings: [] },
    error: null,
    supported: true,
    requested: new Set(requested),
  }) as never;

it("offers Evidence for a placed landing the thread read did not ask for", async () => {
  await using screen = await render(
    <ThreadEvidenceContext value={read([])}>
      <ThreadEvidenceTimelineRow threadRef={threadRef} landingIds={["older-landing"]} />
    </ThreadEvidenceContext>,
  );
  await expect.element(screen.getByRole("button", { name: "Open in Evidence" })).toBeVisible();
  await expect.element(screen.getByText(/no longer available/)).not.toBeInTheDocument();
});

it("says a landing the read asked for and did not get is no longer available", async () => {
  await using screen = await render(
    <ThreadEvidenceContext value={read(["deleted-landing"])}>
      <ThreadEvidenceTimelineRow threadRef={threadRef} landingIds={["deleted-landing"]} />
    </ThreadEvidenceContext>,
  );
  await expect
    .element(screen.getByText("Landing deleted-landing is no longer available."))
    .toBeVisible();
});
