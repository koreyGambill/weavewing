import { parseScopedThreadKey, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { type ScopedThreadRef } from "@t3tools/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { resolveStorage } from "./lib/storage";
import { DEFAULT_THREAD_TERMINAL_HEIGHT, DEFAULT_THREAD_TERMINAL_ID } from "./types";

interface ThreadTerminalUiState {
  terminalOpen: boolean;
  terminalHeight: number;
  terminalIds: string[];
  activeTerminalId: string;
}

const TERMINAL_UI_STATE_STORAGE_KEY = "t3code:terminal-state:v1";

interface PersistedTerminalUiStateStoreState {
  terminalUiStateByThreadKey?: Record<string, ThreadTerminalUiState>;
  terminalStateByThreadKey?: Record<string, ThreadTerminalUiState>;
}

export function migratePersistedTerminalUiStateStoreState(
  persistedState: unknown,
  _version: number,
): PersistedTerminalUiStateStoreState {
  if (!persistedState || typeof persistedState !== "object") {
    return { terminalUiStateByThreadKey: {} };
  }

  const candidate = persistedState as PersistedTerminalUiStateStoreState;
  const persistedUiStateByThreadKey =
    candidate.terminalUiStateByThreadKey ?? candidate.terminalStateByThreadKey ?? {};
  const terminalUiStateByThreadKey = Object.fromEntries(
    Object.entries(persistedUiStateByThreadKey)
      .filter(([threadKey]) => parseScopedThreadKey(threadKey))
      .map(([threadKey, state]) => [
        threadKey,
        normalizeThreadTerminalUiState({
          terminalOpen: state.terminalOpen,
          terminalHeight: state.terminalHeight,
          terminalIds: state.terminalIds,
          activeTerminalId: state.activeTerminalId,
        }),
      ]),
  );

  return { terminalUiStateByThreadKey };
}

function createTerminalUiStateStorage() {
  return resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined);
}

function normalizeTerminalIds(terminalIds: string[]): string[] {
  const normalizedIds: string[] = [];
  const seen = new Set<string>();
  for (const id of terminalIds) {
    const trimmedId = id.trim();
    if (trimmedId.length === 0 || seen.has(trimmedId)) continue;
    seen.add(trimmedId);
    normalizedIds.push(trimmedId);
  }
  return normalizedIds;
}

function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return false;
  }
  return true;
}

function threadTerminalUiStateEqual(
  left: ThreadTerminalUiState,
  right: ThreadTerminalUiState,
): boolean {
  return (
    left.terminalOpen === right.terminalOpen &&
    left.terminalHeight === right.terminalHeight &&
    left.activeTerminalId === right.activeTerminalId &&
    arraysEqual(left.terminalIds, right.terminalIds)
  );
}

const DEFAULT_THREAD_TERMINAL_UI_STATE: ThreadTerminalUiState = Object.freeze({
  terminalOpen: false,
  terminalHeight: DEFAULT_THREAD_TERMINAL_HEIGHT,
  terminalIds: [],
  activeTerminalId: "",
});

function createDefaultThreadTerminalUiState(): ThreadTerminalUiState {
  return {
    ...DEFAULT_THREAD_TERMINAL_UI_STATE,
    terminalIds: [...DEFAULT_THREAD_TERMINAL_UI_STATE.terminalIds],
  };
}

function getDefaultThreadTerminalUiState(): ThreadTerminalUiState {
  return DEFAULT_THREAD_TERMINAL_UI_STATE;
}

function normalizeThreadTerminalUiState(state: ThreadTerminalUiState): ThreadTerminalUiState {
  const nextTerminalIds = normalizeTerminalIds(state.terminalIds);
  const activeTerminalId = nextTerminalIds.includes(state.activeTerminalId)
    ? state.activeTerminalId
    : (nextTerminalIds[0] ?? "");
  const normalized: ThreadTerminalUiState = {
    terminalOpen: state.terminalOpen,
    terminalHeight:
      Number.isFinite(state.terminalHeight) && state.terminalHeight > 0
        ? state.terminalHeight
        : DEFAULT_THREAD_TERMINAL_HEIGHT,
    terminalIds: nextTerminalIds,
    activeTerminalId,
  };
  return threadTerminalUiStateEqual(state, normalized) ? state : normalized;
}

