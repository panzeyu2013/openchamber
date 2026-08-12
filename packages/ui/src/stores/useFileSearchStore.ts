import React from 'react';
import { create } from 'zustand';
import { devtools } from 'zustand/middleware';
import type { OpencodeService, ProjectFileSearchHit } from '@/lib/opencode/client';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { resolveActiveWorkspaceId, useWorkspaceSessionIndexStore } from '@/workspaces/session-index-store';
import { workspaceScopeKey } from '@/workspaces/identity';
import { useWorkspaceRuntime } from '@/workspaces/workspace-runtime-context';
import { getSyncOpencodeService } from '@/sync/sync-refs';

const resolveActiveWorkspaceScopeKey = (): string => {
  const { currentSessionId, currentSessionDirectory } = useSessionUIStore.getState();
  const sessions = useWorkspaceSessionIndexStore.getState().snapshot?.sessions;
  const workspaceId = resolveActiveWorkspaceId(sessions, currentSessionId, currentSessionDirectory);
  return workspaceId ? workspaceScopeKey(workspaceId) : '';
};

const CACHE_TTL_MS = 30_000;
const MAX_CACHE_ENTRIES = 40;
const DEFAULT_SEARCH_LIMIT = 60;

interface FileSearchCacheEntry {
  files: ProjectFileSearchHit[];
  timestamp: number;
}

type FileSearchTransport = Pick<OpencodeService, 'searchFiles'>;

type FileSearchRequestContext = {
  scopeKey?: string;
  transport?: FileSearchTransport;
};

interface FileSearchStoreState {
  cache: Record<string, FileSearchCacheEntry>;
  cacheKeys: string[];
  inFlight: Record<string, Promise<ProjectFileSearchHit[]>>;
  searchFiles: (
    directory: string,
    query: string,
    limit?: number,
    options?: { includeHidden?: boolean; respectGitignore?: boolean; type?: 'file' | 'directory' },
    context?: FileSearchRequestContext,
  ) => Promise<ProjectFileSearchHit[]>;
  invalidateDirectory: (directory?: string | null) => void;
}

const buildCacheKey = (
  scopeKey: string,
  directory: string,
  query: string,
  limit: number,
  includeHidden: boolean,
  respectGitignore: boolean,
  type: 'file' | 'directory'
) => {
  const normalizedDirectory = directory.trim();
  const normalizedQuery = query.trim().toLowerCase();
  return JSON.stringify([scopeKey, normalizedDirectory, normalizedQuery, limit, includeHidden, respectGitignore, type]);
};

const cacheKeyMatchesDirectory = (cacheKey: string, directory: string) => {
  try {
    const value: unknown = JSON.parse(cacheKey);
    return Array.isArray(value) && value[0] === resolveActiveWorkspaceScopeKey() && value[1] === directory;
  } catch {
    return false;
  }
};

export const useFileSearchStore = create<FileSearchStoreState>()(
  devtools(
    (set, get) => ({
      cache: {},
      cacheKeys: [],
      inFlight: {},
      async searchFiles(directory, query, limit = DEFAULT_SEARCH_LIMIT, options, context) {
        if (!directory || directory.trim().length === 0) {
          return [];
        }

        const normalizedDirectory = directory.trim();
        const scopeKey = context?.scopeKey ?? resolveActiveWorkspaceScopeKey();
        const normalizedQuery = typeof query === 'string' ? query.trim() : '';
        const includeHidden = Boolean(options?.includeHidden);
        const respectGitignore = options?.respectGitignore ?? true;
        const type = options?.type === 'directory' ? 'directory' : 'file';
        const key = buildCacheKey(scopeKey, normalizedDirectory, normalizedQuery, limit, includeHidden, respectGitignore, type);
        const now = Date.now();
        const cached = get().cache[key];

        if (cached && now - cached.timestamp < CACHE_TTL_MS) {
          return cached.files;
        }

        const inflight = get().inFlight[key];
        if (inflight) {
          return inflight;
        }

        const transport = context?.transport ?? getSyncOpencodeService();
        const searchPromise = transport
          .searchFiles(normalizedQuery, {
            directory: normalizedDirectory,
            limit,
            includeHidden,
            respectGitignore,
            dirs: type !== 'file',
            type,
          })
          .then((files) => {
            set((state) => {
              if (state.inFlight[key] !== searchPromise) {
                return state;
              }

              const nextCache = { ...state.cache, [key]: { files, timestamp: Date.now() } };
              const nextKeys = state.cacheKeys.filter((cacheKey) => cacheKey !== key);
              nextKeys.push(key);

              while (nextKeys.length > MAX_CACHE_ENTRIES) {
                const oldestKey = nextKeys.shift();
                if (oldestKey) {
                  delete nextCache[oldestKey];
                }
              }

              return {
                cache: nextCache,
                cacheKeys: nextKeys,
              };
            });
            return files;
          })
          .finally(() => {
            set((state) => {
              if (state.inFlight[key] !== searchPromise) {
                return state;
              }

              const nextInFlight = { ...state.inFlight };
              delete nextInFlight[key];
              return { inFlight: nextInFlight };
            });
          });

        set((state) => ({
          inFlight: {
            ...state.inFlight,
            [key]: searchPromise,
          },
        }));

        return searchPromise;
      },
      invalidateDirectory(directory) {
        if (!directory || directory.trim().length === 0) {
          set({ cache: {}, cacheKeys: [], inFlight: {} });
          return;
        }

        const normalizedDirectory = directory.trim();

        set((state) => {
          const nextCache = { ...state.cache };
          const nextKeys = state.cacheKeys.filter((cacheKey) => {
            if (cacheKeyMatchesDirectory(cacheKey, normalizedDirectory)) {
              delete nextCache[cacheKey];
              return false;
            }
            return true;
          });

          const nextInFlightEntries = Object.entries(state.inFlight).filter(
            ([key]) => !cacheKeyMatchesDirectory(key, normalizedDirectory)
          );
          const nextInFlight = Object.fromEntries(nextInFlightEntries);

          return {
            cache: nextCache,
            cacheKeys: nextKeys,
            inFlight: nextInFlight,
          };
        });
      },
    }),
    {
      name: 'file-search-store',
    }
  )
);

/**
 * Search through the current workspace handle when one is mounted. The store
 * keeps the legacy singleton fallback for non-workspace mounts, but callers
 * should use this hook so a workspace search cannot accidentally follow the
 * ambient runtime endpoint.
 */
export const useScopedFileSearch = (): FileSearchStoreState['searchFiles'] => {
  const searchFiles = useFileSearchStore((state) => state.searchFiles);
  const { handle } = useWorkspaceRuntime();
  const scopeKey = handle?.scopeKey ?? resolveActiveWorkspaceScopeKey();

  return React.useCallback(
    (directory, query, limit, options) => searchFiles(directory, query, limit, options, {
      scopeKey,
      transport: handle?.service,
    }),
    [handle?.service, scopeKey, searchFiles],
  );
};
