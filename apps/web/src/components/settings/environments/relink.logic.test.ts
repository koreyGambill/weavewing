import { describe, expect, it, vi } from "vite-plus/test";

import { runRelink, settleUncertain } from "./relink.logic";

const base = { from: "WSL", to: "Mac mini", current: "Full access", hasAddress: true };

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
        "Could not get a code from Mac mini: Not allowed. Nothing changed; WSL still has Full access there.",
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
        "Mac mini issued a code, but WSL could not save the link: Disk full. Mac mini may already have ended the old link, so WSL's access there is uncertain.",
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

  it("keeps a half-failed line uncertain through a retry that fails at mint, until one completes", async () => {
    const outcomes = [
      await runRelink({
        ...base,
        mint: async () => ({ code: "FULL-ABC" }),
        link: async () => ({ failure: "Disk full." }),
      }),
      await runRelink({
        ...base,
        current: null,
        mint: async () => ({ failure: "Not allowed." }),
        link: vi.fn(),
      }),
      await runRelink({
        ...base,
        current: null,
        mint: async () => ({ code: "C" }),
        link: async () => null,
      }),
    ];
    const states: Array<ReadonlyMap<string, "full-access">> = [];
    let uncertain: ReadonlyMap<string, "full-access"> = new Map();
    for (const outcome of outcomes) {
      uncertain = settleUncertain(uncertain, "WSL>Mac mini", outcome.kind, "full-access");
      states.push(uncertain);
    }

    expect(states.map((state) => state.has("WSL>Mac mini"))).toEqual([true, true, false]);
    expect(outcomes[1]).toEqual({
      kind: "unchanged",
      message:
        "Could not get a code from Mac mini: Not allowed. Nothing changed, so WSL's access there is still uncertain.",
    });
  });
});
