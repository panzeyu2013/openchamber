import { normalizePath } from '@/lib/pathNormalization';
import { getDeferredSafeStorage } from '@/stores/utils/safeStorage';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { resolveSessionScopeKey } from '@/sync/selection-store';
import { countSyncPersistenceSerialization } from '@/sync/performance-diagnostics';

export type ChatDraftIdentity = {
  /** Workspace scope key for workspace sessions, ambient runtime key otherwise. */
  scopeKey: string;
  directory: string;
  sessionId: string | null;
};

export type ChatDraftSnapshot = {
  text: string;
  confirmedMentions: Set<string>;
};

type PersistedChatDraft = {
  text: string;
  confirmedMentions: string[];
  touchedAt: number;
};

type PersistedChatDraftEnvelope = {
  version: 2;
  drafts: Record<string, PersistedChatDraft>;
};

const STORAGE_KEY = 'openchamber.chatDrafts.v2';
const MAX_DRAFTS = 50;
const storage = getDeferredSafeStorage();
const deletionListeners = new Set<(identity: ChatDraftIdentity) => void>();
let cachedRawEnvelope: string | null | undefined;
let cachedEnvelope: PersistedChatDraftEnvelope | undefined;

export const createChatDraftIdentity = (
  scopeKey: string,
  directory: string | null | undefined,
  sessionId: string | null,
): ChatDraftIdentity | null => {
  const normalizedDirectory = normalizePath(directory);
  if (!scopeKey || !normalizedDirectory) return null;
  return { scopeKey, directory: normalizedDirectory, sessionId };
};

export const getChatDraftIdentityKey = (identity: ChatDraftIdentity): string =>
  JSON.stringify([identity.scopeKey, identity.directory, identity.sessionId]);

/** Legacy key form: the ambient runtime key in the first tuple slot, as
 * written before the scope migration. */
const getLegacyChatDraftIdentityKey = (identity: ChatDraftIdentity): string =>
  JSON.stringify([getRuntimeKey(), identity.directory, identity.sessionId]);

/** Key under the session's resolved workspace scope, when the identity was
 * captured with the current runtime key (legacy deletion path). */
const getResolvedScopeChatDraftIdentityKey = (identity: ChatDraftIdentity): string | null => {
  if (!identity.sessionId || identity.scopeKey !== getRuntimeKey()) return null;
  const resolved = resolveSessionScopeKey(identity.sessionId, identity.directory);
  if (!resolved || resolved === identity.scopeKey) return null;
  return getChatDraftIdentityKey({ ...identity, scopeKey: resolved });
};

const readEnvelope = (): PersistedChatDraftEnvelope => {
  const raw = storage.getItem(STORAGE_KEY);
  if (raw === cachedRawEnvelope && cachedEnvelope) return cachedEnvelope;
  try {
    const parsed = JSON.parse(raw ?? '') as Partial<PersistedChatDraftEnvelope>;
    if (parsed.version !== 2 || !parsed.drafts || typeof parsed.drafts !== 'object' || Array.isArray(parsed.drafts)) {
      cachedRawEnvelope = raw;
      cachedEnvelope = { version: 2, drafts: {} };
      return cachedEnvelope;
    }
    const drafts: Record<string, PersistedChatDraft> = {};
    for (const [key, value] of Object.entries(parsed.drafts)) {
      if (!value || typeof value !== 'object') continue;
      const draft = value as Partial<PersistedChatDraft>;
      if (typeof draft.text !== 'string' || !Array.isArray(draft.confirmedMentions) || typeof draft.touchedAt !== 'number') continue;
      drafts[key] = {
        text: draft.text,
        confirmedMentions: draft.confirmedMentions.filter((mention): mention is string => typeof mention === 'string'),
        touchedAt: draft.touchedAt,
      };
    }
    cachedRawEnvelope = raw;
    cachedEnvelope = { version: 2, drafts };
    return cachedEnvelope;
  } catch {
    storage.removeItem(STORAGE_KEY);
    cachedRawEnvelope = null;
    cachedEnvelope = { version: 2, drafts: {} };
    return cachedEnvelope;
  }
};

const writeEnvelope = (envelope: PersistedChatDraftEnvelope): void => {
  const serialized = JSON.stringify(envelope);
  cachedRawEnvelope = serialized;
  cachedEnvelope = envelope;
  countSyncPersistenceSerialization(serialized);
  storage.setItem(STORAGE_KEY, serialized);
};

export const readChatDraft = (identity: ChatDraftIdentity | null): ChatDraftSnapshot => {
  if (!identity) return { text: '', confirmedMentions: new Set() };
  // Dual read: the scoped key first, then the legacy ambient-runtime-keyed
  // entry written before the scope migration, then the resolved-scope twin.
  const envelope = readEnvelope();
  const persisted = envelope.drafts[getChatDraftIdentityKey(identity)]
    ?? envelope.drafts[getLegacyChatDraftIdentityKey(identity)]
    ?? (getResolvedScopeChatDraftIdentityKey(identity)
      ? envelope.drafts[getResolvedScopeChatDraftIdentityKey(identity)!]
      : undefined);
  return persisted
    ? { text: persisted.text, confirmedMentions: new Set(persisted.confirmedMentions) }
    : { text: '', confirmedMentions: new Set() };
};

export const writeChatDraft = (
  identity: ChatDraftIdentity | null,
  text: string,
  confirmedMentions: Iterable<string>,
): void => {
  if (!identity) return;
  const envelope = readEnvelope();
  const key = getChatDraftIdentityKey(identity);
  const legacyKey = getLegacyChatDraftIdentityKey(identity);
  const resolvedKey = getResolvedScopeChatDraftIdentityKey(identity);
  const mentions = Array.from(new Set(confirmedMentions));
  if (!text && mentions.length === 0) {
    if (!(key in envelope.drafts)) {
      // Nothing to delete under the primary key; still clear the twins so
      // deletion identities cannot leave workspace-scoped drafts behind.
      if (resolvedKey !== null && resolvedKey !== key && resolvedKey in envelope.drafts) {
        delete envelope.drafts[resolvedKey];
        const retained = Object.entries(envelope.drafts)
          .sort((left, right) => right[1].touchedAt - left[1].touchedAt)
          .slice(0, MAX_DRAFTS);
        writeEnvelope({ version: 2, drafts: Object.fromEntries(retained) });
      }
      return;
    }
    delete envelope.drafts[key];
  } else {
    envelope.drafts[key] = { text, confirmedMentions: mentions, touchedAt: Date.now() };
    // A scoped write supersedes the legacy runtime-keyed draft for the same
    // identity; drop it so a stale read cannot resurrect the old text.
    if (key !== legacyKey) delete envelope.drafts[legacyKey];
  }
  // Always drop the resolved-scope twin (deletion and write paths), so a
  // runtime-keyed identity clears the workspace-scoped draft too.
  if (resolvedKey !== null && resolvedKey !== key) delete envelope.drafts[resolvedKey];

  const retained = Object.entries(envelope.drafts)
    .sort((left, right) => right[1].touchedAt - left[1].touchedAt)
    .slice(0, MAX_DRAFTS);
  writeEnvelope({ version: 2, drafts: Object.fromEntries(retained) });
};

export const clearChatDraft = (identity: ChatDraftIdentity, notify = false): void => {
  writeChatDraft(identity, '', []);
  if (notify) deletionListeners.forEach((listener) => listener(identity));
};

export const subscribeChatDraftDeletion = (listener: (identity: ChatDraftIdentity) => void): (() => void) => {
  deletionListeners.add(listener);
  return () => deletionListeners.delete(listener);
};
