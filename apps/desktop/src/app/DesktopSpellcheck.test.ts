// @effect-diagnostics nodeBuiltinImport:off - models Electron's synchronous app lifecycle events.
import * as NodeEvents from "node:events";
import { describe, expect, it, vi } from "vite-plus/test";

const { electron } = vi.hoisted(() => ({
  electron: {
    app: {
      on: vi.fn(),
      once: vi.fn(),
    },
    session: {
      defaultSession: {
        setSpellCheckerLanguages: vi.fn(),
        setSpellCheckerDictionaryDownloadURL: vi.fn(),
      },
    },
  },
}));
vi.mock("electron", () => electron);

import { installSpellcheckPolicy } from "./DesktopSpellcheck.ts";

function setup() {
  const app = new NodeEvents.EventEmitter();
  electron.app.on.mockImplementation((event, listener) => app.on(event, listener));
  electron.app.once.mockImplementation((event, listener) => app.once(event, listener));
  const makeSession = () => {
    const state = {
      languages: ["en-US"],
      downloadURL: "https://redirector.gvt1.com/edgedl/chrome/dict/",
    };
    return {
      state,
      setSpellCheckerLanguages: (languages: string[]) => {
        state.languages = languages;
      },
      setSpellCheckerDictionaryDownloadURL: (url: string) => {
        state.downloadURL = url;
      },
    };
  };
  const defaultSession = makeSession();
  electron.session.defaultSession.setSpellCheckerLanguages.mockImplementation(
    defaultSession.setSpellCheckerLanguages,
  );
  electron.session.defaultSession.setSpellCheckerDictionaryDownloadURL.mockImplementation(
    defaultSession.setSpellCheckerDictionaryDownloadURL,
  );
  return { app, defaultSession, makeSession };
}

describe("desktop spellcheck outbound policy", () => {
  it.each(["linux", "win32", "darwin"] as const)(
    "keeps default and future %s sessions off dictionary CDNs",
    (platform) => {
      const { app, defaultSession, makeSession } = setup();
      installSpellcheckPolicy(platform);
      app.emit("ready");
      const sessions = [defaultSession];
      for (const partition of ["persist:app", "persist:preview", "temporary-preview"]) {
        const session = makeSession();
        app.emit("session-created", session);
        sessions.push(session);
        expect(new URL(session.state.downloadURL + "en-us-10-1.bdic").protocol, partition).toBe(
          "file:",
        );
      }
      for (const session of sessions) {
        expect(new URL(session.state.downloadURL + "en-us-10-1.bdic").protocol).toBe("file:");
        expect(session.state.languages).toEqual(platform === "linux" ? [] : ["en-US"]);
      }
    },
  );
});
