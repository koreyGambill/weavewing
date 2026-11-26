import { createContext } from "react";

import type { useThreadEvidence } from "../../state/evidence";

/** The open thread's one landings read, shared by its timeline's card rows. */
export const ThreadEvidenceContext = createContext<ReturnType<typeof useThreadEvidence> | null>(
  null,
);
