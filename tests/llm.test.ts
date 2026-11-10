import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { createServer, type Server } from 'node:http'
import {
  buildEnhanceRequest,
  buildStoryboardRequest,
  cleanEnhancement,
  createLlmClient,
  normalizeBaseUrl
} from '../src/main/providers/llm'
import { DEFAULT_TEST_SPEC } from './helpers'

let server: Server
let base = ''
let lastBody = ''
let lastAuth = ''
let mode: 'ok' | 'unauthorised' | 'array-content' | 'error' = 'ok'

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    lastAuth = String(req.headers.authorization ?? '')

    if (req.method === 'GET' && url.pathname === '/v1/models') {
      res.writeHead(mode === 'unauthorised' ? 401 : 200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: [{ id: 'deepseek-chat' }] }))
      return
    }

    if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
      let raw = ''
      req.on('data', (c) => (raw += c))
      req.on('end', () => {
        lastBody = raw
        if (mode === 'error') {
          res.writeHead(400, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: { message: 'model not found' } }))
          return
        }
        if (mode === 'array-content') {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(
            JSON.stringify({ choices: [{ message: { content: [{ type: 'text', text: 'part one ' }, { type: 'text', text: 'part two' }] } }] })
          )
          return
        }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ choices: [{ message: { content: 'Slow dolly through a sunlit studio, warm grade.' } }] }))
      })
      return
    }

    res.writeHead(404, { 'content-type': 'application/json' })
    res.end('{}')
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('no port')
  base = `http://127.0.0.1:${address.port}/v1`
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

// Built per test: the port is only known once beforeAll has started the server.
const testConfig = (): { name: string; baseUrl: string; model: string } => ({
  name: 'Local mock',
  baseUrl: base,
  model: 'deepseek-chat'
})

describe('universal llm client', () => {
  it('normalises base urls the way people paste them', () => {
    expect(normalizeBaseUrl('https://api.deepseek.com/v1/')).toBe('https://api.deepseek.com/v1')
    expect(normalizeBaseUrl('https://api.deepseek.com/v1/chat/completions')).toBe('https://api.deepseek.com/v1')
    expect(normalizeBaseUrl('  http://localhost:11434/v1  ')).toBe('http://localhost:11434/v1')
  })

  it('posts an OpenAI-shaped chat completion and returns the text', async () => {
    mode = 'ok'
    const client = createLlmClient(testConfig(), 'sk-test-key-123456')
    const text = await client.complete({ system: 'be terse', prompt: 'rewrite this', maxTokens: 200 })

    expect(text).toBe('Slow dolly through a sunlit studio, warm grade.')
    expect(lastAuth).toBe('Bearer sk-test-key-123456')

    const body = JSON.parse(lastBody) as { model: string; messages: Array<{ role: string; content: string }>; max_tokens: number }
    expect(body.model).toBe('deepseek-chat')
    expect(body.messages[0]).toEqual({ role: 'system', content: 'be terse' })
    expect(body.messages[1]).toEqual({ role: 'user', content: 'rewrite this' })
    expect(body.max_tokens).toBe(200)
  })

  it('joins array-shaped content parts', async () => {
    mode = 'array-content'
    const client = createLlmClient(testConfig(), 'sk-test-key-123456')
    await expect(client.complete({ prompt: 'x' })).resolves.toBe('part one part two')
    mode = 'ok'
  })

  it('surfaces the provider error message instead of a generic failure', async () => {
    mode = 'error'
    const client = createLlmClient(testConfig(), 'sk-test-key-123456')
    await expect(client.complete({ prompt: 'x' })).rejects.toThrow(/model not found/)
    mode = 'ok'
  })

  it('verifies the key without billing a completion', async () => {
    mode = 'ok'
    const client = createLlmClient(testConfig(), 'sk-test-key-123456')
    await expect(client.verify()).resolves.toMatchObject({ ok: true })

    mode = 'unauthorised'
    const rejected = createLlmClient(testConfig(), 'sk-bad-key-000000')
    const result = await rejected.verify()
    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/rejected/i)
    mode = 'ok'
  })

  it('refuses a base url that is not a URL', () => {
    expect(() => createLlmClient({ ...testConfig(), baseUrl: 'not a url' }, 'sk-test-key-123456')).toThrow(/not a valid URL/)
  })

  it('pins every request to the configured base url', async () => {
    const seen: string[] = []
    const client = createLlmClient(
      { name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
      'sk-test-key-123456',
      {
        fetchImpl: (async (input: RequestInfo | URL) => {
          seen.push(String(input))
          return new Response(JSON.stringify({ choices: [{ message: { content: 'a rewritten shot' } }] }), {
            status: 200,
            headers: { 'content-type': 'application/json' }
          })
        }) as typeof fetch
      }
    )

    await client.complete({ prompt: 'x' })
    // The client's own allowlist holds exactly one host, so there is no path by
    // which a completion could be sent anywhere else.
    expect(seen).toEqual(['https://api.deepseek.com/v1/chat/completions'])
  })
})

describe('prompts', () => {
  it('builds a storyboard request that carries the shot list and forbids invention', () => {
    const { system, prompt } = buildStoryboardRequest(DEFAULT_TEST_SPEC)
    expect(system).toMatch(/never invent/i)
    for (const shot of DEFAULT_TEST_SPEC.shots) expect(prompt).toContain(shot.prompt)
    expect(prompt).toContain(DEFAULT_TEST_SPEC.title)
    expect(prompt).toMatch(/Shot list/)
  })

  it('builds an enhancement request scoped to one shot', () => {
    const shot = DEFAULT_TEST_SPEC.shots[0]!
    const { system, prompt } = buildEnhanceRequest(shot, DEFAULT_TEST_SPEC)
    expect(system).toMatch(/at most 60 words/i)
    expect(prompt).toContain(shot.prompt)
    expect(prompt).toContain('camera movement')
  })

  it('cleans labels, quotes and whitespace out of a rewrite', () => {
    expect(cleanEnhancement('Prompt: "A slow orbit around a pedestal."', 'fallback')).toBe('A slow orbit around a pedestal.')
    expect(cleanEnhancement('\n\n  macro   detail  \n', 'fallback')).toBe('macro detail')
  })

  it('falls back when the model returns something unusable', () => {
    expect(cleanEnhancement('ok', 'the original prompt')).toBe('the original prompt')
    expect(cleanEnhancement('', 'the original prompt')).toBe('the original prompt')
  })

  it('caps a runaway rewrite', () => {
    const long = 'a'.repeat(900)
    const result = cleanEnhancement(long, 'fallback')
    expect(result.length).toBeLessThanOrEqual(600)
    expect(result.endsWith('…')).toBe(true)
  })
})
