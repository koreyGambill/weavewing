/** Shell input cannot contain terminal control characters, even inside quotes. */
export function fileVimCommand(path: string, windows: boolean): string | null {
  if (
    Array.from(path).some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || (code >= 127 && code <= 159);
    })
  )
    return null;
  if (windows) {
    // The terminal can fall back from PowerShell to cmd, which expands variables inside quotes too.
    if (/["$%`!“”‘’]/u.test(path)) return null;
    return `vim -- "${path}"\r`;
  }
  // Escape backslashes outside quotes so this works in fish as well as POSIX shells.
  return `vim -- '${path.replace(/['\\]/g, (character) => `'\\${character}'`)}'\r`;
}
