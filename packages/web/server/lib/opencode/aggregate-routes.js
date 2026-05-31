/**
 * Multi-server REST API routes.
 *
 *   GET    /api/servers               → list all servers
 *   POST   /api/servers               → register a new server
 *   DELETE /api/servers/:serverId     → remove a server
 *   GET    /api/servers/:serverId/health → probe server health
 *   GET    /api/servers/all/sessions  → aggregate session list across servers
 */

export function registerAggregateRoutes(router, serverManager, sseFanIn, getOpenCodeAuthHeaders) {
  router.get('/api/servers', (_req, res) => {
    try {
      const list = serverManager.listServers();
      res.json(list);
    } catch (err) {
      res.status(500).json({ error: err?.message || 'Failed to list servers' });
    }
  });

  router.delete('/api/servers/:serverId', (req, res) => {
    try {
      const { serverId } = req.params;
      if (serverId === 'local') {
        return res.status(400).json({ error: 'Cannot remove local server' });
      }

      const entry = serverManager.getServer(serverId);
      if (!entry) {
        return res.status(404).json({ error: `Server '${serverId}' not found` });
      }

      serverManager.removeServer(serverId);

      if (sseFanIn && typeof sseFanIn.unsubscribeServer === 'function') {
        sseFanIn.unsubscribeServer(serverId);
      }

      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err?.message || 'Failed to remove server' });
    }
  });

  router.get('/api/servers/:serverId/health', async (req, res) => {
    try {
      const { serverId } = req.params;
      if (!serverManager.getServer(serverId)) {
        return res.status(404).json({ error: `Server '${serverId}' not found` });
      }
      const healthy = await serverManager.probeServer(serverId);
      res.json({ serverId, healthy });
    } catch (err) {
      res.status(500).json({ error: err?.message || 'Health check failed' });
    }
  });

  router.get('/api/servers/all/sessions', async (req, res) => {
    try {
      const archived = req.query.archived === 'true';
      const result = await serverManager.getGlobalSessions({ archived });
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err?.message || 'Failed to aggregate sessions' });
    }
  });

  router.post('/api/servers', async (req, res) => {
    try {
      const { id: rawId, label, type, url } = req.body || {};
      const id = (typeof rawId === 'string' ? rawId : '').trim();

      if (id.length === 0) {
        return res.status(400).json({ error: 'server "id" is required' });
      }
      if (!label || typeof label !== 'string') {
        return res.status(400).json({ error: 'server "label" is required' });
      }

      const VALID_TYPES = new Set(['local', 'ssh', 'remote-url']);
      const effectiveType = type || 'remote-url';
      if (!VALID_TYPES.has(effectiveType)) {
        return res.status(400).json({ error: 'server "type" must be one of: local, ssh, remote-url' });
      }

      if (id === 'local') {
        return res.status(400).json({ error: 'Cannot re-register local server via API' });
      }

      if (url !== undefined && url !== null && typeof url !== 'string') {
        return res.status(400).json({ error: 'server "url" must be a string' });
      }

      const existing = serverManager.getServer(id);
      const isReconnect = existing && existing.status === 'disconnected';

      let client = null;
      if (url) {
        try {
          const { createOpencodeClient } = await import('@opencode-ai/sdk');
          const headers = typeof getOpenCodeAuthHeaders === 'function'
            ? getOpenCodeAuthHeaders() ?? {}
            : {};
          client = createOpencodeClient({ baseUrl: url, headers });
        } catch (sdkErr) {
          return res.status(500).json({
            error: `Failed to create SDK client for remote server: ${sdkErr?.message || sdkErr}`,
          });
        }

        try {
          await client.health.check();
        } catch (healthErr) {
          return res.status(502).json({
            error: `Remote server at "${url}" is not reachable: ${healthErr?.message || healthErr}`,
          });
        }
      }

      if (!url && !isReconnect) {
        return res.status(400).json({ error: 'server "url" is required for new servers' });
      }

      serverManager.registerServer({
        id,
        label: label.trim(),
        type: effectiveType,
        url: url || existing?.url || null,
        client,
      });

      if (sseFanIn && typeof sseFanIn.subscribeServer === 'function') {
        try {
          sseFanIn.subscribeServer(id);
        } catch (subscribeErr) {
          // Rollback: remove the server entry on SSE subscription failure
          try { serverManager.removeServer(id); } catch { /* best-effort */ }
          return res.status(500).json({
            error: `Server registered but SSE subscription failed: ${subscribeErr?.message || subscribeErr}`,
          });
        }
      }

      const registered = serverManager.listServers().find((s) => s.id === id);
      if (!registered) {
        return res.status(500).json({ error: 'Server registered but not found in listing' });
      }
      return res.json(registered);
    } catch (err) {
      res.status(500).json({ error: err?.message || 'Failed to register server' });
    }
  });

  // Generic proxy middleware: forwards /api/servers/:serverId/proxy/* to the
  // corresponding remote server. The UI creates per-server OpencodeClient
  // instances pointed at /api/servers/<serverId>/proxy so all session CRUD
  // (create, delete, send, abort, etc.) routes through the correct server.
  router.use((req, res, next) => {
    const prefix = '/api/servers/'
    const url = req.path
    if (!url.startsWith(prefix)) return next()

    const afterPrefix = url.slice(prefix.length)
    const slashIndex = afterPrefix.indexOf('/')
    if (slashIndex === -1) return next()

    const serverId = afterPrefix.slice(0, slashIndex)
    const afterServerId = afterPrefix.slice(slashIndex)

    if (!afterServerId.startsWith('/proxy') && afterServerId !== '/proxy') return next()

    const remainingPath = afterServerId.slice('/proxy'.length) || '/'

    const serverEntry = serverManager.getServer(serverId)
    if (!serverEntry || !serverEntry.url) {
      return res.status(404).json({ error: `Server '${serverId}' not found or has no URL` })
    }

    const client = serverManager.getClient(serverId)
    if (!client) {
      return res.status(502).json({ error: `No client available for server '${serverId}'` })
    }

    const baseUrl = serverEntry.url.replace(/\/$/, '')
    const targetUrl = `${baseUrl}${remainingPath}`
    const queryIndex = req.url.indexOf('?')
    const queryString = queryIndex !== -1 ? req.url.slice(queryIndex) : ''

    const headers = { ...req.headers }
    // Remove hop-by-hop and host headers
    delete headers['host']
    delete headers['connection']
    delete headers['transfer-encoding']
    delete headers['keep-alive']

    // Attach auth headers if available
    if (typeof getOpenCodeAuthHeaders === 'function') {
      const authHeaders = getOpenCodeAuthHeaders()
      if (authHeaders && typeof authHeaders === 'object') {
        Object.assign(headers, authHeaders)
      }
    }

    const bodyChunks = []
    req.on('data', (chunk) => bodyChunks.push(chunk))
    req.on('end', async () => {
      try {
        const body = bodyChunks.length > 0
          ? Buffer.concat(bodyChunks)
          : undefined

        const upstreamRes = await fetch(`${targetUrl}${queryString}`, {
          method: req.method,
          headers,
          body,
        })

        const resHeaders = {}
        for (const [key, value] of upstreamRes.headers.entries()) {
          if (key.toLowerCase() === 'transfer-encoding' || key.toLowerCase() === 'content-encoding') continue
          resHeaders[key] = value
        }
        res.status(upstreamRes.status).set(resHeaders)

        if (upstreamRes.body) {
          const reader = upstreamRes.body.getReader()
          const pump = async () => {
            while (true) {
              const { done, value } = await reader.read()
              if (done) {
                res.end()
                break
              }
              res.write(value)
            }
          }
          await pump()
        } else {
          res.end()
        }
      } catch (err) {
        if (!res.headersSent) {
          res.status(502).json({ error: `Proxy to '${serverId}' failed: ${err?.message || err}` })
        }
      }
    })
  })
}
