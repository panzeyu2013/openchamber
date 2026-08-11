import { beforeEach, describe, expect, test } from "bun:test"
import type { ProjectEntry } from "@/lib/api/types"
import type { DesktopSettings } from "@/lib/desktop"
import { useProjectsStore } from "./useProjectsStore"
import { useWorkspaceCatalogStore } from "@/workspaces/catalog-store"
import type { WorkspaceCatalogSnapshot, WorkspaceDescriptor } from "@/workspaces/types"
import { useSessionUIStore } from "@/sync/session-ui-store"
import { useDirectoryStore } from "./useDirectoryStore"

const makeWorkspace = (id: string, overrides: Partial<WorkspaceDescriptor> = {}): WorkspaceDescriptor => ({
  id,
  connectionId: 'local',
  path: `/repo/${id}`,
  canonicalPath: `/repo/${id}`,
  label: `Workspace ${id}`,
  orderKey: '',
  createdAt: 1,
  updatedAt: 2,
  ...overrides,
})

const makeCatalogSnapshot = (workspaces: WorkspaceDescriptor[]): WorkspaceCatalogSnapshot => ({
  schemaVersion: 1,
  revision: 1,
  connections: [],
  workspaces,
  migration: { legacyProjectsImported: true, pendingConnectionIds: [] },
})

describe("useProjectsStore settings synchronization", () => {
  beforeEach(() => {
    useWorkspaceCatalogStore.setState({ snapshot: null, status: 'idle', lastError: null })
    useProjectsStore.setState({ projects: [], activeProjectId: null, manualProjectOrder: [] })
    useSessionUIStore.setState({ currentWorkspaceId: null })
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

  test('projects catalog takes priority for the local projection and excludes remote workspaces', () => {
    const local = makeWorkspace('workspace-local', { path: '/repo/local', canonicalPath: '/repo/local' })
    const remote = makeWorkspace('workspace-remote', {
      connectionId: 'remote-1',
      path: '/repo/remote',
      canonicalPath: '/repo/remote',
    })

    useWorkspaceCatalogStore.setState({
      snapshot: makeCatalogSnapshot([remote, local]),
      status: 'ready',
      lastError: null,
    })

    const state = useProjectsStore.getState()
    expect(state.projects.map((project) => project.id)).toEqual(['workspace-local'])
    expect(state.projects[0]?.path).toBe('/repo/local')
    expect(state.activeProjectId).toBe('workspace-local')
    expect(state.manualProjectOrder).toEqual(['workspace-local'])
  })

  test('catalog projection preserves legacy metadata while adopting workspace identity', () => {
    const legacy = { id: 'legacy-path-id', path: '/repo/local', label: 'Old label', defaultModel: 'openai/gpt-5' } as ProjectEntry
    useProjectsStore.getState().synchronizeFromSettings({
      projects: [legacy],
      activeProjectId: legacy.id,
    } as DesktopSettings)

    useWorkspaceCatalogStore.setState({
      snapshot: makeCatalogSnapshot([makeWorkspace('workspace-local', { path: '/repo/local', label: 'Catalog label' })]),
      status: 'ready',
      lastError: null,
    })

    const project = useProjectsStore.getState().projects[0]
    expect(project?.id).toBe('workspace-local')
    expect(project?.label).toBe('Catalog label')
    expect(project?.defaultModel).toBe('openai/gpt-5')
  })

  test('catalog-backed add reuses an existing local workspace for the same path', () => {
    const local = makeWorkspace('workspace-local', { path: '/repo/local', canonicalPath: '/repo/local' })
    let createCalls = 0
    useWorkspaceCatalogStore.setState({
      snapshot: makeCatalogSnapshot([local]),
      status: 'ready',
      lastError: null,
      createWorkspace: async () => {
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

  test('legacy project navigation does not mutate the ambient directory inside a workspace session', () => {
    const first = { id: 'project-a', path: '/repo/a', label: 'A' } as ProjectEntry
    const second = { id: 'project-b', path: '/repo/b', label: 'B' } as ProjectEntry
    useProjectsStore.setState({ projects: [first, second], activeProjectId: first.id, manualProjectOrder: [first.id, second.id] })
    useSessionUIStore.setState({ currentWorkspaceId: 'workspace-1' })
    const before = useDirectoryStore.getState().currentDirectory

    useProjectsStore.getState().setActiveProject(second.id)

    expect(useProjectsStore.getState().activeProjectId).toBe(second.id)
    expect(useDirectoryStore.getState().currentDirectory).toBe(before)
  })
})
