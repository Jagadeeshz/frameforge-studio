import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { JobStore, newJob } from '../src/main/jobs/store'
import { DEFAULT_TEST_SPEC } from './helpers'

let dir = ''
let store: JobStore

beforeEach(async () => {
  dir = await fs.mkdtemp(join(process.env.TMPDIR ?? tmpdir(), 'ff-jobs-'))
  store = new JobStore(dir)
  await store.init()
})

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

describe('job store', () => {
  it('seeds every stage as pending', () => {
    const job = newJob(DEFAULT_TEST_SPEC)
    expect(job.stages.map((stage) => stage.id)).toEqual([
      'validate',
      'storyboard',
      'generate',
      'download',
      'compose',
      'render',
      'export'
    ])
    expect(job.stages.every((stage) => stage.status === 'pending')).toBe(true)
    expect(job.status).toBe('queued')
  })

  it('persists and reloads a job', async () => {
    const job = newJob(DEFAULT_TEST_SPEC)
    await store.save(job)
    const loaded = await store.get(job.id)
    expect(loaded?.spec.title).toBe(DEFAULT_TEST_SPEC.title)
    expect(loaded?.stages).toHaveLength(7)
  })

  it('lists newest first', async () => {
    const first = { ...newJob(DEFAULT_TEST_SPEC), createdAt: '2026-01-01T00:00:00.000Z', id: 'a' }
    const second = { ...newJob(DEFAULT_TEST_SPEC), createdAt: '2026-02-01T00:00:00.000Z', id: 'b' }
    await store.save(first)
    await store.save(second)
    const list = await store.list()
    expect(list.map((job) => job.id)).toEqual(['b', 'a'])
  })

  it('marks interrupted jobs as failed on reconcile', async () => {
    const job = { ...newJob(DEFAULT_TEST_SPEC), status: 'running' as const }
    job.stages[0] = { ...job.stages[0]!, status: 'running', startedAt: new Date().toISOString() }
    await store.save(job)

    const touched = await store.reconcile()
    expect(touched).toHaveLength(1)
    const after = await store.get(job.id)
    expect(after?.status).toBe('failed')
    expect(after?.error).toMatch(/Interrupted/)
    expect(after?.stages[0]?.status).toBe('failed')
  })

  it('ignores corrupted job files', async () => {
    await fs.writeFile(join(dir, 'broken.json'), '{not json')
    const job = newJob(DEFAULT_TEST_SPEC)
    await store.save(job)
    const list = await store.list()
    expect(list).toHaveLength(1)
  })

  it('removes a job record', async () => {
    const job = newJob(DEFAULT_TEST_SPEC)
    await store.save(job)
    await store.remove(job.id)
    expect(await store.get(job.id)).toBeNull()
  })
})
