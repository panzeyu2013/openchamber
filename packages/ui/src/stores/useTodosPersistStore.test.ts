import { beforeEach, describe, expect, test } from 'bun:test';
import type { Todo } from '@opencode-ai/sdk/v2/client';
import { getTodosPersistenceKey, useTodosPersistStore } from './useTodosPersistStore';

const todo = (content: string): Todo => ({ content, status: 'pending', priority: 'medium' });

describe('useTodosPersistStore', () => {
    beforeEach(() => {
        useTodosPersistStore.setState({ sessions: {} });
    });

    test('isolates identical session IDs by directory', () => {
        const store = useTodosPersistStore.getState();
        store.setSessionTodos('/repo-a', 'session-1', [todo('a')]);
        store.setSessionTodos('/repo-b', 'session-1', [todo('b')]);

        expect(useTodosPersistStore.getState().getSessionTodos('/repo-a', 'session-1')).toEqual([todo('a')]);
        expect(useTodosPersistStore.getState().getSessionTodos('/repo-b', 'session-1')).toEqual([todo('b')]);
    });

    test('stores entries under the resolved scope identity', () => {
        useTodosPersistStore.getState().setSessionTodos('/repo', 'session-1', [todo('active')]);

        const key = getTodosPersistenceKey('', '/repo', 'session-1');
        expect(useTodosPersistStore.getState().sessions[key]?.todos).toEqual([todo('active')]);
        expect(getTodosPersistenceKey('workspace:ws-a', '/repo', 'session-1'))
            .not.toBe(getTodosPersistenceKey('workspace:ws-b', '/repo', 'session-1'));
    });

    test('removes only the matching composite session', () => {
        const store = useTodosPersistStore.getState();
        store.setSessionTodos('/repo-a', 'session-1', [todo('a')]);
        store.setSessionTodos('/repo-b', 'session-1', [todo('b')]);
        store.setSessionTodos('/repo-a', 'session-1', []);

        expect(useTodosPersistStore.getState().getSessionTodos('/repo-a', 'session-1')).toBe(undefined);
        expect(useTodosPersistStore.getState().getSessionTodos('/repo-b', 'session-1')).toEqual([todo('b')]);
    });

    test('clears only the explicitly owned scope', () => {
        const store = useTodosPersistStore.getState();
        store.setSessionTodos('/repo', 'session-1', [todo('active')]);
        store.clearSessionTodos('workspace:other', '/repo', 'session-1');
        expect(useTodosPersistStore.getState().getSessionTodos('/repo', 'session-1')).toEqual([todo('active')]);

        store.clearSessionTodos('', '/repo/', 'session-1');
        expect(useTodosPersistStore.getState().getSessionTodos('/repo', 'session-1')).toBe(undefined);
    });
});
