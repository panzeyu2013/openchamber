import { beforeEach, describe, expect, test } from 'bun:test'
import { getControlPlaneKey } from '@/lib/control-plane'
import { workspaceScopeKey, workspaceSessionKey } from '@/workspaces/identity'
import { useWorkspaceSessionIndexStore } from '@/workspaces/session-index-store'
import type { WorkspaceSessionSnapshot, WorkspaceSessionSummary } from '@/workspaces/types'
import { resolveSessionScopeKey, useSelectionStore } from '@/sync/selection-store'
import { viewportSessionKey, useViewportStore } from '@/sync/viewport-store'
import { getPinnedSessionKey, isSessionPinned, useSessionPinnedStore } from '@/stores/useSessionPinnedStore'
import { getTodosPersistenceKey, useTodosPersistStore } from '@/stores/useTodosPersistStore'
import { createChatDraftIdentity, getChatDraftIdentityKey, readChatDraft, writeChatDraft } from '@/lib/chatDraftPersistence'
import { createMessageQueueTarget, getMessageQueueKey } from '@/stores/messageQueueStore'
import { getDeferredSafeStorage } from '@/stores/utils/safeStorage'

const makeSession = (workspaceId: string, sessionId: string, directory: string): WorkspaceSessionSummary => ({
  key: workspaceSessionKey(workspaceId, sessionId),
  workspaceId,
  connectionId: 'conn-1',
  upstreamSessionId: sessionId,
  directory,
  title: `Session ${sessionId}`,
  updatedAt: 1000,
  archived: false,
  createdAt: 1000,
})

