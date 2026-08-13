import React, { type JSX, type ReactNode } from 'react';
import { RuntimeAPIContext } from '@/contexts/runtimeAPIContext';
import { registerProjectRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import type { FilesAPI, RuntimeAPIs } from '@/lib/api/types';
import { createContentCachedFiles } from '@/contexts/content-cache-owner';
import { useProjectRuntime } from '@/projects/project-runtime-context';

type ContentCachedFiles = ReturnType<typeof createContentCachedFiles>;

export function RuntimeAPIProvider({ apis, children }: { apis: RuntimeAPIs; children: ReactNode }): JSX.Element {
  const { handle } = useProjectRuntime();
  const scopedApis = React.useMemo<RuntimeAPIs>(() => {
    if (!handle) return apis;

    // Project-owned capabilities must follow the selected project handle.
    // Keep the ambient API object for capabilities that are still global or
    // have not acquired a project route yet (GitHub, auth, …). Settings are
    // deliberately overlaid with the project handle's typed unavailable
    // implementation: a missing project config contract must never turn
    // into a write against the ambient runtime.
    return {
      ...apis,
      files: handle.apis.files,
      git: handle.apis.git,
      terminal: handle.apis.terminal,
      settings: handle.apis.settings,
      permissions: handle.apis.permissions,
    };
  }, [apis, handle]);

  React.useEffect(() => {
    registerProjectRuntimeAPIs(handle ? scopedApis : null);
    return () => registerProjectRuntimeAPIs(null);
  }, [handle, scopedApis]);

  // Effect-owned lifecycle: React Strict Mode dispose+remount must create a fresh
  // owner. useMemo + dispose reused a dead owner and broke text-file opens
  // (binaries skipped the pre-read, so they still appeared to work).
  const [cachedOwner, setCachedOwner] = React.useState<ContentCachedFiles | null>(null);

  React.useEffect(() => {
    const owner = createContentCachedFiles(scopedApis.files);
    setCachedOwner(owner);
    return () => {
      owner.dispose();
      setCachedOwner((current) => (current === owner ? null : current));
    };
  }, [scopedApis.files]);

  const files: FilesAPI = cachedOwner?.files ?? scopedApis.files;
  const cachedApis = React.useMemo<RuntimeAPIs>(
    () => ({
      ...scopedApis,
      files,
    }),
    [scopedApis, files],
  );
  return <RuntimeAPIContext.Provider value={cachedApis}>{children}</RuntimeAPIContext.Provider>;
}
