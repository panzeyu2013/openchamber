/**
 * Project Catalog schema: runtime validation and PUBLIC DTO serialization.
 *
 * Security contract: `toConnectionSummary` is the ONLY serializer allowed to
 * project a private connection record into a public response. Private records
 * are never spread or field-deleted after the fact — they stay server-only.
 * Any field added to a private record must be explicitly absent from the
 * summary (or explicitly deemed public here).
 */

/** Current on-disk schema version. v1 documents (`workspaces` key) are
 * migrated to v2 (`projects` key) by the catalog store, never rejected. */
export const CATALOG_SCHEMA_VERSION = 2;

const HEX_COLOR_PATTERN = /^#(?:[\da-fA-F]{3}|[\da-fA-F]{6})$/;

/** Connection kinds exposed by the public summary. `kind` itself is not a
 * credential (the private target fields behind it stay server-only), so it is
 * safe to serialize. Anything outside this set is omitted, never defaulted. */
const CONNECTION_SUMMARY_KINDS = new Set(['local', 'direct', 'ssh', 'relay']);

const isNonEmptyString = (value) => typeof value === 'string' && value.length > 0;

const isFiniteNonNegativeNumber = (value) => Number.isFinite(value) && value >= 0;

const normalizeColor = (value) => (
  typeof value === 'string' && HEX_COLOR_PATTERN.test(value.trim()) ? value.trim().toLowerCase() : null
);

/** A scalar string field that accepts null/missing and normalizes to null. */
const optionalString = (value) => (isNonEmptyString(value) ? value.trim() : null);

/** Validates and normalizes one connection summary record. */
const validateConnectionSummary = (value, seenIds) => {
  if (!value || typeof value !== 'object') return null;
  const candidate = value;
  const id = optionalString(candidate.id);
  const label = optionalString(candidate.label);
  if (!id || !label || seenIds.has(id)) return null;
  const capabilities = candidate.capabilities && typeof candidate.capabilities === 'object'
    ? candidate.capabilities
    : {};
  seenIds.add(id);
  return {
    id,
    label,
    ...(normalizeColor(candidate.accentColor) ? { accentColor: normalizeColor(candidate.accentColor) } : {}),
    capabilities: {
      pathBrowse: capabilities.pathBrowse === true,
      terminal: capabilities.terminal === true,
      files: capabilities.files === true,
      git: capabilities.git === true,
      eventStream: capabilities.eventStream === true,
    },
  };
};

/** Validates and normalizes one project descriptor record. */
const validateProjectDescriptor = (value, seenIds, seenLocations) => {
  if (!value || typeof value !== 'object') return null;
  const candidate = value;
  const id = optionalString(candidate.id);
  const connectionId = optionalString(candidate.connectionId);
  const path = optionalString(candidate.path);
  const canonicalPath = optionalString(candidate.canonicalPath);
  const label = optionalString(candidate.label);
  const orderKey = typeof candidate.orderKey === 'string' ? candidate.orderKey : '';
  if (
    !id || !connectionId || !path || !canonicalPath || !label
    || seenIds.has(id)
  ) {
    return null;
  }
  const location = `${connectionId}\0${canonicalPath}`;
  if (seenLocations.has(location)) return null;
  seenIds.add(id);
  seenLocations.add(location);
  return {
    id,
    connectionId,
    path,
    canonicalPath,
    label,
    ...(normalizeColor(candidate.color) ? { color: normalizeColor(candidate.color) } : {}),
    orderKey,
    createdAt: isFiniteNonNegativeNumber(candidate.createdAt) ? candidate.createdAt : 0,
    updatedAt: isFiniteNonNegativeNumber(candidate.updatedAt) ? candidate.updatedAt : 0,
  };
};

/**
 * Validates a full catalog document read from disk. Returns a normalized copy
 * or null when the document is unusable (missing core fields, wrong schema
 * version). Corrupt documents must never be treated as an empty catalog and
 * must never crash the process.
 *
 * Entries that fail validation (invalid or duplicate connections/projects)
 * are dropped from the returned document — but the drop is NOT silent: the
 * returned document carries a non-enumerable `dropped` counter
 * ({ connections, projects }) that the store must surface as an explicit
 * recovery state. A silently shrunk catalog must never be treated as an
 * authoritative clean load.
 */
export const validateCatalogDocument = (value) => {
  if (!value || typeof value !== 'object') return null;
  const candidate = value;
  if (candidate.schemaVersion !== CATALOG_SCHEMA_VERSION) return null;
  if (!Number.isInteger(candidate.revision) || candidate.revision < 0) return null;
  if (!Array.isArray(candidate.connections) || !Array.isArray(candidate.projects)) return null;

  const seenConnectionIds = new Set();
  const connections = [];
  let droppedConnections = 0;
  for (const entry of candidate.connections) {
    const normalized = validateConnectionSummary(entry, seenConnectionIds);
    if (normalized) connections.push(normalized);
    else droppedConnections += 1;
  }

  const seenProjectIds = new Set();
  const seenLocations = new Set();
  const projects = [];
  let droppedProjects = 0;
  for (const entry of candidate.projects) {
    const normalized = validateProjectDescriptor(entry, seenProjectIds, seenLocations);
    if (normalized) projects.push(normalized);
    else droppedProjects += 1;
  }

  const migration = candidate.migration && typeof candidate.migration === 'object'
    ? candidate.migration
    : {};

  const document = {
    schemaVersion: CATALOG_SCHEMA_VERSION,
    revision: candidate.revision,
    connections,
    projects,
    migration: {
      legacyProjectsImported: migration.legacyProjectsImported === true,
      pendingConnectionIds: Array.isArray(migration.pendingConnectionIds)
        ? migration.pendingConnectionIds.filter((id) => typeof id === 'string')
        : [],
    },
  };
  if (droppedConnections > 0 || droppedProjects > 0) {
    Object.defineProperty(document, 'dropped', {
      value: { connections: droppedConnections, projects: droppedProjects },
      enumerable: false,
    });
  }
  return document;
};

