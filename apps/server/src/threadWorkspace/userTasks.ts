import type { ListItem, MessageId, ThreadListUpdateInput } from "@t3tools/contracts";
import { NEEDS_USER_MESSAGE } from "../orchestration-v2/currentUserMessage.ts";

/** Who changes the list: the user from a client, or an agent with its turn's user message, if any. */
export type ListActor =
  | { readonly by: "user" }
  | { readonly by: "agent"; readonly userMessageId: MessageId | null };

export const TASK_DONE_NEEDS_USER =
  "Only the user marks their task done; record it from their message with settledFromUser.";
export const TASK_DROP_NEEDS_NOTE = "Dropping the user's task needs a note saying why.";
export const TASK_LEAVES_ONLY_CLOSED =
  "An open user task leaves the user's list only when closed: done with settledFromUser from their message, or dropped with a note.";
export const TASK_NOT_HANDED_OFF =
  "A user task is open, done or dropped; handed_off is for linked work.";
export const SETTLED_FROM_USER_CLOSES =
  "settledFromUser closes or reopens a user task: set state done, dropped or open on an owner you item.";
export const USER_OUTCOME_NEEDS_USER =
  "The user recorded this task's outcome; change it only from their message in this turn, with settledFromUser.";

/**
 * Whether the user recorded the task's current outcome themselves: closed it, with any note, or
 * reopened it. Only the user, or an agent relaying the user's message, may change that.
 */
const userOutcome = (item: ListItem | undefined) =>
  item !== undefined &&
  item.owner === "you" &&
  (item.settledBy === "user" || (item.state === "open" && item.userChangedAt !== undefined));

type Change = ThreadListUpdateInput["changes"][number];
type TaskFields = Pick<
  ListItem,
  "settledBy" | "settledFromMessageId" | "discussedInMessageId" | "note" | "userChangedAt"
>;

const closed = (state: ListItem["state"]) => state === "done" || state === "dropped";
const withoutTaskFields = ({
  settledBy: _settledBy,
  settledFromMessageId: _settledFromMessageId,
  discussedInMessageId: _discussedInMessageId,
  note: _note,
  userChangedAt: _userChangedAt,
  ...item
}: ListItem): ListItem => item;
const taskFields = (item: ListItem): TaskFields => {
  const { settledBy, settledFromMessageId, discussedInMessageId, note, userChangedAt } = item;
  return {
    ...(settledBy === undefined ? {} : { settledBy }),
    ...(settledFromMessageId === undefined ? {} : { settledFromMessageId }),
    ...(discussedInMessageId === undefined ? {} : { discussedInMessageId }),
    ...(note === undefined ? {} : { note }),
    ...(userChangedAt === undefined ? {} : { userChangedAt }),
  };
};

/**
 * Applies the user-task rules to one changed item: `next` is the item as the change leaves it,
 * before any task field. Returns the item with its task fields, or the refusal for an agent.
 */
export function changeUserTask(
  old: ListItem | undefined,
  next: ListItem,
  change: Change,
  actor: ListActor,
  now: string,
): ListItem | string {
  const base = withoutTaskFields(next);
  const isTask = next.owner === "you";
  // Handing an item to the user files a task, so a closed one counts as closing it.
  const stateChanged =
    old === undefined || old.owner !== "you" ? next.state !== "open" : old.state !== next.state;
  const note = change.note?.trim() || undefined;
  if (actor.by === "user") {
    if (!isTask) return base;
    if (!stateChanged) {
      // Any change of the user's own ends a chat about it; a dismissed task takes a later reason.
      const {
        discussedInMessageId: _,
        note: keptNote,
        ...kept
      } = old === undefined ? {} : taskFields(old);
      const reason = change.note === undefined || next.state !== "dropped" ? keptNote : note;
      return { ...base, ...kept, ...(reason === undefined ? {} : { note: reason }) };
    }
    return closed(next.state)
      ? { ...base, settledBy: "user", userChangedAt: now, ...(note ? { note } : {}) }
      : { ...base, userChangedAt: now };
  }
  const relayed = change.settledFromUser === true;
  if (relayed) {
    const reopening = old !== undefined && closed(old.state) && next.state === "open";
    if (!isTask || !(closed(next.state) || reopening)) return SETTLED_FROM_USER_CLOSES;
    if (actor.userMessageId === null) return NEEDS_USER_MESSAGE;
  }
  if (userOutcome(old) && (stateChanged || !isTask) && !relayed) return USER_OUTCOME_NEEDS_USER;
  if (old?.owner === "you" && old.state === "open" && !isTask) return TASK_LEAVES_ONLY_CLOSED;
  if (!isTask) return base;
  if (!stateChanged) {
    const kept = old === undefined ? {} : taskFields(old);
    // A relay that keeps the outcome, such as a clarified note, keeps the message it came from;
    // it may replace the note the agent recorded, never one the user left.
    return relayed && note !== undefined && old?.settledBy === "agent"
      ? { ...base, ...kept, note }
      : { ...base, ...kept };
  }
  if (next.state === "handed_off") return TASK_NOT_HANDED_OFF;
  if (next.state === "done" && change.settledFromUser !== true) return TASK_DONE_NEEDS_USER;
  if (next.state === "dropped" && note === undefined) return TASK_DROP_NEEDS_NOTE;
  if (!closed(next.state)) return base;
  return {
    ...base,
    settledBy: "agent",
    ...(change.settledFromUser === true && actor.userMessageId !== null
      ? { settledFromMessageId: actor.userMessageId }
      : {}),
    ...(note ? { note } : {}),
  };
}

/** The open user tasks an agent's rewrite would remove without closing them. */
export const removedOpenTasks = (
  before: ReadonlyArray<ListItem>,
  keptIds: ReadonlySet<string>,
): ReadonlyArray<ListItem> =>
  before.filter((item) => item.owner === "you" && item.state === "open" && !keptIds.has(item.id));

const TASK_REF = /^T\d+$/;

/**
 * The list item a change's `id` names: a task ref such as T2 names that task, any other id the
 * item with that id. Returns the id to write, `undefined` for a new item, or the refusal: a ref
 * that names no task, or names one task while another item carries it as a literal id, and a new
 * item whose id would read as a task ref.
 */
export function resolveListItemId(
  items: ReadonlyArray<ListItem>,
  id: string | undefined,
): { readonly id: string | undefined } | string {
  if (id === undefined) return { id };
  if (!TASK_REF.test(id)) return { id };
  const task = items.find((item) => item.ref === id);
  const literal = items.find((item) => item.id === id);
  if (task !== undefined && literal !== undefined && task !== literal)
    return `${id} names a task and another item's id; use the task's id ${task.id}.`;
  const named = task ?? literal;
  return named === undefined
    ? `${id} is not a task in this list; omit id to create an item, and never give one an id like a task ref.`
    : { id: named.id };
}
