// @effect-diagnostics nodeBuiltinImport:off - scans real web bundle sources on disk.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { remoteMediaHost } from "@t3tools/shared/weavewingOutbound";
import { describe, expect, it } from "vite-plus/test";

const repoRoot = NodePath.resolve(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "../../..",
);

// Everything the web and desktop renderer bundles from source.
const bundledSources = ["apps/web/src", "packages/client-runtime/src", "packages/shared/src"]
  .flatMap((directory) =>
    NodeFS.readdirSync(NodePath.join(repoRoot, directory), { recursive: true })
      .map(String)
      .map((file) => `${directory}/${file}`),
  )
  .filter((file) => /\.tsx?$/.test(file) && !/\.(test|browser\.test)\.tsx?$/.test(file))
  .map((file) => ({ file, source: NodeFS.readFileSync(NodePath.join(repoRoot, file), "utf8") }));

const FAVICON_SERVICES =
  /google\.com\/s2\/favicons|gstatic\.com\/faviconV2|icons\.duckduckgo\.com|icon\.horse|favicone\.com|faviconkit|besticon|githubassets\.com\/favicons|\/favicon\.ico/;

describe("Weavewing outbound guard", () => {
  it("bundles no third-party favicon lookup", () => {
    expect(
      bundledSources.filter(({ source }) => FAVICON_SERVICES.test(source)).map(({ file }) => file),
    ).toEqual([]);
  });

  it("gates every web renderer of markdown images", () => {
    const renderers = bundledSources.filter(
      ({ file, source }) =>
        file.startsWith("apps/web/") && source.includes("classifyMarkdownImageSource("),
    );
    expect(renderers.map(({ file }) => file)).toContain("apps/web/src/components/ChatMarkdown.tsx");
    expect(
      renderers
        .filter(({ source }) => !source.includes("<RemoteMediaGate"))
        .map(({ file }) => file),
    ).toEqual([]);
  });

  it.each([
    ["https://cdn.example.com/a.png?q=1", "cdn.example.com"],
    ["//cdn.example.com/a.png", "cdn.example.com"],
    ["http://127.0.0.1:3000/shot.png", "127.0.0.1:3000"],
    ["data:image/png;base64,AAAA", null],
    ["blob:http://localhost/123", null],
    ["not a url", null],
  ])("treats %s as remote host %s", (uri, host) => {
    expect(remoteMediaHost(uri)).toBe(host);
  });
});
