import type { ProviderDescriptor } from '../../shared/contract'
import { ASPECT_RATIOS, type GenerateInput, type PollContext, type PollResult, type ProviderAdapter, type SubmitResult } from './types'
import { probeKey, type HttpClient } from './http'

export const descriptor: ProviderDescriptor = {
  id: 'luma',
  label: 'Luma Dream Machine',
  capability: 'text-to-video',
  docsUrl: 'https://docs.lumalabs.ai',
  keyPlaceholder: 'luma-xxxxxxxxxxxxxxxx',
  keyPrefix: null,
  defaultModel: 'ray-2',
  models: ['ray-2', 'ray-flash-2'],
  note: 'Ray-2 text-to-video. Generation runs on your Luma account; no footage leaves this machine.'
}

interface GenerationResponse {
  id?: string
  state?: string
  failure_reason?: string
  assets?: { video?: string }
}

export function createLumaAdapter(http: HttpClient, baseUrl: string): ProviderAdapter {
  const headers = (key: string): Record<string, string> => ({
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json'
  })

  return {
    descriptor,

    async verify(key) {
      return probeKey(http, `${baseUrl}/dream-machine/v1/generations?limit=1`, { method: 'GET', headers: headers(key) })
    },

    async submit(input: GenerateInput, key: string): Promise<SubmitResult> {
      const body = {
        prompt: input.prompt,
        model: input.model,
        aspect_ratio: ASPECT_RATIOS[input.aspect].luma,
        duration: `${input.durationSeconds}s`,
        loop: false
      }
      const generation = await http.json<GenerationResponse>(`${baseUrl}/dream-machine/v1/generations`, {
        method: 'POST',
        headers: headers(key),
        body: JSON.stringify(body)
      })
      if (!generation.id) throw new Error('Luma did not return a generation id')
      return { remoteId: generation.id }
    },

    async poll(remote: SubmitResult, ctx: PollContext): Promise<PollResult> {
      const generation = await http.json<GenerationResponse>(
        `${baseUrl}/dream-machine/v1/generations/${remote.remoteId}`,
        { method: 'GET', headers: headers(ctx.key) }
      )
      const state = (generation.state ?? '').toLowerCase()
      if (state === 'completed') {
        const url = generation.assets?.video
        if (!url) return { state: 'failed', error: 'Luma completed without a video asset' }
        return { state: 'succeeded', url }
      }
      if (state === 'failed') return { state: 'failed', error: generation.failure_reason ?? 'Luma generation failed' }
      return { state: 'pending', progress: state === 'dreaming' ? 45 : 10, detail: state || 'queued' }
    }
  }
}
