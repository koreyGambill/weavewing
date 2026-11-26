import { APP_BASE_NAME } from "../../lib/mobileBranding";

// Servers report failures as free text; these are the reasons that name the upstream product.
const KNOWN_FAILURES: ReadonlyArray<{ readonly pattern: RegExp; readonly copy: string }> = [
  {
    pattern: /Remote updates require the .* background service/,
    copy: `Remote updates need the ${APP_BASE_NAME} background service. Run \`t3 service install\` on that machine.`,
  },
  {
    pattern: /This server is managed by the .* desktop app/,
    copy: `The ${APP_BASE_NAME} desktop app on that machine runs this server. Update the desktop app to update it.`,
  },
];

/** Shows a server update failure in the app's own words, never another product's name. */
export function serverUpdateFailureCopy(message: string): string {
  const known = KNOWN_FAILURES.find((failure) => failure.pattern.test(message));
  if (known) return known.copy;
  // Other reasons, such as a managed-policy refusal, carry detail the user needs to act on.
  return message.replace(/\bT3 Code\b/g, APP_BASE_NAME);
}
