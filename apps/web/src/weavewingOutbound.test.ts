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

// Everything the web and desktop clients bundle from source. Mobile is the upstream app, unguarded here.
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

const MEDIA_SINK = /<(?:img|video|audio|source|Image|ImageBackground|SvgUri)\b/;
const LITERAL_REMOTE_SOURCE = /\b(?:src|poster|uri)\s*[=:]\s*\{?\s*["'`](?:https?:)?\/\//;

// Every file that renders an image or media element, and why it loads nothing on its own.
// A new sink fails the guard until someone checks where its source comes from.
const REVIEWED_MEDIA_SINKS = {
  "apps/web/src/components/chat/ChatMarkdownMedia.tsx": "markdown media behind RemoteMediaGate",
  "apps/web/src/components/chat/ComposerAttachmentStrip.tsx": "local composer files",
  "apps/web/src/components/chat/ComposerImageThumbnail.tsx": "local composer files",
  "apps/web/src/components/chat/ComposerStashMenu.tsx": "stashed data URLs",
  "apps/web/src/components/chat/MarkdownFileLink.tsx": "signed asset route",
  "apps/web/src/components/chat/QueuedRunsControl.tsx": "attachment thumbnails",
  "apps/web/src/components/chat/SnapShotAttachmentDetails.tsx": "captured data URLs",
  "apps/web/src/components/chat/TimelineToolActivityIcon.tsx": "inline data favicons only",
  "apps/web/src/components/chat/TimelineWorkEntryRow.tsx": "tool output images via asset route",
  "apps/web/src/components/chat/UserMessageContextChips.tsx": "attachment previews",
  "apps/web/src/components/composerContextPresentation.tsx": "captured screenshots",
  "apps/web/src/components/contextChipParts.tsx": "attachment previews",
  "apps/web/src/components/device/DeviceStreamView.tsx": "local device stream",
  "apps/web/src/components/evidence/EvidenceView.tsx": "signed asset route",
  "apps/web/src/components/files/AttachmentFilePreview.tsx": "signed asset route",
  "apps/web/src/components/files/AudioPreview.tsx": "signed asset route",
  "apps/web/src/components/files/extendedDocumentPreview.ts": "markup for sandboxed DocumentPages",
  "apps/web/src/components/files/NotebookPreview.tsx": "notebook data URLs",
  "apps/web/src/components/guest/GuestPage.tsx": "staged local files",
  "apps/web/src/components/mcp/UseInAnotherAppDialog.tsx": "bundled logos",
  "apps/web/src/components/media/AttachmentImage.tsx": "attachments",
  "apps/web/src/components/media/mediaContent.ts": "comment only",
  "apps/web/src/components/media/MediaVideoPlayer.tsx": "sources its callers gate",
  "apps/web/src/components/preview/PreviewFaviconIcon.tsx": "desktop-captured data URLs",
  "apps/web/src/components/ProjectFavicon.tsx": "project favicons from the environment",
  "apps/web/src/components/pullRequest/pullRequestPresentation.tsx":
    "forge avatars (GitHub allowed)",
  "apps/web/src/components/settings/MicrophoneTest.tsx": "local recording",
  "apps/web/src/components/settings/ProjectFaviconThumbnail.tsx": "project favicons",
  "apps/web/src/components/settings/ThemeSearchSection.tsx": "results of a user's Open VSX search",
  "apps/web/src/components/statusSources/StatusSourceIcon.tsx": "server-fetched configured source",
  "apps/web/src/components/T3AppIcon.tsx": "bundled icon",
};

describe("Weavewing outbound guard", () => {
  it("renders images and media only from reviewed sinks", () => {
    const sinks = bundledSources
      .filter(({ file, source }) => file.startsWith("apps/") && MEDIA_SINK.test(source))
      .map(({ file }) => file);
    expect(sinks.filter((file) => !(file in REVIEWED_MEDIA_SINKS))).toEqual([]);
    expect(Object.keys(REVIEWED_MEDIA_SINKS).filter((file) => !sinks.includes(file))).toEqual([]);
  });

  it("hard-codes no remote image or media source", () => {
    expect(
      bundledSources
        .filter(({ source }) => LITERAL_REMOTE_SOURCE.test(source))
        .map(({ file }) => file),
    ).toEqual([]);
  });

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

  // User messages, assistant turns, inbox cards, notes and files all render markdown
  // through ChatMarkdown, the one place the gate sits.
  it("renders every web markdown surface through the gated renderer", () => {
    const renderers = bundledSources
      .filter(({ source }) =>
        /^import (?!type )[^;]*from "react-markdown"|createMarkdownRenderer\(/m.test(source),
      )
      .map(({ file }) => file);
    expect(renderers.toSorted()).toEqual([
      "apps/web/src/components/ChatMarkdown.tsx",
      "apps/web/src/components/chat/markdownRenderer.ts",
    ]);
    const surfaces = [
      "apps/web/src/components/chat/TimelineUserMessageRow.tsx",
      "apps/web/src/components/chat/TimelineAssistantRows.tsx",
      "apps/web/src/components/inbox/InboxView.tsx",
      "apps/web/src/components/notes/NotesPanel.tsx",
      "apps/web/src/components/files/FileMarkdownPreview.tsx",
    ];
    expect(
      surfaces.filter(
        (surface) =>
          !bundledSources.find(({ file }) => file === surface)?.source.includes("<ChatMarkdown"),
      ),
    ).toEqual([]);
  });

  // CSP cannot stop agent HTML navigating its own frame; the app page's frame-src can.
  it("installs the web app's frame-src before anything renders", () => {
    const sources = new Map(bundledSources.map((entry) => [entry.file, entry.source]));
    const sourceOf = (file = "") => sources.get(file) ?? "";
    expect(sourceOf("packages/shared/src/weavewingOutbound.ts")).toContain(
      `export const WEB_APP_FRAME_CSP = "frame-src 'self'";`,
    );
    expect(sourceOf("apps/web/src/weavewingFramePolicy.ts")).toContain(
      "meta.content = WEB_APP_FRAME_CSP;",
    );
    expect(sourceOf("apps/web/src/main.tsx")).toContain(
      "if (!isElectron) installWebFramePolicy();\nconst router = startAppServices();",
    );
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
