import type { ProviderDescriptor } from '../../shared/contract'
import type { GenerateInput, PollContext, PollResult, ProviderAdapter, SubmitResult } from './types'
import { probeKey, type HttpClient } from './http'

export const descriptor: ProviderDescriptor = {
  id: 'openai',
  label: 'OpenAI Sora',
  capability: 'text-to-video',
  docsUrl: 'https://platform.openai.com/docs/api-reference/videos',
  keyPlaceholder: 'sk-...',
  keyPrefix: 'sk-',
  defaultModel: 'sora-2',
  models: ['sora-2', 'sora-2-pro'],
  note: 'Videos API. Output is fetched with your key, so the download stays authenticated.'
}

interface VideoResponse {
  id?: string
  status?: string
  progress?: number
  error?: { message?: string } | null
}

const SIZES: Record<string, string> = {
  '16:9': '1280x720',
  '9:16': '720x1280',
  '1:1': '1280x720'
}

export function createOpenAiAdapter(http: HttpClient, baseUrl: string): ProviderAdapter {
  const headers = (key: string): Record<string, string> => ({
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json'
  })

  return {
    descriptor,

    async verify(key) {
      return probeKey(http, `${baseUrl}/v1/models`, { method: 'GET', headers: headers(key) })
    },

    async submit(input: GenerateInput, key: string): Promise<SubmitResult> {
      const seconds = input.durationSeconds <= 6 ? '4' : input.durationSeconds <= 8 ? '8' : '12'
      const body = {
        model: input.model,
        prompt: input.prompt,
        size: SIZES[input.aspect] ?? SIZES['16:9'],
        seconds
      }
      const video = await http.json<VideoResponse>(`${baseUrl}/v1/videos`, {
        method: 'POST',
        headers: headers(key),
        body: JSON.stringify(body)
      })
      if (!video.id) throw new Error('OpenAI did not return a video id')
      return { remoteId: video.id, responseUrl: `${baseUrl}/v1/videos/${video.id}/content` }
    },

    async poll(remote: SubmitResult, ctx: PollContext): Promise<PollResult> {
      const video = await http.json<VideoResponse>(`${baseUrl}/v1/videos/${remote.remoteId}`, {
        method: 'GET',
        headers: headers(ctx.key)
      })
      const status = (video.status ?? '').toLowerCase()
      if (status === 'completed') {
        const url = remote.responseUrl ?? `${baseUrl}/v1/videos/${remote.remoteId}/content`
        return { state: 'succeeded', url, headers: { Authorization: `Bearer ${ctx.key}` } }
      }
      if (status === 'failed') return { state: 'failed', error: video.error?.message ?? 'OpenAI reported a failed render' }
      return { state: 'pending', progress: Math.round(video.progress ?? 0), detail: status || 'queued' }
    }
  }
}
