import React from 'react';
import type { Session } from '@opencode-ai/sdk/v2';
import { resolveGlobalSessionDirectory, resolveGlobalSessionServerId } from '@/stores/useGlobalSessionsStore';
import { dedupeSessionsById, isSessionRelatedToProject, normalizePath } from '../utils';

type WorktreeMeta = { path: string };

type NormalizedProject = { id: string; normalizedPath: string; serverId?: string };

type Args = {
  isVSCode: boolean;
  sessions: Session[];
  archivedSessions: Session[];
  availableWorktreesByProject: Map<string, WorktreeMeta[]>;
  /**
   * The set of normalized projects the sidebar will render. Used in
   * Layer 4.13 to precompute the allowed directory set so the per-row
   * `sessionsByDirectory` Map only contains buckets the sidebar will
   * actually consume. With 10 projects × 5 worktrees and 100 sessions
   * per directory this drops the Map from N entries to the small
   * subset the sidebar needs.
   */
  normalizedProjects: NormalizedProject[];
};

export const useProjectSessionLists = (args: Args) => {
  const {
    isVSCode,
    sessions,
    archivedSessions,
    availableWorktreesByProject,
    normalizedProjects,
  } = args;

  const allowedDirectories = React.useMemo(() => {
    const map = new Map<string, Set<string>>();
    normalizedProjects.forEach((project) => {
      if (project.normalizedPath) {
        const sid = project.serverId || 'local';
        const dirs = map.get(sid) ?? new Set<string>();
        dirs.add(project.normalizedPath);
        map.set(sid, dirs);
      }
    });
    if (!isVSCode) {
      for (const [projectPath, worktrees] of availableWorktreesByProject.entries()) {
        const project = normalizedProjects.find((p) => p.normalizedPath === projectPath);
        const sid = project?.serverId || 'local';
        const dirs = map.get(sid) ?? new Set<string>();
        for (const worktree of worktrees) {
          const normalized = normalizePath(worktree.path);
          if (normalized) dirs.add(normalized);
        }
        if (dirs.size > 0) map.set(sid, dirs);
      }
    }
    return map;
  }, [normalizedProjects, availableWorktreesByProject, isVSCode]);

  const sessionsByDirectory = React.useMemo(() => {
    const next = new Map<string, Map<string, Session[]>>();
    sessions.forEach((session) => {
      const directory = resolveGlobalSessionDirectory(session);
      if (!directory) return;
      const serverId = resolveGlobalSessionServerId(session);
      const allowedForServer = allowedDirectories.get(serverId);
      if (!allowedForServer || !allowedForServer.has(directory)) return;

      const serverMap = next.get(serverId) ?? new Map<string, Session[]>();
      const collection = serverMap.get(directory) ?? [];
      collection.push(session);
      serverMap.set(directory, collection);
      next.set(serverId, serverMap);
    });
    return next;
  }, [sessions, allowedDirectories]);

  const getSessionsForProject = React.useCallback(
    (project: { normalizedPath: string; serverId?: string | null }) => {
      const effectiveServerId = project.serverId || 'local';
      const worktreesForProject = isVSCode ? [] : (availableWorktreesByProject.get(project.normalizedPath) ?? []);
      const directories = [
        project.normalizedPath,
        ...worktreesForProject
          .map((meta) => normalizePath(meta.path) ?? meta.path)
          .filter((value): value is string => Boolean(value)),
      ];

      const seen = new Set<string>();
      const collected: Session[] = [];
      const serverDirMap = sessionsByDirectory.get(effectiveServerId);

      directories.forEach((directory) => {
        const sessionsForDirectory = serverDirMap?.get(directory) ?? [];
        sessionsForDirectory.forEach((session) => {
          if (seen.has(session.id)) return;
          seen.add(session.id);
          collected.push(session);
        });
      });

      return collected;
    },
    [availableWorktreesByProject, isVSCode, sessionsByDirectory],
  );

  const getArchivedSessionsForProject = React.useCallback(
    (project: { normalizedPath: string; serverId?: string | null }) => {
      const effectiveServerId = project.serverId || 'local';

      if (isVSCode) {
        const archived = archivedSessions.filter((session) => {
          const sid = resolveGlobalSessionServerId(session);
          if (sid !== effectiveServerId) return false;
          const sessionDirectory = normalizePath((session as Session & { directory?: string | null }).directory ?? null);
          const projectWorktree = normalizePath((session as Session & { project?: { worktree?: string | null } | null }).project?.worktree ?? null);
          if (sessionDirectory) return sessionDirectory === project.normalizedPath;
          return projectWorktree === project.normalizedPath;
        });

        const unassignedLive = sessions.filter((session) => {
          const sid = resolveGlobalSessionServerId(session);
          if (sid !== effectiveServerId) return false;
          if (session.time?.archived) return false;
          const sessionDirectory = normalizePath((session as Session & { directory?: string | null }).directory ?? null);
          if (sessionDirectory) return false;
          const projectWorktree = normalizePath((session as Session & { project?: { worktree?: string | null } | null }).project?.worktree ?? null);
          return projectWorktree === project.normalizedPath;
        });

        return dedupeSessionsById([...archived, ...unassignedLive]);
      }

      const worktreesForProject = isVSCode ? [] : (availableWorktreesByProject.get(project.normalizedPath) ?? []);
      const validDirectories = new Set<string>([
        project.normalizedPath,
        ...worktreesForProject
          .map((meta) => normalizePath(meta.path) ?? meta.path)
          .filter((value): value is string => Boolean(value)),
      ]);

      const collect = (input: Session[]): Session[] => input.filter((session) => {
        if (resolveGlobalSessionServerId(session) !== effectiveServerId) return false;
        return isSessionRelatedToProject(session, project.normalizedPath, validDirectories);
      });

      const archived = collect(archivedSessions);
      const unassignedLive = sessions.filter((session) => {
        const sid = resolveGlobalSessionServerId(session);
        if (sid !== effectiveServerId) return false;
        if (session.time?.archived) return false;
        const sessionDirectory = normalizePath((session as Session & { directory?: string | null }).directory ?? null);
        if (sessionDirectory) return false;
        const projectWorktree = normalizePath((session as Session & { project?: { worktree?: string | null } | null }).project?.worktree ?? null);
        if (!projectWorktree) return false;
        return projectWorktree === project.normalizedPath || projectWorktree.startsWith(`${project.normalizedPath}/`);
      });

      return dedupeSessionsById([...archived, ...unassignedLive]);
    },
    [archivedSessions, availableWorktreesByProject, isVSCode, sessions],
  );

  return {
    getSessionsForProject,
    getArchivedSessionsForProject,
  };
};