function isDefaultThreadTerminalUiState(state: ThreadTerminalUiState): boolean {
  const normalized = normalizeThreadTerminalUiState(state);
  return threadTerminalUiStateEqual(normalized, DEFAULT_THREAD_TERMINAL_UI_STATE);
}

function isValidTerminalId(terminalId: string): boolean {
  return terminalId.trim().length > 0;
}

function terminalThreadKey(threadRef: ScopedThreadRef): string {
  return scopedThreadKey(threadRef);
}

function upsertTerminal(state: ThreadTerminalUiState, terminalId: string): ThreadTerminalUiState {
  const normalized = normalizeThreadTerminalUiState(state);
  if (!isValidTerminalId(terminalId)) return normalized;
  return {
    ...normalized,
    terminalOpen: true,
    terminalIds: normalized.terminalIds.includes(terminalId)
      ? normalized.terminalIds
      : [...normalized.terminalIds, terminalId],
    activeTerminalId: terminalId,
  };
}

function setThreadTerminalOpen(state: ThreadTerminalUiState, open: boolean): ThreadTerminalUiState {
  const normalized = normalizeThreadTerminalUiState(state);
  if (open && normalized.terminalIds.length === 0) {
    return upsertTerminal(normalized, DEFAULT_THREAD_TERMINAL_ID);
  }
  if (normalized.terminalOpen === open) return normalized;
  return { ...normalized, terminalOpen: open };
}

function setThreadTerminalHeight(
  state: ThreadTerminalUiState,
  height: number,
): ThreadTerminalUiState {
  const normalized = normalizeThreadTerminalUiState(state);
  if (!Number.isFinite(height) || height <= 0 || normalized.terminalHeight === height) {
    return normalized;
  }
  return { ...normalized, terminalHeight: height };
}

function newThreadTerminal(
  state: ThreadTerminalUiState,
  terminalId: string,
): ThreadTerminalUiState {
  return upsertTerminal(state, terminalId);
}

function setThreadActiveTerminal(
  state: ThreadTerminalUiState,
  terminalId: string,
): ThreadTerminalUiState {
  const normalized = normalizeThreadTerminalUiState(state);
  if (!normalized.terminalIds.includes(terminalId)) {
    return normalized;
  }
  return normalized.activeTerminalId === terminalId
    ? normalized
    : { ...normalized, activeTerminalId: terminalId };
}

function closeThreadTerminal(
  state: ThreadTerminalUiState,
  terminalId: string,
): ThreadTerminalUiState {
  const normalized = normalizeThreadTerminalUiState(state);
  if (!normalized.terminalIds.includes(terminalId)) {
    return normalized;
  }

  const remainingTerminalIds = normalized.terminalIds.filter((id) => id !== terminalId);
  if (remainingTerminalIds.length === 0) {
    return createDefaultThreadTerminalUiState();
  }

  const closedTerminalIndex = normalized.terminalIds.indexOf(terminalId);
  return {
    ...normalized,
    terminalIds: remainingTerminalIds,
    activeTerminalId:
      normalized.activeTerminalId === terminalId
        ? (remainingTerminalIds[Math.min(closedTerminalIndex, remainingTerminalIds.length - 1)] ??
          "")
        : normalized.activeTerminalId,
  };
}

