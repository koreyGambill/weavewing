import { WEB_APP_FRAME_CSP } from "@t3tools/shared/weavewingOutbound";

/** Installs before any frame renders; the desktop shell sets its own policy and frame guard. */
export function installWebFramePolicy() {
  const meta = document.createElement("meta");
  meta.httpEquiv = "Content-Security-Policy";
  meta.content = WEB_APP_FRAME_CSP;
  document.head.prepend(meta);
}
