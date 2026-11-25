import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { type EnvironmentId, ThreadId } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";

import { render } from "../../../test/render";
import { ThreadQuestionsPanel } from "./ThreadQuestionsPanel";

const threadRef = scopeThreadRef("env-1" as EnvironmentId, ThreadId.make("thread-1"));

it("takes keyboard focus from the composer when its tab is shown, even while loading", async () => {
  await using screen = await render(
    <>
      <textarea aria-label="Composer" />
      <ThreadQuestionsPanel threadRef={threadRef} active={false} onClose={() => {}} />
    </>,
    // router: false because the panel never navigates.
    { router: false },
  );
  const composer = screen.getByLabelText("Composer").element() as HTMLTextAreaElement;
  composer.focus();
  await screen.rerender(
    <>
      <textarea aria-label="Composer" />
      <ThreadQuestionsPanel threadRef={threadRef} active onClose={() => {}} />
    </>,
  );
  await expect.element(screen.getByLabelText("Question review")).toHaveFocus();
});