function reconcileThreadTerminalSessionIds(
  state: ThreadTerminalUiState,
  nextIds: string[],
): ThreadTerminalUiState {
  const normalized = normalizeThreadTerminalUiState(state);
  if (arraysEqual(normalized.terminalIds, nextIds)) {
    return normalized;
  }

  const nextActiveTerminalId = nextIds.includes(normalized.activeTerminalId)
    ? normalized.activeTerminalId
    : (nextIds[0] ?? "");

  return {
    ...normalized,
    terminalIds: nextIds,
    activeTerminalId: nextActiveTerminalId,
  };
}

export function selectThreadTerminalUiState(
  terminalUiStateByThreadKey: Record<string, ThreadTerminalUiState>,
  threadRef: ScopedThreadRef | null | undefined,
): ThreadTerminalUiState {
  if (!threadRef || threadRef.threadId.length === 0) {
    return getDefaultThreadTerminalUiState();
  }
  return (
    terminalUiStateByThreadKey[terminalThreadKey(threadRef)] ?? getDefaultThreadTerminalUiState()
  );
}

function updateTerminalUiStateByThreadKey(
  terminalUiStateByThreadKey: Record<string, ThreadTerminalUiState>,
  threadRef: ScopedThreadRef,
  updater: (state: ThreadTerminalUiState) => ThreadTerminalUiState,
): Record<string, ThreadTerminalUiState> {
  if (threadRef.threadId.length === 0) {
    return terminalUiStateByThreadKey;
  }

  const threadKey = terminalThreadKey(threadRef);
  const current = selectThreadTerminalUiState(terminalUiStateByThreadKey, threadRef);
  const next = updater(current);
  if (next === current) {
    return terminalUiStateByThreadKey;
  }

  if (isDefaultThreadTerminalUiState(next)) {
    if (terminalUiStateByThreadKey[threadKey] === undefined) {
      return terminalUiStateByThreadKey;
    }
    const { [threadKey]: _removed, ...rest } = terminalUiStateByThreadKey;
    return rest;
  }

  return {
    ...terminalUiStateByThreadKey,
    [threadKey]: next,
  };
}

function updateSuppressedTerminalId(
  suppressedTerminalIdsByThreadKey: Record<string, string[]>,
  threadRef: ScopedThreadRef,
  terminalId: string,
  suppressed: boolean,
): Record<string, string[]> {
  const normalizedTerminalId = terminalId.trim();
  if (normalizedTerminalId.length === 0) {
    return suppressedTerminalIdsByThreadKey;
  }
  const threadKey = terminalThreadKey(threadRef);
  const currentIds = suppressedTerminalIdsByThreadKey[threadKey] ?? [];
  const currentlySuppressed = currentIds.includes(normalizedTerminalId);
  if (currentlySuppressed === suppressed) {
    return suppressedTerminalIdsByThreadKey;
  }
  if (suppressed) {
    return {
      ...suppressedTerminalIdsByThreadKey,
      [threadKey]: [...currentIds, normalizedTerminalId],
    };
  }

  const remainingIds = currentIds.filter((id) => id !== normalizedTerminalId);
  if (remainingIds.length > 0) {
    return {
      ...suppressedTerminalIdsByThreadKey,
      [threadKey]: remainingIds,
    };
  }
  return removeRecordEntry(suppressedTerminalIdsByThreadKey, threadKey);
}

function removeRecordEntry<T>(record: Record<string, T>, key: string): Record<string, T> {
  if (record[key] === undefined) {
    return record;
  }
  const { [key]: _removed, ...remaining } = record;
  return remaining;
}

