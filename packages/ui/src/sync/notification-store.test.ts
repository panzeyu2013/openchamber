import { afterEach, describe, expect, test } from 'bun:test';
import {
  appendNotification,
  getNotificationSessionKey,
  markSessionViewed,
  useNotificationStore,
} from './notification-store';

const emptyIndex = () => ({
  session: { unseenCount: {}, unseenHasError: {} },
  project: { unseenCount: {}, unseenHasError: {} },
});

afterEach(() => {
  useNotificationStore.setState({ list: [], index: emptyIndex() });
});

describe('workspace-scoped notifications', () => {
  test('separates identical upstream session ids by workspace', () => {
    appendNotification({
      type: 'turn-complete',
      workspaceId: 'workspace-a',
      session: 'session-1',
      directory: '/repo',
      time: Date.now(),
      viewed: false,
    });
    appendNotification({
      type: 'error',
      workspaceId: 'workspace-b',
      session: 'session-1',
      directory: '/repo',
      time: Date.now(),
      viewed: false,
    });

    const state = useNotificationStore.getState();
    expect(getNotificationSessionKey('session-1', 'workspace-a')).not.toBe(
      getNotificationSessionKey('session-1', 'workspace-b'),
    );
    expect(state.index.session.unseenCount[getNotificationSessionKey('session-1', 'workspace-a')]).toBe(1);
    expect(state.index.session.unseenCount[getNotificationSessionKey('session-1', 'workspace-b')]).toBe(1);
    expect(state.index.session.unseenHasError[getNotificationSessionKey('session-1', 'workspace-a')]).toBe(undefined);
    expect(state.index.session.unseenHasError[getNotificationSessionKey('session-1', 'workspace-b')]).toBe(true);
  });

  test('viewing one workspace does not clear another workspace notification', () => {
    appendNotification({
      type: 'turn-complete',
      workspaceId: 'workspace-a',
      session: 'session-1',
      time: Date.now(),
      viewed: false,
    });
    appendNotification({
      type: 'turn-complete',
      workspaceId: 'workspace-b',
      session: 'session-1',
      time: Date.now(),
      viewed: false,
    });

    markSessionViewed('session-1', 'workspace-a');

    const state = useNotificationStore.getState();
    expect(state.index.session.unseenCount[getNotificationSessionKey('session-1', 'workspace-a')]).toBe(undefined);
    expect(state.index.session.unseenCount[getNotificationSessionKey('session-1', 'workspace-b')]).toBe(1);
  });
});
