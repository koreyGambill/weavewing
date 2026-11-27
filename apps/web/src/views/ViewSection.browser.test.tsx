import { expect, it } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { useThreadContextSidebarStore } from "~/threadContextSidebarStore";
import { act, render } from "../../test/render";
import { ViewSection, ViewSectionGroup } from "./ViewSection";

function Panel() {
  return (
    <div data-testid="scroller" style={{ height: 160, overflow: "auto" }}>
      <ViewSectionGroup>
        <ViewSection id="activity:runs" title="Runs">
          {() => <div style={{ height: 600 }}>Runs body</div>}
        </ViewSection>
        <ViewSection id="activity:landings" title="Landings" after="activity:runs">
          {() => <p>Landings body</p>}
        </ViewSection>
      </ViewSectionGroup>
    </div>
  );
}

function setup() {
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
