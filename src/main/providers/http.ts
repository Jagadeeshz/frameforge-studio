import { createWriteStream, promises as fs } from 'node:fs'
import { dirname } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

/**
 * Every outbound call in the app funnels through here, so the host allowlist
 * and timeouts are enforced in one place instead of per adapter.
 */

export class ProviderHttpError extends Error {
  readonly status: number
  readonly body: string
  constructor(message: string, status: number, body: string) {
    super(message)
    this.name = 'ProviderHttpError'
    this.status = status
    this.body = body
  }
}

export interface HttpClientOptions {
  /** Hostnames API calls may target. */
  allowHosts: string[]
  /** Tests point at a loopback mock server. Never enabled in the shipped app. */
  allowLoopback?: boolean
  timeoutMs?: number
  fetchImpl?: typeof fetch
}

export interface HttpClient {
  json<T>(url: string, init: RequestInit): Promise<T>
  download(url: string, dest: string, headers?: Record<string, string>): Promise<{ bytes: number }>
  assertAllowed(url: string): URL
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0'])
const PRIVATE_V4 = /^(10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/
const PRIVATE_HOST_SUFFIX = /\.(local|internal|localhost)$/i

/**
 * Providers hand back signed CDN URLs on hosts we cannot pre-list, so downloads
 * are guarded against SSRF (loopback / RFC1918 / link-local) rather than by a
 * fixed host allowlist.
 */
export function assertPublicHttps(raw: string, allowLoopback = false): URL {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new ProviderHttpError('Malformed media URL', 0, '')
  }
  if (allowLoopback) return url
  if (url.protocol !== 'https:') throw new ProviderHttpError(`Refused non-HTTPS media URL (${url.protocol})`, 0, '')
  const host = url.hostname.toLowerCase()
  if (LOOPBACK.has(host) || PRIVATE_V4.test(host) || PRIVATE_HOST_SUFFIX.test(host)) {
    throw new ProviderHttpError(`Refused media URL pointing at a private address (${host})`, 0, '')
  }
  return url
}

export function createHttpClient(options: HttpClientOptions): HttpClient {
  const allow = new Set(options.allowHosts.map((h) => h.toLowerCase()))
  const doFetch = options.fetchImpl ?? fetch
  const timeoutMs = options.timeoutMs ?? 45_000
  const loopbackOk = options.allowLoopback === true

  const assertAllowed = (raw: string): URL => {
    let url: URL
    try {
      url = new URL(raw)
    } catch {
      throw new ProviderHttpError(`Malformed URL: ${raw}`, 0, '')
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      throw new ProviderHttpError(`Blocked protocol ${url.protocol}`, 0, '')
    }
    if (!loopbackOk || !LOOPBACK.has(url.hostname.toLowerCase())) {
      const host = url.hostname.toLowerCase()
      if (!allow.has(host)) throw new ProviderHttpError(`Blocked host ${host} (not in allowlist)`, 0, '')
    }
    return url
  }

  return {
    assertAllowed,
    async json<T>(url: string, init: RequestInit): Promise<T> {
      assertAllowed(url)
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      try {
        const response = await doFetch(url, { ...init, signal: controller.signal })
        const text = await response.text()
        if (!response.ok) {
          throw new ProviderHttpError(
            `${init.method ?? 'GET'} ${new URL(url).pathname} failed (${response.status})`,
            response.status,
            text.slice(0, 800)
          )
        }
        if (!text) return {} as T
        try {
          return JSON.parse(text) as T
        } catch {
          throw new ProviderHttpError('Response was not valid JSON', response.status, text.slice(0, 400))
        }
      } catch (error) {
        if (error instanceof ProviderHttpError) throw error
        if (error instanceof Error && error.name === 'AbortError') {
          throw new ProviderHttpError(`Request timed out after ${timeoutMs}ms`, 0, '')
        }
        throw new ProviderHttpError(error instanceof Error ? error.message : 'Network error', 0, '')
      } finally {
        clearTimeout(timer)
      }
    },

    async download(url, dest, headers) {
      assertPublicHttps(url, loopbackOk)
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs * 4)
      try {
        const response = await doFetch(url, { headers, signal: controller.signal })
        if (!response.ok || !response.body) {
          throw new ProviderHttpError(`Download failed (${response.status})`, response.status, '')
        }
        await fs.mkdir(dirname(dest), { recursive: true })
        const tmp = `${dest}.part`
        await pipeline(Readable.fromWeb(response.body as never), createWriteStream(tmp))
        const stat = await fs.stat(tmp)
        if (stat.size < 1024) {
          await fs.rm(tmp, { force: true })
          throw new ProviderHttpError('Downloaded file was implausibly small', 0, '')
        }
        await fs.rename(tmp, dest)
        return { bytes: stat.size }
      } finally {
        clearTimeout(timer)
      }
    }
  }
}

/**
 * Cheap auth probe: 401/403 means the key is wrong; any other status means the
 * key was accepted (endpoint missing, method not allowed, ...). This avoids
 * billing a real generation just to test a key.
 */
export async function probeKey(
  http: HttpClient,
  url: string,
  init: RequestInit
): Promise<{ ok: boolean; message: string }> {
  try {
    await http.json(url, init)
    return { ok: true, message: 'Key accepted by provider' }
  } catch (error) {
    if (!(error instanceof ProviderHttpError)) throw error
    if (error.status === 401 || error.status === 403) {
      return { ok: false, message: `Provider rejected the key (${error.status})` }
    }
    if (error.status === 0) return { ok: false, message: error.message }
    return { ok: true, message: `Key accepted (probe returned ${error.status})` }
  }
}

export async function withRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  let lastError: unknown
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await fn()
    } catch (error) {
      lastError = error
      const status = error instanceof ProviderHttpError ? error.status : 0
      const retryable = status === 0 || status === 429 || status >= 500
      if (!retryable || i === attempts - 1) break
      await sleep(400 * 2 ** i)
    }
  }
  throw lastError
}
