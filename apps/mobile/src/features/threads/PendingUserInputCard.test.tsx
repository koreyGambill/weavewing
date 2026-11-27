import { RegistryContext } from "@effect/atom-react";
import type { EnvironmentId, RuntimeRequestId, ThreadId } from "@t3tools/contracts";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

import type { PendingUserInput } from "../../lib/threadActivity";
import type { SelectableMarkdownTextProps } from "../../native/SelectableMarkdownText.types";

const harness = vi.hoisted(() => ({
  navigate: [] as Array<[string, object | undefined]>,
  openedUrls: [] as string[],
  markdown: {} as Pick<SelectableMarkdownTextProps, "resolveImageSource" | "onImagePress">,
}));
// Finish the Effect import before Vitest starts resolving the queued mocks.
const atoms = await vi.hoisted(async () => {
  const { Atom, AtomRegistry } = await import("effect/reactivity");
  return {
    registry: AtomRegistry.make(),
    configValueAtom: Atom.family((_environmentId: string) => Atom.make(null)),
  };
});

type Children = { children?: ReactNode };

vi.mock("react-native", () => ({
  Platform: { OS: "ios" },
  View: ({ children }: Children) => <div>{children}</div>,
  ScrollView: ({ children }: Children) => <div>{children}</div>,
  Pressable: ({
    children,
    onPress,
    accessibilityLabel,
  }: Children & { onPress?: () => void; accessibilityLabel?: string }) => (
    <button type="button" aria-label={accessibilityLabel} onClick={onPress}>
      {children}
    </button>
  ),
}));
vi.mock("react-native-reanimated", () => {
  const animation = { duration: () => ({ easing: () => ({}) }) };
  return {
    default: { View: ({ children }: Children) => <div>{children}</div> },
    Easing: { out: () => () => 0, cubic: () => 0 },
    FadeInUp: animation,
    FadeOutDown: animation,
    useAnimatedStyle: () => ({}),
    useSharedValue: (value: number) => ({ value, set: () => {} }),
  };
});
vi.mock("../../components/ui/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("../../components/ui/AppText", () => ({
  AppText: ({ children }: Children) => <span>{children}</span>,
}));
vi.mock("../../components/ui/ControlPill", () => ({ ControlPill: () => null }));
vi.mock("../../components/ui/Button", () => ({ Button: () => null }));
vi.mock("./QuestionAttachments", () => ({ QuestionAttachments: () => null }));
vi.mock("./ThreadMarkdownImage", () => ({
  ThreadMarkdownImageView: ({ uri, alt }: { uri: string; alt: string }) => (
    <img src={uri} alt={alt} />
  ),
}));
vi.mock("../files/FileMarkdownPreview", () => ({
  useMarkdownPreviewStyles: () => ({ nativeTextStyle: {} }),
}));
vi.mock("../../state/atom-registry", () => ({ appAtomRegistry: atoms.registry }));
vi.mock("../../state/server", () => ({
  serverEnvironment: { configValueAtom: atoms.configValueAtom },
}));
vi.mock("../../native/SelectableMarkdownText", () => ({
  SelectableMarkdownText: (props: SelectableMarkdownTextProps) => {
    harness.markdown = props;
    return (
      <div>
        {props.markdown.split("\n").map((line) => {
          const image = /^!\[([^\]]*)\]\(([^)]+)\)$/.exec(line);
          if (image) {
            const [, alt, href] = image;
            return (
              <div key={href}>{props.renderImage?.({ href: href!, alt: alt!, title: null })}</div>
            );
          }
          return [...line.matchAll(/(?<!!)\[([^\]]+)\]\(([^)]+)\)/g)].map(([, label, href]) => (
            <button key={href} type="button" onClick={() => props.onLinkPress?.(href!)}>
              {label}
            </button>
          ));
        })}
      </div>
    );
  },
}));
vi.mock("../../state/entities", () => ({
  useLiveThreadLinkLabels: (markdown: string) => markdown,
}));
vi.mock("../../native/useOpenPullRequest", () => ({
  useOpenPullRequest: () => async (url: string) => {
    harness.openedUrls.push(url);
    return true;
  },
}));
vi.mock("@react-navigation/native", () => ({
  useNavigation: () => ({
    navigate: (name: string, params?: object) => harness.navigate.push([name, params]),
  }),
}));

