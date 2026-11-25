import "~/index.css";

import { expect, it } from "vite-plus/test";

import { render } from "../../../test/render";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import { QuestionNoteBox } from "./QuestionNoteBox";

const box = (note: string, width = 640) => (
  <div data-testid="frame" style={{ width }}>
    <QuestionNoteBox
      text={note}
      note={
        <Textarea
          unstyled
          size="sm"
          rows={1}
          aria-label="Note"
          value={note}
          readOnly
          className="w-full"
        />
      }
      actions={
        <>
          <Button size="xs" variant="contrast-outline">
            Not yet
          </Button>
          <Button size="xs" variant="contrast-outline">
            Dismiss
          </Button>
          <Button size="xs" variant="contrast-outline">
            Discuss
          </Button>
          <Button size="xs">Answer</Button>
        </>
      }
    />
  </div>
);

it("keeps a short note beside the buttons and puts the buttons under a long one, at the right", async () => {
  // router: false because the box never navigates.
  await using screen = await render(box("Short"), { router: false });
  const note = () => screen.getByLabelText("Note").element().getBoundingClientRect();
  const answer = () => screen.getByText("Answer").element().getBoundingClientRect();
  expect(answer().top).toBeLessThan(note().bottom);
  expect(answer().left).toBeGreaterThan(note().right);

  await screen.rerender(box("where will these live, btw? ".repeat(6)));
  expect(answer().top).toBeGreaterThanOrEqual(note().bottom);
  expect(note().height).toBeGreaterThan(30);
  const container = screen.container.querySelector("div > div")!.getBoundingClientRect();
  expect(container.right - answer().right).toBeLessThan(12);
});

it("keeps every button inside the box on a narrow card", async () => {
  // router: false because the box never navigates.
  await using screen = await render(box("", 260), { router: false });
  const frame = screen.getByTestId("frame").element().getBoundingClientRect();
  for (const button of screen.container.querySelectorAll("button")) {
    const rect = button.getBoundingClientRect();
    expect(rect.right).toBeLessThanOrEqual(frame.right);
    expect(rect.left).toBeGreaterThanOrEqual(frame.left);
  }
});
