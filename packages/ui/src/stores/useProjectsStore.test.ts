import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type { ProjectEntry } from "@/lib/api/types"
import type { DesktopSettings } from "@/lib/desktop"
import { useProjectsStore } from "./useProjectsStore"
import { useProjectCatalogStore } from "@/projects/catalog-store"
import type { ConnectionProfileSummary, ProjectCatalogSnapshot, ProjectDescriptor } from "@/projects/types"
import { useSessionUIStore } from "@/sync/session-ui-store"
import { useDirectoryStore } from "./useDirectoryStore"
import { opencodeClient } from "@/lib/opencode/client"

const makeProject = (id: string, overrides: Partial<ProjectDescriptor> = {}): ProjectDescriptor => ({
  id,
  connectionId: 'local',
  path: `/repo/${id}`,
  canonicalPath: `/repo/${id}`,
  label: `Project ${id}`,
  orderKey: '',
  createdAt: 1,
  updatedAt: 2,
  ...overrides,
})

const makeConnection = (id: string, label: string, overrides: Partial<ConnectionProfileSummary> = {}): ConnectionProfileSummary => ({
  id,
  label,
  capabilities: { pathBrowse: false, terminal: false, files: false, git: false, eventStream: false },
  ...overrides,
})

const makeCatalogSnapshot = (
  projects: ProjectDescriptor[],
  connections: ConnectionProfileSummary[] = [],
): ProjectCatalogSnapshot => ({
  schemaVersion: 1,
  revision: 1,
  connections,
  projects,
  migration: { legacyProjectsImported: true, pendingConnectionIds: [] },
})

const originalSetDirectory = useDirectoryStore.getState().setDirectory
const originalClientSetDirectory = opencodeClient.setDirectory
const originalCatalogCreateProject = useProjectCatalogStore.getState().createProject

const installDirectorySpies = () => {
  const setDirectoryCalls: Array<[string, { showOverlay?: boolean } | undefined]> = []
  const clientSetDirectoryCalls: string[] = []
  useDirectoryStore.setState({
    setDirectory: (path: string, options?: { showOverlay?: boolean }) => {
      setDirectoryCalls.push([path, options])
    },
  })
  opencodeClient.setDirectory = (path?: string) => {
    clientSetDirectoryCalls.push(path ?? '')
  }
  return { setDirectoryCalls, clientSetDirectoryCalls }
}

