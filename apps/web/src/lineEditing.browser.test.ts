import { expect, it } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { installInputLineEditing } from "./lineEditing";

it("keeps a line deletion on the field's undo stack", async () => {
  installInputLineEditing();
  const field = document.createElement("textarea");
  document.body.append(field);
  await using _field = { [Symbol.asyncDispose]: async () => field.remove() };
  field.focus();
  await userEvent.keyboard("first line");
  await userEvent.keyboard("{Control>}{Backspace}{/Control}");
  expect(field.value).toBe("");
  await userEvent.keyboard("{Control>}z{/Control}");
  expect(field.value).toBe("first line");
});
