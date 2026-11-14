import {
  composerDraftHasUserContent,
  DraftId,
  type ComposerThreadDraftState,
  type DraftSessionState,
} from "../../composerDraftStore";

export interface SidebarDraftRowData {
  readonly draftId: DraftId;
  readonly session: DraftSessionState;
  readonly composer: ComposerThreadDraftState | null;
}

/** The open draft's row as captured when it became the route; it does not repaint while typing. */
export interface FrozenRouteDraftRow {
  readonly routeDraftId: string | null;
  readonly row: SidebarDraftRowData | null;
}

export function captureRouteDraftRow(
  routeDraftId: string | null,
  sessions: Readonly<Record<string, DraftSessionState>>,
  composers: Readonly<Record<string, ComposerThreadDraftState | undefined>>,
): FrozenRouteDraftRow {
  const session = routeDraftId === null ? undefined : sessions[routeDraftId];
  if (routeDraftId === null || !session || session.promotedTo != null) {
    return { routeDraftId, row: null };
  }
  return {
    routeDraftId,
    row: {
      draftId: DraftId.make(routeDraftId),
      session,
      composer: composers[routeDraftId] ?? null,
    },
  };
}

export function needsRouteDraftCapture(
  frozen: FrozenRouteDraftRow,
  routeDraftId: string | null,
  sessions: Readonly<Record<string, DraftSessionState>>,
): boolean {
  if (frozen.routeDraftId !== routeDraftId) return true;
  const session = routeDraftId === null ? undefined : sessions[routeDraftId];
  if (session === undefined || session.promotedTo != null) return false;
  // The session lands after the route, or moves to another project; typing leaves it alone.
  return frozen.row === null || frozen.row.session !== session;
}

/**
 * The open draft is listed from the moment it opens, even empty. Any other draft is listed only once
 * it holds something the user typed or attached, so leaving an untouched draft drops its row.
 */
export function selectSidebarDraftRows(input: {
  readonly sessions: Readonly<Record<string, DraftSessionState>>;
  readonly composers: Readonly<Record<string, ComposerThreadDraftState | undefined>>;
  readonly routeDraftId: string | null;
  readonly frozen: FrozenRouteDraftRow;
  readonly scopedProjectKeys: ReadonlySet<string> | null;
}): SidebarDraftRowData[] {
  const rows: SidebarDraftRowData[] = [];
  for (const [draftKey, session] of Object.entries(input.sessions)) {
    if (session.promotedTo != null) continue;
    if (
      input.scopedProjectKeys !== null &&
      !input.scopedProjectKeys.has(`${session.environmentId}:${session.projectId}`)
    ) {
      continue;
    }
    if (draftKey === input.routeDraftId) {
      if (input.frozen.routeDraftId === draftKey && input.frozen.row !== null) {
        rows.push(input.frozen.row);
      }
      continue;
    }
    const composer = input.composers[draftKey];
    if (!composer || !composerDraftHasUserContent(composer)) continue;
    rows.push({ draftId: DraftId.make(draftKey), session, composer });
  }
  rows.sort((left, right) => right.session.createdAt.localeCompare(left.session.createdAt));
  return rows;
}
