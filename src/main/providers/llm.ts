import type { CustomLlmConfig, JobSpec, Shot } from '../../shared/contract'
import { createHttpClient, probeKey, ProviderHttpError, type HttpClient } from './http'

/**
 * Universal OpenAI-compatible LLM client.
 *
 * DeepSeek, OpenRouter, Groq, Together, vLLM, LM Studio, Ollama and anything
 * else that speaks `/chat/completions` work here. The base URL is chosen by the
 * user, so the HTTP client is built per client instance with that single host
 * allowlisted — the app-wide allowlist stays untouched, and no other host
 * becomes reachable.
 */

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0', '[::1]'])

export interface LlmClient {
  readonly config: CustomLlmConfig
  verify(): Promise<{ ok: boolean; message: string }>
  complete(input: { system?: string; prompt: string; maxTokens?: number }): Promise<string>
}

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string | Array<{ type?: string; text?: string }> } }>
  error?: { message?: string } | string
}

function isLoopback(host: string): boolean {
  return LOOPBACK_HOSTS.has(host.toLowerCase())
}

/** Accepts `https://api.deepseek.com/v1`, `…/v1/chat/completions`, or a bare host. */
export function normalizeBaseUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, '')
  return trimmed.replace(/\/chat\/completions$/i, '')
}

export function createLlmClient(
  config: CustomLlmConfig,
  apiKey: string,
  options?: { fetchImpl?: typeof fetch; timeoutMs?: number }
): LlmClient {
  const baseUrl = normalizeBaseUrl(config.baseUrl)

  let host: string
  try {
    host = new URL(baseUrl).hostname
  } catch {
    throw new Error(`Base URL is not a valid URL: ${config.baseUrl}`)
  }

  const http: HttpClient = createHttpClient({
    // Exactly one host is reachable from this client: the one the user typed.
    allowHosts: [host, host.replace(/^\[|\]$/g, '')],
    allowLoopback: isLoopback(host),
    timeoutMs: options?.timeoutMs ?? 60_000,
    ...(options?.fetchImpl ? { fetchImpl: options.fetchImpl } : {})
  })

  const headers = (): Record<string, string> => ({
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
    Accept: 'application/json'
  })

  const describeError = (error: unknown): string => {
    if (error instanceof ProviderHttpError) {
      const body = error.body?.trim()
      if (body) {
        try {
          const parsed = JSON.parse(body) as { error?: { message?: string } | string; message?: string }
          const message = typeof parsed.error === 'string' ? parsed.error : parsed.error?.message ?? parsed.message
          if (message) return message
        } catch {
          return body.slice(0, 240)
        }
      }
      return error.status === 401 || error.status === 403
        ? `Provider rejected the key (${error.status})`
        : error.message
    }
    return error instanceof Error ? error.message : 'Unknown LLM error'
  }

  return {
    config: { ...config, baseUrl },

    async verify() {
      // A cheap authenticated GET; some gateways do not implement /models, in
      // which case 404 still proves the key was not rejected.
      try {
        return await probeKey(http, `${baseUrl}/models`, { method: 'GET', headers: headers() })
      } catch (error) {
        return { ok: false, message: describeError(error) }
      }
    },

    async complete(input) {
      const messages: Array<{ role: string; content: string }> = []
      if (input.system) messages.push({ role: 'system', content: input.system })
      messages.push({ role: 'user', content: input.prompt })

      const response = await http
        .json<ChatCompletionResponse>(`${baseUrl}/chat/completions`, {
          method: 'POST',
          headers: headers(),
          body: JSON.stringify({
            model: config.model,
            messages,
            temperature: 0.4,
            max_tokens: input.maxTokens ?? 1200,
            stream: false
          })
        })
        // Surface the vendor's own message ("model not found", "insufficient
        // quota") instead of a bare HTTP status the user cannot act on.
        .catch((error: unknown) => {
          throw new Error(describeError(error))
        })

      if (response.error) {
        const message = typeof response.error === 'string' ? response.error : response.error.message
        throw new Error(message || 'Provider returned an error')
      }

      const content = response.choices?.[0]?.message?.content
      const text = Array.isArray(content)
        ? content.map((part) => (typeof part?.text === 'string' ? part.text : '')).join('')
        : content

      if (!text || !text.trim()) throw new Error('Provider returned an empty completion')
      return text.trim()
    }
  }
}

/* ------------------------------------------------------------------ */
/* Prompts                                                            */
/* ------------------------------------------------------------------ */

export const STORYBOARD_SYSTEM =
  'You are a senior video producer writing internal production briefs. Be concrete and terse. ' +
  'Never invent metrics, testimonials, prices or claims that the user did not supply.'

export function buildStoryboardRequest(spec: JobSpec): { system: string; prompt: string } {
  const shots = spec.shots
    .map((shot) => `Shot ${shot.index + 1} (${spec.durationSeconds}s): ${shot.prompt}`)
    .join('\n')

  return {
    system: STORYBOARD_SYSTEM,
    prompt: [
      `Write a production brief in Markdown for a ${spec.aspect} video titled "${spec.title}".`,
      `It will be generated with ${spec.providerId} (${spec.model}), ${spec.shots.length} shot(s) of ${spec.durationSeconds}s, joined with ${spec.transition === 'cut' ? 'hard cuts' : 'crossfades'}.`,
      '',
      'Use exactly these sections as `##` headings: Objective, Audience, Visual direction, Shot list, On-screen copy, Delivery checklist.',
      'In Shot list, restate each shot with its camera movement and lighting. In On-screen copy, quote only the title-card text supplied below. Keep the whole brief under 450 words.',
      '',
      `Headline: ${spec.titles.headline || '(none)'}`,
      `Subhead: ${spec.titles.subhead || '(none)'}`,
      '',
      'Shots:',
      shots
    ].join('\n')
  }
}

export const ENHANCE_SYSTEM =
  'You rewrite shot descriptions for text-to-video models. Reply with the rewritten shot only: ' +
  'one paragraph, at most 60 words, no preamble, no quotes, no bullet points, no labels.'

export function buildEnhanceRequest(shot: Shot, spec: JobSpec): { system: string; prompt: string } {
  return {
    system: ENHANCE_SYSTEM,
    prompt: [
      `Rewrite this ${spec.durationSeconds}-second ${spec.aspect} shot so a video model renders it predictably.`,
      'Name the camera movement, the subject and action, the setting, the lighting, and the grade or texture. Keep one idea.',
      'Do not add on-screen text or dialogue.',
      '',
      `Original: ${shot.prompt}`
    ].join('\n')
  }
}

/** Providers sometimes return labels or quotes despite instructions. */
export function cleanEnhancement(raw: string, fallback: string): string {
  const text = raw
    .replace(/^\s*(rewritten\s+)?(prompt|shot)\s*[:\-]\s*/i, '')
    .replace(/^["'`]+|["'`]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (text.length < 12) return fallback
  return text.length > 600 ? `${text.slice(0, 597).trimEnd()}…` : text
}
