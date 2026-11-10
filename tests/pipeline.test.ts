import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { createServer, type Server } from 'node:http'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { JobRunner } from '../src/main/jobs/runner'
import { JobStore } from '../src/main/jobs/store'
import { createProviderRegistry } from '../src/main/providers'
import { Ffmpeg } from '../src/main/ffmpeg'
import { locateFfmpeg } from '../src/main/ffmpeg/locate'
import { DEFAULT_TEST_SPEC } from './helpers'
import type { Job } from '../src/shared/contract'
import type { LlmClient } from '../src/main/providers/llm'

const run = promisify(execFile)
let server: Server
let base = ''
let media: Buffer
let dir = ''
let lastSubmittedPrompt = ''

beforeAll(async () => {
  dir = await fs.mkdtemp(join(process.env.TMPDIR ?? tmpdir(), 'ff-pipe-'))
  const clip = join(dir, 'seed.mp4')
  await run('ffmpeg', [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    'testsrc=size=640x360:rate=30:duration=4',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    clip
  ])
  media = await fs.readFile(clip)

  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    let body = ''
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString()
    })
    req.on('end', () => {
      const hold = body.includes('never')
      if (req.method === 'POST' && url.pathname === '/v1/text_to_video') {
        try {
          lastSubmittedPrompt = (JSON.parse(body) as { promptText?: string }).promptText ?? ''
        } catch {
          lastSubmittedPrompt = ''
        }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ id: hold ? 'task-hold' : 'task-fast' }))
        return
      }
      if (req.method === 'GET' && url.pathname === '/v1/tasks/task-fast') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ status: 'SUCCEEDED', progress: 1, output: [`${base}/media/clip.mp4`] }))
        return
      }
      if (req.method === 'GET' && url.pathname === '/v1/tasks/task-hold') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ status: 'PENDING', progress: 0.1 }))
        return
      }
      if (req.method === 'GET' && url.pathname === '/media/clip.mp4') {
        res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': String(media.length) })
        res.end(media)
        return
      }
      res.writeHead(404)
      res.end('{}')
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No port')
  base = `http://127.0.0.1:${address.port}`
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await fs.rm(dir, { recursive: true, force: true })
})

async function buildRunner(
  workspace: string,
  getLlm?: () => Promise<LlmClient | null>
): Promise<{ runner: JobRunner; store: JobStore }> {
  const tools = await locateFfmpeg()
  const registry = createProviderRegistry({ baseUrls: { runway: base }, allowLoopback: true })
  const store = new JobStore(join(workspace, 'jobs'))
  await store.init()

  const runner = new JobRunner({
    store,
    getKey: async () => 'test-key-123456',
    getAdapter: (id) => registry.get(id),
    http: registry.http,
    ffmpeg: new Ffmpeg(tools),
    office: { info: { available: false, path: null, version: null, mode: 'unknown' } },
    ...(getLlm ? { getLlm } : {}),
    workspaceRoot: workspace,
    pollIntervalMs: 120,
    pollTimeoutMs: 20_000,
    onUpdate: () => undefined,
    renderCards: async ({ width, height, framesDir, durationSeconds, fps }) => {
      await fs.mkdir(framesDir, { recursive: true })
      const seed = join(framesDir, 'seed.png')
      await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `color=c=#1a1035:s=${width}x${height}:d=1`, '-frames:v', '1', seed])
      const png = await fs.readFile(seed)
      const total = Math.round(durationSeconds * fps)
      for (let i = 0; i < total; i += 1) {
        await fs.writeFile(join(framesDir, `frame_${String(i).padStart(5, '0')}.png`), png)
      }
    }
  })
  return { runner, store }
}

async function waitForFinish(store: JobStore, id: string, timeoutMs = 150_000): Promise<Job> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const job = await store.get(id)
    if (job && ['succeeded', 'failed', 'cancelled'].includes(job.status)) return job
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error('Job did not finish in time')
}