/**
 * Public DTO serializer for a connection. `privateRecord` is the full
 * server-side record (may contain credentialRefs / SSH instance ids); only
 * whitelisted public fields are copied. Never spread the input.
 * Public fields: id, label, accentColor, capabilities, the non-sensitive
 * `kind` tag ('local'|'direct'|'ssh'|'relay', omitted when missing/illegal)
 * and lastProbeOkAt. baseUrl/tokens/credentialRefs/sshInstanceId/relayId
 * are NEVER projected here.
 */
export const toConnectionSummary = (privateRecord, capabilities) => {
  if (!privateRecord || typeof privateRecord !== 'object') return null;
  const summary = {
    id: String(privateRecord.id),
    label: String(privateRecord.label),
    capabilities: {
      pathBrowse: capabilities?.pathBrowse === true,
      terminal: capabilities?.terminal === true,
      files: capabilities?.files === true,
      git: capabilities?.git === true,
      eventStream: capabilities?.eventStream === true,
    },
  };
  const kind = privateRecord.target?.kind;
  if (CONNECTION_SUMMARY_KINDS.has(kind)) summary.kind = kind;
  const color = normalizeColor(privateRecord.accentColor);
  if (color) summary.accentColor = color;
  // The last successful probe time is public (epoch ms, non-secret): it
  // drives connection status displays. Never add baseUrl/tokens here.
  const lastProbeOkAt = privateRecord.lastProbeOkAt;
  if (typeof lastProbeOkAt === 'number' && Number.isFinite(lastProbeOkAt) && lastProbeOkAt > 0) {
    summary.lastProbeOkAt = lastProbeOkAt;
  }
  return summary;
};

/** Public DTO serializer for a project record. */
export const toProjectDescriptor = (record) => {
  if (!record || typeof record !== 'object') return null;
  const descriptor = {
    id: String(record.id),
    connectionId: String(record.connectionId),
    path: String(record.path),
    canonicalPath: String(record.canonicalPath),
    label: String(record.label),
    orderKey: String(record.orderKey ?? ''),
    createdAt: Number(record.createdAt) || 0,
    updatedAt: Number(record.updatedAt) || 0,
  };
  const color = normalizeColor(record.color);
  if (color) descriptor.color = color;
  return descriptor;
};

/**
 * Validates client input for creating a project. Returns a normalized
 * { connectionId, path, label?, color?, orderKey? } or throws a typed error
 * carrying the HTTP status and public message. Path syntax checks are
 * intentionally minimal: canonicalization happens in the connection adapter
 * under the target server's semantics.
 */
export const validateCreateProjectInput = (value) => {
  if (!value || typeof value !== 'object') {
    throw createValidationError('Project input must be an object');
  }
  const connectionId = optionalString(value.connectionId);
  const path = typeof value.path === 'string' ? value.path : '';
  if (!connectionId) throw createValidationError('connectionId is required');
  if (!path.trim()) throw createValidationError('path is required');
  const label = optionalString(value.label);
  const color = normalizeColor(value.color);
  return {
    connectionId,
    path,
    label: label ?? null,
    color,
    orderKey: typeof value.orderKey === 'string' ? value.orderKey : '',
  };
};

/** Validates the updatable fields of a project (label/color/orderKey). */
export const validateUpdateProjectInput = (value) => {
  if (!value || typeof value !== 'object') {
    throw createValidationError('Project update input must be an object');
  }
  const patch = {};
  if ('label' in value) {
    const label = optionalString(value.label);
    if (!label) throw createValidationError('label cannot be empty');
    patch.label = label;
  }
  if ('color' in value) {
    const color = normalizeColor(value.color);
    if (value.color !== null && value.color !== undefined && !color) {
      throw createValidationError('color must be a hex color or null');
    }
    if (color) patch.color = color;
    else patch.color = null;
  }
  if ('orderKey' in value) {
    if (typeof value.orderKey !== 'string') throw createValidationError('orderKey must be a string');
    patch.orderKey = value.orderKey;
  }
  return patch;
};

export class CatalogInputError extends Error {
  constructor(message, status = 400, code = 'catalog_invalid_input') {
    super(message);
    this.name = 'CatalogInputError';
    this.status = status;
    this.code = code;
  }
}

const createValidationError = (message, status = 400, code = 'catalog_invalid_input') => new CatalogInputError(message, status, code);