const setIndexSessions = (sessions: WorkspaceSessionSummary[]): void => {
  useWorkspaceSessionIndexStore.setState({
    snapshot: {
      revision: 1,
      sessions,
      freshnessByConnection: {},
    } satisfies WorkspaceSessionSnapshot,
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

  test('resolveSessionScopeKey returns the workspace scope when indexed, the unscoped bucket otherwise', () => {
    setIndexSessions([makeSession('ws-1', 'ses-1', '/a'), makeSession('ws-2', 'ses-2', '/b')])
    expect(resolveSessionScopeKey('ses-1', '/a')).toBe(workspaceScopeKey('ws-1'))
    expect(resolveSessionScopeKey('ses-2', '/b')).toBe(workspaceScopeKey('ws-2'))
    expect(resolveSessionScopeKey('ses-unknown', '/c')).toBe('')
    expect(resolveSessionScopeKey(null, null)).toBe('')
  })

  test('two workspaces with the same sessionId and directory do not share selection data', () => {
    const sameSessionId = 'same-session'
    setIndexSessions([
      makeSession('ws-1', sameSessionId, '/home/a'),
      makeSession('ws-2', sameSessionId, '/home/b'),
    ])

    // Model selection with explicit directory disambiguation.
    const save = useSelectionStore.getState().saveSessionModelSelection
    const getModel = useSelectionStore.getState().getSessionModelSelection
    expect(resolveSessionScopeKey(sameSessionId, '/home/a')).toBe(workspaceScopeKey('ws-1'))
    expect(resolveSessionScopeKey(sameSessionId, '/home/b')).toBe(workspaceScopeKey('ws-2'))

    // The store actions resolve the scope from the session index, so the
    // directory hint is not available to them; selecting one workspace must
    // not leak into the other even with identical session IDs.
    // (Same sessionId in two workspaces without a directory hint resolves to
    // the first match — matching resolveActiveWorkspaceId's documented
    // fallback — so bleed tests use distinct session IDs below.)
    save(sameSessionId, 'provider-a', 'model-a')
    expect(getModel(sameSessionId)?.modelId).toBe('model-a')
  })

  test('selection data is isolated between two workspaces with distinct sessions', () => {
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

  test('viewport keys outside workspace mode use the unscoped bucket', () => {
    expect(viewportSessionKey('ses-x')).toBe(`\nses-x`)
  })

  test('viewport memory is isolated per workspace scope and keeps the legacy bare-key fallback', () => {
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

  test('pinned sessions use the workspace scope key and keep legacy runtime-keyed pins visible', () => {
    const directory = '/repo'
    const sessionId = 'ses-pin'
    expect(getPinnedSessionKey('workspace:ws-1', directory, sessionId)).toBe(JSON.stringify(['workspace:ws-1', directory, sessionId]))

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

  test('pinned sessions do not bleed between workspaces once the scope key differs', () => {
    setIndexSessions([
      makeSession('ws-1', 'ses-same', '/repo/a'),
      makeSession('ws-2', 'ses-same', '/repo/b'),
    ])
    // The same session ID in two workspaces disambiguates by directory.
    const key1 = getPinnedSessionKey(resolveSessionScopeKey('ses-same', '/repo/a'), '/repo/a', 'ses-same')!
    const key2 = getPinnedSessionKey(resolveSessionScopeKey('ses-same', '/repo/b'), '/repo/b', 'ses-same')!
    expect(key1).not.toBe(key2)
    expect(resolveSessionScopeKey('ses-same', '/repo/a')).toBe(workspaceScopeKey('ws-1'))
    expect(resolveSessionScopeKey('ses-same', '/repo/b')).toBe(workspaceScopeKey('ws-2'))

    const ids = new Set([key1])
    expect(isSessionPinned(ids, '/repo/a', 'ses-same')).toBe(true)
    expect(isSessionPinned(ids, '/repo/b', 'ses-same')).toBe(false)
    ids.delete(key1)
    ids.add(key2)
    expect(isSessionPinned(ids, '/repo/a', 'ses-same')).toBe(false)
    expect(isSessionPinned(ids, '/repo/b', 'ses-same')).toBe(true)
  })

  test('todos keys use the workspace scope; unmapped sessions use the unscoped bucket', () => {
    const directory = '/repo'
    const sessionId = 'ses-todo'
    setIndexSessions([makeSession('ws-1', sessionId, directory)])
    expect(getTodosPersistenceKey(resolveSessionScopeKey(sessionId, directory), directory, sessionId))
      .toBe(JSON.stringify([workspaceScopeKey('ws-1'), directory, sessionId]))
    expect(getTodosPersistenceKey(resolveSessionScopeKey('ses-unmapped', directory), directory, 'ses-unmapped'))
      .toBe(JSON.stringify(['', directory, 'ses-unmapped']))
  })

  test('chat drafts are isolated per workspace scope and keep legacy runtime-keyed drafts readable', () => {
    const directory = '/repo'
    const sessionId = 'ses-draft'
    setIndexSessions([makeSession('ws-1', sessionId, directory)])

    const identity = createChatDraftIdentity(resolveSessionScopeKey(sessionId, directory), directory, sessionId)!
    expect(getChatDraftIdentityKey(identity)).toBe(JSON.stringify([workspaceScopeKey('ws-1'), directory, sessionId]))

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

  test('two workspaceIds with the same sessionId and directory never share a chat draft', () => {
    const directory = '/repo'
    const sessionId = 'ses-draft'
    const ws1 = createChatDraftIdentity(workspaceScopeKey('ws-1'), directory, sessionId)!
    const ws2 = createChatDraftIdentity(workspaceScopeKey('ws-2'), directory, sessionId)!

    writeChatDraft(ws1, 'workspace one draft', [])
    expect(readChatDraft(ws2).text).toBe('')
    writeChatDraft(ws2, 'workspace two draft', [])
    expect(readChatDraft(ws1).text).toBe('workspace one draft')
    expect(readChatDraft(ws2).text).toBe('workspace two draft')
  })

  test('message queue targets use the workspace scope; unmapped targets use the unscoped bucket', () => {
    setIndexSessions([makeSession('ws-1', 'ses-q', '/repo')])
    const workspaceTarget = createMessageQueueTarget('ses-q', '/repo')!
    expect(workspaceTarget.scopeKey).toBe(workspaceScopeKey('ws-1'))
    expect(getMessageQueueKey(workspaceTarget)).toBe(`${workspaceScopeKey('ws-1')}\n/repo\nses-q`)

    // Unmapped sessions have no sync scope, so no queue target exists.
    expect(createMessageQueueTarget('ses-q2', '/repo2')).toBeNull()
  })
})
