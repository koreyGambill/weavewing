import { expect, it } from "vite-plus/test";

import { fileLinkFlashNow, playFileLinkFlash, stopFileLinkFlash } from "./fileLinkFlash";

it("resumes a flash after its tile is hidden and shown, and restarts only for a new flash", () => {
  using stack = new DisposableStack();
  const target = stack.adopt(document.body.appendChild(document.createElement("div")), (node) =>
    node.remove(),
  );
  const elapsed = () => Number(target.getAnimations()[0]?.currentTime ?? -1);
  const startedAt = fileLinkFlashNow() - 600;

  playFileLinkFlash(target, startedAt);
  expect(elapsed()).toBeGreaterThan(599);

  target.hidden = true;
  expect(getComputedStyle(target).display).toBe("none");
  target.hidden = false;
  expect(getComputedStyle(target).display).toBe("block");
  playFileLinkFlash(target, startedAt);
  expect(target.getAnimations()).toHaveLength(1);
  expect(elapsed()).toBeGreaterThan(599);

  playFileLinkFlash(target, fileLinkFlashNow());
  expect(target.getAnimations()).toHaveLength(1);
  expect(elapsed()).toBeLessThan(599);

  stopFileLinkFlash(target);
  expect(target.getAnimations()).toHaveLength(0);
});
