import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { type EnvironmentId, type ThreadQuestion, ThreadId } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { ThreadQuestionCard } from "./ThreadQuestionCard";

const threadRef = scopeThreadRef("env-1" as EnvironmentId, ThreadId.make("thread-1"));

const answered: ThreadQuestion = {
  id: "Q8",
  prompt: "Which machine should agents drive?",
  options: [
    { id: "mac", label: "Mac only", description: "Works today" },
    { id: "pc", label: "Mac now, investigate the PC", description: "" },
  ],
  recommendedOptionIds: ["mac"],
  multiSelect: false,
  state: "answered",
  createdAt: "2026-11-24T12:00:00.000Z",
  closedAt: "2026-11-24T12:10:00.000Z",
  answer: {
    chosenOptionIds: ["pc"],
    notes: "Windows should work if possible.",
    submittedAt: "2026-11-24T12:05:00.000Z",
  },
  answeredBy: "user",
  replacedBy: null,
};

it("expands a closed question into the full card, read-only, with its answer chosen", async () => {
  // router: false because the card never navigates.
  await using screen = await render(
    <ThreadQuestionCard question={answered} threadRef={threadRef} />,
    { router: false },
  );
  await expect.element(screen.getByRole("radio")).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: /Which machine/ }));

  const chosen = screen.getByRole("radio", { name: /investigate the PC/ });
  await expect.element(chosen).toBeChecked();
  await expect.element(chosen).toBeDisabled();
  await expect.element(screen.getByRole("radio", { name: /Mac only/ })).not.toBeChecked();
  await expect.element(screen.getByText("Recommended")).toBeVisible();
  await expect
    .element(screen.getByRole("paragraph"))
    .toHaveTextContent("Windows should work if possible.");
  await expect.element(screen.getByRole("textbox")).not.toBeInTheDocument();
  await expect.element(screen.getByRole("button", { name: "Reopen" })).toBeVisible();

  await userEvent.click(screen.getByRole("button", { name: /Which machine/ }));
  await expect.element(screen.getByRole("radio")).not.toBeInTheDocument();
});
