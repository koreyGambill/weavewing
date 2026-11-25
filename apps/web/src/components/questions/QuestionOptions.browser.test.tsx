import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import "~/index.css";

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

it.each([false, true])(
  "keeps a transformed scroller still when an option or its control is clicked (multiSelect: %s)",
  async (multiSelect) => {
    // The chat timeline virtualises its rows in a transformed container, so this mirrors it.
    await using screen = await render(
      <div data-testid="scroller" style={{ height: 200, overflowY: "auto" }}>
        <div style={{ transform: "translateY(0)", paddingTop: 800, paddingBottom: 800 }}>
          <QuestionOptions
            question={{ ...question, multiSelect }}
            chosenOptionIds={[]}
            disabled={false}
            onChoose={() => {}}
          />
        </div>
      </div>,
      { router: false },
    );
    const scroller = screen.getByTestId("scroller").element();
    scroller.scrollTop = 750;
    await userEvent.click(screen.getByText("SQLite"));
    expect(scroller.scrollTop).toBe(750);
    await userEvent.click(
      screen.getByRole(multiSelect ? "checkbox" : "radio", { name: "Postgres" }),
    );
    expect(scroller.scrollTop).toBe(750);
  },
);
