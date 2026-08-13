import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createConnectionBroker } from './connection-broker.js';

const createFakeAdapter = (connectionId, dispose) => ({
  connectionId,
  dispose: dispose ?? vi.fn(async () => {}),
});

describe('createConnectionBroker', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('registerAdapter', () => {
    it('rejects adapters without a connectionId', () => {
      const broker = createConnectionBroker();
      expect(() => broker.registerAdapter(null)).toThrow('adapter must expose a connectionId');
      expect(() => broker.registerAdapter({})).toThrow('adapter must expose a connectionId');
      expect(() => broker.registerAdapter({ dispose: async () => {} })).toThrow('adapter must expose a connectionId');
    });

    it('registers, lists and resolves adapters', () => {
      const broker = createConnectionBroker();
      broker.registerAdapter(createFakeAdapter('local'));
      broker.registerAdapter(createFakeAdapter('remote-1'));

      expect(broker.listConnectionIds().sort()).toEqual(['local', 'remote-1']);
      expect(broker.hasAdapter('local')).toBe(true);
      expect(broker.hasAdapter('ghost')).toBe(false);
      expect(broker.getAdapter('local').connectionId).toBe('local');
      expect(broker.getAdapter('ghost')).toBeNull();
    });
  });

  describe('acquireLease', () => {
    it('returns null for an unknown connection', () => {
      const broker = createConnectionBroker();
      broker.registerAdapter(createFakeAdapter('local'));
      expect(broker.acquireLease('ghost')).toBeNull();
      expect(broker.acquireLease('local')).toEqual(expect.any(Function));
    });

    it('counts multiple leases and reports a ready state', () => {
      const broker = createConnectionBroker();
      broker.registerAdapter(createFakeAdapter('local'));
      const releaseOne = broker.acquireLease('local');
      const releaseTwo = broker.acquireLease('local');

      expect(broker.getLifecycleState('local')).toEqual({ state: 'ready', leaseCount: 2, lastReleasedAt: 0 });
      releaseOne();
      expect(broker.getLifecycleState('local').leaseCount).toBe(1);
      releaseTwo();
      expect(broker.getLifecycleState('local').leaseCount).toBe(0);
    });

    it('is safe to call a release function twice', () => {
      const broker = createConnectionBroker();
      broker.registerAdapter(createFakeAdapter('local'));
      const release = broker.acquireLease('local');
      release();
      release();
      expect(broker.getLifecycleState('local').leaseCount).toBe(0);
    });

    it('reports an idle state for unregistered connections', () => {
      const broker = createConnectionBroker();
      expect(broker.getLifecycleState('ghost')).toEqual({ state: 'idle', leaseCount: 0 });
    });
  });

  describe('idle grace disposal', () => {
    it('disposes the adapter after the grace period following the last release', () => {
      const dispose = vi.fn(async () => {});
      const broker = createConnectionBroker({ idleGraceMs: 50 });
      broker.registerAdapter(createFakeAdapter('local', dispose));

      const release = broker.acquireLease('local');
      release();
      expect(broker.getLifecycleState('local').state).toBe('backoff');
      expect(dispose).not.toHaveBeenCalled();

      vi.advanceTimersByTime(50);
      expect(dispose).toHaveBeenCalledTimes(1);
      expect(broker.getLifecycleState('local')).toEqual({ state: 'idle', leaseCount: 0, lastReleasedAt: expect.any(Number) });
    });

    it('does not dispose while a lease is still held', () => {
      const dispose = vi.fn(async () => {});
      const broker = createConnectionBroker({ idleGraceMs: 50 });
      broker.registerAdapter(createFakeAdapter('local', dispose));

      const releaseOne = broker.acquireLease('local');
      const releaseTwo = broker.acquireLease('local');
      releaseOne();
      vi.advanceTimersByTime(500);
      expect(dispose).not.toHaveBeenCalled();

      releaseTwo();
      vi.advanceTimersByTime(50);
      expect(dispose).toHaveBeenCalledTimes(1);
    });

    it('cancels disposal when a lease is re-acquired during the grace', () => {
      const dispose = vi.fn(async () => {});
      const broker = createConnectionBroker({ idleGraceMs: 50 });
      broker.registerAdapter(createFakeAdapter('local', dispose));

      const releaseFirst = broker.acquireLease('local');
      releaseFirst();
      vi.advanceTimersByTime(20);
      expect(dispose).not.toHaveBeenCalled();

      const releaseSecond = broker.acquireLease('local');
      vi.advanceTimersByTime(500);
      expect(dispose).not.toHaveBeenCalled();

      releaseSecond();
      vi.advanceTimersByTime(50);
      expect(dispose).toHaveBeenCalledTimes(1);
    });
  });

  describe('dispose', () => {
    it('disposes every adapter with an active lease', async () => {
      const disposeLocal = vi.fn(async () => {});
      const disposeRemote = vi.fn(async () => {});
      const broker = createConnectionBroker({ idleGraceMs: 50 });
      broker.registerAdapter(createFakeAdapter('local', disposeLocal));
      broker.registerAdapter(createFakeAdapter('remote-1', disposeRemote));

      broker.acquireLease('local');
      broker.acquireLease('remote-1');

      await broker.dispose();
      expect(disposeLocal).toHaveBeenCalledTimes(1);
      expect(disposeRemote).toHaveBeenCalledTimes(1);
      expect(broker.getLifecycleState('local')).toEqual({ state: 'idle', leaseCount: 0 });
      expect(broker.getLifecycleState('remote-1')).toEqual({ state: 'idle', leaseCount: 0 });
    });

    it('does not dispose adapters with no leases', async () => {
      const dispose = vi.fn(async () => {});
      const broker = createConnectionBroker();
      broker.registerAdapter(createFakeAdapter('local', dispose));
      await broker.dispose();
      expect(dispose).not.toHaveBeenCalled();
    });

    it('survives a failing adapter dispose', async () => {
      const broker = createConnectionBroker();
      broker.registerAdapter(createFakeAdapter('local', vi.fn(async () => {
        throw new Error('dispose exploded');
      })));
      broker.registerAdapter(createFakeAdapter('remote-1', vi.fn(async () => {})));

      broker.acquireLease('local');
      broker.acquireLease('remote-1');
      await expect(broker.dispose()).resolves.toBeUndefined();
    });
  });

  describe('resolveConnection', () => {
    it('returns the adapter and profile for a known connection', async () => {
      const profileStore = {
        getPrivateRecord: vi.fn(async (connectionId) => (
          connectionId === 'local' ? { id: 'local', label: 'This computer', target: { kind: 'local' } } : null
        )),
      };
      const broker = createConnectionBroker({ profileStore });
      broker.registerAdapter(createFakeAdapter('local'));

      const resolved = await broker.resolveConnection('local');
      expect(resolved.adapter.connectionId).toBe('local');
      expect(resolved.profile.id).toBe('local');

      expect(await broker.resolveConnection('ghost')).toBeNull();
    });
  });
});
