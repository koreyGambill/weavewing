import { ActivityIcon } from "lucide-react";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../test/render";
import { HostedView } from "./ViewPageHost";
import type { ViewDefinition, ViewLayout } from "./viewRegistry";

// A wide view such as a board: its full layout needs 720 px.
const board: ViewDefinition = {
  id: "calendar",
  title: "Board",
  icon: ActivityIcon,
  about: "",
  scope: "global",
  minWidthPx: 720,
  page: "/view/$viewId",
  render: ({ layout }) => <p>Board {layout}</p>,
};

function hosted(width: number, layout: ViewLayout = "full") {
  return (
    <HostedView
      definition={board}
      target={{ threadRef: null, draft: null }}
      layout={layout}
      host="panel"
      width={width}
      slots={{ actions: null, setDetails: () => {} }}
    />
  );
}

it("renders a view compact with Open full size below its minimum width", async () => {
  await using screen = await render(hosted(300));
  await expect.element(screen.getByText("Board compact")).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "Open full size" }));
  await vi.waitFor(() => expect(screen.router?.state.location.pathname).toBe("/view/calendar"));
  await screen.rerender(hosted(720));
  await expect.element(screen.getByText("Board full")).toBeVisible();
  expect(screen.getByRole("button", { name: "Open full size" }).elements()).toHaveLength(0);
});
