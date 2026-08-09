export const probeServerIdentityMatches = (payload, expectedServerId) => {
  const expected = typeof expectedServerId === 'string' ? expectedServerId.trim() : '';
  if (!expected) return true;
  const reported = typeof payload?.serverId === 'string' ? payload.serverId.trim() : '';
  return Boolean(reported && reported === expected);
};

const REMOTE_RENDERER_COMMANDS = new Set([
  'desktop_set_window_title',
  'desktop_set_window_theme',
  'desktop_is_window_fullscreen',
  'desktop_start_window_drag',
  'desktop_minimize_current_window',
  'desktop_toggle_current_window_maximized',
  'desktop_close_current_window',
  'desktop_get_current_window_state',
  'desktop_get_app_version',
  'desktop_capture_page_rect',
]);

export const isDesktopCommandAllowed = (command, localSender) => (
  localSender || REMOTE_RENDERER_COMMANDS.has(command)
);
