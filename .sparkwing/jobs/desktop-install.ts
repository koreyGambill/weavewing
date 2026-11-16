import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { ConcurrencyGroup, definePipeline } from "@sparkwing/sdk";

import { checkout, checkoutArgs, logged } from "../lib/checkout.ts";

const MODES = ["plan", "check", "auto", "wsl-only", "full"] as const;
type Mode = (typeof MODES)[number];

const MODE_FLAGS: Record<Mode, string[]> = {
  plan: ["--plan-only"],
  check: ["--check-only"],
  auto: [],
  "wsl-only": ["--wsl-only"],
  full: ["--full"],
};

definePipeline({
  name: "DesktopInstall",
  short: "Build and install the worktree into the local Weavewing desktop, one at a time",
  help:
    "Wraps scripts/update-local-desktop.ts (vp run desktop:update-local). plan reports the update path " +
    "from the installed receipt and changes nothing. Every other mode drains and backs up the WSL home " +
    "(check) or replaces the install, so it needs --allow-risk prod.",
  examples: [
    {
      command:
        "sparkwing run desktop-install -- --worktree $PWD --install-dir 'C:\\Users\\you\\Apps\\Weavewing'",
      comment: "Which update path would run",
    },
    {
      command:
        "sparkwing run desktop-install --detach --allow-risk prod -- --worktree $PWD --install-dir 'C:\\Users\\you\\Apps\\Weavewing' --mode auto",
      comment: "Install",
    },
  ],
  args: [
    ...checkoutArgs,
    {
      name: "install-dir",
      type: "string",
      required: true,
      description: "Windows install directory holding .weavewing-local-update.json",
    },
    { name: "mode", type: "string", default: "plan", enum: MODES, description: "plan, check, auto, wsl-only or full" },
    {
      name: "tools-dir",
      type: "string",
      description:
        "Directory with patchelf/usr/bin, linux-resource-monitor and windows-monitor (default ~/.local/share/weavewing-update-tools)",
    },
    { name: "wsl-home", type: "string", description: "Installed T3 home (the script defaults to ~/.t3)" },
    { name: "wsl-distro", type: "string", description: "WSL distribution (default WSL_DISTRO_NAME)" },
    { name: "drain-minutes", type: "string", description: "Wait for active turns before restarting" },
    { name: "notify-thread", type: "string", description: "Thread that receives the activation result" },
  ],
  plan(p, run) {
    const mode = (run.args.mode || "plan") as Mode;
    // Install modes end at Launch, which hands activation and its drain to a detached PowerShell, so
    // the cores cover the build. check runs Activate in the foreground and holds them through the drain.
    const job = p
      .job("desktop-install")
      .inline()
      .cores(mode === "plan" ? 1 : 8)
      .concurrency(new ConcurrencyGroup("weavewing-desktop", { capacity: 1 }));
    const step = job
      .step("update-local", async (ctx) => {
        const co = checkout(ctx);
        const tools = ctx.args["tools-dir"] || NodePath.join(NodeOS.homedir(), ".local/share/weavewing-update-tools");
        const optional = (name: string, value: string | undefined) => (value ? [`--${name}`, value] : []);
        const output = NodePath.join(co.evidence, "update");
        const log = await logged(ctx, co, "update-local", [
          "node",
          "scripts/update-local-desktop.ts",
          "--install-dir", ctx.args["install-dir"] ?? "",
          "--output-dir", output,
          "--vp-home", NodePath.join(NodeOS.homedir(), ".vite-plus"),
          "--patchelf-dir", NodePath.join(tools, "patchelf/usr/bin"),
          "--linux-monitor-dir", NodePath.join(tools, "linux-resource-monitor"),
          "--windows-monitor", NodePath.join(tools, "windows-monitor/t3-resource-monitor.exe"),
          ...optional("wsl-distro", ctx.args["wsl-distro"] || process.env.WSL_DISTRO_NAME),
          ...optional("wsl-home", ctx.args["wsl-home"]),
          ...optional("drain-minutes", ctx.args["drain-minutes"]),
          ...optional("notify-thread", ctx.args["notify-thread"]),
          ...MODE_FLAGS[mode],
        ]);
        return { mode, log, output };
      })
      .result();
    if (mode !== "plan") step.risk("prod");
  },
});
