import { describe, expect, it } from "vite-plus/test";

import { editedHostFileData, hostEditState } from "./OutsideEditAccess.logic";

const grant = { kind: "file" as const, path: "/home/user/notes.md" };
const read = {
  relativePath: "~/notes.md",
  contents: "old",
  byteLength: 3,
  truncated: false,
  writable: true,
  editGrant: grant,
};

describe("hostEditState", () => {
  it("drops edit access as soon as another client revokes the grant", () => {
    expect(hostEditState(read, [grant])).toEqual({ writable: true, editGrant: grant });
    expect(hostEditState(read, [])).toEqual({ writable: false, editGrant: undefined });
    // Before settings arrive, the read decides.
    expect(hostEditState(read, undefined)).toEqual({ writable: true, editGrant: grant });
    // The instruction file allowlist needs no grant.
    expect(hostEditState({ ...read, editGrant: undefined }, [])).toEqual({
      writable: true,
      editGrant: undefined,
    });
  });
});

describe("editedHostFileData", () => {
  it("keeps the grant on unsaved edits so the badge can still revoke it", () => {
    expect(editedHostFileData("~/notes.md", "new", read)).toEqual({
      relativePath: "~/notes.md",
      contents: "new",
      byteLength: 3,
      truncated: false,
      writable: true,
      editGrant: grant,
    });
    expect(editedHostFileData("~/notes.md", "new", undefined)).toEqual({
      relativePath: "~/notes.md",
      contents: "new",
      byteLength: 3,
      truncated: false,
    });
  });
});
