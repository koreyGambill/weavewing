import { expect, it, vi } from "vite-plus/test";

import { installWebFramePolicy } from "./weavewingFramePolicy";

it("keeps frames on the app's own origin once the web policy is installed", async () => {
  installWebFramePolicy();
  const violations: string[] = [];
  const onViolation = (event: SecurityPolicyViolationEvent) =>
    violations.push(`${event.effectiveDirective} ${event.blockedURI}`);
  document.addEventListener("securitypolicyviolation", onViolation);
  using _listener = {
    [Symbol.dispose]: () => document.removeEventListener("securitypolicyviolation", onViolation),
  };
  const frame = (src: string) => {
    const element = document.createElement("iframe");
    element.src = src;
    document.body.append(element);
    return element;
  };
  using _frames = {
    remote: frame("http://127.0.0.1:1/navigation?canary=1"),
    local: frame(`${location.origin}/`),
    [Symbol.dispose]() {
      this.remote.remove();
      this.local.remove();
    },
  };

  await vi.waitFor(() => expect(violations).toEqual(["frame-src http://127.0.0.1:1"]));
});
