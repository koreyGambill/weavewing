import { expect, it } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { useThreadContextSidebarStore } from "~/threadContextSidebarStore";
import { useToolSidebarStore } from "~/toolSidebarStore";
import { act, render } from "../../test/render";
import { ViewSection, ViewSectionGroup } from "./ViewSection";

function Panel({ followsPanelReveal = true }: { followsPanelReveal?: boolean }) {
  return (
    <div data-testid="scroller" style={{ height: 160, overflow: "auto" }}>
      <ViewSectionGroup
        order={["activity:runs", "activity:landings"]}
        followsPanelReveal={followsPanelReveal}
      >
        <ViewSection id="activity:runs" title="Runs">
          {() => <div style={{ height: 600 }}>Runs body</div>}
        </ViewSection>
        <ViewSection id="activity:landings" title="Landings">
          {() => <p>Landings body</p>}
        </ViewSection>
      </ViewSectionGroup>
    </div>
  );
}

function setup() {
  useToolSidebarStore.setState(useToolSidebarStore.getInitialState());
  useThreadContextSidebarStore.setState(useThreadContextSidebarStore.getInitialState());
}

it("mounts a section's body after the one above it, and only once it scrolls into view", async () => {
  setup();
  await using screen = await render(<Panel />);
  await expect.element(screen.getByText("Runs body")).toBeVisible();
  expect(screen.getByText("Landings body").query()).toBeNull();
  await act(() => screen.getByTestId("scroller").element().scrollTo({ top: 1000 }));
  await expect.element(screen.getByText("Landings body")).toBeVisible();
});

it("mounts nothing for a collapsed section and mounts it when expanded", async () => {
  setup();
  useThreadContextSidebarStore.getState().toggleSection("activity:runs");
  await using screen = await render(<Panel />);
  const runs = screen.getByRole("button", { name: "Runs" });
  await expect.element(runs).toHaveAttribute("aria-expanded", "false");
  await expect.element(screen.getByText("Landings body")).toBeVisible();
  expect(screen.getByText("Runs body").query()).toBeNull();
  await userEvent.click(runs);
  await expect.element(screen.getByText("Runs body")).toBeVisible();
  expect(useThreadContextSidebarStore.getState().collapsedSections).toEqual([]);
});

it("reveals a section after a cold panel lays out the body above it", async () => {
  setup();
  useThreadContextSidebarStore.getState().show("activity", { section: "activity:landings" });
  await using screen = await render(<Panel />);
  await expect.element(screen.getByRole("button", { name: "Landings" })).toBeInViewport();
  await expect.element(screen.getByText("Landings body")).toBeInViewport();
  expect(screen.getByTestId("scroller").element().scrollTop).toBeGreaterThan(0);
});

it("keeps a tile section collapsed when the side panel requests that section", async () => {
  setup();
  useThreadContextSidebarStore.getState().show("activity", { section: "activity:runs" });
  useThreadContextSidebarStore.getState().toggleSection("activity:runs");
  await using screen = await render(<Panel followsPanelReveal={false} />);
  await expect.element(screen.getByText("Landings body")).toBeVisible();
  expect(screen.getByText("Runs body").query()).toBeNull();
  expect(useToolSidebarStore.getState().revealSection).toBe("activity:runs");
});
