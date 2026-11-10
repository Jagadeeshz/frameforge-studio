import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import type { Artifact, Job, JobSpec, ProviderId, StageId } from '../../shared/contract'
import { MOTION_PROVIDER_ID } from '../../shared/contract'
import { buildCompositionHtml, compositionDurationSeconds } from '../../shared/composition'
import type { ProviderAdapter } from '../providers/types'
import { buildEnhanceRequest, buildStoryboardRequest, cleanEnhancement, type LlmClient } from '../providers/llm'
import { buildSceneRequest, fallbackSceneHtml, parseStoryboard, sceneDocument, type Scene } from '../scenes'
import type { HttpClient } from '../providers/http'
import type { Ffmpeg, MediaInfo } from '../ffmpeg'
import { dimensionsFor } from '../ffmpeg'
import type { OfficeCliInfo } from '../office'
import { generateOfficeDocument, buildDeliveryDeckPrompt, buildStoryboardPrompt } from '../office'
import { JobStore, newJob } from './store'

export class CancelledError extends Error {
  constructor() {
    super('Cancelled')
    this.name = 'CancelledError'
  }
}

const STAGE_WEIGHT: Record<StageId, number> = {
  validate: 3,
  storyboard: 7,
  generate: 44,
  download: 12,
  compose: 10,
  render: 19,
  export: 5
}

const GAP_AFTER: Record<StageId, number> = {
  validate: 3,
  storyboard: 10,
  generate: 54,
  download: 66,
  compose: 76,
  render: 95,
  export: 100
}

/** Rough per-second list prices, shown only as an estimate before spending. */
const COST_PER_SECOND: Record<ProviderId, number> = {
  runway: 0.1,
  luma: 0.09,
  fal: 0.07,
  replicate: 0.06,
  heygen: 0.05,
  openai: 0.1
}

