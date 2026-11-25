import { expect, it } from "vite-plus/test";

import { AssetWorkspaceAssetNotFoundError, ThreadId } from "@t3tools/contracts";

import {
  missingLinkedMediaPath,
  shouldUseMarkdownFileBrowserPrimaryAction,
} from "./MarkdownFileLink.logic";

it("opens PDFs in the file panel and uses the browser only when no other destination exists", () => {
  expect(
    shouldUseMarkdownFileBrowserPrimaryAction({
      canOpenInEditor: true,
      canOpenInBrowser: true,
      canOpenInPanel: true,
    }),
  ).toBe(false);
  expect(
    shouldUseMarkdownFileBrowserPrimaryAction({
      canOpenInEditor: false,
      canOpenInBrowser: true,
      canOpenInPanel: true,
    }),
  ).toBe(false);
  expect(
    shouldUseMarkdownFileBrowserPrimaryAction({
      canOpenInEditor: false,
      canOpenInBrowser: true,
      canOpenInPanel: false,
    }),
  ).toBe(true);
});

it("sends a linked image that is gone to the file view instead of a toast", () => {
  const missing = new AssetWorkspaceAssetNotFoundError({
    resource: { _tag: "media-file", threadId: ThreadId.make("thread"), path: "../shot.png" },
  });
  expect(missingLinkedMediaPath(missing, "/work/shot.png")).toBe("/work/shot.png");
  expect(missingLinkedMediaPath(missing, undefined)).toBeNull();
  expect(missingLinkedMediaPath(new Error("offline"), "/work/shot.png")).toBeNull();
});
