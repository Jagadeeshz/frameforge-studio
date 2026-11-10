import type { Aspect, ProviderDescriptor, ProviderId } from '../../shared/contract'

export interface GenerateInput {
  prompt: string
  durationSeconds: number
  aspect: Aspect
  model: string
}

export interface SubmitResult {
  remoteId: string
  statusUrl?: string
  responseUrl?: string
}

export type PollResult =
  | { state: 'pending'; progress: number; detail: string }
  | { state: 'succeeded'; url: string; headers?: Record<string, string>; costUsd?: number }
  | { state: 'failed'; error: string }

export interface PollContext {
  key: string
  model: string
}

export interface ProviderAdapter {
  readonly descriptor: ProviderDescriptor
  /** Cheap, non-generation call used by "Test connection". */
  verify(key: string): Promise<{ ok: boolean; message: string }>
  submit(input: GenerateInput, key: string): Promise<SubmitResult>
  poll(remote: SubmitResult, ctx: PollContext): Promise<PollResult>
}

export interface ProviderConfig {
  /** Overridable only for tests / self-hosted gateways. */
  baseUrls?: Partial<Record<ProviderId, string>>
  timeoutMs?: number
}

export const ASPECT_RATIOS: Record<Aspect, { runway: string; luma: string; fal: string; label: string }> = {
  '16:9': { runway: '1280:720', luma: '16:9', fal: '16:9', label: 'Landscape 16:9' },
  '9:16': { runway: '720:1280', luma: '9:16', fal: '9:16', label: 'Portrait 9:16' },
  '1:1': { runway: '960:960', luma: '1:1', fal: '1:1', label: 'Square 1:1' }
}
