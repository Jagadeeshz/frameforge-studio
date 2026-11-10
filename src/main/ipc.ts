import { ipcMain, shell, app } from 'electron'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  IPC,
  jobIdSchema,
  jobSpecSchema,
  providerIdInputSchema,
  setKeySchema,
  testKeySchema,
  revealSchema,
  llmSettingsSchema,
  CUSTOM_LLM_ID,
  VAULT_KEY_IDS,
  type Job,
  type ProviderDescriptor,
  type SystemProbe
} from '../shared/contract'
import { buildCompositionHtml } from '../shared/composition'
import type { KeyVault } from './vault'
import type { ProviderRegistry } from './providers'
import type { LlmClient } from './providers/llm'
import type { SettingsStore } from './settings'
import type { JobRunner } from './jobs/runner'
import type { JobStore } from './jobs/store'
import { dimensionsFor } from './ffmpeg'

export interface IpcContext {
  vault: KeyVault
  registry: ProviderRegistry
  runner: JobRunner
  store: JobStore
  settings: SettingsStore
  /** Resolves the user's OpenAI-compatible client, or null when unconfigured. */
  getLlm: () => Promise<LlmClient | null>
  workspaceRoot: string
  probe: () => Promise<SystemProbe>
  registerComposition: (html: string) => string
}

function fail(error: unknown): never {
  const message = error instanceof Error ? error.message : 'Unexpected error'
  throw new Error(message)
}

export function registerIpc(context: IpcContext): void {
  const { vault, registry, runner, store, settings } = context

  ipcMain.handle(IPC.systemProbe, async () => context.probe())

  ipcMain.handle(IPC.vaultStatus, async () => {
    try {
      return await vault.status(VAULT_KEY_IDS)
    } catch (error) {
      fail(error)
    }
  })

  ipcMain.handle(IPC.vaultSet, async (_event, raw: unknown) => {
    try {
      const input = setKeySchema.parse(raw)
      await vault.setSecret(input.providerId, input.key)
      return await vault.status(VAULT_KEY_IDS)
    } catch (error) {
      fail(error)
    }
  })

  ipcMain.handle(IPC.vaultDelete, async (_event, raw: unknown) => {
    try {
      const { providerId } = providerIdInputSchema.parse(raw)
      await vault.deleteSecret(providerId)
      return await vault.status(VAULT_KEY_IDS)
    } catch (error) {
      fail(error)
    }
  })

  ipcMain.handle(IPC.vaultTest, async (_event, raw: unknown) => {
    try {
      const input = testKeySchema.parse(raw)

      // The universal provider has no fixed endpoint, so it is verified through
      // the client built from the user's own base URL.
      if (input.providerId === CUSTOM_LLM_ID) {
        const client = await context.getLlm()
        if (!client) return { ok: false, latencyMs: 0, message: 'Add a base URL and model first' }
        const startedAt = Date.now()
        const result = await client.verify()
        return { ok: result.ok, latencyMs: Date.now() - startedAt, message: result.message }
      }

      const key = await vault.getSecret(input.providerId)
      if (!key) return { ok: false, latencyMs: 0, message: 'No key stored for this provider' }
      const adapter = registry.get(input.providerId)
      const startedAt = Date.now()
      const result = await adapter.verify(key)
      return { ok: result.ok, latencyMs: Date.now() - startedAt, message: result.message }
    } catch (error) {
      fail(error)
    }
  })

  ipcMain.handle(IPC.llmSettingsGet, async () => settings.llm)

  ipcMain.handle(IPC.llmSettingsSet, async (_event, raw: unknown) => {
    try {
      const next = llmSettingsSchema.parse(raw)
      return await settings.setLlm(next)
    } catch (error) {
      fail(error)
    }
  })

  ipcMain.handle(IPC.llmTest, async () => {
    try {
      const client = await context.getLlm()
      if (!client) return { ok: false, latencyMs: 0, message: 'Add a base URL, model and key first' }
      const startedAt = Date.now()
      const result = await client.verify()
      return { ok: result.ok, latencyMs: Date.now() - startedAt, message: result.message }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Connection failed'
      return { ok: false, latencyMs: 0, message }
    }
  })

  ipcMain.handle(IPC.providersList, async (): Promise<ProviderDescriptor[]> => registry.list())

  ipcMain.handle(IPC.jobCreate, async (_event, raw: unknown): Promise<Job> => {
    try {
      const spec = jobSpecSchema.parse(raw)
      return await runner.enqueue(spec)
    } catch (error) {
      fail(error)
    }
  })

  ipcMain.handle(IPC.jobList, async (): Promise<Job[]> => store.list())

  ipcMain.handle(IPC.jobGet, async (_event, raw: unknown) => {
    try {
      const { jobId } = jobIdSchema.parse(raw)
      return await store.get(jobId)
    } catch (error) {
      fail(error)
    }
  })

  ipcMain.handle(IPC.jobCancel, async (_event, raw: unknown) => {
    try {
      const { jobId } = jobIdSchema.parse(raw)
      return await runner.cancel(jobId)
    } catch (error) {
      fail(error)
    }
  })

  ipcMain.handle(IPC.jobDelete, async (_event, raw: unknown) => {
    try {
      const { jobId } = jobIdSchema.parse(raw)
      await store.remove(jobId)
      return { ok: true }
    } catch (error) {
      fail(error)
    }
  })

  ipcMain.handle(IPC.compositionPreview, async (_event, raw: unknown) => {
    try {
      const spec = jobSpecSchema.parse(raw)
      const { width, height } = dimensionsFor(spec.aspect)
      const html = buildCompositionHtml(spec, {
        kind: 'intro',
        width,
        height,
        durationSeconds: spec.aspect === '9:16' ? 2.6 : 3.2,
        fps: 30,
        mode: 'preview'
      })
      return { url: context.registerComposition(html) }
    } catch (error) {
      fail(error)
    }
  })

  ipcMain.handle(IPC.reveal, async (_event, raw: unknown) => {
    try {
      const { path } = revealSchema.parse(raw)
      const resolved = path.replace(/\\/g, '/')
      const root = context.workspaceRoot.replace(/\\/g, '/')
      if (!resolved.startsWith(root)) throw new Error('Refusing to reveal a path outside the project workspace')
      shell.showItemInFolder(path)
      return { ok: true }
    } catch (error) {
      fail(error)
    }
  })
}

/** Composition documents are served from memory over a dedicated scheme. */
export function createCompositionRegistry(): {
  register(html: string): string
  get(token: string): string | null
} {
  const store = new Map<string, { html: string; createdAt: number }>()
  const MAX = 40
  const TTL = 1000 * 60 * 30

  return {
    register(html: string): string {
      const token = randomUUID()
      store.set(token, { html, createdAt: Date.now() })
      for (const [key, value] of store) {
        if (Date.now() - value.createdAt > TTL || store.size > MAX) store.delete(key)
        else break
      }
      return `ffcomp://card/${token}`
    },
    get(token: string): string | null {
      return store.get(token)?.html ?? null
    }
  }
}

export function workspacePaths(dataDir: string): { root: string; output: string; jobs: string; vault: string } {
  return {
    root: join(dataDir, 'workspace'),
    output: join(dataDir, 'workspace', 'output'),
    jobs: join(dataDir, 'jobs'),
    vault: join(dataDir, 'vault')
  }
}

export function appDataDir(): string {
  return app.getPath('userData')
}
