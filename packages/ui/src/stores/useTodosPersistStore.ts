import { create } from 'zustand';
import { devtools, persist } from 'zustand/middleware';
import type { Todo } from '@opencode-ai/sdk/v2/client';
import { resolveSessionScopeKey } from '@/sync/selection-store';
import { legacyScopeKeyForProjectKey } from '@/projects/identity';
import { normalizePath } from '@/lib/pathNormalization';
import { createDeferredSafeJSONStorage } from './utils/safeStorage';

const MAX_SESSIONS = 50;

interface SessionTodosRecord {
    todos: Todo[];
    touchedAt: number;
}

interface TodosPersistState {
    sessions: Record<string, SessionTodosRecord>;
    setSessionTodos: (directory: string, sessionId: string, todos: Todo[] | undefined) => void;
    getSessionTodos: (directory: string, sessionId: string) => Todo[] | undefined;
    clearSessionTodos: (scopeKey: string, directory: string, sessionId: string) => void;
}

export const getTodosPersistenceKey = (scopeKey: string, directory: string, sessionId: string): string =>
    JSON.stringify([scopeKey, normalizePath(directory), sessionId]);

const getCurrentSessionKey = (directory: string, sessionId: string): string | null => {
    if (!directory || !sessionId) return null;
    return getTodosPersistenceKey(resolveSessionScopeKey(sessionId, directory), directory, sessionId);
};

/** P-MIG: todos written before the workspace→project rename keyed their
 * records with the `workspace:` scope prefix; reads fall back to that legacy
 * key so pre-upgrade todos stay visible. Writes always use the current key. */
const readTodosWithLegacyFallback = (
    sessions: Record<string, SessionTodosRecord>,
    scopeKey: string,
    directory: string,
    sessionId: string,
): SessionTodosRecord | undefined => {
    const current = sessions[getTodosPersistenceKey(scopeKey, directory, sessionId)];
    if (current) return current;
    const legacyScopeKey = legacyScopeKeyForProjectKey(scopeKey);
    if (!legacyScopeKey) return undefined;
    return sessions[getTodosPersistenceKey(legacyScopeKey, directory, sessionId)];
};

const evictOldest = (sessions: Record<string, SessionTodosRecord>): Record<string, SessionTodosRecord> => {
    const ids = Object.keys(sessions);
    if (ids.length <= MAX_SESSIONS) return sessions;

    const sorted = ids
        .map((id) => [id, sessions[id].touchedAt] as const)
        .sort((a, b) => a[1] - b[1]);
    const drop = sorted.slice(0, ids.length - MAX_SESSIONS).map(([id]) => id);
    const next = { ...sessions };
    for (const id of drop) delete next[id];
    return next;
};

export const useTodosPersistStore = create<TodosPersistState>()(
    devtools(
        persist(
            (set, get) => ({
                sessions: {},
                setSessionTodos: (directory, sessionId, todos) => {
                    const key = getCurrentSessionKey(directory, sessionId);
                    if (!key) return;
                    set((state) => {
                        const next = { ...state.sessions };
                        if (!todos || todos.length === 0) {
                            const hadKey = key in next;
                            delete next[key];
                            if (!hadKey) return state;
                            return { sessions: next };
                        }
                        next[key] = { todos, touchedAt: Date.now() };
                        return { sessions: evictOldest(next) };
                    });
                },
                getSessionTodos: (directory, sessionId) => {
                    const key = getCurrentSessionKey(directory, sessionId);
                    if (!key) return undefined;
                    const [scopeKey] = JSON.parse(key) as [string, string, string];
                    return readTodosWithLegacyFallback(get().sessions, scopeKey, directory, sessionId)?.todos;
                },
                clearSessionTodos: (scopeKey, directory, sessionId) => {
                    if (typeof scopeKey !== 'string' || !directory || !sessionId) return;
                    const key = getTodosPersistenceKey(scopeKey, directory, sessionId);
                    set((state) => {
                        const sessions = { ...state.sessions };
                        let changed = false;
                        for (const candidate of [key]) {
                            if (candidate && candidate in sessions) {
                                delete sessions[candidate];
                                changed = true;
                            }
                        }
                        if (!changed) return state;
                        return { sessions };
                    });
                },
            }),
            {
                name: 'openchamber-session-todos',
                version: 2,
                storage: createDeferredSafeJSONStorage(),
                partialize: (state) => ({ sessions: state.sessions }),
                migrate: () => ({ sessions: {} }),
            },
        ),
        { name: 'TodosPersistStore' },
    ),
);