interface TerminalUiStateStoreState {
  terminalUiStateByThreadKey: Record<string, ThreadTerminalUiState>;
  suppressedTerminalIdsByThreadKey: Record<string, string[]>;
  setTerminalOpen: (threadRef: ScopedThreadRef, open: boolean) => void;
  setTerminalHeight: (threadRef: ScopedThreadRef, height: number) => void;
  newTerminal: (threadRef: ScopedThreadRef, terminalId: string) => void;
  ensureTerminal: (
    threadRef: ScopedThreadRef,
    terminalId: string,
    options?: { open?: boolean; active?: boolean },
  ) => void;
  setActiveTerminal: (threadRef: ScopedThreadRef, terminalId: string) => void;
  closeTerminal: (threadRef: ScopedThreadRef, terminalId: string) => void;
  reconcileTerminalIds: (threadRef: ScopedThreadRef, nextIds: string[]) => void;
  clearTerminalUiState: (threadRef: ScopedThreadRef) => void;
  removeTerminalUiState: (threadRef: ScopedThreadRef) => void;
  removeOrphanedTerminalUiStates: (activeThreadKeys: Set<string>) => void;
}

export const useTerminalUiStateStore = create<TerminalUiStateStoreState>()(
  persist(
    (set, get) => {
      const updateTerminal = (
        threadRef: ScopedThreadRef,
        updater: (
          state: ThreadTerminalUiState,
          suppressedTerminalIds: readonly string[],
        ) => ThreadTerminalUiState,
        suppression?: { terminalId: string; suppressed: boolean },
      ) => {
        set((state) => {
          const threadKey = terminalThreadKey(threadRef);
          const suppressedTerminalIds = state.suppressedTerminalIdsByThreadKey[threadKey] ?? [];
          const nextTerminalUiStateByThreadKey = updateTerminalUiStateByThreadKey(
            state.terminalUiStateByThreadKey,
            threadRef,
            (terminalState) => updater(terminalState, suppressedTerminalIds),
          );
          const nextSuppressedTerminalIdsByThreadKey = suppression
            ? updateSuppressedTerminalId(
                state.suppressedTerminalIdsByThreadKey,
                threadRef,
                suppression.terminalId,
                suppression.suppressed,
              )
            : state.suppressedTerminalIdsByThreadKey;
          if (
            nextTerminalUiStateByThreadKey === state.terminalUiStateByThreadKey &&
            nextSuppressedTerminalIdsByThreadKey === state.suppressedTerminalIdsByThreadKey
          ) {
            return state;
          }
          return {
            terminalUiStateByThreadKey: nextTerminalUiStateByThreadKey,
            suppressedTerminalIdsByThreadKey: nextSuppressedTerminalIdsByThreadKey,
          };
        });
      };

      return {
        terminalUiStateByThreadKey: {},
        suppressedTerminalIdsByThreadKey: {},
        setTerminalOpen: (threadRef, open) => {
          const terminalState = selectThreadTerminalUiState(
            get().terminalUiStateByThreadKey,
            threadRef,
          );
          updateTerminal(
            threadRef,
            (state) => setThreadTerminalOpen(state, open),
            open && terminalState.terminalIds.length === 0
              ? { terminalId: DEFAULT_THREAD_TERMINAL_ID, suppressed: false }
              : undefined,
          );
        },
        setTerminalHeight: (threadRef, height) =>
          updateTerminal(threadRef, (state) => setThreadTerminalHeight(state, height)),
        newTerminal: (threadRef, terminalId) =>
          updateTerminal(threadRef, (state) => newThreadTerminal(state, terminalId), {
            terminalId,
            suppressed: false,
          }),
        ensureTerminal: (threadRef, terminalId, options) =>
          updateTerminal(
            threadRef,
            (state) => {
              let nextState = state;
              if (!state.terminalIds.includes(terminalId)) {
                nextState = newThreadTerminal(nextState, terminalId);
              }
              if (options?.active === false) {
                nextState = {
                  ...nextState,
                  activeTerminalId: state.activeTerminalId,
                };
              }
              if (options?.active ?? true) {
                nextState = setThreadActiveTerminal(nextState, terminalId);
              }
              if (options?.open) {
                nextState = setThreadTerminalOpen(nextState, true);
              }
              return normalizeThreadTerminalUiState(nextState);
            },
            { terminalId, suppressed: false },
          ),
        setActiveTerminal: (threadRef, terminalId) =>
          updateTerminal(threadRef, (state) => setThreadActiveTerminal(state, terminalId)),
        closeTerminal: (threadRef, terminalId) =>
          updateTerminal(threadRef, (state) => closeThreadTerminal(state, terminalId), {
            terminalId,
            suppressed: true,
          }),
        reconcileTerminalIds: (threadRef, nextIds) =>
          updateTerminal(threadRef, (state, suppressedTerminalIds) => {
            if (suppressedTerminalIds.length === 0) {
              return reconcileThreadTerminalSessionIds(state, nextIds);
            }
            const suppressedIds = new Set(suppressedTerminalIds);
            return reconcileThreadTerminalSessionIds(
              state,
              nextIds.filter((terminalId) => !suppressedIds.has(terminalId)),
            );
          }),
        clearTerminalUiState: (threadRef) =>
          set((state) => {
            const threadKey = terminalThreadKey(threadRef);
            const nextTerminalUiStateByThreadKey = updateTerminalUiStateByThreadKey(
              state.terminalUiStateByThreadKey,
              threadRef,
              () => createDefaultThreadTerminalUiState(),
            );
            const hadSuppressedTerminalIds =
              state.suppressedTerminalIdsByThreadKey[threadKey] !== undefined;
            if (
              nextTerminalUiStateByThreadKey === state.terminalUiStateByThreadKey &&
              !hadSuppressedTerminalIds
            ) {
              return state;
            }
            return {
              terminalUiStateByThreadKey: nextTerminalUiStateByThreadKey,
              suppressedTerminalIdsByThreadKey: removeRecordEntry(
                state.suppressedTerminalIdsByThreadKey,
                threadKey,
              ),
            };
          }),
        removeTerminalUiState: (threadRef) =>
          set((state) => {
            const threadKey = terminalThreadKey(threadRef);
            const hadTerminalUiState = state.terminalUiStateByThreadKey[threadKey] !== undefined;
            const hadSuppressedTerminalIds =
              state.suppressedTerminalIdsByThreadKey[threadKey] !== undefined;
            if (!hadTerminalUiState && !hadSuppressedTerminalIds) {
              return state;
            }
            return {
              terminalUiStateByThreadKey: removeRecordEntry(
                state.terminalUiStateByThreadKey,
                threadKey,
              ),
              suppressedTerminalIdsByThreadKey: removeRecordEntry(
                state.suppressedTerminalIdsByThreadKey,
                threadKey,
              ),
            };
          }),
        removeOrphanedTerminalUiStates: (activeThreadKeys) =>
          set((state) => {
            const orphanedIds = new Set(
              [
                ...Object.keys(state.terminalUiStateByThreadKey),
                ...Object.keys(state.suppressedTerminalIdsByThreadKey),
              ].filter((key) => !activeThreadKeys.has(key)),
            );
            if (orphanedIds.size === 0) {
              return state;
            }
            const nextTerminalUiStateByThreadKey = { ...state.terminalUiStateByThreadKey };
            const nextSuppressedTerminalIdsByThreadKey = {
              ...state.suppressedTerminalIdsByThreadKey,
            };
            for (const id of orphanedIds) {
              delete nextTerminalUiStateByThreadKey[id];
              delete nextSuppressedTerminalIdsByThreadKey[id];
            }
            return {
              terminalUiStateByThreadKey: nextTerminalUiStateByThreadKey,
              suppressedTerminalIdsByThreadKey: nextSuppressedTerminalIdsByThreadKey,
            };
          }),
      };
    },
    {
      name: TERMINAL_UI_STATE_STORAGE_KEY,
      version: 5,
      storage: createJSONStorage(createTerminalUiStateStorage),
      migrate: migratePersistedTerminalUiStateStoreState,
      partialize: (state) => ({
        terminalUiStateByThreadKey: state.terminalUiStateByThreadKey,
      }),
    },
  ),
);
