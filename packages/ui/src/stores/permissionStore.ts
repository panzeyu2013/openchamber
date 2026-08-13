import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { Session } from "@opencode-ai/sdk/v2/client";
import { autoRespondsPermission, type PermissionAutoAcceptMap } from "./utils/permissionAutoAccept";
import { getAllSyncSessionMap } from "@/sync/sync-refs";
import { runtimeFetch } from "@/lib/runtime-fetch";
import { isVSCodeRuntime } from "@/lib/desktop";
import { createDeferredSafeJSONStorage } from "./utils/safeStorage";
import { useSessionUIStore } from "@/sync/session-ui-store";
import { opencodeClient } from "@/lib/opencode/client";
import { getSyncScopeKey } from "@/sync/sync-refs";
import { projectIdFromScopeKey } from "@/projects/identity";

type PermissionPolicySnapshot = {
    sessions: PermissionAutoAcceptMap;
    revision?: number;
};

const normalizeRevision = (value: unknown): number | undefined => (
    Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : undefined
);

interface PermissionStore {
    autoAccept: PermissionAutoAcceptMap;
    loaded: boolean;
    saving: boolean;
    lastAppliedRevision: number;
    activeScopeKey: string | null;
    legacyCandidate: PermissionAutoAcceptMap | null;
    legacyRuntimeKey: string | null;
    hydrate: () => Promise<void>;
    applySnapshot: (snapshot: PermissionPolicySnapshot, expectedScopeKey?: string) => void;
    reset: () => void;
    isSessionAutoAccepting: (sessionId: string) => boolean;
    setSessionAutoAccept: (sessionId: string, enabled: boolean) => Promise<void>;
}

const readSnapshot = async (response: Response): Promise<PermissionPolicySnapshot> => {
    if (!response.ok) throw new Error(`Permission auto-accept request failed (${response.status})`);
    const payload = await response.json() as Partial<PermissionPolicySnapshot>;
    if (!payload.sessions || typeof payload.sessions !== "object") {
        throw new Error("Invalid permission auto-accept response");
    }
    const sessions: PermissionAutoAcceptMap = {};
    for (const [sessionId, enabled] of Object.entries(payload.sessions)) {
        if (sessionId && typeof enabled === "boolean") sessions[sessionId] = enabled;
    }
    return { sessions, revision: normalizeRevision(payload.revision) };
};

const requestSnapshot = async (path: string, init?: RequestInit) => readSnapshot(await runtimeFetch(path, init));

const isAutoAccepting = (
    autoAccept: PermissionAutoAcceptMap,
    sessionById: ReadonlyMap<string, Session>,
    sessionId: string,
) => autoRespondsPermission({ autoAccept, sessions: [], sessionById, sessionID: sessionId });

type PermissionOperation = { generation: number; scopeKey: string; sequence: number };
let generation = 0;
let operationSequence = 0;
let latestStartedSequence = 0;
const pendingSavingOperations = new Set<number>();

const beginOperation = (): PermissionOperation => {
    const operation = { generation, scopeKey: getSyncScopeKey(), sequence: ++operationSequence };
    latestStartedSequence = operation.sequence;
    return operation;
};

const isCurrentOperation = (operation: PermissionOperation) => (
    operation.generation === generation && operation.scopeKey === getSyncScopeKey()
);

const normalizeSessions = (value: unknown): PermissionAutoAcceptMap => {
    const sessions: PermissionAutoAcceptMap = {};
    if (!value || typeof value !== "object" || Array.isArray(value)) return sessions;
    for (const [sessionId, enabled] of Object.entries(value)) {
        if (sessionId && typeof enabled === "boolean") sessions[sessionId] = enabled;
    }
    return sessions;
};