describe("useProjectsStore settings synchronization", () => {
  beforeEach(() => {
    useProjectCatalogStore.setState({ snapshot: null, status: 'idle', lastError: null })
    useProjectsStore.setState({ projects: [], activeProjectId: null, manualProjectOrder: [] })
    useSessionUIStore.setState({ currentProjectId: null })
  })

  afterEach(() => {
    useDirectoryStore.setState({ setDirectory: originalSetDirectory })
    opencodeClient.setDirectory = originalClientSetDirectory
    // Tests may replace catalog actions to observe calls; restore the originals
    // so the replacement cannot leak into other suites (non-isolated runs).
    useProjectCatalogStore.setState({ createProject: originalCatalogCreateProject })
  })

  test("treats a successful empty project snapshot as authoritative", () => {
    const project = { id: "project-a", path: "/repo", label: "Repo" } as ProjectEntry
    useProjectsStore.setState({
      projects: [project],
      activeProjectId: project.id,
      manualProjectOrder: [project.id],
    })

    useProjectsStore.getState().synchronizeFromSettings({ projects: [] } as DesktopSettings)

    expect(useProjectsStore.getState().projects).toEqual([])
    expect(useProjectsStore.getState().activeProjectId).toBe(null)
    expect(useProjectsStore.getState().manualProjectOrder).toEqual([])
  })

  test('catalog projects projects from every connection into the projects list', () => {
    const local = makeProject('project-local', { path: '/repo/local', canonicalPath: '/repo/local' })
    const remote = makeProject('project-remote', {
      connectionId: 'remote-1',
      path: '/repo/remote',
      canonicalPath: '/repo/remote',
    })

    useProjectCatalogStore.setState({
      snapshot: makeCatalogSnapshot([local, remote], [
        makeConnection('local', 'This computer'),
        makeConnection('remote-1', 'Remote server'),
      ]),
      status: 'ready',
      lastError: null,
    })

    const state = useProjectsStore.getState()
    expect(state.projects.map((project) => project.id)).toEqual(['project-local', 'project-remote'])
    const localProject = state.projects.find((project) => project.id === 'project-local')
    const remoteProject = state.projects.find((project) => project.id === 'project-remote')
    expect(localProject?.connectionId).toBe('local')
    expect(localProject?.connectionLabel).toBe('This computer')
    expect(remoteProject?.connectionId).toBe('remote-1')
    expect(remoteProject?.connectionLabel).toBe('Remote server')
    expect(remoteProject?.path).toBe('/repo/remote')
    expect(state.activeProjectId).toBe('project-local')
    expect(state.manualProjectOrder).toEqual(['project-local', 'project-remote'])
  })

  test('catalog projection keeps a remote previous active project by id', () => {
    const local = makeProject('project-local', { path: '/repo/local' })
    const remote = makeProject('project-remote', {
      connectionId: 'remote-1',
      path: '/repo/remote',
    })

    useProjectsStore.setState({
      projects: [{ id: 'project-remote', path: '/repo/remote', connectionId: 'remote-1' } as ProjectEntry],
      activeProjectId: 'project-remote',
      manualProjectOrder: ['project-remote'],
    })

    useProjectCatalogStore.setState({
      snapshot: makeCatalogSnapshot([local, remote], [makeConnection('remote-1', 'Remote server')]),
      status: 'ready',
      lastError: null,
    })

    const state = useProjectsStore.getState()
    expect(state.activeProjectId).toBe('project-remote')
    expect(state.projects.find((project) => project.id === 'project-remote')?.connectionId).toBe('remote-1')
  })

  test('catalog projection adopts the project identity without legacy metadata merge', () => {
    const legacy = { id: 'legacy-path-id', path: '/repo/local', label: 'Old label', defaultModel: 'openai/gpt-5' } as ProjectEntry
    useProjectsStore.getState().synchronizeFromSettings({
      projects: [legacy],
      activeProjectId: legacy.id,
    } as DesktopSettings)

    useProjectCatalogStore.setState({
      snapshot: makeCatalogSnapshot([makeProject('project-local', { path: '/repo/local', label: 'Catalog label' })]),
      status: 'ready',
      lastError: null,
    })

    const project = useProjectsStore.getState().projects[0]
    expect(project?.id).toBe('project-local')
    expect(project?.label).toBe('Catalog label')
    // The legacy metadata bridge was removed: the catalog owns the projected
    // fields, and path-derived legacy metadata is no longer merged in.
    expect(project?.defaultModel).toBeUndefined()
  })

  test('catalog-backed add reuses an existing local project for the same path', () => {
    const local = makeProject('project-local', { path: '/repo/local', canonicalPath: '/repo/local' })
    let createCalls = 0
    useProjectCatalogStore.setState({
      snapshot: makeCatalogSnapshot([local]),
      status: 'ready',
      lastError: null,
      createProject: async () => {
        createCalls += 1
        return local
      },
    })

    const result = useProjectsStore.getState().addProject('/repo/local', { label: 'Duplicate' })

    expect(result?.id).toBe(local.id)
    expect(createCalls).toBe(0)
    expect(useProjectsStore.getState().projects).toHaveLength(1)
    expect(useProjectsStore.getState().activeProjectId).toBe(local.id)
  })

  test('activating a remote project does not set the ambient directory', () => {
    const local = makeProject('project-local', { path: '/repo/local' })
    const remote = makeProject('project-remote', {
      connectionId: 'remote-1',
      path: '/repo/remote',
    })
    useProjectCatalogStore.setState({
      snapshot: makeCatalogSnapshot([local, remote], [makeConnection('remote-1', 'Remote server')]),
      status: 'ready',
      lastError: null,
    })

    const { setDirectoryCalls, clientSetDirectoryCalls } = installDirectorySpies()

    useProjectsStore.getState().setActiveProject('project-remote')

    expect(useProjectsStore.getState().activeProjectId).toBe('project-remote')
    expect(setDirectoryCalls).toEqual([])
    expect(clientSetDirectoryCalls).toEqual([])
  })

  test('activating a local project sets the ambient directory', () => {
    const first = makeProject('project-first', { path: '/repo/first' })
    const second = makeProject('project-second', { path: '/repo/second' })
    useProjectCatalogStore.setState({
      snapshot: makeCatalogSnapshot([first, second]),
      status: 'ready',
      lastError: null,
    })

    const { setDirectoryCalls, clientSetDirectoryCalls } = installDirectorySpies()

    useProjectsStore.getState().setActiveProject('project-second')

    expect(useProjectsStore.getState().activeProjectId).toBe('project-second')
    expect(clientSetDirectoryCalls).toEqual(['/repo/second'])
    expect(setDirectoryCalls).toEqual([['/repo/second', { showOverlay: false }]])
  })

  test('settings sync never installs a remote project as the ambient directory', () => {
    useProjectsStore.setState({ projects: [], activeProjectId: null, manualProjectOrder: [] })

    const { setDirectoryCalls, clientSetDirectoryCalls } = installDirectorySpies()

    useProjectsStore.getState().synchronizeFromSettings({
      projects: [{ id: 'project-remote', path: '/repo/remote', connectionId: 'remote-1', connectionLabel: 'Remote server' }],
      activeProjectId: 'project-remote',
    } as unknown as DesktopSettings)

    expect(useProjectsStore.getState().activeProjectId).toBe('project-remote')
    expect(setDirectoryCalls).toEqual([])
    expect(clientSetDirectoryCalls).toEqual([])
  })

  test('settings sync round-trip preserves the remote connection identity', () => {
    useProjectsStore.setState({ projects: [], activeProjectId: null, manualProjectOrder: [] })

    useProjectsStore.getState().synchronizeFromSettings({
      projects: [{ id: 'project-remote', path: '/repo/remote', connectionId: 'remote-1', connectionLabel: 'Remote server' }],
      activeProjectId: 'project-remote',
    } as unknown as DesktopSettings)

    const project = useProjectsStore.getState().projects[0]
    expect(project?.connectionId).toBe('remote-1')
    expect(project?.connectionLabel).toBe('Remote server')
  })

  test('settings sync keeps two remote projects with the same path on different connections', () => {
    useProjectsStore.setState({ projects: [], activeProjectId: null, manualProjectOrder: [] })

    useProjectsStore.getState().synchronizeFromSettings({
      projects: [
        { id: 'project-remote-a', path: '/repo/shared', connectionId: 'remote-1' },
        { id: 'project-remote-b', path: '/repo/shared', connectionId: 'remote-2' },
      ],
      activeProjectId: 'project-remote-a',
    } as unknown as DesktopSettings)

    expect(useProjectsStore.getState().projects.map((project) => project.id)).toEqual(['project-remote-a', 'project-remote-b'])
  })

  test('legacy project navigation does not mutate the ambient directory inside a project session', () => {
    const first = { id: 'project-a', path: '/repo/a', label: 'A' } as ProjectEntry
    const second = { id: 'project-b', path: '/repo/b', label: 'B' } as ProjectEntry
    useProjectsStore.setState({ projects: [first, second], activeProjectId: first.id, manualProjectOrder: [first.id, second.id] })
    useSessionUIStore.setState({ currentProjectId: 'project-1' })
    const before = useDirectoryStore.getState().currentDirectory

    useProjectsStore.getState().setActiveProject(second.id)

    expect(useProjectsStore.getState().activeProjectId).toBe(second.id)
    expect(useDirectoryStore.getState().currentDirectory).toBe(before)
  })

  test('catalog-unavailable fallback still adds projects through the legacy path', () => {
    const result = useProjectsStore.getState().addProject('/repo/fallback', { label: 'Fallback' })

    expect(result?.id).toBe('/repo/fallback')
    const state = useProjectsStore.getState()
    expect(state.projects).toHaveLength(1)
    expect(state.projects[0]?.path).toBe('/repo/fallback')
    expect(state.projects[0]?.label).toBe('Fallback')
    expect(state.projects[0]?.connectionId).toBeUndefined()
    expect(state.activeProjectId).toBe('/repo/fallback')
  })
})
