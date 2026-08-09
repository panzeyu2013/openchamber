export const probeServerIdentityMatches = (payload, expectedServerId) => {
  const expected = typeof expectedServerId === 'string' ? expectedServerId.trim() : '';
  if (!expected) return true;
  const reported = typeof payload?.serverId === 'string' ? payload.serverId.trim() : '';
  return Boolean(reported && reported === expected);
};
