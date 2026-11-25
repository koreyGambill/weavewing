import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { QuestionOptions } from "./QuestionOptions";

const question = {
  prompt: "Which database?",
  options: [
    { id: "pg", label: "Postgres", description: "" },
    { id: "lite", label: "SQLite", description: "" },
  ],
  recommendedOptionIds: [],
  multiSelect: false,
};

it("clears a single choice when its chosen option is clicked again", async () => {
  const onChoose = vi.fn();
  // router: false because the options never navigate.
  await using screen = await render(
    <QuestionOptions
      question={question}
      chosenOptionIds={["pg"]}
      disabled={false}
      onChoose={onChoose}
    />,
    { router: false },
  );
  await userEvent.click(screen.getByText("Postgres"));
  expect(onChoose).toHaveBeenLastCalledWith([]);
  await userEvent.click(screen.getByText("SQLite"));
  expect(onChoose).toHaveBeenLastCalledWith(["lite"]);
  expect(onChoose).toHaveBeenCalledTimes(2);
});
