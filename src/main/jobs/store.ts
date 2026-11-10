import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Job, JobSpec, Stage, StageId } from '../../shared/contract'
import { writeJsonAtomic } from '../fsx'

const STAGE_LABELS: Record<StageId, string> = {
  validate: 'Validate inputs & toolchain',
  storyboard: 'Storyboard via OfficeCLI',
  generate: 'Generate shots with provider',
  download: 'Download source clips',
  compose: 'Compose title cards',
  render: 'Render with FFmpeg',
  export: 'Export deliverables'
}

const STAGE_ORDER: StageId[] = ['validate', 'storyboard', 'generate', 'download', 'compose', 'render', 'export']

export function createStages(): Stage[] {
  return STAGE_ORDER.map((id) => ({
    id,
    label: STAGE_LABELS[id],
    status: 'pending',
    detail: null,
    startedAt: null,
    endedAt: null
  }))
}

export function newJob(spec: JobSpec): Job {
  const now = new Date().toISOString()
  return {
    id: randomUUID(),
    spec,
    status: 'queued',
    progress: 0,
    createdAt: now,
    updatedAt: now,
    finishedAt: null,
    stages: createStages(),
    artifacts: [],
    error: null,
    costEstimateUsd: null,
    compositionHtml: null
  }
}

export class JobStore {
  readonly #dir: string
  constructor(dir: string) {
    this.#dir = dir
  }

  #file(id: string): string {
    return join(this.#dir, `${id}.json`)
  }

  async init(): Promise<void> {
    await fs.mkdir(this.#dir, { recursive: true })
  }

  async save(job: Job): Promise<Job> {
    const stamped: Job = { ...job, updatedAt: new Date().toISOString() }
    await writeJsonAtomic(this.#file(job.id), stamped)
    return stamped
  }

  async get(id: string): Promise<Job | null> {
    try {
      const raw = await fs.readFile(this.#file(id), 'utf8')
      return JSON.parse(raw) as Job
    } catch {
      return null
    }
  }

  async list(): Promise<Job[]> {
    let names: string[] = []
    try {
      names = await fs.readdir(this.#dir)
    } catch {
      return []
    }
    const jobs: Job[] = []
    for (const name of names) {
      if (!name.endsWith('.json')) continue
      const raw = await fs.readFile(join(this.#dir, name), 'utf8').catch(() => null)
      if (!raw) continue
      try {
        jobs.push(JSON.parse(raw) as Job)
      } catch {
        continue
      }
    }
    return jobs.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }

  async remove(id: string): Promise<void> {
    await fs.rm(this.#file(id), { force: true })
  }

  /** Jobs left mid-flight by a crash or quit are marked interrupted on boot. */
  async reconcile(): Promise<Job[]> {
    const jobs = await this.list()
    const touched: Job[] = []
    for (const job of jobs) {
      if (job.status !== 'running' && job.status !== 'queued') continue
      const failedStages = job.stages.map((stage) =>
        stage.status === 'running'
          ? { ...stage, status: 'failed' as const, detail: 'Interrupted when the app closed', endedAt: new Date().toISOString() }
          : stage
      )
      touched.push(await this.save({ ...job, status: 'failed', error: 'Interrupted when the app closed', stages: failedStages, finishedAt: new Date().toISOString() }))
    }
    return touched
  }
}