import { PendingUserInputCard } from "./PendingUserInputCard";

function setup(questionMarkdown: string) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  harness.navigate = [];
  harness.openedUrls = [];

  const pendingUserInput = {
    requestId: "request-1" as RuntimeRequestId,
    responseCapability: "resumable",
    questions: [
      {
        id: "question-1",
        header: "Review",
        question: questionMarkdown,
        options: [],
        allowCustomAnswer: false,
      },
    ],
  } as unknown as PendingUserInput;
  const container = document.createElement("div");
  const root = createRoot(container);
  act(() =>
    root.render(
      <RegistryContext.Provider value={atoms.registry}>
        <PendingUserInputCard
          environmentId={"env-1" as EnvironmentId}
          threadId={"thread-1" as ThreadId}
          workspaceRoot="/repo"
          canOperateThread
          pendingUserInput={pendingUserInput}
          maxHeight={{ value: 600 } as never}
          cardProgress={{ value: 1, set: () => {} } as never}
          cardCoverage={{ value: 0, set: () => {} } as never}
          collapsed={false}
          onToggleCollapsed={() => {}}
          drafts={{}}
          answers={null}
          respondingUserInputId={null}
          onSelectOption={() => {}}
          onChangeCustomAnswer={() => {}}
          onSubmit={async () => {}}
          onDismiss={async () => {}}
        />
      </RegistryContext.Provider>,
    ),
  );
  return {
    container,
    async pressLink(label: string) {
      const link = [...container.querySelectorAll("button")].find(
        (button) => button.textContent === label,
      );
      if (!link) throw new Error(`No link labelled ${label}`);
      await act(async () => link.click());
    },
    [Symbol.dispose]() {
      act(() => root.unmount());
    },
  };
}

it("opens a workspace file link in a question in the thread's file viewer", async () => {
  using screen = setup("Should I update [probe.md](docs/probe.md:12)?");

  await screen.pressLink("probe.md");

  expect(harness.openedUrls).toEqual([]);
  expect(harness.navigate).toEqual([
    [
      "ThreadFile",
      { environmentId: "env-1", threadId: "thread-1", path: ["docs", "probe.md"], line: "12" },
    ],
  ]);
});

it("holds a remote image in a question until the user taps it", async () => {
  using _screen = setup("Look: ![pixel](https://tracker.example.com/p.gif)");
  const resolve = harness.markdown.resolveImageSource!;
  const request = (href: string) => Promise.resolve(resolve({ href, alt: null, title: null }));

  await expect(request("docs/local.png")).resolves.toBeNull();
  let loaded = false;
  void request("https://tracker.example.com/p.gif").then(() => {
    loaded = true;
  });
  await act(async () => {});
  expect(loaded).toBe(false);

  await act(async () => harness.markdown.onImagePress!("https://tracker.example.com/p.gif"));
  expect(loaded).toBe(true);
  expect(harness.openedUrls).toEqual([]);
});

it("shows a load control for each remote image block and loads only the tapped image", async () => {
  using screen = setup(
    "![One](https://first.example.com/p.png)\n\n![Two](https://second.example.com/p.png)",
  );

  expect(screen.container.querySelector("img")).toBeNull();
  await screen.pressLink("Load image from first.example.com");
  expect([...screen.container.querySelectorAll("img")].map((image) => image.alt)).toEqual(["One"]);
  expect(
    screen.container.querySelector('[aria-label="Load image from second.example.com"]'),
  ).not.toBeNull();
});
