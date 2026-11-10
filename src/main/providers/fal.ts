import type { ProviderDescriptor } from '../../shared/contract'
import { ASPECT_RATIOS, type GenerateInput, type PollContext, type PollResult, type ProviderAdapter, type SubmitResult } from './types'
import { probeKey, type HttpClient } from './http'

export const descriptor: ProviderDescriptor = {
  id: 'fal',
  label: 'fal.ai',
  capability: 'text-to-video',
  docsUrl: 'https://docs.fal.ai',
  keyPlaceholder: 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx:xxxxxxxx',
  keyPrefix: null,
  defaultModel: 'fal-ai/kling-video/v2/master/text-to-video',
  models: [
    'fal-ai/kling-video/v2/master/text-to-video',
    'fal-ai/minimax/hailuo-02/standard/text-to-video',
    'fal-ai/veo3'
  ],
  note: 'Queue-based inference. Model id is sent as the path, so any fal text-to-video endpoint works.'
}

interface QueueSubmit {
  request_id?: string
  status_url?: string
  response_url?: string
}

interface QueueStatus {
  status?: string
}

interface QueueResult {
  video?: { url?: string }
  data?: { video?: { url?: string } }
}

export function createFalAdapter(http: HttpClient, baseUrl: string): ProviderAdapter {
  const headers = (key: string): Record<string, string> => ({
    Authorization: `Key ${key}`,
    'Content-Type': 'application/json'
  })

  return {
    descriptor,

    async verify(key) {
      return probeKey(http, `${baseUrl}/${descriptor.defaultModel}`, { method: 'GET', headers: headers(key) })
    },

    async submit(input: GenerateInput, key: string): Promise<SubmitResult> {
      const body = {
        prompt: input.prompt,
        aspect_ratio: ASPECT_RATIOS[input.aspect].fal,
        duration: String(input.durationSeconds)
      }
      const queued = await http.json<QueueSubmit>(`${baseUrl}/${input.model}`, {
        method: 'POST',
        headers: headers(key),
        body: JSON.stringify(body)
      })
      if (!queued.request_id) throw new Error('fal did not return a request id')
      return {
        remoteId: queued.request_id,
        statusUrl: queued.status_url ?? `${baseUrl}/requests/${queued.request_id}/status`,
        responseUrl: queued.response_url ?? `${baseUrl}/requests/${queued.request_id}`
      }
    },

    async poll(remote: SubmitResult, ctx: PollContext): Promise<PollResult> {
      const statusUrl = remote.statusUrl
      const responseUrl = remote.responseUrl
      if (!statusUrl || !responseUrl) return { state: 'failed', error: 'fal returned an incomplete queue descriptor' }

      const status = await http.json<QueueStatus>(statusUrl, { method: 'GET', headers: headers(ctx.key) })
      const state = (status.status ?? '').toUpperCase()
      if (state === 'COMPLETED') {
        const result = await http.json<QueueResult>(responseUrl, { method: 'GET', headers: headers(ctx.key) })
        const url = result.video?.url ?? result.data?.video?.url
        if (!url) return { state: 'failed', error: 'fal completed without a video URL' }
        return { state: 'succeeded', url }
      }
      if (state === 'ERROR' || state === 'FAILED') return { state: 'failed', error: 'fal reported a failed request' }
      return { state: 'pending', progress: state === 'IN_PROGRESS' ? 55 : 15, detail: state || 'IN_QUEUE' }
    }
  }
}
