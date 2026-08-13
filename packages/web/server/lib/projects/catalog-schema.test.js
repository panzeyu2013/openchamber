import { describe, expect, it } from 'vitest';

import {
  CATALOG_SCHEMA_VERSION,
  validateCatalogDocument,
  toConnectionSummary,
  toProjectDescriptor,
  validateCreateProjectInput,
  validateUpdateProjectInput,
  CatalogInputError,
} from './catalog-schema.js';

const validConnection = (overrides = {}) => ({
  id: 'conn-1',
  label: 'Local',
  accentColor: '#ABC',
  capabilities: { pathBrowse: true, terminal: true, files: true, git: true, eventStream: true },
  ...overrides,
});

const validProject = (overrides = {}) => ({
  id: 'ws-1',
  connectionId: 'conn-1',
  path: '/tmp/project',
  canonicalPath: '/tmp/project',
  label: 'Project',
  color: '#ABC',
  orderKey: '1',
  createdAt: 100,
  updatedAt: 200,
  ...overrides,
});

const validDocument = (overrides = {}) => ({
  schemaVersion: 2,
  revision: 3,
  connections: [validConnection()],
  projects: [validProject()],
  migration: { legacyProjectsImported: true, pendingConnectionIds: ['/gone', 42] },
  ...overrides,
});

describe('CATALOG_SCHEMA_VERSION', () => {
  it('is 2', () => {
    expect(CATALOG_SCHEMA_VERSION).toBe(2);
  });
});

