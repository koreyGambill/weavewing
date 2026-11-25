import type { ArtifactQuestion } from "@t3tools/contracts";

import { Badge } from "../ui/badge";
import { Checkbox } from "../ui/checkbox";
import { Radio, RadioGroup } from "../ui/radio-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/**
 * A question's options, one row each, as radios or checkboxes; recommendations are marked, never
 * preselected. A description is cut to the row, in full on hover. Choosing the chosen option
 * again clears it.
 */
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
      // A radio group never reports a click on its chosen option, so the label clears it. The
      // click the label forwards to the radio's hidden input is the same click, so it is skipped.
      onClick={(event) => {
        if (
          !question.multiSelect &&
          !disabled &&
          !(event.target instanceof HTMLInputElement) &&
          chosenOptionIds[0] === option.id
        )
          onChoose([]);
      }}
      // The chosen row is outlined from the text colour as well as tinted, so it reads on any theme.
      className="flex min-w-0 cursor-pointer items-center gap-2 rounded-md px-1.5 py-1 text-sm transition-colors hover:bg-muted/40 has-[[data-checked]]:ring-1 has-[[data-checked]]:ring-foreground/55 has-[[data-checked]]:ring-inset has-[[data-checked]]:bg-primary/10 has-[[data-disabled]]:cursor-default"
    >
      {question.multiSelect ? (
        <Checkbox
          variant="contrast"
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
        <Radio variant="contrast" value={option.id} disabled={disabled} />
      )}
      <span className="shrink-0 font-medium">{option.label}</span>
      {question.recommendedOptionIds.includes(option.id) ? (
        <Badge variant="info-outline" size="sm">
          Recommended
        </Badge>
      ) : null}
      {option.description ? (
        <Tooltip>
          <TooltipTrigger
            render={<span className="min-w-0 flex-1 truncate text-muted-foreground" />}
          >
            {option.description}
          </TooltipTrigger>
          <TooltipPopup side="top" className="max-w-96">
            {option.description}
          </TooltipPopup>
        </Tooltip>
      ) : null}
    </label>
  ));
  return question.multiSelect ? (
    <div role="group" aria-label={question.prompt} className="flex flex-col gap-px">
      {options}
    </div>
  ) : (
    <RadioGroup
      aria-label={question.prompt}
      density="compact"
      value={chosenOptionIds[0] ?? ""}
      onValueChange={(value) => onChoose([value])}
    >
      {options}
    </RadioGroup>
  );
}
