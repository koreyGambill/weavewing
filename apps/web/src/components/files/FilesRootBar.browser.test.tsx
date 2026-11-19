import { userEvent } from "vite-plus/test/browser";
import { describe, expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";
import { FilesRootBar } from "./FilesRootBar";

describe("FilesRootBar", () => {
  it("keeps keyboard focus on Up when Up reaches the filesystem root", async () => {
    const onChangeRoot = vi.fn();
    const bar = (treeRoot: string) => (
      <FilesRootBar
        treeRoot={treeRoot}
        workspaceRoot="/ws"
        outsideWorkspace
        onChangeRoot={onChangeRoot}
        onOpenTabHere={vi.fn()}
      />
    );
    await using screen = await render(bar("/tmp"));
    const up = screen.getByRole("button", { name: "Up one folder" });
    (up.element() as HTMLElement).focus();
    await userEvent.keyboard("{Enter}");
    expect(onChangeRoot).toHaveBeenCalledWith("/");

    await screen.rerender(bar("/"));
    await expect.element(up).toHaveAttribute("aria-disabled", "true");
    expect(document.activeElement).toBe(up.element());
    await userEvent.keyboard("{Enter}");
    expect(onChangeRoot).toHaveBeenCalledTimes(1);
  });
});