describe('job pipeline', () => {
  it('runs every stage end to end and writes a playable MP4 plus a poster', async () => {
    const workspace = join(dir, 'run-ok')
    const { runner, store } = await buildRunner(workspace)

    const queued = await runner.enqueue({ ...DEFAULT_TEST_SPEC, office: { storyboard: false, deliveryDeck: false } })
    const finished = await waitForFinish(store, queued.id)

    expect(finished.status, finished.error ?? '').toBe('succeeded')
    expect(finished.progress).toBe(100)

    const byId = Object.fromEntries(finished.stages.map((stage) => [stage.id, stage]))
    expect(byId.validate?.status).toBe('succeeded')
    expect(byId.storyboard?.status).toBe('skipped')
    expect(byId.generate?.status).toBe('succeeded')
    expect(byId.render?.status).toBe('succeeded')
    expect(byId.export?.status).toBe('succeeded')

    const video = finished.artifacts.find((artifact) => artifact.kind === 'video')
    expect(video).toBeTruthy()
    const stat = await fs.stat(video!.path)
    expect(stat.size).toBeGreaterThan(10_000)

    const tools = await locateFfmpeg()
    const info = await new Ffmpeg(tools).probe(video!.path)
    // intro ~3.2s + 2 shots x 4s + outro ~2.8s, minus crossfade overlaps
    expect(info.durationSeconds).toBeGreaterThan(9)
    expect(info.width).toBe(1920)
    expect(info.height).toBe(1080)
    expect(info.videoCodec).toBe('h264')

    const poster = finished.artifacts.find((artifact) => artifact.kind === 'poster')
    expect(poster).toBeTruthy()
    expect((await fs.stat(poster!.path)).size).toBeGreaterThan(500)

    expect(finished.artifacts.filter((artifact) => artifact.kind === 'clip')).toHaveLength(2)
    expect(finished.costEstimateUsd).toBeGreaterThan(0)
  })

  it('writes the storyboard with the user\'s LLM and enhances every shot prompt', async () => {
    const workspace = join(dir, 'run-llm')
    const calls: string[] = []
    const fakeLlm: LlmClient = {
      config: { name: 'Mock LLM', baseUrl: 'http://127.0.0.1:1/v1', model: 'mock-model' },
      async verify() {
        return { ok: true, message: 'ok' }
      },
      async complete(input: { system?: string; prompt: string }) {
        calls.push(input.prompt)
        if (input.prompt.includes('production brief')) return '## Objective\nShip the teaser.'
        const original = input.prompt.split('Original: ')[1] ?? 'unknown'
        return `ENHANCED SHOT: ${original}`
      }
    }

    const { runner, store } = await buildRunner(workspace, async () => fakeLlm)
    const queued = await runner.enqueue({
      ...DEFAULT_TEST_SPEC,
      office: { storyboard: true, deliveryDeck: false },
      enhancePrompts: true
    })
    const finished = await waitForFinish(store, queued.id)

    expect(finished.status, finished.error ?? '').toBe('succeeded')

    const storyboardStage = finished.stages.find((stage) => stage.id === 'storyboard')
    expect(storyboardStage?.status).toBe('succeeded')
    expect(storyboardStage?.detail).toContain('mock-model')

    const storyboard = finished.artifacts.find((artifact) => artifact.kind === 'storyboard')
    expect(storyboard?.path.endsWith('storyboard.md')).toBe(true)
    const brief = await fs.readFile(storyboard!.path, 'utf8')
    expect(brief).toContain('## Objective')

    const prompts = finished.artifacts.find((artifact) => artifact.kind === 'log')
    expect(prompts?.path.endsWith('enhanced-prompts.json')).toBe(true)
    const rewritten = JSON.parse(await fs.readFile(prompts!.path, 'utf8')) as Array<{ original: string; used: string }>
    expect(rewritten).toHaveLength(DEFAULT_TEST_SPEC.shots.length)
    expect(rewritten.every((entry) => entry.used.startsWith('ENHANCED SHOT:'))).toBe(true)

    // The provider must have received the rewritten prompt, not the original.
    expect(lastSubmittedPrompt.startsWith('ENHANCED SHOT:')).toBe(true)
    expect(calls.length).toBe(DEFAULT_TEST_SPEC.shots.length + 1)
  })

  it('runs the free motion pipeline from model HTML to an encoded film', async () => {
    const workspace = join(dir, 'run-motion')
    const received: string[] = []
    const scenesJson = JSON.stringify({
      scenes: [
        { title: 'Open', durationSeconds: 3, html: '<!doctype html><html><body><h1 style="color:#fff">Built</h1><script>alert(1)</script></body></html>' },
        { title: 'Close', durationSeconds: 3, html: '<!doctype html><html><body><h1 style="color:#fff">Ship</h1></body></html>' }
      ]
    })
    const fakeLlm: LlmClient = {
      config: { name: 'Mock LLM', baseUrl: 'http://127.0.0.1:1/v1', model: 'mock-model' },
      async verify() {
        return { ok: true, message: 'ok' }
      },
      async complete() {
        return scenesJson
      }
    }

    const tools = await locateFfmpeg()
    const registry = createProviderRegistry({ baseUrls: { runway: base }, allowLoopback: true })
    const store = new JobStore(join(workspace, 'jobs'))
    await store.init()

    const runner = new JobRunner({
      store,
      getKey: async () => null,
      getAdapter: (id) => registry.get(id),
      http: registry.http,
      ffmpeg: new Ffmpeg(tools),
      office: { info: { available: false, path: null, version: null, mode: 'unknown' } },
      getLlm: async () => fakeLlm,
      workspaceRoot: workspace,
      onUpdate: () => undefined,
      renderCards: async ({ html, width, height, framesDir, durationSeconds, fps }) => {
        received.push(html)
        await fs.mkdir(framesDir, { recursive: true })
        const seed = join(framesDir, 'seed.png')
        await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `color=c=#101018:s=${width}x${height}:d=1`, '-frames:v', '1', seed])
        const png = await fs.readFile(seed)
        for (let i = 0; i < Math.round(durationSeconds * fps); i += 1) {
          await fs.writeFile(join(framesDir, `frame_${String(i).padStart(5, '0')}.png`), png)
        }
      }
    })

    const queued = await runner.enqueue({
      ...DEFAULT_TEST_SPEC,
      providerId: 'motion',
      title: 'Motion test',
      model: 'mock-model',
      durationSeconds: 10,
      scenes: 2,
      shots: [],
      brief: 'A ten second kinetic type test.',
      office: { storyboard: true, deliveryDeck: false }
    })
    const finished = await waitForFinish(store, queued.id)

    expect(finished.status, finished.error ?? '').toBe('succeeded')
    expect(finished.costEstimateUsd).toBe(0)

    const byId = Object.fromEntries(finished.stages.map((stage) => [stage.id, stage]))
    expect(byId.storyboard?.status).toBe('succeeded')
    expect(byId.download?.status).toBe('skipped')
    expect(byId.generate?.status).toBe('succeeded')

    // Scene HTML reached the renderer, with the model's script stripped and our
    // driver injected instead. Bookends also contain <h1>, so match scene copy.
    const sceneDocs = received.filter((html) => html.includes('>Built<') || html.includes('>Ship<'))
    expect(sceneDocs).toHaveLength(2)
    expect(sceneDocs.every((html) => html.includes('window.__ff'))).toBe(true)
    expect(sceneDocs.some((html) => html.includes('alert(1)'))).toBe(false)

    const storyboard = finished.artifacts.find((artifact) => artifact.kind === 'storyboard')
    expect(storyboard?.path.endsWith('storyboard.json')).toBe(true)
    const saved = JSON.parse(await fs.readFile(storyboard!.path, 'utf8')) as { scenes: unknown[] }
    expect(saved.scenes).toHaveLength(2)

    const video = finished.artifacts.find((artifact) => artifact.kind === 'video')
    const info = await new Ffmpeg(tools).probe(video!.path)
    expect(info.width).toBe(1920)
    expect(info.height).toBe(1080)
    expect(info.videoCodec).toBe('h264')
    // 10s of scenes plus the two bookends.
    expect(info.durationSeconds).toBeGreaterThan(12)
  }, 180_000)

  it('cancels a job stuck waiting on the provider', async () => {
    const workspace = join(dir, 'run-cancel')
    const { runner, store } = await buildRunner(workspace)

    const spec = {
      ...DEFAULT_TEST_SPEC,
      shots: [{ index: 0, prompt: 'never finishes' }]
    }
    const queued = await runner.enqueue(spec)

    await new Promise((resolve) => setTimeout(resolve, 900))
    await runner.cancel(queued.id)

    const finished = await waitForFinish(store, queued.id, 30_000)
    expect(finished.status).toBe('cancelled')
    expect(finished.progress).toBeLessThan(100)
    expect(finished.stages.find((stage) => stage.id === 'render')?.status).toBe('pending')
  })

  it('fails the job with a clear reason when no key is stored', async () => {
    const workspace = join(dir, 'run-nokey')
    const tools = await locateFfmpeg()
    const registry = createProviderRegistry({ baseUrls: { runway: base }, allowLoopback: true })
    const store = new JobStore(join(workspace, 'jobs'))
    await store.init()
    const runner = new JobRunner({
      store,
      getKey: async () => null,
      getAdapter: (id) => registry.get(id),
      http: registry.http,
      ffmpeg: new Ffmpeg(tools),
      office: { info: { available: false, path: null, version: null, mode: 'unknown' } },
      workspaceRoot: workspace,
      onUpdate: () => undefined,
      renderCards: async () => undefined
    })

    const job = await runner.enqueue(DEFAULT_TEST_SPEC)
    const finished = await waitForFinish(store, job.id, 30_000)
    expect(finished.status).toBe('failed')
    expect(finished.error).toMatch(/No API key stored/)
    expect(finished.stages.find((stage) => stage.id === 'validate')?.status).toBe('failed')
  })
})
