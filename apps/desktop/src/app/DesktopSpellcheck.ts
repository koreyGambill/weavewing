import { app, session, type Session } from "electron";

export function installSpellcheckPolicy(platform: NodeJS.Platform): void {
  const configureSession = (browserSession: Session) => {
    // Hunspell downloads from Google automatically; native OS spellcheck needs no download.
    browserSession.setSpellCheckerDictionaryDownloadURL("file:///weavewing-dictionaries/");
    if (platform === "linux") browserSession.setSpellCheckerLanguages([]);
  };
  app.on("session-created", configureSession);
  app.once("ready", () => configureSession(session.defaultSession));
}
