import { create } from 'zustand';
import { devtools, persist } from 'zustand/middleware';
import type { Todo } from '@opencode-ai/sdk/v2/client';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { resolveSessionScopeKey } from '@/sync/selection-store';
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

/** Legacy key form: the ambient runtime key in the first tuple slot. */
const getLegacyTodosPersistenceKey = (directory: string, sessionId: string): string =>
    getTodosPersistenceKey(getRuntimeKey(), directory, sessionId);

const getCurrentSessionKey = (directory: string, sessionId: string): string | null => {
    if (!directory || !sessionId) return null;
    return getTodosPersistenceKey(resolveSessionScopeKey(sessionId, directory), directory, sessionId);
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
                        const legacyKey = getLegacyTodosPersistenceKey(directory, sessionId);
                        if (!todos || todos.length === 0) {
                            const hadKey = key in next;
                            delete next[key];
                            // A scoped write supersedes the legacy
                            // runtime-keyed entry for the same session.
                            if (legacyKey !== key) delete next[legacyKey];
                            if (!hadKey && legacyKey === key) return state;
                            return { sessions: next };
                        }
                        next[key] = { todos, touchedAt: Date.now() };
                        if (legacyKey !== key) delete next[legacyKey];
                        return { sessions: evictOldest(next) };
                    });
                },
                getSessionTodos: (directory, sessionId) => {
                    const key = getCurrentSessionKey(directory, sessionId);
                    if (!key) return undefined;
                    return get().sessions[key]?.todos
                        ?? get().sessions[getLegacyTodosPersistenceKey(directory, sessionId)]?.todos;
                },
                clearSessionTodos: (scopeKey, directory, sessionId) => {
                    if (!scopeKey || !directory || !sessionId) return;
                    const key = getTodosPersistenceKey(scopeKey, directory, sessionId);
                    // When the identity carries the current runtime key (the
                    // legacy deletion path), also clear the workspace-scoped
                    // twin so runtime-captured cleanup still reaches
                    // workspace-scoped todos. A non-current or workspace
                    // scope must never clear another owner's entry.
                    const resolvedKey = scopeKey === getRuntimeKey()
                        ? getCurrentSessionKey(directory, sessionId)
                        : null;
                    set((state) => {
                        const sessions = { ...state.sessions };
                        let changed = false;
                        for (const candidate of [key, resolvedKey]) {
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
