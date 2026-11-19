import { create } from "zustand";

export type Kind = "device" | "computer";
export type How = "qr" | "link" | "address" | "ssh";

export interface WizardState {
  readonly open: boolean;
  readonly step: number;
  readonly kind: Kind | null;
  readonly how: How | null;
}

export const CLOSED: WizardState = { open: false, step: 0, kind: null, how: null };

export const useWizardStore = create<WizardState>(() => CLOSED);

/** Links that ask for a computer to be added open the wizard on its "How" step. */
export const CONNECT_COMPUTER_HASH = "connect-computer";

/** Opens the Connect wizard; for a computer it starts at "How", with a link or address chosen. */
export function openConnectWizard(kind: Kind | null = null) {
  useWizardStore.setState(
    kind === "computer"
      ? { open: true, step: 1, kind, how: "address" }
      : { ...CLOSED, open: true, kind },
  );
}