export interface RunnerDeps {
  store: JobStore
  getKey(providerId: ProviderId): Promise<string | null>
  getAdapter(providerId: ProviderId): ProviderAdapter
  http: HttpClient
  ffmpeg: Ffmpeg
  office: { info: OfficeCliInfo }
  /** User's OpenAI-compatible client, or null when none is configured. */
  getLlm?: () => Promise<LlmClient | null>
  workspaceRoot: string
  /** Injected so the pipeline stays free of Electron imports (and testable). */
  renderCards(options: {
    html: string
    durationSeconds: number
    fps: number
    width: number
    height: number
    framesDir: string
    signal: AbortSignal
  }): Promise<void>
  onUpdate(job: Job): void
  pollIntervalMs?: number
  pollTimeoutMs?: number
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export class JobRunner {
  readonly #deps: RunnerDeps
  readonly #queue: Job[] = []
  readonly #controllers = new Map<string, AbortController>()
  #draining = false

  constructor(deps: RunnerDeps) {
    this.#deps = deps
  }

  estimateCost(spec: JobSpec): number {
    // Motion mode spends nothing on video: the LLM writes HTML and the machine
    // renders it, so there is no per-second vendor rate to estimate.
    if (spec.providerId === MOTION_PROVIDER_ID) return 0
    const perSecond = COST_PER_SECOND[spec.providerId as ProviderId] ?? 0.08
    return Math.round(spec.shots.length * spec.durationSeconds * perSecond * 100) / 100
  }

  async enqueue(spec: JobSpec): Promise<Job> {
    const job = newJob(spec)
    job.costEstimateUsd = this.estimateCost(spec)
    const saved = await this.#deps.store.save(job)
    this.#queue.push(saved)
    this.#deps.onUpdate(saved)
    void this.#drain()
    return saved
  }

  async cancel(jobId: string): Promise<Job | null> {
    const controller = this.#controllers.get(jobId)
    if (controller) controller.abort()
    const queuedAt = this.#queue.findIndex((j) => j.id === jobId)
    if (queuedAt >= 0) this.#queue.splice(queuedAt, 1)
    const job = await this.#deps.store.get(jobId)
    if (!job) return null
    if (job.status === 'queued') {
      return this.#deps.store.save({ ...job, status: 'cancelled', finishedAt: new Date().toISOString() })
    }
    return job
  }

  async #drain(): Promise<void> {
    if (this.#draining) return
    this.#draining = true
    try {
      while (this.#queue.length > 0) {
        const job = this.#queue.shift()
        if (!job) break
        await this.#process(job)
      }
    } finally {
      this.#draining = false
    }
  }

  async #process(job: Job): Promise<void> {
    const controller = new AbortController()
    this.#controllers.set(job.id, controller)
    let current: Job = { ...job, status: 'running' }
    const emit = async (): Promise<void> => {
      current = await this.#deps.store.save(current)
      this.#deps.onUpdate(current)
    }
    await emit()

    const workDir = join(this.#deps.workspaceRoot, 'projects', job.id)
    const dirs = {
      root: workDir,
      clips: join(workDir, 'clips'),
      frames: join(workDir, 'frames'),
      out: join(this.#deps.workspaceRoot, 'output'),
      docs: join(workDir, 'docs')
    }

    try {
      for (const dir of Object.values(dirs)) await fs.mkdir(dir, { recursive: true })

      // ---- free motion-scene pipeline -------------------------------------
      // The LLM writes animated HTML; this machine renders and encodes it. No
      // video API, no per-second vendor cost.
      if (job.spec.providerId === MOTION_PROVIDER_ID) {
        const width = dimensionsFor(job.spec.aspect).width
        const height = dimensionsFor(job.spec.aspect).height
        const fps = 30
        let model: LlmClient | null = null

        await this.#stage(current, 'validate', controller, async () => {
          if (!this.#deps.ffmpeg.available) {
            throw new Error('FFmpeg and ffprobe must be installed (or set FRAMEFORGE_FFMPEG_DIR) before rendering.')
          }
          model = this.#deps.getLlm ? await this.#deps.getLlm() : null
          if (!model) {
            throw new Error('Add your DeepSeek (or any OpenAI-compatible) key under Keys to generate scenes.')
          }
          if (!job.spec.brief.trim()) throw new Error('Write a brief — it is the source of every scene.')
          return `Toolchain ready · ${model.config.name} (${model.config.model})`
        }, emit)

        if (!model) throw new Error('No LLM configured')
        const sceneModel: LlmClient = model
        let scenes: Scene[] = []

        await this.#stage(current, 'storyboard', controller, async () => {
          const request = buildSceneRequest(job.spec, { width, height, providerLabel: sceneModel.config.name })
          const reply = await sceneModel.complete({ system: request.system, prompt: request.prompt, maxTokens: 4000 })
          scenes = parseStoryboard(reply, job.spec)

          const path = join(dirs.docs, 'storyboard.json')
          await fs.mkdir(dirs.docs, { recursive: true })
          await fs.writeFile(
            path,
            JSON.stringify(
              {
                title: job.spec.title,
                durationSeconds: job.spec.durationSeconds,
                scenes: scenes.map((scene) => ({ title: scene.title, durationSeconds: scene.durationSeconds, htmlBytes: scene.html.length }))
              },
              null,
              2
            ),
            'utf8'
          )
          current.artifacts.push({
            kind: 'storyboard',
            label: `${scenes.length} scenes · ${sceneModel.config.model}`,
            path,
            bytes: (await fs.stat(path)).size,
            createdAt: new Date().toISOString()
          })
          const total = scenes.reduce((sum, scene) => sum + scene.durationSeconds, 0)
          return `${scenes.length} scenes · ${total.toFixed(1)}s storyboarded`
        }, emit)

        // Nothing is fetched in this mode, so the stage is informational only.
        const downloadStage = current.stages.find((stage) => stage.id === 'download')
        if (downloadStage) {
          downloadStage.status = 'skipped'
          downloadStage.detail = 'Scenes render locally — nothing to download'
          downloadStage.endedAt = new Date().toISOString()
          await emit()
        }

        const scenePaths: string[] = []
        await this.#stage(current, 'generate', controller, async () => {
          const generateStage = current.stages.find((stage) => stage.id === 'generate')
          let fallbacks = 0
          for (const [index, scene] of scenes.entries()) {
            this.#throwIfAborted(controller)
            const label = `scene-${String(index + 1).padStart(2, '0')}`
            const framesDir = join(dirs.frames, label)
            const output = join(dirs.clips, `${label}.mp4`)

            try {
              await this.#deps.renderCards({
                html: sceneDocument(scene),
                durationSeconds: scene.durationSeconds,
                fps,
                width,
                height,
                framesDir,
                signal: controller.signal
              })
            } catch (error) {
              if (controller.signal.aborted) throw error
              // One unusable scene must not lose the whole film.
              fallbacks += 1
              await this.#deps.renderCards({
                html: fallbackSceneHtml(scene, job.spec, width, height),
                durationSeconds: scene.durationSeconds,
                fps,
                width,
                height,
                framesDir,
                signal: controller.signal
              })
            }

            await this.#deps.ffmpeg.encodeFrames({ framesDir, output, width, height, fps, signal: controller.signal })
            scenePaths.push(output)
            if (generateStage) {
              generateStage.detail = `Scene ${index + 1}/${scenes.length} · ${scene.durationSeconds}s${fallbacks ? ` · ${fallbacks} fallback` : ''}`
            }
            current.progress = Math.round(
              GAP_AFTER.validate + (GAP_AFTER.generate - GAP_AFTER.validate) * ((index + 1) / scenes.length)
            )
            await emit()
          }
          return `${scenePaths.length} scenes rendered${fallbacks ? ` (${fallbacks} fallback)` : ''}`
        }, emit)

        const { intro, outro } = compositionDurationSeconds(job.spec)
        const cards = { intro: join(dirs.clips, 'card-intro.mp4'), outro: join(dirs.clips, 'card-outro.mp4') }

        await this.#stage(current, 'compose', controller, async () => {
          const introHtml = buildCompositionHtml(job.spec, { kind: 'intro', width, height, durationSeconds: intro, fps })
          current.compositionHtml = introHtml
          await this.#deps.renderCards({ html: introHtml, durationSeconds: intro, fps, width, height, framesDir: join(dirs.frames, 'intro'), signal: controller.signal })
          current.progress = Math.round(GAP_AFTER.storyboard + (GAP_AFTER.compose - GAP_AFTER.storyboard) * 0.6)
          await emit()

          const outroHtml = buildCompositionHtml(job.spec, { kind: 'outro', width, height, durationSeconds: outro, fps })
          await this.#deps.renderCards({ html: outroHtml, durationSeconds: outro, fps, width, height, framesDir: join(dirs.frames, 'outro'), signal: controller.signal })
          await this.#deps.ffmpeg.encodeFrames({ framesDir: join(dirs.frames, 'intro'), output: cards.intro, width, height, fps })
          await this.#deps.ffmpeg.encodeFrames({ framesDir: join(dirs.frames, 'outro'), output: cards.outro, width, height, fps })
          current.artifacts.push({
            kind: 'composition',
            label: 'Opening card',
            path: cards.intro,
            bytes: (await fs.stat(cards.intro)).size,
            createdAt: new Date().toISOString()
          })
          return 'Title cards captured and encoded'
        }, emit)

        let motionFinal = ''
        await this.#stage(current, 'render', controller, async () => {
          const sequence = [cards.intro, ...scenePaths, cards.outro]
          const normalised: string[] = []
          for (const clip of sequence) {
            this.#throwIfAborted(controller)
            const target = clip.replace(/\.mp4$/, '.norm.mp4')
            await this.#deps.ffmpeg.normalize(clip, target, { width, height, fps, signal: controller.signal })
            normalised.push(target)
          }
          const assembled = join(dirs.root, 'assembled.mp4')
          await this.#deps.ffmpeg.concat(normalised, assembled, {
            width,
            height,
            fps,
            transition: job.spec.transition,
            signal: controller.signal
          })
          motionFinal = join(dirs.out, `${job.spec.outputName}.mp4`)
          await fs.copyFile(assembled, motionFinal)
          return `Assembled ${sequence.length} segments`
        }, emit)

        await this.#stage(current, 'export', controller, async () => {
          const info = await this.#deps.ffmpeg.probe(motionFinal)
          current.artifacts.push({
            kind: 'video',
            label: `${job.spec.outputName}.mp4`,
            path: motionFinal,
            bytes: info.sizeBytes,
            createdAt: new Date().toISOString()
          })
          const posterPath = join(dirs.out, `${job.spec.outputName}-poster.jpg`)
          await this.#deps.ffmpeg.extractPoster(motionFinal, posterPath, Math.min(1.5, info.durationSeconds / 2))
          current.artifacts.push({
            kind: 'poster',
            label: 'Poster frame',
            path: posterPath,
            bytes: (await fs.stat(posterPath)).size,
            createdAt: new Date().toISOString()
          })
          return `${info.durationSeconds.toFixed(1)}s · ${(info.sizeBytes / 1_048_576).toFixed(1)} MB`
        }, emit)

        current.status = 'succeeded'
        current.progress = 100
        current.finishedAt = new Date().toISOString()
        await emit()
        return
      }

      // From here on this is a video-provider job.
      const providerId = job.spec.providerId as ProviderId

      await this.#stage(current, 'validate', controller, async () => {
        if (!this.#deps.ffmpeg.available) {
          throw new Error('FFmpeg and ffprobe must be installed (or set FRAMEFORGE_FFMPEG_DIR) before rendering.')
        }
        const key = await this.#deps.getKey(providerId)
        if (!key) throw new Error(`No API key stored for ${providerId}. Add it in Settings → API keys.`)
        return `Toolchain ready · key present for ${providerId}`
      }, emit)

      const width = dimensionsFor(job.spec.aspect).width
      const height = dimensionsFor(job.spec.aspect).height
      const fps = 30

      await this.#stage(current, 'storyboard', controller, async () => {
        if (!job.spec.office.storyboard) return 'Skipped (not requested)'

        // Prefer the user's own model: any OpenAI-compatible endpoint, billed to
        // their key, so the brief does not depend on OfficeCLI's hosted credits.
        const llm = this.#deps.getLlm ? await this.#deps.getLlm() : null
        if (llm) {
          const request = buildStoryboardRequest(job.spec)
          const brief = await llm.complete({ system: request.system, prompt: request.prompt, maxTokens: 1500 })
          const path = join(dirs.docs, 'storyboard.md')
          await fs.writeFile(path, `# ${job.spec.title}\n\n${brief}\n`, 'utf8')
          const stat = await fs.stat(path)
          current.artifacts.push({
            kind: 'storyboard',
            label: `Brief · ${llm.config.name} (${llm.config.model})`,
            path,
            bytes: stat.size,
            createdAt: new Date().toISOString()
          })
          return `Brief written with ${llm.config.model}`
        }

        const info = this.#deps.office.info
        if (!info.available || !info.path) return 'Skipped (no LLM configured and OfficeCLI is not installed)'
        const doc = await generateOfficeDocument({
          binary: info.path,
          kind: 'docx',
          title: job.spec.title,
          prompt: buildStoryboardPrompt(job.spec),
          outDir: dirs.docs,
          signal: controller.signal
        })
        current.artifacts.push(doc.artifact)
        return `Storyboard written (${Math.round(doc.artifact.bytes / 1024)} KB)`
      }, emit)

      // ---- generate + download -------------------------------------------
      const adapter = this.#deps.getAdapter(providerId)
      const key = (await this.#deps.getKey(providerId)) as string
      const clips: string[] = []

      const generateStage = current.stages.find((s) => s.id === 'generate')
      const downloadStage = current.stages.find((s) => s.id === 'download')
      if (!generateStage || !downloadStage) throw new Error('Stage table is corrupt')

      generateStage.status = 'running'
      generateStage.startedAt = new Date().toISOString()
      downloadStage.status = 'running'
      downloadStage.startedAt = new Date().toISOString()
      await emit()

      // Prompt enhancement runs per shot, before submission, only when the user
      // enabled it and an LLM is configured.
      const enhancer = job.spec.enhancePrompts && this.#deps.getLlm ? await this.#deps.getLlm() : null
      const enhancedPrompts: Array<{ index: number; original: string; used: string }> = []

      for (const shot of job.spec.shots) {
        this.#throwIfAborted(controller)

        let prompt = shot.prompt
        if (enhancer) {
          const request = buildEnhanceRequest(shot, job.spec)
          const rewritten = await enhancer.complete({ system: request.system, prompt: request.prompt, maxTokens: 320 })
          prompt = cleanEnhancement(rewritten, shot.prompt)
          enhancedPrompts.push({ index: shot.index, original: shot.prompt, used: prompt })
          generateStage.detail = `Shot ${shot.index + 1}/${job.spec.shots.length} · prompt enhanced by ${enhancer.config.model}`
          await emit()
        }

        const remote = await adapter.submit(
          {
            prompt,
            durationSeconds: job.spec.durationSeconds,
            aspect: job.spec.aspect,
            model: job.spec.model
          },
          key
        )
        const deadline = Date.now() + (this.#deps.pollTimeoutMs ?? 20 * 60 * 1000)
        let media: { url: string; headers?: Record<string, string> } | null = null
        while (!media) {
          this.#throwIfAborted(controller)
          if (Date.now() > deadline) throw new Error(`Shot ${shot.index + 1} timed out waiting for the provider`)
          const poll = await adapter.poll(remote, { key, model: job.spec.model })
          if (poll.state === 'succeeded') {
            media = poll.headers ? { url: poll.url, headers: poll.headers } : { url: poll.url }
            break
          }
          if (poll.state === 'failed') throw new Error(`Shot ${shot.index + 1} failed: ${poll.error}`)
          const perShot = (shot.index + poll.progress / 100) / job.spec.shots.length
          current.progress = Math.round(GAP_AFTER.validate + (GAP_AFTER.generate - GAP_AFTER.validate) * perShot)
          generateStage.detail = `Shot ${shot.index + 1}/${job.spec.shots.length} · ${poll.detail} ${poll.progress}%`
          await emit()
          await sleep(this.#deps.pollIntervalMs ?? 4_000)
        }

        const clipPath = join(dirs.clips, `shot-${String(shot.index + 1).padStart(2, '0')}.mp4`)
        const { bytes } = await this.#deps.http.download(media.url, clipPath, media.headers)
        clips.push(clipPath)
        current.artifacts.push({
          kind: 'clip',
          label: `Shot ${shot.index + 1}`,
          path: clipPath,
          bytes,
          createdAt: new Date().toISOString()
        })
        generateStage.detail = `Shot ${shot.index + 1}/${job.spec.shots.length} downloaded`
        current.progress = Math.round(GAP_AFTER.validate + (GAP_AFTER.generate - GAP_AFTER.validate) * ((shot.index + 1) / job.spec.shots.length))
        await emit()
      }
      if (enhancedPrompts.length > 0) {
        const promptsPath = join(dirs.docs, 'enhanced-prompts.json')
        await fs.mkdir(dirs.docs, { recursive: true })
        await fs.writeFile(promptsPath, JSON.stringify(enhancedPrompts, null, 2), 'utf8')
        current.artifacts.push({
          kind: 'log',
          label: 'Enhanced prompts (before → after)',
          path: promptsPath,
          bytes: (await fs.stat(promptsPath)).size,
          createdAt: new Date().toISOString()
        })
      }

      generateStage.status = 'succeeded'
      generateStage.endedAt = new Date().toISOString()
      downloadStage.status = 'succeeded'
      downloadStage.endedAt = new Date().toISOString()
      downloadStage.detail = `${clips.length} clip(s) on disk`
      await emit()

      // ---- compose title cards -------------------------------------------
      const { intro, outro } = compositionDurationSeconds(job.spec)
      const cards: { intro: string; outro: string } = { intro: '', outro: '' }

      await this.#stage(current, 'compose', controller, async () => {
        const introHtml = buildCompositionHtml(job.spec, { kind: 'intro', width, height, durationSeconds: intro, fps })
        current.compositionHtml = introHtml
        await this.#deps.renderCards({
          html: introHtml,
          durationSeconds: intro,
          fps,
          width,
          height,
          framesDir: join(dirs.frames, 'intro'),
          signal: controller.signal
        })
        current.progress = Math.round(GAP_AFTER.storyboard + (GAP_AFTER.compose - GAP_AFTER.storyboard) * 0.6)
        await emit()

        const outroHtml = buildCompositionHtml(job.spec, { kind: 'outro', width, height, durationSeconds: outro, fps })
        await this.#deps.renderCards({
          html: outroHtml,
          durationSeconds: outro,
          fps,
          width,
          height,
          framesDir: join(dirs.frames, 'outro'),
          signal: controller.signal
        })
        cards.intro = join(dirs.clips, 'card-intro.mp4')
        cards.outro = join(dirs.clips, 'card-outro.mp4')
        await this.#deps.ffmpeg.encodeFrames({ framesDir: join(dirs.frames, 'intro'), output: cards.intro, width, height, fps })
        await this.#deps.ffmpeg.encodeFrames({ framesDir: join(dirs.frames, 'outro'), output: cards.outro, width, height, fps })
        current.artifacts.push({
          kind: 'composition',
          label: 'Opening card',
          path: cards.intro,
          bytes: (await fs.stat(cards.intro)).size,
          createdAt: new Date().toISOString()
        })
        return 'Title cards captured and encoded'
      }, emit)

      // ---- render ---------------------------------------------------------
      let finalPath = ''
      await this.#stage(current, 'render', controller, async () => {
        for (const clip of [cards.intro, ...clips, cards.outro]) {
          this.#throwIfAborted(controller)
          const normalized = clip.replace(/\.mp4$/, '.norm.mp4')
          const info: MediaInfo = await this.#deps.ffmpeg.normalize(clip, normalized, { width, height, fps, signal: controller.signal })
          if (info.durationSeconds <= 0) throw new Error(`Normalised clip has no duration: ${clip}`)
        }
        current.progress = Math.round(GAP_AFTER.compose + (GAP_AFTER.render - GAP_AFTER.compose) * 0.5)
        await emit()

        const sequence = [cards.intro, ...clips, cards.outro].map((clip) => clip.replace(/\.mp4$/, '.norm.mp4'))
        const assembled = join(dirs.root, 'assembled.mp4')
        await this.#deps.ffmpeg.concat(sequence, assembled, {
          width,
          height,
          fps,
          transition: job.spec.transition,
          signal: controller.signal
        })
        finalPath = join(dirs.out, `${job.spec.outputName}.mp4`)
        await fs.copyFile(assembled, finalPath)
        return `Assembled ${sequence.length} segments`
      }, emit)

      // ---- export ---------------------------------------------------------
      await this.#stage(current, 'export', controller, async () => {
        const info = await this.#deps.ffmpeg.probe(finalPath)
        current.artifacts.push({
          kind: 'video',
          label: `${job.spec.outputName}.mp4`,
          path: finalPath,
          bytes: info.sizeBytes,
          createdAt: new Date().toISOString()
        })
        const posterPath = join(dirs.out, `${job.spec.outputName}-poster.jpg`)
        await this.#deps.ffmpeg.extractPoster(finalPath, posterPath, Math.min(1.5, info.durationSeconds / 2))
        current.artifacts.push({
          kind: 'poster',
          label: 'Poster frame',
          path: posterPath,
          bytes: (await fs.stat(posterPath)).size,
          createdAt: new Date().toISOString()
        })

        if (job.spec.office.deliveryDeck) {
          const office = this.#deps.office.info
          if (office.available && office.path) {
            const deck = await generateOfficeDocument({
              binary: office.path,
              kind: 'pptx',
              title: job.spec.title,
              prompt: buildDeliveryDeckPrompt(job.spec),
              outDir: dirs.docs,
              signal: controller.signal
            })
            current.artifacts.push(deck.artifact)
          }
        }
        return `${info.durationSeconds.toFixed(1)}s · ${(info.sizeBytes / 1_048_576).toFixed(1)} MB`
      }, emit)

      current.status = 'succeeded'
      current.progress = 100
      current.finishedAt = new Date().toISOString()
      await emit()
    } catch (error) {
      const cancelled = error instanceof CancelledError || controller.signal.aborted
      current.status = cancelled ? 'cancelled' : 'failed'
      current.error = cancelled ? 'Cancelled by user' : error instanceof Error ? error.message : 'Unknown failure'
      current.finishedAt = new Date().toISOString()
      for (const stage of current.stages) {
        if (stage.status === 'running') {
          stage.status = 'failed'
          stage.detail = current.error
          stage.endedAt = new Date().toISOString()
        }
      }
      await emit()
    } finally {
      this.#controllers.delete(job.id)
    }
  }

  #throwIfAborted(controller: AbortController): void {
    if (controller.signal.aborted) throw new CancelledError()
  }

  async #stage(
    job: Job,
    id: StageId,
    controller: AbortController,
    body: () => Promise<string | null>,
    emit: () => Promise<void>
  ): Promise<void> {
    const stage = job.stages.find((s) => s.id === id)
    if (!stage) throw new Error(`Unknown stage ${id}`)
    if (stage.status === 'succeeded' || stage.status === 'skipped') return
    stage.status = 'running'
    stage.startedAt = new Date().toISOString()
    job.progress = Math.max(job.progress, GAP_AFTER[id] - STAGE_WEIGHT[id])
    await emit()
    try {
      this.#throwIfAborted(controller)
      const detail = await body()
      stage.status = detail && detail.startsWith('Skipped') ? 'skipped' : 'succeeded'
      stage.detail = detail
      stage.endedAt = new Date().toISOString()
      job.progress = Math.max(job.progress, GAP_AFTER[id])
    } catch (error) {
      stage.status = 'failed'
      stage.detail = error instanceof Error ? error.message : 'Stage failed'
      stage.endedAt = new Date().toISOString()
      throw error
    } finally {
      await emit()
    }
  }
}

export type { Artifact }
