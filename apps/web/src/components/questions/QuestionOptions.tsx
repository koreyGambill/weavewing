import type { ArtifactQuestion } from "@t3tools/contracts";

import { Badge } from "../ui/badge";
import { Checkbox } from "../ui/checkbox";
import { Radio, RadioGroup } from "../ui/radio-group";

/** A question's options as radios or checkboxes; recommendations are marked, never preselected. */
export function QuestionOptions({
  question,
  chosenOptionIds,
  disabled,
  onChoose,
}: {
  readonly question: Pick<
    ArtifactQuestion,
    "prompt" | "options" | "recommendedOptionIds" | "multiSelect"
  >;
  readonly chosenOptionIds: ReadonlyArray<string>;
  readonly disabled: boolean;
  readonly onChoose: (chosenOptionIds: ReadonlyArray<string>) => void;
}) {
  const options = question.options.map((option) => (
    <label
      key={option.id}
      className="grid cursor-pointer grid-cols-[auto_minmax(0,1fr)] items-start gap-x-2 gap-y-1 rounded-lg border border-border p-3 transition-colors hover:bg-muted/40 has-[[data-checked]]:border-primary/60 has-[[data-checked]]:bg-primary/5 has-[[data-disabled]]:cursor-default"
    >
      {question.multiSelect ? (
        <Checkbox
          checked={chosenOptionIds.includes(option.id)}
          disabled={disabled}
          onCheckedChange={(checked) =>
            onChoose(
              checked
                ? [...chosenOptionIds, option.id]
                : chosenOptionIds.filter((id) => id !== option.id),
            )
          }
        />
      ) : (
        <Radio value={option.id} disabled={disabled} />
      )}
      <span className="min-w-0 contents">
        <span className="flex min-w-0 flex-wrap items-center gap-2 text-sm font-medium break-words">
          {option.label}
          {question.recommendedOptionIds.includes(option.id) ? (
            <Badge variant="info" size="sm">
              Recommended
            </Badge>
          ) : null}
        </span>
        {option.description ? (
          <span className="col-span-2 block text-xs leading-relaxed break-words text-muted-foreground @min-[320px]:col-start-2 @min-[320px]:col-span-1">
            {option.description}
          </span>
        ) : null}
      </span>
    </label>
  ));
  return question.multiSelect ? (
    <div role="group" aria-label={question.prompt} className="space-y-2">
      {options}
    </div>
  ) : (
    <RadioGroup
      aria-label={question.prompt}
      value={chosenOptionIds[0] ?? ""}
      onValueChange={(value) => onChoose([value])}
    >
      {options}
    </RadioGroup>
  );
}
