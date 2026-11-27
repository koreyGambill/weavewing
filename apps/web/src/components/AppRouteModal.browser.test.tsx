import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../test/render";
import { useCommitOnBlur } from "../hooks/useCommitOnBlur";
import { AppRouteModal } from "./AppRouteModal";

function CommitOnBlurField({ onCommit }: { onCommit: (next: string) => void }) {
  return <input aria-label="Instructions" {...useCommitOnBlur("", onCommit)} />;
}

describe("AppRouteModal", () => {
  it("commits a focused field when Esc closes it", async () => {
    const onCommit = vi.fn();
    await using _screen = await render(
      <AppRouteModal label="Settings">
        <CommitOnBlurField onCommit={onCommit} />
      </AppRouteModal>,
      { router: "/settings/general" },
    );

    await page.getByRole("textbox", { name: "Instructions" }).fill("Keep titles short");
    await userEvent.keyboard("{Escape}");

    expect(onCommit).toHaveBeenCalledWith("Keep titles short");
  });

  it("stays open when Esc belongs to a modal outside Base UI", async () => {
    await using _screen = await render(
      <AppRouteModal label="Settings">
        <CommitOnBlurField onCommit={() => undefined} />
      </AppRouteModal>,
      { router: "/settings/general" },
    );
    const settings = page.getByRole("dialog", { name: "Settings" });
    // Base UI takes initial focus a frame after opening; let it land before Clerk's modal takes focus.
    await expect.element(settings).toHaveFocus();
    // Clerk renders its account modal in its own root and dismisses on a document Esc listener.
    const foreignModal = document.body.appendChild(document.createElement("input"));
    using _foreignModal = { [Symbol.dispose]: () => foreignModal.remove() };

    foreignModal.focus();
    await userEvent.keyboard("{Escape}");

    await expect.element(settings).toHaveAttribute("data-open");
  });

  it("leaves the page beside it usable when docked", async () => {
    const onPageClick = vi.fn();
    await using _screen = await render(
      <>
        <button type="button" onClick={onPageClick}>
          Copy instructions
        </button>
        <AppRouteModal label="Settings" docked>
          <CommitOnBlurField onCommit={() => undefined} />
        </AppRouteModal>
      </>,
      { router: "/settings/general" },
    );
    const settings = page.getByRole("dialog", { name: "Settings" });
    await expect.element(settings).toHaveFocus();

    await page.getByRole("button", { name: "Copy instructions" }).click();
    await userEvent.keyboard("{Escape}");

    expect(onPageClick).toHaveBeenCalledOnce();
    await expect.element(settings).toHaveAttribute("data-open");
  });
});
