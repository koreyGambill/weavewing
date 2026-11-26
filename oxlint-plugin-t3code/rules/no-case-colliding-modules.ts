import { defineRule } from "@oxlint/plugins";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

const MODULE = /^(.+)\.(?:[cm]?[jt]sx?)$/u;

// Lint visits many files per directory, so each directory is read once per run.
const stemsByDirectory = new Map<string, ReadonlyArray<{ name: string; stem: string }>>();

const moduleStems = (directory: string) => {
  let stems = stemsByDirectory.get(directory);
  if (stems === undefined) {
    stems = NodeFS.readdirSync(directory).flatMap((name) => {
      const stem = MODULE.exec(name)?.[1];
      return stem === undefined ? [] : [{ name, stem }];
    });
    stemsByDirectory.set(directory, stems);
  }
  return stems;
};

export default defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Reject sibling modules whose names differ only by case, which resolve to the same file on a case-insensitive disk.",
    },
  },
  create(context) {
    const stem = MODULE.exec(NodePath.basename(context.filename))?.[1];
    if (stem === undefined) return {};
    return {
      Program(node) {
        const lower = stem.toLowerCase();
        for (const sibling of moduleStems(NodePath.dirname(context.filename))) {
          if (sibling.stem !== stem && sibling.stem.toLowerCase() === lower) {
            context.report({
              node,
              message: `${sibling.name} differs from this file only by case, so an import without an extension resolves to either one on macOS and Windows. Rename one of them.`,
            });
          }
        }
      },
    };
  },
});
