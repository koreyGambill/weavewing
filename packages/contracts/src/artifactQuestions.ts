import * as Schema from "effect/Schema";
import { IsoDateTime, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const ArtifactQuestion = Schema.Struct({
  id: TrimmedNonEmptyString,
  prompt: TrimmedNonEmptyString,
  details: Schema.optional(Schema.String),
  options: Schema.Array(
    Schema.Struct({
      id: TrimmedNonEmptyString,
      label: TrimmedNonEmptyString,
      description: Schema.String,
    }),
  ),
  recommendedOptionIds: Schema.Array(TrimmedNonEmptyString),
  multiSelect: Schema.Boolean,
});
export type ArtifactQuestion = typeof ArtifactQuestion.Type;
export const ArtifactAnswer = Schema.Struct({
  chosenOptionIds: Schema.Array(TrimmedNonEmptyString),
  notes: Schema.String,
  submittedAt: Schema.NullOr(IsoDateTime),
  draftRevision: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
});
export type ArtifactAnswer = typeof ArtifactAnswer.Type;

const decodeQuestion = Schema.decodeUnknownSync(ArtifactQuestion);

/** Option ids are unique and recommendations name options, at most one for a single choice. */
export function artifactQuestionIsConsistent(
  question: Pick<ArtifactQuestion, "options" | "recommendedOptionIds" | "multiSelect">,
): boolean {
  const options = new Set(question.options.map((option) => option.id));
  return (
    options.size === question.options.length &&
    new Set(question.recommendedOptionIds).size === question.recommendedOptionIds.length &&
    question.recommendedOptionIds.every((id) => options.has(id)) &&
    (question.multiSelect || question.recommendedOptionIds.length <= 1)
  );
}

/** The chosen ids are distinct options of the question, at most one for a single choice. */
export function artifactAnswerFits(
  question: Pick<ArtifactQuestion, "options" | "multiSelect">,
  chosenOptionIds: ReadonlyArray<string>,
): boolean {
  return (
    new Set(chosenOptionIds).size === chosenOptionIds.length &&
    (question.multiSelect || chosenOptionIds.length <= 1) &&
    chosenOptionIds.every((choice) => question.options.some((option) => option.id === choice))
  );
}

/** Reads validated question blocks embedded in Markdown documents. */
export function parseArtifactQuestions(content: string): readonly ArtifactQuestion[] {
  const questions = [
    ...content.matchAll(/^```t3-question[^\S\r\n]*\r?\n([\s\S]*?)^```[^\S\r\n]*\r?$/gm),
  ].map((match) => decodeQuestion(JSON.parse(match[1]!)));
  const ids = new Set<string>();
  for (const question of questions) {
    if (ids.has(question.id) || !artifactQuestionIsConsistent(question))
      throw new Error("Question ids, options and recommendations must be consistent.");
    ids.add(question.id);
  }
  if ((content.match(/^```t3-question(?:\s|$)/gm)?.length ?? 0) !== questions.length)
    throw new Error("Question blocks must have a closing fence.");
  return questions;
}
