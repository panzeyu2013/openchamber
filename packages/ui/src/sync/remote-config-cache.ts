import { create } from "zustand"
import { useStore } from "zustand"
import { useCallback, useEffect } from "react"
import { opencodeClient } from "@/lib/opencode/client"
import type { Config } from "@opencode-ai/sdk/v2"

const TTL_MS = 60_000
const STALE_MS = 30_000
const POLL_MS = 5_000

interface CachedEntry {
  config: Config
  fetchedAt: number
}

interface RemoteConfigState {
  configs: Record<string, CachedEntry | null>
  loading: Record<string, boolean>
  errors: Record<string, string>
}

interface RemoteConfigActions {
  setLoading: (serverId: string, loading: boolean) => void
  setConfig: (serverId: string, config: Config | null, fetchedAt: number) => void
  setError: (serverId: string, error: string) => void
  clearConfig: (serverId: string) => void
}

export const useRemoteConfigStore = create<RemoteConfigState & RemoteConfigActions>()((set) => ({
  configs: {},
  loading: {},
  errors: {},

  setLoading: (serverId, loading) =>
    set((state) => {
      if (state.loading[serverId] === loading) return state
      if (loading) return { loading: { ...state.loading, [serverId]: true } }
      const { [serverId]: _, ...rest } = state.loading
      return { loading: rest }
    }),

  setConfig: (serverId, config, fetchedAt) =>
    set((state) => {
      const { [serverId]: _l, ...nextLoading } = state.loading
      const { [serverId]: _e, ...nextErrors } = state.errors
      return {
        configs: { ...state.configs, [serverId]: config ? { config, fetchedAt } : null },
        loading: nextLoading,
        errors: nextErrors,
      }
    }),

  setError: (serverId, error) =>
    set((state) => {
      const { [serverId]: _l, ...nextLoading } = state.loading
      return {
        loading: nextLoading,
        errors: { ...state.errors, [serverId]: error },
      }
    }),

  clearConfig: (serverId) =>
    set((state) => {
      const { [serverId]: _c, ...nextConfigs } = state.configs
      const { [serverId]: _l, ...nextLoading } = state.loading
      const { [serverId]: _e, ...nextErrors } = state.errors
      return { configs: nextConfigs, loading: nextLoading, errors: nextErrors }
    }),
}))

const inFlightRequests = new Map<string, Promise<Config | null>>()

async function fetchRemoteConfig(
  serverId: string,
  opts?: { showLoading?: boolean },
): Promise<Config | null> {
  const existing = inFlightRequests.get(serverId)
  if (existing) return existing

  const store = useRemoteConfigStore.getState()
  if (opts?.showLoading !== false) {
    store.setLoading(serverId, true)
  }

  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), 30_000)

  const promise = (async () => {
    try {
      const client = opencodeClient.getServerClient(serverId)
      const result = await client.config.get({ signal: controller.signal })
      if (!result.data) throw new Error("empty config response")
      store.setConfig(serverId, result.data, Date.now())
      return result.data
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (controller.signal.aborted) {
        store.setError(serverId, `Config fetch timed out for ${serverId}`)
      } else {
        store.setError(serverId, message)
      }
      return null
    } finally {
      clearTimeout(timeoutId)
      inFlightRequests.delete(serverId)
    }
  })()

  inFlightRequests.set(serverId, promise)
  return promise
}

export function useRemoteConfig(
  serverId: string,
): { config: Config | null; isLoading: boolean; error: string | null } {
  const configEntry = useStore(
    useRemoteConfigStore,
    useCallback((s) => s.configs[serverId] ?? null, [serverId]),
  )
  const isLoading = useStore(
    useRemoteConfigStore,
    useCallback((s) => s.loading[serverId] === true, [serverId]),
  )
  const error = useStore(
    useRemoteConfigStore,
    useCallback((s) => s.errors[serverId] ?? null, [serverId]),
  )

  useEffect(() => {
    if (!serverId) return

    const trigger = () => {
      const state = useRemoteConfigStore.getState()
      const entry = state.configs[serverId]
      const loading = state.loading[serverId]

      if (!entry) {
        if (!loading) fetchRemoteConfig(serverId)
        return
      }

      const age = Date.now() - entry.fetchedAt
      if (age >= TTL_MS) {
        state.clearConfig(serverId)
        fetchRemoteConfig(serverId)
      } else if (age > STALE_MS && !loading) {
        fetchRemoteConfig(serverId, { showLoading: false })
      }
    }

    trigger()
    const interval = setInterval(trigger, POLL_MS)
    return () => clearInterval(interval)
  }, [serverId])

  return {
    config: configEntry?.config ?? null,
    isLoading: !configEntry && isLoading,
    error,
  }
}
