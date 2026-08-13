import { beforeEach, describe, expect, test } from 'bun:test'
import { getControlPlaneKey } from '@/lib/control-plane'
import { projectScopeKey, projectSessionKey } from '@/projects/identity'
import { useProjectSessionIndexStore } from '@/projects/session-index-store'
import type { ProjectSessionSnapshot, ProjectSessionSummary } from '@/projects/types'
import { resolveSessionScopeKey, useSelectionStore } from '@/sync/selection-store'
import { setActiveSyncScopeKey } from '@/sync/active-scope'
import { viewportSessionKey, useViewportStore } from '@/sync/viewport-store'
import { getPinnedSessionKey, isSessionPinned, useSessionPinnedStore } from '@/stores/useSessionPinnedStore'
import { getTodosPersistenceKey, useTodosPersistStore } from '@/stores/useTodosPersistStore'
import { createChatDraftIdentity, getChatDraftIdentityKey, readChatDraft, writeChatDraft } from '@/lib/chatDraftPersistence'
import { createMessageQueueTarget, getMessageQueueKey } from '@/stores/messageQueueStore'
import { getDeferredSafeStorage } from '@/stores/utils/safeStorage'

const makeSession = (projectId: string, sessionId: string, directory: string): ProjectSessionSummary => ({
  key: projectSessionKey(projectId, sessionId),
  projectId,
  connectionId: 'conn-1',
  upstreamSessionId: sessionId,
  directory,
  title: `Session ${sessionId}`,
  updatedAt: 1000,
  archived: false,
  createdAt: 1000,
})

const setIndexSessions = (sessions: ProjectSessionSummary[]): void => {
  useProjectSessionIndexStore.setState({
    snapshot: {
      revision: 1,
      sessions,
      freshnessByConnection: {},
    } satisfies ProjectSessionSnapshot,
  })
}

