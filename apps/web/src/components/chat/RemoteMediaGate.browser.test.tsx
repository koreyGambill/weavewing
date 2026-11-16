import { expect, it } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { render } from "../../../test/render";
import { RemoteMediaGate } from "./RemoteMediaGate";

it("requires consent for remote media unless automatic loading is enabled", async () => {
  const gate = (uri: string | null, autoLoad = false) => (
    <RemoteMediaGate uri={uri} kind="image" alt="fixture" autoLoad={autoLoad}>
      <span>Media mounted</span>
    </RemoteMediaGate>
  );
  // The gate is independent of navigation; the child marks whether a fetch-capable element mounts.
  await using screen = await render(gate("https://media.example/image.png"), { router: false });
  const button = screen.getByRole("button", { name: "Load image from media.example" });
  await expect.element(button).toBeInTheDocument();
  expect(screen.container.textContent).not.toContain("Media mounted");
  await screen.rerender(gate("https://media.example/image.png", true));
  expect(screen.container.textContent).toBe("Media mounted");
  await screen.rerender(gate("https://media.example/image.png"));
  await expect.element(button).toBeInTheDocument();
  await userEvent.click(button);
  expect(screen.container.textContent).toBe("Media mounted");
  await screen.rerender(gate("https://other.example/image.png"));
  await expect
    .element(screen.getByRole("button", { name: "Load image from other.example" }))
    .toBeInTheDocument();
  for (const uri of [
    null,
    "data:image/png;base64,AAAA",
    "blob:http://localhost/fixture",
    "/api/assets/fixture",
  ]) {
    await screen.rerender(gate(uri));
    expect(screen.container.textContent).toBe("Media mounted");
  }
});
