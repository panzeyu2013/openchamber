import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { probeServerIdentityMatches } from './ipc-security.mjs';

describe('Electron remote host identity gate', () => {
  test('requires an exact non-empty server identity before credentialed probing', () => {
    assert.equal(probeServerIdentityMatches({ serverId: 'server-1' }, 'server-1'), true);
    assert.equal(probeServerIdentityMatches({ serverId: 'server-2' }, 'server-1'), false);
    assert.equal(probeServerIdentityMatches({}, 'server-1'), false);
    assert.equal(probeServerIdentityMatches(null, 'server-1'), false);
  });
});
