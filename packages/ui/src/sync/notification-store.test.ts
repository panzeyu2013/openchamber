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

describe('project-scoped notifications', () => {
  test('separates identical upstream session ids by project', () => {
    appendNotification({
      type: 'turn-complete',
      projectId: 'project-a',
      session: 'session-1',
      directory: '/repo',
      time: Date.now(),
      viewed: false,
    });
    appendNotification({
      type: 'error',
      projectId: 'project-b',
      session: 'session-1',
      directory: '/repo',
      time: Date.now(),
      viewed: false,
    });

    const state = useNotificationStore.getState();
    expect(getNotificationSessionKey('session-1', 'project-a')).not.toBe(
      getNotificationSessionKey('session-1', 'project-b'),
    );
    expect(state.index.session.unseenCount[getNotificationSessionKey('session-1', 'project-a')]).toBe(1);
    expect(state.index.session.unseenCount[getNotificationSessionKey('session-1', 'project-b')]).toBe(1);
    expect(state.index.session.unseenHasError[getNotificationSessionKey('session-1', 'project-a')]).toBe(undefined);
    expect(state.index.session.unseenHasError[getNotificationSessionKey('session-1', 'project-b')]).toBe(true);
  });

  test('viewing one project does not clear another project notification', () => {
    appendNotification({
      type: 'turn-complete',
      projectId: 'project-a',
      session: 'session-1',
      time: Date.now(),
      viewed: false,
    });
    appendNotification({
      type: 'turn-complete',
      projectId: 'project-b',
      session: 'session-1',
      time: Date.now(),
      viewed: false,
    });

    markSessionViewed('session-1', 'project-a');

    const state = useNotificationStore.getState();
    expect(state.index.session.unseenCount[getNotificationSessionKey('session-1', 'project-a')]).toBe(undefined);
    expect(state.index.session.unseenCount[getNotificationSessionKey('session-1', 'project-b')]).toBe(1);
  });
});
