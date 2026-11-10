import type { ProviderDescriptor } from '../../shared/contract'
import { ASPECT_RATIOS, type GenerateInput, type PollContext, type PollResult, type ProviderAdapter, type SubmitResult } from './types'
import { probeKey, type HttpClient } from './http'

export const descriptor: ProviderDescriptor = {
  id: 'runway',
  label: 'Runway',
  capability: 'text-to-video',
  docsUrl: 'https://docs.dev.runwayml.com',
  keyPlaceholder: 'key_xxxxxxxxxxxxxxxxxxxxxxxx',
  keyPrefix: 'key_',
  defaultModel: 'gen4_turbo',
  models: ['gen4_turbo', 'gen3a_turbo'],
  note: 'Gen-4 Turbo text-to-video. Billed per second of output on your own Runway account.'
}

const API_VERSION = '2024-11-06'

interface TaskResponse {
  id?: string
  status?: string
  progress?: number
  output?: string[] | string
  failure?: string
  error?: string
}

export function createRunwayAdapter(http: HttpClient, baseUrl: string): ProviderAdapter {
  const headers = (key: string): Record<string, string> => ({
    Authorization: `Bearer ${key}`,
    'X-Runway-Version': API_VERSION,
    'Content-Type': 'application/json'
  })

  return {
    descriptor,

    async verify(key) {
      return probeKey(http, `${baseUrl}/v1/organization`, { method: 'GET', headers: headers(key) })
    },

    async submit(input: GenerateInput, key: string): Promise<SubmitResult> {
      const body = {
        model: input.model,
        promptText: input.prompt,
        ratio: ASPECT_RATIOS[input.aspect].runway,
        duration: input.durationSeconds <= 5 ? 5 : 10
      }
      const task = await http.json<TaskResponse>(`${baseUrl}/v1/text_to_video`, {
        method: 'POST',
        headers: headers(key),
        body: JSON.stringify(body)
      })
      if (!task.id) throw new Error('Runway did not return a task id')
      return { remoteId: task.id }
    },

    async poll(remote: SubmitResult, ctx: PollContext): Promise<PollResult> {
      const task = await http.json<TaskResponse>(`${baseUrl}/v1/tasks/${remote.remoteId}`, {
        method: 'GET',
        headers: headers(ctx.key)
      })
      const status = (task.status ?? '').toUpperCase()
      if (status === 'SUCCEEDED') {
        const url = Array.isArray(task.output) ? task.output[0] : task.output
        if (!url) return { state: 'failed', error: 'Runway reported success without an output URL' }
        return { state: 'succeeded', url }
      }
      if (status === 'FAILED' || status === 'CANCELLED') {
        return { state: 'failed', error: task.failure ?? task.error ?? `Runway task ${status.toLowerCase()}` }
      }
      const progress = typeof task.progress === 'number' ? Math.round(task.progress * 100) : 0
      return { state: 'pending', progress, detail: status || 'QUEUED' }
    }
  }
}
