import { PlusIcon, Trash2Icon } from "lucide-react";
import { useRef, type ReactNode } from "react";
import { flushSync } from "react-dom";

import { randomUUID } from "../../lib/utils";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";
import { reviewFieldKey, withKind, type ReviewDraft } from "./reviewAgentDraft.logic";

const KIND_LABELS: Record<ReviewDraft["kind"], string> = {
  standards: "Standards",
  "context-review": "Context use (Claude Haiku)",
};
const DELIVERY_LABELS: Record<ReviewDraft["delivery"], string> = {
  "thread-or-alert": "Inbox, and tell the thread",
  alerts: "Inbox only",
};
const STATE_LABELS: Record<ReviewDraft["targets"]["state"], string> = {
  active: "Active threads",
  closed: "Closed threads",
  all: "All threads",
};

function Row({
  label,
  htmlFor,
  children,
}: {
  label: string;
  htmlFor: string;
  children: ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
    </div>
  );
}

/** The review agent's rules, standards sources, targets and delivery. */
export function ReviewAgentFields({
  draft,
  onChange,
}: {
  readonly draft: ReviewDraft;
  readonly onChange: (update: (draft: ReviewDraft) => ReviewDraft) => void;
}) {
  const rulesRef = useRef<HTMLFieldSetElement>(null);
  const setRule = (index: number, field: "title" | "instructions", value: string) =>
    onChange((current) => ({
      ...current,
      rules: current.rules.map((rule, at) => (at === index ? { ...rule, [field]: value } : rule)),
    }));
  return (
    <div className="space-y-4">
      <p className="text-xs text-muted-foreground">
        Reviews thread transcripts against these rules without tools. Findings arrive in the inbox.
        With an event trigger on turn end it reviews each finished turn.
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <Row label="Review" htmlFor="review-kind">
          <Select
            value={draft.kind}
            onValueChange={(kind) => {
              if (kind === "standards" || kind === "context-review")
                onChange((current) => withKind(current, kind));
            }}
          >
            <SelectTrigger size="sm" id="review-kind">
              <SelectValue>{KIND_LABELS[draft.kind]}</SelectValue>
            </SelectTrigger>
            <SelectPopup>
              <SelectItem value="standards">{KIND_LABELS.standards}</SelectItem>
              <SelectItem value="context-review">{KIND_LABELS["context-review"]}</SelectItem>
            </SelectPopup>
          </Select>
        </Row>
        <Row label="Findings go to" htmlFor="review-delivery">
          <Select
            value={draft.delivery}
            onValueChange={(delivery) => {
              if (delivery === "thread-or-alert" || delivery === "alerts")
                onChange((current) => ({ ...current, delivery }));
            }}
          >
            <SelectTrigger size="sm" id="review-delivery">
              <SelectValue>{DELIVERY_LABELS[draft.delivery]}</SelectValue>
            </SelectTrigger>
            <SelectPopup>
              <SelectItem value="thread-or-alert">{DELIVERY_LABELS["thread-or-alert"]}</SelectItem>
              <SelectItem value="alerts">{DELIVERY_LABELS.alerts}</SelectItem>
            </SelectPopup>
          </Select>
        </Row>
      </div>

      <fieldset ref={rulesRef} className="min-w-0 space-y-3">
        <legend className="text-sm font-medium">Rules</legend>
        {draft.rules.map((rule, index) => (
          <div key={rule.id} className="space-y-2 rounded-md border border-border p-3">
            <div className="flex items-center gap-2">
              <Input
                aria-label={`Rule ${index + 1} title`}
                data-rule-id={rule.id}
                data-review-field={reviewFieldKey.ruleTitle(rule.id)}
                className="min-w-0 flex-1"
                placeholder="Rule title"
                value={rule.title}
                onChange={(event) => setRule(index, "title", event.target.value)}
              />
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`Remove rule ${index + 1}`}
                disabled={draft.rules.length === 1}
                onClick={() =>
                  onChange((current) => ({
                    ...current,
                    rules: current.rules.filter((_, at) => at !== index),
                  }))
                }
              >
                <Trash2Icon />
              </Button>
            </div>
            <Textarea
              aria-label={`Rule ${index + 1} instructions`}
              data-review-field={reviewFieldKey.ruleInstructions(rule.id)}
              className="max-h-48 overflow-y-auto"
              placeholder="What the reviewer checks, and what counts as evidence"
              value={rule.instructions}
              onChange={(event) => setRule(index, "instructions", event.target.value)}
            />
          </div>
        ))}
        <Button
          variant="outline"
          size="sm"
          disabled={draft.rules.length >= 32}
          onClick={() => {
            const id = randomUUID();
            // Render the new rule now, so its title can take focus from the button.
            flushSync(() =>
              onChange((current) => ({
                ...current,
                rules: [...current.rules, { id, title: "", instructions: "" }],
              })),
            );
            rulesRef.current?.querySelector<HTMLInputElement>(`[data-rule-id="${id}"]`)?.focus();
          }}
        >
          <PlusIcon />
          Add rule
        </Button>
      </fieldset>

      <Row label="Instruction files" htmlFor="review-instruction-files">
        <Textarea
          id="review-instruction-files"
          data-review-field={reviewFieldKey.instructionFiles}
          placeholder="~/standards.md"
          value={draft.instructionFiles}
          onChange={(event) =>
            onChange((current) => ({ ...current, instructionFiles: event.target.value }))
          }
        />
        <p className="text-xs text-muted-foreground">
          One absolute or ~/ path per line, on this environment's machine.
        </p>
      </Row>
      <label className="flex items-center gap-2 text-sm">
        <Checkbox
          checked={draft.includeProjectAgents}
          onCheckedChange={(checked) =>
            onChange((current) => ({ ...current, includeProjectAgents: checked === true }))
          }
        />
        Include the project's AGENTS.md
      </label>

      <div className="grid gap-3 sm:grid-cols-2">
        <Row label="Scheduled runs review" htmlFor="review-target-state">
          <Select
            value={draft.targets.state}
            onValueChange={(state) => {
              if (state === "active" || state === "closed" || state === "all")
                onChange((current) => ({ ...current, targets: { ...current.targets, state } }));
            }}
          >
            <SelectTrigger size="sm" id="review-target-state">
              <SelectValue>{STATE_LABELS[draft.targets.state]}</SelectValue>
            </SelectTrigger>
            <SelectPopup>
              <SelectItem value="active">{STATE_LABELS.active}</SelectItem>
              <SelectItem value="closed">{STATE_LABELS.closed}</SelectItem>
              <SelectItem value="all">{STATE_LABELS.all}</SelectItem>
            </SelectPopup>
          </Select>
        </Row>
        <Row label="Only these threads" htmlFor="review-thread-ids">
          <Input
            id="review-thread-ids"
            placeholder="All threads in the project"
            value={draft.threadIds}
            onChange={(event) =>
              onChange((current) => ({ ...current, threadIds: event.target.value }))
            }
          />
        </Row>
      </div>
      <label className="flex items-center gap-2 text-sm">
        <Checkbox
          checked={draft.targets.includeChildren}
          onCheckedChange={(checked) =>
            onChange((current) => ({
              ...current,
              targets: { ...current.targets, includeChildren: checked === true },
            }))
          }
        />
        Include their subagents and delegated threads
      </label>
    </div>
  );
}
