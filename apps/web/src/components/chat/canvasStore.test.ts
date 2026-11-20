import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  createChatCanvasStore,
  resolveChatCanvasModel,
  type ChatCanvasMeasurements,
} from "./canvasStore";
import type { ChatCanvasPreview } from "./chatCanvasLayout";

const threadRef = {
  environmentId: EnvironmentId.make("environment-1"),
  threadId: ThreadId.make("thread-1"),
};
const otherThreadRef = { ...threadRef, threadId: ThreadId.make("thread-2") };
const measurements = (width: number, height = 900): ChatCanvasMeasurements => ({
  width,
  height,
  padding: 48,
  maxChatWidth: 768,
  minChatWidth: 640,
  composerHeight: 180,
  timelineGutter: 0,
  findBar: null,
});
const preview: ChatCanvasPreview = {
  key: "browser:one",
  width: 320,
  position: null,
  source: { width: 1600, height: 1000 },
};

describe("chat canvas model", () => {
  it("floats details over narrow chat without changing the chat width", () => {
    const resolve = (width: number, detailsCardInlineOpen: boolean) =>
      resolveChatCanvasModel({
        measurements: measurements(width),
        detailsCardMeasurement: {
          threadRef,
          width: width === 260 ? 208 : 280,
          fullContentHeight: 300,
        },
        threadRef,
        preview: null,
        detailsCardInlineOpen,
      });
    for (const width of [1_300, 1_050, 900, 500, 260]) {
      const open = resolve(width, true);
      expect(open.detailsCardMode).toBe("inline");
      expect(open.detailsCardPlacement).toMatchObject({
        right: 12,
        width: width === 260 ? 208 : 280,
      });
      expect(open.layout.chat.width).toBe(resolve(width, false).layout.chat.width);
    }
  });

  it("moves the card into a popover when a preview below it leaves too little height", () => {
    const resolve = (fullContentHeight: number) =>
      resolveChatCanvasModel({
        measurements: { ...measurements(1100, 300), maxChatWidth: 728 },
        detailsCardMeasurement: { threadRef, width: 280, fullContentHeight },
        threadRef,
        preview: { ...preview, position: { x: 760, y: 150 }, lastInteraction: "drag" },
        detailsCardInlineOpen: true,
      });
    const model = resolve(400);
    expect(model.layout.overlapsDetailsCard).toBe(true);
    expect(model.detailsCardMode).toBe("popover");
  });

  it("keeps a dragged preview below find controls", () => {
    const model = resolveChatCanvasModel({
      measurements: {
        ...measurements(900),
        findBar: { left: 608, right: 888, bottom: 48 },
      },
      detailsCardMeasurement: null,
      threadRef,
      preview: { ...preview, position: { x: 568, y: 12 }, lastInteraction: "drag" },
      detailsCardInlineOpen: true,
    });
    expect(model.detailsCardTopInset).toBe(48);
    expect(model.layout.frame?.y).toBeGreaterThan(48);
  });

  it("ignores a details card measured for another thread", () => {
    const model = resolveChatCanvasModel({
      measurements: { ...measurements(1100, 300), maxChatWidth: 728 },
      detailsCardMeasurement: { threadRef: otherThreadRef, width: 280, fullContentHeight: 400 },
      threadRef,
      preview: { ...preview, position: { x: 760, y: 150 }, lastInteraction: "drag" },
      detailsCardInlineOpen: true,
    });
    expect(model.layout.overlapsDetailsCard).toBe(false);
    expect(model.detailsCardMode).toBe("inline");
  });

  it("keeps state identity when a measurement repeats", () => {
    const store = createChatCanvasStore();
    store.getState().setMeasurements(measurements(1400));
    const before = store.getState();
    store.getState().setMeasurements(measurements(1400));
    store.getState().measureDetailsCard({ threadRef, width: 280, fullContentHeight: 300 });
    const measured = store.getState();
    store.getState().measureDetailsCard({ threadRef, width: 280, fullContentHeight: 300 });
    expect(measured.measurements).toBe(before.measurements);
    expect(store.getState()).toBe(measured);
    store.getState().setMeasurements(measurements(900));
    expect(store.getState().measurements.width).toBe(900);
    expect(store.getState()).not.toBe(measured);
  });
});
