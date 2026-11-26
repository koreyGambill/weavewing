import { expect, it } from "vite-plus/test";

import { render } from "../../../test/render";
import {
  prStatusIndicator,
  resolveThreadPullRequestBadgePresentation,
  ThreadPullRequestBadgeControl,
} from "../ThreadStatusIndicators";
import { ComposerControl } from "./ComposerControl";

const STATES = ["open", "draft", "merged", "closed"] as const;

function PullRequestChips() {
  return (
    <div>
      {STATES.map((state) => {
        const url = `https://github.com/acme/render/pull/${STATES.indexOf(state) + 40}`;
        const status = prStatusIndicator(
          {
            number: 42,
            title: `A ${state} pull request`,
            url,
            baseRef: "main",
            headRef: "feature/chip",
            state: state === "draft" ? "open" : state,
            isDraft: state === "draft",
          },
          null,
        );
        return (
          <span key={state} data-state={state}>
            <ThreadPullRequestBadgeControl
              render={<ComposerControl size="xs" />}
              badge={null}
              pullRequests={[]}
              number={42}
              url={url}
              status={status}
              presentation={resolveThreadPullRequestBadgePresentation({
                badge: null,
                number: 42,
                url,
                status,
              })}
              onOpenList={() => {}}
              onOpenPullRequest={() => {}}
            />
          </span>
        );
      })}
      {/* An icon with no tone of its own, which the control colors with its foreground. */}
      <ComposerControl size="xs" data-state="plain">
        <svg viewBox="0 0 1 1" />
      </ComposerControl>
    </div>
  );
}

const glyphColor = (state: string) =>
  getComputedStyle(document.querySelector(`[data-state="${state}"] svg`)!).color;

it("colors the row's pull request glyph by state in both themes", async () => {
  await import("~/index.css");
  await using _screen = await render(<PullRequestChips />);
  const byTheme = (["light", "dark"] as const).map((theme) => {
    document.documentElement.classList.toggle("dark", theme === "dark");
    const colors = STATES.map(glyphColor);
    expect(new Set(colors).size, `${theme}: ${colors.join(", ")}`).toBe(STATES.length);
    expect(colors, theme).not.toContain(glyphColor("plain"));
    return colors;
  });
  document.documentElement.classList.remove("dark");
  // The dark theme has its own tones, so both themes were measured.
  expect(byTheme[1]).not.toEqual(byTheme[0]);
});