describe('validateCatalogDocument', () => {
  it('round-trips a valid document into a normalized copy', () => {
    const result = validateCatalogDocument(validDocument());

    expect(result).toEqual({
      schemaVersion: 2,
      revision: 3,
      connections: [
        {
          id: 'conn-1',
          label: 'Local',
          accentColor: '#abc',
          capabilities: { pathBrowse: true, terminal: true, files: true, git: true, eventStream: true },
        },
      ],
      projects: [
        {
          id: 'ws-1',
          connectionId: 'conn-1',
          path: '/tmp/project',
          canonicalPath: '/tmp/project',
          label: 'Project',
          color: '#abc',
          orderKey: '1',
          createdAt: 100,
          updatedAt: 200,
        },
      ],
      migration: { legacyProjectsImported: true, pendingConnectionIds: ['/gone'] },
    });
  });

  it('does not mutate the input document', () => {
    const input = validDocument();
    validateCatalogDocument(input);
    expect(input.connections[0].accentColor).toBe('#ABC');
    expect(input.projects[0].color).toBe('#ABC');
  });

  it('drops unknown private fields from connections and projects', () => {
    const input = validDocument({
      connections: [validConnection({ target: { kind: 'ssh', sshInstanceId: 'secret-ssh' }, credentialRef: 'secret-token' })],
      projects: [validProject({ secret: 'data' })],
    });
    const result = validateCatalogDocument(input);
    expect(result.connections[0]).not.toHaveProperty('target');
    expect(result.connections[0]).not.toHaveProperty('credentialRef');
    expect(result.projects[0]).not.toHaveProperty('secret');
  });

  it('coerces capabilities to booleans', () => {
    const input = validDocument({
      connections: [validConnection({ capabilities: { pathBrowse: 'yes', terminal: 1, files: true } })],
    });
    const result = validateCatalogDocument(input);
    expect(result.connections[0].capabilities).toEqual({
      pathBrowse: false,
      terminal: false,
      files: true,
      git: false,
      eventStream: false,
    });
  });

  it('returns null for a wrong schemaVersion', () => {
    expect(validateCatalogDocument(validDocument({ schemaVersion: 0 }))).toBeNull();
    // v1 was the pre-rename schema; the validator accepts only the current
    // version (legacy documents are migrated by the catalog store, not here).
    expect(validateCatalogDocument(validDocument({ schemaVersion: 1 }))).toBeNull();
    expect(validateCatalogDocument(validDocument({ schemaVersion: '2' }))).toBeNull();
  });

  it('returns null for a missing, non-integer or negative revision', () => {
    const { revision, ...withoutRevision } = validDocument();
    expect(validateCatalogDocument(withoutRevision)).toBeNull();
    expect(validateCatalogDocument(validDocument({ revision: 1.5 }))).toBeNull();
    expect(validateCatalogDocument(validDocument({ revision: -1 }))).toBeNull();
  });

  it('returns null when connections or projects are not arrays', () => {
    expect(validateCatalogDocument(validDocument({ connections: {} }))).toBeNull();
    expect(validateCatalogDocument(validDocument({ connections: null }))).toBeNull();
    expect(validateCatalogDocument(validDocument({ projects: 'nope' }))).toBeNull();
    expect(validateCatalogDocument(validDocument({ projects: undefined }))).toBeNull();
  });

  it('returns null for non-object input', () => {
    expect(validateCatalogDocument(null)).toBeNull();
    expect(validateCatalogDocument(undefined)).toBeNull();
    expect(validateCatalogDocument('string')).toBeNull();
    expect(validateCatalogDocument(42)).toBeNull();
    expect(validateCatalogDocument([])).toBeNull();
  });

  it('drops connections missing required fields instead of failing the document', () => {
    const input = validDocument({
      connections: [
        validConnection({ id: '' }),
        validConnection({ id: 'conn-2', label: '' }),
        validConnection(),
      ],
    });
    const result = validateCatalogDocument(input);
    expect(result.connections.map((entry) => entry.id)).toEqual(['conn-1']);
  });

  it('drops projects missing required fields', () => {
    const input = validDocument({
      projects: [
        validProject({ id: '' }),
        validProject({ id: 'ws-2', connectionId: '' }),
        validProject({ id: 'ws-3', path: '' }),
        validProject({ id: 'ws-4', canonicalPath: '' }),
        validProject({ id: 'ws-5', label: '' }),
        validProject(),
      ],
    });
    const result = validateCatalogDocument(input);
    expect(result.projects.map((entry) => entry.id)).toEqual(['ws-1']);
  });

  it('drops duplicate connection ids', () => {
    const input = validDocument({
      connections: [validConnection(), validConnection({ label: 'Duplicate' })],
    });
    const result = validateCatalogDocument(input);
    expect(result.connections).toHaveLength(1);
    expect(result.connections[0].label).toBe('Local');
  });

  it('drops duplicate project ids', () => {
    const input = validDocument({
      projects: [validProject(), validProject({ canonicalPath: '/other' })],
    });
    const result = validateCatalogDocument(input);
    expect(result.projects).toHaveLength(1);
  });

  it('drops duplicate (connectionId, canonicalPath) locations', () => {
    const input = validDocument({
      projects: [validProject(), validProject({ id: 'ws-2' })],
    });
    const result = validateCatalogDocument(input);
    expect(result.projects).toHaveLength(1);
  });

  it('defaults missing migration state to empty', () => {
    const result = validateCatalogDocument(validDocument({ migration: null }));
    expect(result.migration).toEqual({ legacyProjectsImported: false, pendingConnectionIds: [] });
  });
});

