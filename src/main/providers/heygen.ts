import type { ProviderDescriptor } from '../../shared/contract'
import type { GenerateInput, PollContext, PollResult, ProviderAdapter, SubmitResult } from './types'
import { probeKey, type HttpClient } from './http'

export const descriptor: ProviderDescriptor = {
  id: 'heygen',
  label: 'HeyGen',
  capability: 'avatar-video',
  docsUrl: 'https://docs.heygen.com',
  keyPlaceholder: 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
  keyPrefix: null,
  defaultModel: 'Angela-inTshirt-20220820',
  models: ['Angela-inTshirt-20220820'],
  note: 'Your prompt is spoken by an avatar. Model field takes avatarId or avatarId:voiceId.'
}

interface CreateResponse {
  error?: string | null
  data?: { video_id?: string }
}

interface StatusResponse {
  code?: number
  data?: { status?: string; video_url?: string; error?: { message?: string } | string }
}

const SIZES: Record<string, { width: number; height: number }> = {
  '16:9': { width: 1280, height: 720 },
  '9:16': { width: 720, height: 1280 },
  '1:1': { width: 720, height: 720 }
}

export function createHeygenAdapter(http: HttpClient, baseUrl: string): ProviderAdapter {
  const headers = (key: string): Record<string, string> => ({
    'X-Api-Key': key,
    'Content-Type': 'application/json'
  })

  const parseModel = (model: string): { avatarId: string; voiceId: string | null } => {
    const [avatarId, voiceId] = model.split(':')
    return { avatarId: avatarId || descriptor.defaultModel, voiceId: voiceId ?? null }
  }

  return {
    descriptor,

    async verify(key) {
      return probeKey(http, `${baseUrl}/v2/user`, { method: 'GET', headers: headers(key) })
    },

    async submit(input: GenerateInput, key: string): Promise<SubmitResult> {
      const { avatarId, voiceId } = parseModel(input.model)
      const voice: Record<string, unknown> = { type: 'text', input_text: input.prompt }
      if (voiceId) voice.voice_id = voiceId
      const body = {
        video_inputs: [
          {
            character: { type: 'avatar', avatar_id: avatarId, avatar_style: 'normal' },
            voice
          }
        ],
        dimension: SIZES[input.aspect] ?? SIZES['16:9']
      }
      const response = await http.json<CreateResponse>(`${baseUrl}/v2/video/generate`, {
        method: 'POST',
        headers: headers(key),
        body: JSON.stringify(body)
      })
      const videoId = response.data?.video_id
      if (!videoId) throw new Error(response.error ?? 'HeyGen did not return a video id')
      return { remoteId: videoId }
    },

    async poll(remote: SubmitResult, ctx: PollContext): Promise<PollResult> {
      const response = await http.json<StatusResponse>(
        `${baseUrl}/v1/video_status.get?video_id=${encodeURIComponent(remote.remoteId)}`,
        { method: 'GET', headers: headers(ctx.key) }
      )
      const status = (response.data?.status ?? '').toLowerCase()
      if (status === 'completed') {
        const url = response.data?.video_url
        if (!url) return { state: 'failed', error: 'HeyGen completed without a video URL' }
        return { state: 'succeeded', url }
      }
      if (status === 'failed') {
        const detail = response.data?.error
        const message = typeof detail === 'string' ? detail : detail?.message
        return { state: 'failed', error: message ?? 'HeyGen rendering failed' }
      }
      return { state: 'pending', progress: status === 'processing' ? 50 : 10, detail: status || 'pending' }
    }
  }
}
