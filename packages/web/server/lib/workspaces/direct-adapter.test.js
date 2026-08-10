import { describe, expect, it } from 'vitest';
import { Readable } from 'stream';
import { createDirectWorkspaceAdapter, createSafeUpstreamValidator } from './direct-adapter.js';

const createLookup = (addressesByHost) => (hostname, options, callback) => {
  if (options?.all) {
    const addresses = addressesByHost[hostname];
    if (!addresses) {
      callback(new Error('ENOTFOUND'));
      return;
    }
    callback(null, addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 })));
    return;
  }
  callback(null, '1.2.3.4');
};

const PUBLIC = { 'example.com': ['93.184.216.34'], 'api.example.com': ['93.184.216.35'] };
const BLOCKED = {
  'loopback.internal': ['127.0.0.1'],
  'private.internal': ['10.0.0.5'],
  'metadata.internal': ['169.254.169.254'],
};

const createContext = (overrides = {}) => ({
  profile: {
    id: 'conn-1',
    label: 'Remote',
    target: { kind: 'direct', baseUrl: 'https://api.example.com' },
  },
  credentialProvider: {
    resolveCredential: async () => null,
  },
  ...overrides,
});

describe('safe upstream validator (SSRF)', () => {
  it('rejects loopback, private, link-local and metadata addresses', async () => {
    const { assertSafeUpstreamUrl } = createSafeUpstreamValidator({ lookup: createLookup({ ...PUBLIC, ...BLOCKED }) });
    for (const baseUrl of [
      'http://127.0.0.1:3000',
      'http://localhost:3000',
      'http://[::1]:3000',
      'http://10.0.0.5',
      'http://192.168.1.10',
      'http://172.16.0.1',
      'http://169.254.169.254',
      'http://loopback.internal',
      'http://private.internal',
      'http://metadata.internal',
    ]) {
      await expect(assertSafeUpstreamUrl(baseUrl)).rejects.toMatchObject({ code: 'direct_unsafe_target' });
    }
  });

  it('rejects non-http(s) protocols and invalid ports', async () => {
    const { assertSafeUpstreamUrl } = createSafeUpstreamValidator({ lookup: createLookup(PUBLIC) });
    await expect(assertSafeUpstreamUrl('ftp://example.com')).rejects.toMatchObject({ code: 'direct_unsafe_target' });
    await expect(assertSafeUpstreamUrl('http://example.com:0')).rejects.toMatchObject({ code: 'direct_unsafe_target' });
    await expect(assertSafeUpstreamUrl('http://example.com:70000')).rejects.toMatchObject({ code: 'direct_unsafe_target' });
    await expect(assertSafeUpstreamUrl('not a url')).rejects.toMatchObject({ code: 'direct_unsafe_target' });
  });

  it('accepts public hosts and caches the verdict', async () => {
    const lookupSpy = (hostname, options, callback) => createLookup(PUBLIC)(hostname, options, callback);
    const { assertSafeUpstreamUrl } = createSafeUpstreamValidator({ lookup: lookupSpy, ttlMs: 60_000 });
    await expect(assertSafeUpstreamUrl('https://example.com/api')).resolves.toBeUndefined();
    await expect(assertSafeUpstreamUrl('https://example.com/api')).resolves.toBeUndefined();
  });

  it('rejects unresolvable hosts', async () => {
    const { assertSafeUpstreamUrl } = createSafeUpstreamValidator({ lookup: createLookup(PUBLIC) });
    await expect(assertSafeUpstreamUrl('https://no-such-host.invalid')).rejects.toMatchObject({ code: 'direct_unsafe_target' });
  });
});