describe('toConnectionSummary', () => {
  it('never leaks private fields into the public summary', () => {
    const record = {
      id: 'conn-ssh',
      label: 'SSH Host',
      accentColor: '#ABC',
      target: { kind: 'ssh', sshInstanceId: 'secret-ssh' },
      credentialRef: 'secret-token',
      clientToken: 'tok',
      baseUrl: 'https://internal.example.com',
      relayId: 'relay-1',
    };
    const summary = toConnectionSummary(record, {
      pathBrowse: true,
      terminal: true,
      files: true,
      git: true,
      eventStream: true,
    });

    expect(summary).toEqual({
      id: 'conn-ssh',
      label: 'SSH Host',
      accentColor: '#abc',
      kind: 'ssh',
      capabilities: { pathBrowse: true, terminal: true, files: true, git: true, eventStream: true },
    });
    const serialized = JSON.stringify(summary);
    expect(serialized).not.toContain('secret-ssh');
    expect(serialized).not.toContain('secret-token');
    expect(serialized).not.toContain('clientToken');
    expect(serialized).not.toContain('tok');
    expect(serialized).not.toContain('internal.example.com');
    expect(serialized).not.toContain('relay-1');
  });

  it('exposes the non-sensitive kind tag for every legal connection kind', () => {
    for (const kind of ['local', 'direct', 'ssh', 'relay']) {
      expect(toConnectionSummary({ id: `c-${kind}`, label: kind, target: { kind } })).toEqual({
        id: `c-${kind}`,
        label: kind,
        kind,
        capabilities: { pathBrowse: false, terminal: false, files: false, git: false, eventStream: false },
      });
    }
  });

  it('omits kind when missing or illegal, never defaulting it', () => {
    expect(toConnectionSummary({ id: 'c', label: 'C', target: { kind: 'weird' } })).not.toHaveProperty('kind');
    expect(toConnectionSummary({ id: 'c', label: 'C', target: { kind: 42 } })).not.toHaveProperty('kind');
    expect(toConnectionSummary({ id: 'c', label: 'C', target: {} })).not.toHaveProperty('kind');
    expect(toConnectionSummary({ id: 'c', label: 'C' })).not.toHaveProperty('kind');
  });

  it('defaults capabilities to all-false when none are provided', () => {
    expect(toConnectionSummary({ id: 'c', label: 'C' })).toEqual({
      id: 'c',
      label: 'C',
      capabilities: { pathBrowse: false, terminal: false, files: false, git: false, eventStream: false },
    });
  });

  it('exposes a valid lastProbeOkAt and drops invalid values', () => {
    expect(toConnectionSummary({ id: 'c', label: 'C', lastProbeOkAt: 1700000000000 })).toEqual({
      id: 'c',
      label: 'C',
      capabilities: { pathBrowse: false, terminal: false, files: false, git: false, eventStream: false },
      lastProbeOkAt: 1700000000000,
    });
    for (const invalid of [0, -1, '1700000000000', NaN, Infinity]) {
      expect(toConnectionSummary({ id: 'c', label: 'C', lastProbeOkAt: invalid })).not.toHaveProperty('lastProbeOkAt');
    }
    expect(toConnectionSummary({ id: 'c', label: 'C' })).not.toHaveProperty('lastProbeOkAt');
  });

  it('drops an invalid accent color', () => {
    expect(toConnectionSummary({ id: 'c', label: 'C', accentColor: 'not-a-color' })).not.toHaveProperty('accentColor');
  });

  it('returns null for a missing record', () => {
    expect(toConnectionSummary(null)).toBeNull();
    expect(toConnectionSummary(undefined)).toBeNull();
  });
});

describe('toProjectDescriptor', () => {
  it('serializes the public project shape', () => {
    expect(toProjectDescriptor({
      id: 'ws-1',
      connectionId: 'conn-1',
      path: '/tmp/project',
      canonicalPath: '/tmp/project',
      label: 'Project',
      color: '#ABC',
      orderKey: '5',
      createdAt: 100,
      updatedAt: 200,
      secret: 'data',
    })).toEqual({
      id: 'ws-1',
      connectionId: 'conn-1',
      path: '/tmp/project',
      canonicalPath: '/tmp/project',
      label: 'Project',
      color: '#abc',
      orderKey: '5',
      createdAt: 100,
      updatedAt: 200,
    });
  });

  it('omits the color when it is invalid or missing', () => {
    const descriptor = toProjectDescriptor({ id: 'ws-1', connectionId: 'c', path: '/p', canonicalPath: '/p', label: 'L' });
    expect(descriptor).not.toHaveProperty('color');
    expect(toProjectDescriptor({
      id: 'ws-1', connectionId: 'c', path: '/p', canonicalPath: '/p', label: 'L', color: 'red',
    })).not.toHaveProperty('color');
  });

  it('defaults orderKey and timestamps', () => {
    const descriptor = toProjectDescriptor({ id: 'ws-1', connectionId: 'c', path: '/p', canonicalPath: '/p', label: 'L' });
    expect(descriptor.orderKey).toBe('');
    expect(descriptor.createdAt).toBe(0);
    expect(descriptor.updatedAt).toBe(0);
  });

  it('returns null for a missing record', () => {
    expect(toProjectDescriptor(null)).toBeNull();
  });
});

const captureError = (fn) => {
  try {
    return { value: fn(), error: null };
  } catch (error) {
    return { value: null, error };
  }
};

