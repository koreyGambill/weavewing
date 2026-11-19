/**
 * How a relink ended. Before the link call nothing has changed; once the target has been
 * asked to accept the link, it may already have replaced the old credential, so a failure
 * from then on leaves the access uncertain.
 */
export type RelinkOutcome =
  | { readonly kind: "done" }
  | { readonly kind: "unchanged"; readonly message: string }
  | { readonly kind: "uncertain"; readonly message: string };

export async function runRelink(input: {
  readonly from: string;
  readonly to: string;
  /** What the source holds now, in words, such as "Full access" or "no access". */
  readonly current: string;
  readonly hasAddress: boolean;
  readonly mint: () => Promise<{ readonly code: string } | { readonly failure: string }>;
  readonly link: (code: string) => Promise<{ readonly failure: string } | null>;
}): Promise<RelinkOutcome> {
  const { from, to, current } = input;
  if (!input.hasAddress) {
    return { kind: "unchanged", message: `${from} has no address for ${to}. Nothing changed.` };
  }
  const minted = await input.mint();
  if ("failure" in minted) {
    return {
      kind: "unchanged",
      message: `Could not get a code from ${to}: ${minted.failure} Nothing changed; ${from} still has ${current} there.`,
    };
  }
  const linked = await input.link(minted.code);
  if (linked === null) return { kind: "done" };
  return {
    kind: "uncertain",
    message: `${to} issued a code, but ${from} could not save the link: ${linked.failure} ${to} may already have ended the old link, so ${from}'s access there is uncertain.`,
  };
}