export const usePermissionStore = create<PermissionStore>()(persist((set, get) => ({
    autoAccept: {},
    loaded: false,
    saving: false,
    lastAppliedRevision: -1,
    activeScopeKey: null,
    legacyCandidate: null,
    legacyRuntimeKey: null,

    hydrate: async () => {
        const operation = beginOperation();
        if (get().activeScopeKey && get().activeScopeKey !== operation.scopeKey) {
            set({ autoAccept: {}, loaded: false, lastAppliedRevision: -1, activeScopeKey: operation.scopeKey });
        }
        if (projectIdFromScopeKey(operation.scopeKey)) {
            set({ autoAccept: {}, loaded: false, lastAppliedRevision: -1, activeScopeKey: operation.scopeKey });
            return;
        }
        const legacyCandidate = get().legacyCandidate;
        let legacyRuntimeKey = get().legacyRuntimeKey;
        if (legacyCandidate && !legacyRuntimeKey) {
            legacyRuntimeKey = operation.scopeKey;
            set({ legacyRuntimeKey });
        }
        let snapshot = await requestSnapshot("/api/permission-auto-accept");
        if (!isCurrentOperation(operation)) return;
        const legacyEntries = legacyRuntimeKey === operation.scopeKey
            ? Object.entries(legacyCandidate ?? {})
            : [];
        if (Object.keys(snapshot.sessions).length === 0 && legacyEntries.length > 0) {
            for (const [sessionId, enabled] of legacyEntries) {
                if (!sessionId || typeof enabled !== "boolean") continue;
                snapshot = await requestSnapshot(
                    `/api/permission-auto-accept/sessions/${encodeURIComponent(sessionId)}`,
                    {
                        method: "PUT",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ enabled }),
                    },
                );
                if (!isCurrentOperation(operation)) return;
            }
        }
        if (!isCurrentOperation(operation)) return;
        if (snapshot.revision === undefined && operation.sequence !== latestStartedSequence) return;
        get().applySnapshot(snapshot, operation.scopeKey);
        if (legacyRuntimeKey === operation.scopeKey) {
            set({ legacyCandidate: null, legacyRuntimeKey: null });
        }
    },

    reset: () => {
        generation += 1;
        latestStartedSequence = 0;
        pendingSavingOperations.clear();
        set({ autoAccept: {}, loaded: false, saving: false, lastAppliedRevision: -1, activeScopeKey: null });
    },

    applySnapshot: (snapshot, expectedScopeKey) => {
        const currentScopeKey = getSyncScopeKey();
        if (expectedScopeKey && expectedScopeKey !== currentScopeKey) return;
        if (projectIdFromScopeKey(currentScopeKey)) return;
        const sessions = normalizeSessions(snapshot.sessions);
        const revision = normalizeRevision(snapshot.revision);
        set((state) => {
            if (revision === undefined && state.lastAppliedRevision >= 0) return state;
            if (revision !== undefined && revision < state.lastAppliedRevision) return state;
            return {
                autoAccept: sessions,
                loaded: true,
                activeScopeKey: currentScopeKey,
                ...(revision !== undefined ? { lastAppliedRevision: revision } : {}),
            };
        });
    },

    isSessionAutoAccepting: (sessionId) => {
        if (!sessionId) return false;
        if (get().activeScopeKey && get().activeScopeKey !== getSyncScopeKey()) return false;
        const autoAccept = get().autoAccept;
        if (Object.keys(autoAccept).length === 0) return false;
        return isAutoAccepting(autoAccept, getAllSyncSessionMap(), sessionId);
    },

    setSessionAutoAccept: async (sessionId, enabled) => {
        if (!sessionId) return;
        const operation = beginOperation();
        if (get().activeScopeKey && get().activeScopeKey !== operation.scopeKey) {
            set({ autoAccept: {}, loaded: false, lastAppliedRevision: -1, activeScopeKey: operation.scopeKey });
        }
        if (projectIdFromScopeKey(operation.scopeKey)) {
            set({ autoAccept: {}, loaded: false, lastAppliedRevision: -1, activeScopeKey: operation.scopeKey });
            throw new Error('Permission auto-accept is unavailable for project-bound sessions.');
        }
        pendingSavingOperations.add(operation.sequence);
        set({ saving: true });
        try {
            const directory = useSessionUIStore.getState().getDirectoryForSession(sessionId)
                ?? opencodeClient.getDirectory()
                ?? undefined;
            const snapshot = await requestSnapshot(
                `/api/permission-auto-accept/sessions/${encodeURIComponent(sessionId)}`,
                {
                    method: "PUT",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ enabled, directory }),
                },
            );
            if (!isCurrentOperation(operation)) return;
            if (snapshot.revision === undefined && operation.sequence !== latestStartedSequence) return;
            get().applySnapshot(snapshot, operation.scopeKey);
            if (isCurrentOperation(operation) && isVSCodeRuntime() && enabled) {
                const { reconcileVSCodePendingPermissions } = await import("@/sync/vscode-permission-auto-accept");
                if (isCurrentOperation(operation)) {
                    void reconcileVSCodePendingPermissions(directory).catch(() => undefined);
                }
            }
        } finally {
            if (isCurrentOperation(operation)) {
                pendingSavingOperations.delete(operation.sequence);
                set({ saving: pendingSavingOperations.size > 0 });
            }
        }
    },

}), {
    name: "permission-store",
    storage: createDeferredSafeJSONStorage(),
    version: 2,
    migrate: (persisted, version) => {
        const state = persisted && typeof persisted === "object" ? persisted as Record<string, unknown> : {};
        if (version < 2) {
            const legacyCandidate = normalizeSessions(state.autoAccept);
            return {
                legacyCandidate: Object.keys(legacyCandidate).length > 0 ? legacyCandidate : null,
                legacyRuntimeKey: null,
            };
        }
        return state;
    },
    partialize: (state) => ({
        legacyCandidate: state.legacyCandidate,
        legacyRuntimeKey: state.legacyRuntimeKey,
    }),
}));
