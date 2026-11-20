import { expect, it } from "vite-plus/test";
import { fileVimCommand } from "./fileVimCommand";

it("keeps the interactive vim alias and quotes its file argument", () => {
  expect(fileVimCommand("/work/a file's $name.txt", false)).toBe(
    "vim -- '/work/a file'\\''s $name.txt'\r",
  );
  expect(fileVimCommand("C:\\Work\\a file's name.txt", true)).toBe(
    'vim -- "C:\\Work\\a file\'s name.txt"\r',
  );
  expect(fileVimCommand("/work/slash\\.txt", false)).toBe("vim -- '/work/slash'\\\\'.txt'\r");
  expect(fileVimCommand("C:\\Work\\%USERPROFILE%.txt", true)).toBeNull();
  expect(fileVimCommand("/work/file\nnext command", false)).toBeNull();
});
