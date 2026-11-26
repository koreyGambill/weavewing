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

it("says noted for a quiet change with gaps and nothing to check for one without", async () => {
  const quiet = { state: "quiet", note: "", updatedAt: "2026-11-26T10:00:00.000Z", raised: [] };
  const change = (id: string, gaps: ReadonlyArray<string>) => ({
    id,
    ask: `Ask ${id}`,
    commits: ["a1b2c3d"],
    summary: `Changed ${id}`,
    review: { verdict: "approved", check: "unverified" },
    captures: [],
    gaps,
    qa: quiet,
  });
  const landing = {
    id: "landing-1",
    title: "Landing",
    target: { branch: "main", sha: "abc1234def" },
    verifications: [],
    changes: [change("routine", ["Not run on a phone."]), change("clean", [])],
    threadId: threadRef.threadId,
    projectId: null,
    landedAt: "2026-11-26T10:00:00.000Z",
    updatedAt: "2026-11-26T10:00:00.000Z",
  };
  await using screen = await render(
    <ThreadEvidenceContext
      value={
        {
          data: { landings: [landing] },
          error: null,
          supported: true,
          requested: new Set(["landing-1"]),
        } as never
      }
    >
      <ThreadEvidenceTimelineRow threadRef={threadRef} landingIds={["landing-1"]} />
    </ThreadEvidenceContext>,
  );
  await expect
    .element(screen.getByText("Landed on main · abc1234 · Changed routine · noted"))
    .toBeVisible();
  await expect
    .element(screen.getByText("Landed on main · abc1234 · Changed clean · nothing to check"))
    .toBeVisible();
});