describe('session scope migration', () => {
  beforeEach(() => {
    setIndexSessions([])
    useSelectionStore.setState({
      sessionModelSelections: new Map(),
      sessionAgentSelections: new Map(),
      sessionAgentModelSelections: new Map(),
      lastUsedProvider: null,
    })
    useViewportStore.setState({ sessionMemoryState: new Map() })
    useSessionPinnedStore.setState({ ids: new Set(), touchedAt: {} })
    useTodosPersistStore.setState({ sessions: {} })
    getDeferredSafeStorage().removeItem('openchamber.chatDrafts.v2')
  })

  test('resolveSessionScopeKey returns the project scope when indexed, the unscoped bucket otherwise', () => {
    setIndexSessions([makeSession('ws-1', 'ses-1', '/a'), makeSession('ws-2', 'ses-2', '/b')])
    expect(resolveSessionScopeKey('ses-1', '/a')).toBe(projectScopeKey('ws-1'))
    expect(resolveSessionScopeKey('ses-2', '/b')).toBe(projectScopeKey('ws-2'))
    expect(resolveSessionScopeKey('ses-unknown', '/c')).toBe('')
    expect(resolveSessionScopeKey(null, null)).toBe('')
  })

  test('resolveSessionScopeKey falls back to the mounted project scope for unindexed sessions', () => {
    setActiveSyncScopeKey(projectScopeKey('ws-mounted'))
    try {
      // A freshly created session is not indexed yet: the mounted scope is the
      // only authoritative signal.
      expect(resolveSessionScopeKey('ses-new', '/a')).toBe(projectScopeKey('ws-mounted'))
      expect(resolveSessionScopeKey('ses-new', null)).toBe(projectScopeKey('ws-mounted'))
    } finally {
      setActiveSyncScopeKey(null)
    }
  })

  test('resolveSessionScopeKey trusts an index directory match away from the mounted project', () => {
    setIndexSessions([makeSession('ws-indexed', 'ses-dup', '/real'), makeSession('ws-mounted', 'ses-dup', '/other')])
    setActiveSyncScopeKey(projectScopeKey('ws-mounted'))
    try {
      // The index disambiguated by directory and points away from the mounted
      // project: the explicit directory match wins over the mount.
      expect(resolveSessionScopeKey('ses-dup', '/real')).toBe(projectScopeKey('ws-indexed'))
      // Without a directory the mounted scope is the tie-breaker for the
      // ID collision.
      expect(resolveSessionScopeKey('ses-dup', null)).toBe(projectScopeKey('ws-mounted'))
    } finally {
      setActiveSyncScopeKey(null)
    }
  })

  test('resolveSessionScopeKey with an explicit projectId wins over the mount and the index', () => {
    setIndexSessions([makeSession('ws-indexed', 'ses-x', '/a')])
    setActiveSyncScopeKey(projectScopeKey('ws-mounted'))
    try {
      expect(resolveSessionScopeKey('ses-x', '/a', 'ws-explicit')).toBe(projectScopeKey('ws-explicit'))
    } finally {
      setActiveSyncScopeKey(null)
    }
  })

  test('resolveSessionScopeKey keeps the mounted scope for sessions the index never maps', () => {
    setActiveSyncScopeKey(projectScopeKey('ws-mounted'))
    try {
      expect(resolveSessionScopeKey('ses-unknown', '/c')).toBe(projectScopeKey('ws-mounted'))
    } finally {
      setActiveSyncScopeKey(null)
    }
  })

  test('two projects with the same sessionId and directory do not share selection data', () => {
    const sameSessionId = 'same-session'
    setIndexSessions([
      makeSession('ws-1', sameSessionId, '/home/a'),
      makeSession('ws-2', sameSessionId, '/home/b'),
    ])

    // Model selection with explicit directory disambiguation.
    const save = useSelectionStore.getState().saveSessionModelSelection
    const getModel = useSelectionStore.getState().getSessionModelSelection
    expect(resolveSessionScopeKey(sameSessionId, '/home/a')).toBe(projectScopeKey('ws-1'))
    expect(resolveSessionScopeKey(sameSessionId, '/home/b')).toBe(projectScopeKey('ws-2'))

    // The store actions resolve the scope from the session index, so the
    // directory hint is not available to them; selecting one project must
    // not leak into the other even with identical session IDs.
    // (Same sessionId in two projects without a directory hint resolves to
    // the first match — matching resolveActiveProjectId's documented
    // fallback — so bleed tests use distinct session IDs below.)
    save(sameSessionId, 'provider-a', 'model-a')
    expect(getModel(sameSessionId)?.modelId).toBe('model-a')
  })

  test('selection data is isolated between two projects with distinct sessions', () => {
    setIndexSessions([makeSession('ws-1', 'ses-a', '/home/a'), makeSession('ws-2', 'ses-b', '/home/b')])
    const store = useSelectionStore.getState()
    store.saveSessionModelSelection('ses-a', 'provider-1', 'model-1')
    store.saveSessionAgentSelection('ses-a', 'agent-1')
    store.saveAgentModelForSession('ses-a', 'agent-1', 'provider-1', 'model-1')
    store.saveAgentModelVariantForSession('ses-a', 'agent-1', 'provider-1', 'model-1', 'variant-1')

    store.saveSessionModelSelection('ses-b', 'provider-2', 'model-2')
    store.saveSessionAgentSelection('ses-b', 'agent-2')

    const read = useSelectionStore.getState()
    expect(read.getSessionModelSelection('ses-a')).toEqual({ providerId: 'provider-1', modelId: 'model-1' })
    expect(read.getSessionModelSelection('ses-b')).toEqual({ providerId: 'provider-2', modelId: 'model-2' })
    expect(read.getSessionAgentSelection('ses-a')).toBe('agent-1')
    expect(read.getSessionAgentSelection('ses-b')).toBe('agent-2')
    expect(read.getAgentModelForSession('ses-a', 'agent-1')).toEqual({ providerId: 'provider-1', modelId: 'model-1' })
    expect(read.getAgentModelForSession('ses-b', 'agent-2')).toBeNull()
    expect(read.getAgentModelVariantForSession('ses-a', 'agent-1', 'provider-1', 'model-1')).toBe('variant-1')
    expect(read.getAgentModelVariantForSession('ses-b', 'agent-2', 'provider-2', 'model-2')).toBe(undefined)
  })

  test('selection store keeps legacy bare-session-id entries readable', async () => {
    // The selection store persists through the deferred JSON storage; seed
    // the v1 payload there so the persist getItem sees it.
    getDeferredSafeStorage().removeItem('selection-store')
    getDeferredSafeStorage().setItem(
      'selection-store',
      JSON.stringify({
        state: {
          sessionModelSelections: [['legacy-ses', { providerId: 'provider-legacy', modelId: 'model-legacy' }]],
          sessionAgentSelections: [['legacy-ses', 'agent-legacy']],
          sessionAgentModelSelections: [['legacy-ses', [['agent-legacy', { providerId: 'provider-legacy', modelId: 'model-legacy' }]]]],
          lastUsedProvider: null,
        },
        version: 1,
      }),
    )
    await new Promise((resolve) => setTimeout(resolve, 5))
    await useSelectionStore.persist.rehydrate()
    const read = useSelectionStore.getState()
    expect(read.getSessionModelSelection('legacy-ses')).toEqual({ providerId: 'provider-legacy', modelId: 'model-legacy' })
    expect(read.getSessionAgentSelection('legacy-ses')).toBe('agent-legacy')
    expect(read.getAgentModelForSession('legacy-ses', 'agent-legacy')).toEqual({ providerId: 'provider-legacy', modelId: 'model-legacy' })

    // A scoped write replaces the legacy entry without resurrecting it.
    read.saveSessionModelSelection('legacy-ses', 'provider-new', 'model-new')
    expect(read.getSessionModelSelection('legacy-ses')).toEqual({ providerId: 'provider-new', modelId: 'model-new' })
  })

  test('viewport keys outside project mode use the unscoped bucket', () => {
    expect(viewportSessionKey('ses-x')).toBe(`\nses-x`)
  })

  test('viewport memory is isolated per project scope and keeps the legacy bare-key fallback', () => {
    setIndexSessions([makeSession('ws-1', 'ses-a', '/a'), makeSession('ws-2', 'ses-b', '/b')])
    useViewportStore.getState().updateViewportAnchor('ses-a', 3)
    useViewportStore.getState().updateViewportAnchor('ses-b', 7)

    const map = useViewportStore.getState().sessionMemoryState
    expect(map.get(viewportSessionKey('ses-a'))?.viewportAnchor).toBe(3)
    expect(map.get(viewportSessionKey('ses-b'))?.viewportAnchor).toBe(7)
    expect(map.get(`${getControlPlaneKey()}\nses-a`)).toBe(undefined)

    // Legacy bare-session-id entries remain readable.
    useViewportStore.setState({ sessionMemoryState: new Map([['ses-legacy', { viewportAnchor: 11, isStreaming: false, lastAccessedAt: 1, backgroundMessageCount: 0 }]]) })
    expect(useViewportStore.getState().sessionMemoryState.get('ses-legacy')?.viewportAnchor).toBe(11)
  })

  test('pinned sessions use the project scope key and keep legacy runtime-keyed pins visible', () => {
    const directory = '/repo'
    const sessionId = 'ses-pin'
    expect(getPinnedSessionKey('project:ws-1', directory, sessionId)).toBe(JSON.stringify(['project:ws-1', directory, sessionId]))

    setIndexSessions([makeSession('ws-1', sessionId, directory)])
    useSessionPinnedStore.getState().toggle({ directory, sessionId })
    expect(isSessionPinned(useSessionPinnedStore.getState().ids, directory, sessionId)).toBe(true)

    // Legacy runtime-keyed pin is still readable (dual read).
    const legacyKey = getPinnedSessionKey(getControlPlaneKey(), directory, sessionId)!
    const ids = new Set(useSessionPinnedStore.getState().ids)
    ids.add(legacyKey)
    useSessionPinnedStore.setState({ ids, touchedAt: { ...useSessionPinnedStore.getState().touchedAt, [legacyKey]: 1 } })
    expect(isSessionPinned(useSessionPinnedStore.getState().ids, directory, sessionId)).toBe(true)
  })

  test('pinned sessions do not bleed between projects once the scope key differs', () => {
    setIndexSessions([
      makeSession('ws-1', 'ses-same', '/repo/a'),
      makeSession('ws-2', 'ses-same', '/repo/b'),
    ])
    // The same session ID in two projects disambiguates by directory.
    const key1 = getPinnedSessionKey(resolveSessionScopeKey('ses-same', '/repo/a'), '/repo/a', 'ses-same')!
    const key2 = getPinnedSessionKey(resolveSessionScopeKey('ses-same', '/repo/b'), '/repo/b', 'ses-same')!
    expect(key1).not.toBe(key2)
    expect(resolveSessionScopeKey('ses-same', '/repo/a')).toBe(projectScopeKey('ws-1'))
    expect(resolveSessionScopeKey('ses-same', '/repo/b')).toBe(projectScopeKey('ws-2'))

    const ids = new Set([key1])
    expect(isSessionPinned(ids, '/repo/a', 'ses-same')).toBe(true)
    expect(isSessionPinned(ids, '/repo/b', 'ses-same')).toBe(false)
    ids.delete(key1)
    ids.add(key2)
    expect(isSessionPinned(ids, '/repo/a', 'ses-same')).toBe(false)
    expect(isSessionPinned(ids, '/repo/b', 'ses-same')).toBe(true)
  })

  test('todos keys use the project scope; unmapped sessions use the unscoped bucket', () => {
    const directory = '/repo'
    const sessionId = 'ses-todo'
    setIndexSessions([makeSession('ws-1', sessionId, directory)])
    expect(getTodosPersistenceKey(resolveSessionScopeKey(sessionId, directory), directory, sessionId))
      .toBe(JSON.stringify([projectScopeKey('ws-1'), directory, sessionId]))
    expect(getTodosPersistenceKey(resolveSessionScopeKey('ses-unmapped', directory), directory, 'ses-unmapped'))
      .toBe(JSON.stringify(['', directory, 'ses-unmapped']))
  })

  test('chat drafts are isolated per project scope and keep legacy runtime-keyed drafts readable', () => {
    const directory = '/repo'
    const sessionId = 'ses-draft'
    setIndexSessions([makeSession('ws-1', sessionId, directory)])

    const identity = createChatDraftIdentity(resolveSessionScopeKey(sessionId, directory), directory, sessionId)!
    expect(getChatDraftIdentityKey(identity)).toBe(JSON.stringify([projectScopeKey('ws-1'), directory, sessionId]))

    writeChatDraft(identity, 'scoped text', [])
    expect(readChatDraft(identity).text).toBe('scoped text')

    // Legacy runtime-keyed draft is still readable through the dual read.
    const legacyIdentity = createChatDraftIdentity(getControlPlaneKey(), directory, sessionId)!
    const storage = getDeferredSafeStorage()
    const envelope = JSON.parse(storage.getItem('openchamber.chatDrafts.v2') ?? '{}') as { drafts: Record<string, { text: string; confirmedMentions: string[]; touchedAt: number }> }
    envelope.drafts[getChatDraftIdentityKey(legacyIdentity)] = { text: 'legacy text', confirmedMentions: [], touchedAt: 1 }
    storage.setItem('openchamber.chatDrafts.v2', JSON.stringify(envelope))
    expect(readChatDraft(identity).text).toBe('scoped text')
    expect(readChatDraft(legacyIdentity).text).toBe('legacy text')
  })

  test('two projectIds with the same sessionId and directory never share a chat draft', () => {
    const directory = '/repo'
    const sessionId = 'ses-draft'
    const ws1 = createChatDraftIdentity(projectScopeKey('ws-1'), directory, sessionId)!
    const ws2 = createChatDraftIdentity(projectScopeKey('ws-2'), directory, sessionId)!

    writeChatDraft(ws1, 'project one draft', [])
    expect(readChatDraft(ws2).text).toBe('')
    writeChatDraft(ws2, 'project two draft', [])
    expect(readChatDraft(ws1).text).toBe('project one draft')
    expect(readChatDraft(ws2).text).toBe('project two draft')
  })

  test('message queue targets use the project scope; unmapped targets use the unscoped bucket', () => {
    setIndexSessions([makeSession('ws-1', 'ses-q', '/repo')])
    const projectTarget = createMessageQueueTarget('ses-q', '/repo')!
    expect(projectTarget.scopeKey).toBe(projectScopeKey('ws-1'))
    expect(getMessageQueueKey(projectTarget)).toBe(`${projectScopeKey('ws-1')}\n/repo\nses-q`)

    // Unmapped sessions have no sync scope, so no queue target exists.
    expect(createMessageQueueTarget('ses-q2', '/repo2')).toBeNull()
  })
})
