import { expect, it, vi } from "vite-plus/test";
import { DraftId } from "./composerDraftStore";
import {
  focusDraftProjectPicker,
  openDraftProjectPicker,
  registerDraftProjectPicker,
} from "./draftProjectPicker";

it("opens the focused draft across tiles, then falls back to the active route", () => {
  const first = DraftId.make("first");
  const second = DraftId.make("second");
  const openFirst = vi.fn();
  const openSecond = vi.fn();
  using cleanup = new DisposableStack();
  cleanup.defer(registerDraftProjectPicker(first, openFirst));
  const unregisterSecond = registerDraftProjectPicker(second, openSecond);
  cleanup.defer(unregisterSecond);
  expect(openDraftProjectPicker(first)).toBe(true);
  expect(openFirst).toHaveBeenCalledOnce();
  focusDraftProjectPicker(second);
  openDraftProjectPicker(first);
  expect(openSecond).toHaveBeenCalledOnce();
  focusDraftProjectPicker(null);
  openDraftProjectPicker(first);
  expect(openFirst).toHaveBeenCalledTimes(2);
  focusDraftProjectPicker(second);
  unregisterSecond();
  openDraftProjectPicker(first);
  expect(openFirst).toHaveBeenCalledTimes(3);
  expect(openDraftProjectPicker(null)).toBe(false);
});
