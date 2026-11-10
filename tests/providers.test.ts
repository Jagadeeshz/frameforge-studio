import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { createServer, type Server } from 'node:http'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createProviderRegistry } from '../src/main/providers'
import { createHttpClient, assertPublicHttps, probeKey, ProviderHttpError } from '../src/main/providers/http'

const run = promisify(execFile)
let server: Server
let base = ''
let media: Buffer
let dir = ''

beforeAll(async () => {
  dir = await fs.mkdtemp(join(process.env.TMPDIR ?? tmpdir(), 'ff-prov-'))
  const clip = join(dir, 'clip.mp4')
  await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=orange:s=320x180:d=1:r=30', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', clip])
  media = await fs.readFile(clip)

  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (req.method === 'POST' && url.pathname === '/v1/text_to_video') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ id: 'task-abc' }))
      return
    }
    if (req.method === 'GET' && url.pathname === '/v1/tasks/task-abc') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ status: 'SUCCEEDED', progress: 1, output: [`${base}/media/clip.mp4`] }))
      return
    }
    if (req.method === 'GET' && url.pathname === '/media/clip.mp4') {
      res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': String(media.length) })
      res.end(media)
      return
    }
    if (req.method === 'GET' && url.pathname === '/v1/organization') {
      const ok = req.headers.authorization === 'Bearer good-key-123456'
      res.writeHead(ok ? 200 : 401, { 'content-type': 'application/json' })
      res.end(JSON.stringify(ok ? { id: 'org-1' } : { error: 'bad key' }))
      return
    }
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end('{}')
  })

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No port')
  base = `http://127.0.0.1:${address.port}`
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await fs.rm(dir, { recursive: true, force: true })
})

describe('provider adapters', () => {
  it('submits, polls and reports a media URL (Runway shape)', async () => {
    const registry = createProviderRegistry({ baseUrls: { runway: base }, allowLoopback: true })
    const adapter = registry.get('runway')

    const remote = await adapter.submit(
      { prompt: 'a slow orbit', durationSeconds: 4, aspect: '16:9', model: 'gen4_turbo' },
      'good-key-123456'
    )
    expect(remote.remoteId).toBe('task-abc')

    const result = await adapter.poll(remote, { key: 'good-key-123456', model: 'gen4_turbo' })
    expect(result.state).toBe('succeeded')
    if (result.state !== 'succeeded') throw new Error('unreachable')
    expect(result.url).toContain('/media/clip.mp4')
  })

  it('downloads the clip to disk through the guarded client', async () => {
    const registry = createProviderRegistry({ baseUrls: { runway: base }, allowLoopback: true })
    const dest = join(dir, 'downloaded.mp4')
    const { bytes } = await registry.http.download(`${base}/media/clip.mp4`, dest)
    expect(bytes).toBe(media.length)
    const stat = await fs.stat(dest)
    expect(stat.size).toBe(media.length)
  })

  it('reports a rejected key without billing a generation', async () => {
    const registry = createProviderRegistry({ baseUrls: { runway: base }, allowLoopback: true })
    const bad = await registry.get('runway').verify('wrong-key-000000')
    expect(bad.ok).toBe(false)
    expect(bad.message).toMatch(/rejected/i)

    const good = await registry.get('runway').verify('good-key-123456')
    expect(good.ok).toBe(true)
  })

  it('exposes descriptors for every provider', () => {
    const registry = createProviderRegistry()
    const list = registry.list()
    expect(list).toHaveLength(6)
    expect(list.map((entry) => entry.id).sort()).toEqual(['fal', 'heygen', 'luma', 'openai', 'replicate', 'runway'])
    for (const descriptor of list) {
      expect(descriptor.docsUrl.startsWith('https://')).toBe(true)
      expect(descriptor.defaultModel.length).toBeGreaterThan(0)
    }
  })
})

describe('network guards', () => {
  it('blocks hosts outside the allowlist', async () => {
    const http = createHttpClient({ allowHosts: ['api.example.com'] })
    await expect(http.json('https://evil.test/v1/x', { method: 'GET' })).rejects.toThrow(/Blocked host/)
    expect(() => http.assertAllowed('https://api.example.com/v1/x')).not.toThrow()
  })

  it('blocks non-http protocols outright', async () => {
    const http = createHttpClient({ allowHosts: ['api.example.com'] })
    await expect(http.json('file:///etc/passwd', { method: 'GET' })).rejects.toThrow(/Blocked protocol/)
  })

  it('refuses media URLs on private addresses (SSRF guard)', () => {
    expect(() => assertPublicHttps('https://cdn.provider.com/a.mp4')).not.toThrow()
    expect(() => assertPublicHttps('http://127.0.0.1/a.mp4')).toThrow(/non-HTTPS|private/)
    expect(() => assertPublicHttps('https://10.0.0.5/a.mp4')).toThrow(/private/)
    expect(() => assertPublicHttps('https://192.168.1.20/a.mp4')).toThrow(/private/)
    expect(() => assertPublicHttps('https://169.254.169.254/latest/meta-data')).toThrow(/private/)
    expect(() => assertPublicHttps('https://internal.local/a.mp4')).toThrow(/private/)
  })

  it('treats a 401 probe as a bad key and a 404 as accepted', async () => {
    const http = createProviderRegistry({ baseUrls: { runway: base }, allowLoopback: true }).http
    expect((await probeKey(http, `${base}/v1/organization`, { method: 'GET', headers: { authorization: 'Bearer wrong' } })).ok).toBe(false)
    const accepted = await probeKey(http, `${base}/v1/nothing-here`, { method: 'GET' })
    expect(accepted.ok).toBe(true)
    expect(accepted.message).toMatch(/404/)
  })

  it('surfaces non-JSON responses as provider errors rather than throwing raw', async () => {
    const http = createHttpClient({ allowHosts: ['127.0.0.1'], allowLoopback: true })
    await expect(http.json(`${base}/media/clip.mp4`, { method: 'GET' })).rejects.toBeInstanceOf(ProviderHttpError)
  })
})