const failureOf = (outcome) => (outcome.error ?? outcome.value);

describe('validateCreateProjectInput', () => {
  it('accepts a minimal valid input and normalizes it', () => {
    expect(validateCreateProjectInput({ connectionId: ' local ', path: ' /tmp/project ' })).toEqual({
      connectionId: 'local',
      path: ' /tmp/project ',
      label: null,
      color: null,
      orderKey: '',
    });
  });

  it('normalizes label trimming and hex color case', () => {
    expect(validateCreateProjectInput({
      connectionId: 'local',
      path: '/tmp/project',
      label: '  My Project  ',
      color: '#ABC',
      orderKey: '3',
    })).toEqual({
      connectionId: 'local',
      path: '/tmp/project',
      label: 'My Project',
      color: '#abc',
      orderKey: '3',
    });
  });

  it('rejects a missing connectionId with a typed error', () => {
    const failure = failureOf(captureError(() => validateCreateProjectInput({ path: '/tmp/project' })));
    expect(failure).toBeInstanceOf(CatalogInputError);
    expect(failure.message).toBe('connectionId is required');
    expect(failure.status).toBe(400);
    expect(failure.code).toBe('catalog_invalid_input');
  });

  it('rejects a missing or empty path', () => {
    for (const inputPath of [undefined, '', '   ']) {
      const failure = failureOf(captureError(() => validateCreateProjectInput({ connectionId: 'local', path: inputPath })));
      expect(failure).toBeInstanceOf(CatalogInputError);
      expect(failure.message).toBe('path is required');
    }
  });

  it('rejects non-object input', () => {
    for (const input of [null, 'x', 42]) {
      const failure = failureOf(captureError(() => validateCreateProjectInput(input)));
      expect(failure).toBeInstanceOf(CatalogInputError);
      expect(failure.message).toBe('Project input must be an object');
    }
  });
});

describe('validateUpdateProjectInput', () => {
  it('returns an empty patch for an empty input', () => {
    expect(validateUpdateProjectInput({})).toEqual({});
  });

  it('trims labels', () => {
    expect(validateUpdateProjectInput({ label: '  New Name  ' })).toEqual({ label: 'New Name' });
  });

  it('rejects an empty label', () => {
    for (const label of ['', '  ']) {
      const failure = failureOf(captureError(() => validateUpdateProjectInput({ label })));
      expect(failure).toBeInstanceOf(CatalogInputError);
      expect(failure.message).toBe('label cannot be empty');
    }
  });

  it('normalizes hex colors and lowercases them', () => {
    expect(validateUpdateProjectInput({ color: '#ABC' })).toEqual({ color: '#abc' });
    expect(validateUpdateProjectInput({ color: '#AABBCC' })).toEqual({ color: '#aabbcc' });
  });

  it('removes the color when null is passed explicitly', () => {
    expect(validateUpdateProjectInput({ color: null })).toEqual({ color: null });
    expect(validateUpdateProjectInput({ color: undefined })).toEqual({ color: null });
  });

  it('rejects an invalid color', () => {
    for (const color of ['red', '#12', '']) {
      const failure = failureOf(captureError(() => validateUpdateProjectInput({ color })));
      expect(failure).toBeInstanceOf(CatalogInputError);
      expect(failure.message).toBe('color must be a hex color or null');
    }
  });

  it('leaves the color untouched when absent', () => {
    expect(validateUpdateProjectInput({ label: 'X' })).not.toHaveProperty('color');
  });

  it('keeps string orderKeys and rejects non-strings', () => {
    expect(validateUpdateProjectInput({ orderKey: '42' })).toEqual({ orderKey: '42' });
    const failure = failureOf(captureError(() => validateUpdateProjectInput({ orderKey: 42 })));
    expect(failure).toBeInstanceOf(CatalogInputError);
    expect(failure.message).toBe('orderKey must be a string');
  });

  it('rejects non-object input', () => {
    for (const input of [null, 'x']) {
      const failure = failureOf(captureError(() => validateUpdateProjectInput(input)));
      expect(failure).toBeInstanceOf(CatalogInputError);
    }
  });
});