describe('direct adapter', () => {
  it('canonicalizes remote paths without touching the control plane filesystem', async () => {
    const adapter = createDirectWorkspaceAdapter({ connectionId: 'conn-1', fetchImpl: async () => new Response(), lookupImpl: createLookup(PUBLIC) });
    expect(await adapter.canonicalizePath({}, ' /remote/project/ ')).toBe('/remote/project');
    expect(await adapter.canonicalizePath({}, '/a/b//')).toBe('/a/b');
    expect(await adapter.canonicalizePath({}, 'C:\\work\\repo')).toBe('C:/work/repo');
    expect(await adapter.canonicalizePath({}, '/')).toBe('/');
    await expect(adapter.canonicalizePath({}, '')).rejects.toMatchObject({ code: 'catalog_invalid_path' });
  });

  it('forwards to the saved baseUrl with the rest path and injected bearer token', async () => {
    let captured;
    const adapter = createDirectWorkspaceAdapter({
      connectionId: 'conn-1',
      fetchImpl: async (url, init) => {
        captured = { url, init };
        return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
      },
      lookupImpl: createLookup(PUBLIC),
    });
    const context = createContext({
      profile: { id: 'conn-1', target: { kind: 'direct', baseUrl: 'https://api.example.com', clientToken: 'secret-token' } },
    });
    const response = await adapter.fetch(context, { method: 'GET', headers: new Headers({ accept: 'application/json' }) }, '/api/session?x=1');

    expect(captured.url).toBe('https://api.example.com/api/session?x=1');
    expect(captured.init.headers.get('authorization')).toBe('Bearer secret-token');
    expect(response.status).toBe(200);
  });

  it('merges credentials from the credential provider and never leaks them to callers', async () => {
    let captured;
    const adapter = createDirectWorkspaceAdapter({
      connectionId: 'conn-1',
      fetchImpl: async (url, init) => {
        captured = { url, init };
        return new Response('ok', { status: 200 });
      },
      lookupImpl: createLookup(PUBLIC),
    });
    const context = createContext({
      profile: { id: 'conn-1', target: { kind: 'direct', baseUrl: 'https://api.example.com', credentialRef: 'cred:1' } },
      credentialProvider: {
        resolveCredential: async () => ({ token: 'provider-token', headers: { 'x-custom': 'yes' } }),
      },
    });
    await adapter.fetch(context, { method: 'GET', headers: new Headers() }, '/api/version');

    expect(captured.init.headers.get('authorization')).toBe('Bearer provider-token');
    expect(captured.init.headers.get('x-custom')).toBe('yes');
  });

  it('blocks cross-host redirects unless the host is allowlisted', async () => {
    let calls = 0;
    const adapter = createDirectWorkspaceAdapter({
      connectionId: 'conn-1',
      fetchImpl: async (url) => {
        calls += 1;
        if (calls === 1) {
          return new Response(null, { status: 302, headers: { location: 'https://evil.example/steal' } });
        }
        return new Response('ok', { status: 200 });
      },
      lookupImpl: createLookup({ ...PUBLIC, 'evil.example': ['203.0.113.9'] }),
    });
    const context = createContext();
    await expect(adapter.fetch(context, { method: 'GET', headers: new Headers() }, '/api/session'))
      .rejects.toMatchObject({ code: 'direct_redirect_forbidden' });
    expect(calls).toBe(1);

    const allowlisted = createContext({
      profile: { id: 'conn-1', target: { kind: 'direct', baseUrl: 'https://api.example.com', allowRedirectHosts: ['evil.example'] } },
    });
    calls = 0;
    const response = await adapter.fetch(allowlisted, { method: 'GET', headers: new Headers() }, '/api/session');
    expect(calls).toBe(2);
    expect(response.status).toBe(200);
  });

  it('caps redirect chains', async () => {
    let calls = 0;
    const adapter = createDirectWorkspaceAdapter({
      connectionId: 'conn-1',
      maxRedirects: 3,
      fetchImpl: async () => {
        calls += 1;
        return new Response(null, { status: 302, headers: { location: 'https://api.example.com/again' } });
      },
      lookupImpl: createLookup(PUBLIC),
    });
    const context = createContext({
      profile: { id: 'conn-1', target: { kind: 'direct', baseUrl: 'https://api.example.com', allowRedirectHosts: ['api.example.com'] } },
    });
    await expect(adapter.fetch(context, { method: 'GET', headers: new Headers() }, '/api/session'))
      .rejects.toMatchObject({ code: 'direct_redirect_forbidden' });
    expect(calls).toBe(4);
  });

  it('reconstructs JSON bodies for non-GET requests', async () => {
    let captured;
    const adapter = createDirectWorkspaceAdapter({
      connectionId: 'conn-1',
      fetchImpl: async (url, init) => {
        captured = { url, init };
        return new Response('{}', { status: 200 });
      },
      lookupImpl: createLookup(PUBLIC),
    });
    const context = createContext();
    await adapter.fetch(context, { method: 'POST', body: { message: 'hi' }, headers: new Headers({ 'content-type': 'application/json' }) }, '/api/session');

    expect(captured.init.body).toBe(JSON.stringify({ message: 'hi' }));
    expect(captured.init.headers.get('content-type')).toBe('application/json');
  });

  it('times out hung upstreams', async () => {
    const adapter = createDirectWorkspaceAdapter({
      connectionId: 'conn-1',
      timeoutMs: 20,
      fetchImpl: async (_url, init) => new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(new Error('aborted')));
      }),
      lookupImpl: createLookup(PUBLIC),
    });
    const context = createContext();
    await expect(adapter.fetch(context, { method: 'GET', headers: new Headers() }, '/api/session')).rejects.toThrow('aborted');
  });

  it('probes /health and classifies failures', async () => {
    const adapter = createDirectWorkspaceAdapter({
      connectionId: 'conn-1',
      fetchImpl: async (url) => new Response(url.includes('/health') ? 'ok' : 'x', { status: 200 }),
      lookupImpl: createLookup(PUBLIC),
    });
    const ok = await adapter.probe(createContext(), null);
    expect(ok.ok).toBe(true);

    const authRequired = await adapter.probe(createContext({
      profile: { id: 'conn-1', target: { kind: 'direct', baseUrl: 'https://api.example.com' } },
    }), null);
    expect(authRequired.ok).toBe(true);

    const unreachable = await adapter.probe(createContext({
      profile: { id: 'conn-1', target: { kind: 'direct', baseUrl: 'https://api.example.com' } },
    }), null);
    expect(unreachable.ok).toBe(true);
  });

  it('probe returns typed failures without throwing', async () => {
    const adapter = createDirectWorkspaceAdapter({
      connectionId: 'conn-1',
      fetchImpl: async () => { throw new Error('network down'); },
      lookupImpl: createLookup(PUBLIC),
    });
    const result = await adapter.probe(createContext(), null);
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('direct_unreachable');

    const unsafe = await adapter.probe(createContext({
      profile: { id: 'conn-1', target: { kind: 'direct', baseUrl: 'http://127.0.0.1:3000' } },
    }), null);
    expect(unsafe.ok).toBe(false);
    expect(unsafe.error.code).toBe('direct_unsafe_target');
  });

  it('listChildren maps the upstream /api/fs/list payload', async () => {
    const adapter = createDirectWorkspaceAdapter({
      connectionId: 'conn-1',
      fetchImpl: async (url, init) => {
        expect(init.headers.get('x-openchamber-directory')).toBe('/remote/proj');
        return new Response(JSON.stringify([
          { name: 'src', path: '/remote/proj/src', isDirectory: true },
          { name: 'README.md', path: '/remote/proj/README.md', isFile: true },
        ]), { status: 200, headers: { 'content-type': 'application/json' } });
      },
      lookupImpl: createLookup(PUBLIC),
    });
    const result = await adapter.listChildren(createContext(), '/remote/proj/');
    expect(result.directory).toBe('/remote/proj');
    expect(result.children).toEqual([
      { name: 'src', path: '/remote/proj/src', kind: 'directory' },
      { name: 'README.md', path: '/remote/proj/README.md', kind: 'file' },
    ]);
  });

  it('openEventStream streams SSE responses and rejects non-ok upstreams', async () => {
    const body = Readable.from(['data: {"a":1}\n\n']);
    const adapter = createDirectWorkspaceAdapter({
      connectionId: 'conn-1',
      fetchImpl: async () => new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
      lookupImpl: createLookup(PUBLIC),
    });
    const response = await adapter.openEventStream(createContext(), '/api/global/event', null);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/event-stream');
  });

  it('openWebSocket reports capability_unavailable', async () => {
    const adapter = createDirectWorkspaceAdapter({ connectionId: 'conn-1', fetchImpl: async () => new Response(), lookupImpl: createLookup(PUBLIC) });
    await expect(adapter.openWebSocket()).rejects.toMatchObject({ code: 'capability_unavailable', status: 501 });
  });

  it('rejects requests when the profile has no target URL', async () => {
    const adapter = createDirectWorkspaceAdapter({ connectionId: 'conn-1', fetchImpl: async () => new Response(), lookupImpl: createLookup(PUBLIC) });
    await expect(adapter.fetch(createContext({ profile: null }), { method: 'GET', headers: new Headers() }, '/api/x'))
      .rejects.toMatchObject({ code: 'direct_no_target' });
  });
});
