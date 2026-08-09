import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { isDesktopCommandAllowed, probeServerIdentityMatches } from './ipc-security.mjs';

describe('Electron remote host identity gate', () => {
  test('requires an exact non-empty server identity before credentialed probing', () => {
    assert.equal(probeServerIdentityMatches({ serverId: 'server-1' }, 'server-1'), true);
    assert.equal(probeServerIdentityMatches({ serverId: 'server-2' }, 'server-1'), false);
    assert.equal(probeServerIdentityMatches({}, 'server-1'), false);
    assert.equal(probeServerIdentityMatches(null, 'server-1'), false);
  });
});

describe('Electron renderer command authorization', () => {
  test('allows local renderers to invoke desktop capabilities', () => {
    assert.equal(isDesktopCommandAllowed('desktop_host_probe', true), true);
    assert.equal(isDesktopCommandAllowed('desktop_new_window_at_url', true), true);
  });

  test('limits remote renderers to current-window capabilities', () => {
    assert.equal(isDesktopCommandAllowed('desktop_set_window_title', false), true);
    assert.equal(isDesktopCommandAllowed('desktop_close_current_window', false), true);
    assert.equal(isDesktopCommandAllowed('desktop_capture_page_rect', false), true);

    for (const command of [
      'desktop_hosts_get',
      'desktop_host_probe',
      'desktop_new_window',
      'desktop_new_window_at_url',
      'desktop_new_window_for_host',
      'desktop_get_lan_address',
    ]) {
      assert.equal(isDesktopCommandAllowed(command, false), false, command);
    }
  });
});
