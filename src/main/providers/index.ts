import type { ProviderDescriptor, ProviderId } from '../../shared/contract'
import { PROVIDER_IDS } from '../../shared/contract'
import { createHttpClient, type HttpClient } from './http'
import type { ProviderAdapter } from './types'
import { createRunwayAdapter } from './runway'
import { createLumaAdapter } from './luma'
import { createFalAdapter } from './fal'
import { createReplicateAdapter } from './replicate'
import { createHeygenAdapter } from './heygen'
import { createOpenAiAdapter } from './openai'

export const DEFAULT_BASE_URLS: Record<ProviderId, string> = {
  runway: 'https://api.dev.runwayml.com',
  luma: 'https://api.lumalabs.ai',
  fal: 'https://queue.fal.run',
  replicate: 'https://api.replicate.com',
  heygen: 'https://api.heygen.com',
  openai: 'https://api.openai.com'
}

/** Extra hosts a provider legitimately redirects to for queue polling. */
const EXTRA_HOSTS: Partial<Record<ProviderId, string[]>> = {
  fal: ['queue.fal.run', 'fal.run']
}

export type ProviderRegistry = ReturnType<typeof createProviderRegistry>

export function createProviderRegistry(options?: {
  baseUrls?: Partial<Record<ProviderId, string>>
  allowLoopback?: boolean
  timeoutMs?: number
}): {
  list(): ProviderDescriptor[]
  get(id: ProviderId): ProviderAdapter
  http: HttpClient
} {
  const baseUrls: Record<ProviderId, string> = { ...DEFAULT_BASE_URLS, ...options?.baseUrls }
  const hosts = new Set<string>()
  for (const id of PROVIDER_IDS) {
    try {
      hosts.add(new URL(baseUrls[id]).hostname)
    } catch {
      // A malformed override is caught when the client rejects the URL.
    }
    for (const extra of EXTRA_HOSTS[id] ?? []) hosts.add(extra)
  }

  const http = createHttpClient({
    allowHosts: [...hosts],
    allowLoopback: options?.allowLoopback,
    timeoutMs: options?.timeoutMs
  })

  const adapters: Record<ProviderId, ProviderAdapter> = {
    runway: createRunwayAdapter(http, baseUrls.runway),
    luma: createLumaAdapter(http, baseUrls.luma),
    fal: createFalAdapter(http, baseUrls.fal),
    replicate: createReplicateAdapter(http, baseUrls.replicate),
    heygen: createHeygenAdapter(http, baseUrls.heygen),
    openai: createOpenAiAdapter(http, baseUrls.openai)
  }

  return {
    http,
    list: () => PROVIDER_IDS.map((id) => adapters[id].descriptor),
    get: (id) => {
      const adapter = adapters[id]
      if (!adapter) throw new Error(`Unknown provider: ${String(id)}`)
      return adapter
    }
  }
}
