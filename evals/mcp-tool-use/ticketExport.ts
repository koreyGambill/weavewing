/** The three tickets about the checkout latency regression; every other ticket is filler. */
const RELEVANT: Readonly<Record<number, { readonly owner: string; readonly body: string }>> = {
  47: {
    owner: "Imani Okafor",
    body: "Cart payment step takes 9s since Tuesday's deploy. Root cause: the tax service client lost its connection pool and opens a new TLS session per call.",
  },
  163: {
    owner: "Tomas Lindqvist",
    body: "Customers report the pay button spinning. Root cause: a missing index on order_items(sku_id) after the schema migration makes the stock check scan the table.",
  },
  251: {
    owner: "Rehana Siddiqui",
    body: "Slow order confirmation in the EU region. Root cause: the fraud scoring call was moved from async to inline and its p99 is 4s.",
  },
};
const AREAS = ["invoice PDF", "password reset", "email digest", "CSV export", "avatar upload"];
const OWNERS = ["A. Brandt", "C. Mwangi", "D. Petrov", "E. Nakamura", "F. Alvarez"];

/** A deterministic support export of `count` tickets from SUP-(1000 + `from`), about 270 bytes each. */
export function ticketExport(count: number, from = 1): string {
  return Array.from({ length: count }, (_, index) => {
    const n = from + index;
    const area = AREAS[n % AREAS.length]!;
    const relevant = RELEVANT[n];
    return `KEY: SUP-${1000 + n}
OWNER: ${relevant?.owner ?? OWNERS[n % OWNERS.length]}
STATUS: ${n % 3 === 0 ? "closed" : "open"}
BODY: ${relevant?.body ?? `User reports a problem with ${area}: step ${(n * 7) % 13} of the flow shows the wrong state after a refresh, and the workaround from release ${(n % 9) + 1}.${n % 20} no longer applies. Needs triage by the ${area} team; no customer deadline.`}
`;
  }).join("\n");
}
