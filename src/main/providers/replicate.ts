import type { ProviderDescriptor } from '../../shared/contract'
import type { GenerateInput, PollContext, PollResult, ProviderAdapter, SubmitResult } from './types'
import { probeKey, type HttpClient } from './http'

export const descriptor: ProviderDescriptor = {
  id: 'replicate',
  label: 'Replicate',
  capability: 'text-to-video',
  docsUrl: 'https://replicate.com/docs',
  keyPlaceholder: 'r8_xxxxxxxxxxxxxxxxxxxxxxxxxxxx',
  keyPrefix: 'r8_',
  defaultModel: 'minimax/video-01',
  models: ['minimax/video-01', 'google/veo-3-fast', 'tencent/hunyuan-video'],
  note: 'Runs the newest version of the named model on your Replicate account.'
}

interface Prediction {
  id?: string
  status?: string
  output?: string | string[] | { url?: string } | null
  error?: string
  urls?: { get?: string }
}

function outputUrl(output: Prediction['output']): string | null {
  if (!output) return null
  if (typeof output === 'string') return output
  if (Array.isArray(output)) {
    const first = output[0]
    if (typeof first === 'string') return first
    if (first && typeof first === 'object') return (first as { url?: string }).url ?? null
    return null
  }
  return typeof output.url === 'string' ? output.url : null
}

export function createReplicateAdapter(http: HttpClient, baseUrl: string): ProviderAdapter {
  const headers = (key: string): Record<string, string> => ({
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json'
  })

  return {
    descriptor,

    async verify(key) {
      return probeKey(http, `${baseUrl}/v1/account`, { method: 'GET', headers: headers(key) })
    },

    async submit(input: GenerateInput, key: string): Promise<SubmitResult> {
      const prediction = await http.json<Prediction>(`${baseUrl}/v1/models/${input.model}/predictions`, {
        method: 'POST',
        headers: headers(key),
        body: JSON.stringify({ input: { prompt: input.prompt, duration: input.durationSeconds } })
      })
      if (!prediction.id) throw new Error('Replicate did not return a prediction id')
      return { remoteId: prediction.id, statusUrl: prediction.urls?.get }
    },

    async poll(remote: SubmitResult, ctx: PollContext): Promise<PollResult> {
      const url = remote.statusUrl ?? `${baseUrl}/v1/predictions/${remote.remoteId}`
      const prediction = await http.json<Prediction>(url, { method: 'GET', headers: headers(ctx.key) })
      const status = (prediction.status ?? '').toLowerCase()
      if (status === 'succeeded') {
        const media = outputUrl(prediction.output)
        if (!media) return { state: 'failed', error: 'Replicate succeeded without a video output' }
        return { state: 'succeeded', url: media }
      }
      if (status === 'failed' || status === 'canceled') {
        return { state: 'failed', error: prediction.error ?? `Replicate prediction ${status}` }
      }
      return { state: 'pending', progress: status === 'processing' ? 55 : 10, detail: status || 'starting' }
    }
  }
}
