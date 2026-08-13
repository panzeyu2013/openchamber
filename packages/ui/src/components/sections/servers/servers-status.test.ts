import { describe, expect, test } from 'bun:test';
import {
  deriveConnectionStatus,
  deriveFreshness,
  type ProbeDisplayState,
} from './servers-status';
import type { ConnectionProfileSummary, SourceFreshness } from '@/projects/types';

const connection = (overrides: Partial<ConnectionProfileSummary> = {}): ConnectionProfileSummary => ({
  id: 'conn-1',
  label: 'Remote',
  capabilities: { pathBrowse: true, terminal: true, files: true, git: true, eventStream: true },
  ...overrides,
});

const freshness = (overrides: Partial<SourceFreshness> = {}): SourceFreshness => ({
  complete: true,
  partial: false,
  offline: false,
  stale: false,
  lastSuccessAt: 1000,
  error: null,
  ...overrides,
});

const probe = (kind: ProbeDisplayState['kind'], overrides: Partial<ProbeDisplayState> = {}): ProbeDisplayState => ({
  kind,
  ...overrides,
});

describe('deriveConnectionStatus', () => {
  test('a live probe result wins over persisted state', () => {
    expect(deriveConnectionStatus(connection({ lastProbeOkAt: 1700000000000 }), probe('checking'))).toBe('checking');
    expect(deriveConnectionStatus(connection({ lastProbeOkAt: 1700000000000 }), probe('fail'))).toBe('unreachable');
    expect(deriveConnectionStatus(connection(), probe('ok'))).toBe('connected');
    expect(deriveConnectionStatus(connection(), probe('fail'))).toBe('unreachable');
  });

  test('falls back to the persisted last successful probe', () => {
    expect(deriveConnectionStatus(connection({ lastProbeOkAt: 1700000000000 }), undefined)).toBe('connected');
    expect(deriveConnectionStatus(connection(), undefined)).toBe('neverConnected');
    expect(deriveConnectionStatus(null, undefined)).toBe('neverConnected');
  });
});

describe('deriveFreshness', () => {
  test('maps SourceFreshness to display kinds', () => {
    expect(deriveFreshness(freshness())).toBe('synced');
    expect(deriveFreshness(freshness({ stale: true }))).toBe('stale');
    expect(deriveFreshness(freshness({ offline: true }))).toBe('offline');
    expect(deriveFreshness(freshness({ complete: false }))).toBe('offline');
  });

  test('missing freshness is unknown (just-registered connection)', () => {
    expect(deriveFreshness(undefined)).toBe('unknown');
  });
});
