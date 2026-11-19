import { describe, expect, it, vi } from "vite-plus/test";

import { runRelink } from "./relink.logic";

const base = { from: "WSL", to: "Moonborn", current: "Full access", hasAddress: true };

describe("runRelink", () => {
  it("says nothing changed and the old level still holds when the code cannot be minted", async () => {
    const link = vi.fn();
    const outcome = await runRelink({
      ...base,
      mint: async () => ({ failure: "Not allowed." }),
      link,
    });

    expect(link).not.toHaveBeenCalled();
    expect(outcome).toEqual({
      kind: "unchanged",
      message:
        "Could not get a code from Moonborn: Not allowed. Nothing changed; WSL still has Full access there.",
    });
  });

  it("calls the access uncertain when linking fails after the code was minted", async () => {
    const outcome = await runRelink({
      ...base,
      mint: async () => ({ code: "FULL-ABC" }),
      link: async () => ({ failure: "Disk full." }),
    });

    expect(outcome).toEqual({
      kind: "uncertain",
      message:
        "Moonborn issued a code, but WSL could not save the link: Disk full. Moonborn may already have ended the old link, so WSL's access there is uncertain.",
    });
    expect(outcome.kind === "uncertain" && outcome.message).not.toContain("still applies");
  });

  it("changes nothing without an address and finishes when both steps succeed", async () => {
    const mint = vi.fn();
    expect(await runRelink({ ...base, hasAddress: false, mint, link: vi.fn() })).toMatchObject({
      kind: "unchanged",
    });
    expect(mint).not.toHaveBeenCalled();
    expect(
      await runRelink({ ...base, mint: async () => ({ code: "C" }), link: async () => null }),
    ).toEqual({ kind: "done" });
  });
});
