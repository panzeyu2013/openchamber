import { describe, expect, test } from 'bun:test';
import { parseFleetLiveEvent } from './fleet-summary-transport';

describe('Fleet live-event projection', () => {
  test('projects status without retaining an event payload', () => {
    expect(parseFleetLiveEvent({
      payload: { type: 'session.status', properties: { sessionID: 'ses_1', status: { type: 'busy' } } },
    })).toEqual({ sessionId: 'ses_1', activity: 'busy' });
  });

  test('projects request lifecycle into boolean indicators', () => {
    expect(parseFleetLiveEvent({ type: 'permission.asked', properties: { sessionID: 'ses_1', id: 'per_1' } }))
      .toEqual({ sessionId: 'ses_1', hasPendingPermission: true });
    expect(parseFleetLiveEvent({ type: 'question.rejected', properties: { sessionID: 'ses_1', requestID: 'que_1' } }))
      .toEqual({ sessionId: 'ses_1', hasPendingQuestion: false });
  });

  test('projects structural session lifecycle without retaining session content', () => {
    expect(parseFleetLiveEvent({ type: 'session.updated', properties: { info: { id: 'ses_1', title: 'not retained' } } }))
      .toEqual({ sessionId: 'ses_1', structural: 'updated' });
    expect(parseFleetLiveEvent({ type: 'session.deleted', properties: { sessionID: 'ses_1' } }))
      .toEqual({ sessionId: 'ses_1', structural: 'deleted' });
  });

  test('drops message content and unsupported events', () => {
    expect(parseFleetLiveEvent({ type: 'message.part.delta', properties: { sessionID: 'ses_1', delta: 'secret' } })).toBeNull();
  });
});
