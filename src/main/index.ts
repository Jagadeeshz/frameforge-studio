import { app, BrowserWindow, protocol, session, safeStorage } from 'electron'
import { join } from 'node:path'
import pkg from '../../package.json'
import { IPC, PROVIDER_IDS, CUSTOM_LLM_ID, type ProviderId, type SystemProbe } from '../shared/contract'
import { KeyVault, createKeyringBackend, createSafeStorageBackend, createMemoryBackend, metaPathFor } from './vault'
import { locateFfmpeg, type ToolInfo } from './ffmpeg/locate'
import { Ffmpeg } from './ffmpeg'
import { createProviderRegistry } from './providers'
import { createLlmClient, type LlmClient } from './providers/llm'
import { SettingsStore } from './settings'
import { JobRunner } from './jobs/runner'
import { JobStore } from './jobs/store'
import { locateOfficeCli } from './office'
import { createCompositionRegistry, registerIpc, workspacePaths } from './ipc'
import { applyCsp, contentSecurityPolicy, cardCsp, hardenWebContents } from './security'
import { renderCardsWithChromium } from './render/cards'

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'ffcomp',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true }
  }
])

const isDev = !app.isPackaged
const smokeMode = process.env.FRAMEFORGE_SMOKE === '1'

/**
 * UI libraries are bundled into the renderer, so they live in devDependencies.
 * Read both blocks so the System screen can still report their versions.
 */
const PACKAGE_VERSIONS: Record<string, string | undefined> = {
  ...pkg.dependencies,
  ...pkg.devDependencies
}

/** Deterministic spec used by `FRAMEFORGE_SMOKE_JOB=1` end-to-end checks. */
const SMOKE_JOB_SPEC = {
  title: 'Smoke Motion',
  providerId: 'motion' as const,
  model: 'smoke-model',
  aspect: '16:9' as const,
  durationSeconds: 12 as const,
  shots: [],
  brief:
    'A twelve-second kinetic-type teaser: "Built for the next launch", geometric shapes locking into place, ' +
    'violet-to-cyan gradient, confident technical tone.',
  scenes: 3,
  transition: 'crossfade' as const,
  titles: {
    enabled: true,
    headline: 'Smoke Motion',
    subhead: 'FrameForge · free render',
    accent: '#7C5CFF'
  },
  office: { storyboard: true, deliveryDeck: false },
  enhancePrompts: false,
  outputName: 'smoke-motion'
}

let mainWindow: BrowserWindow | null = null

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })
  void bootstrap()
}

async function bootstrap(): Promise<void> {
  await app.whenReady()
  app.setAppUserModelId('com.quantocos.frameforge')

  const dataDir = app.getPath('userData')
  const paths = workspacePaths(dataDir)
  const compositions = createCompositionRegistry()

  // --- vault: OS credential store, then Electron safeStorage, then memory ---
  const vault = new KeyVault({
    backend:
      (await createKeyringBackend()) ??
      (await createSafeStorageBackend({
        safeStorage: {
          isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
          encryptString: (plain) => safeStorage.encryptString(plain),
          decryptString: (buffer) => safeStorage.decryptString(buffer),
          getSelectedStorageBackend: () => safeStorage.getSelectedStorageBackend?.() ?? 'unknown'
        },
        secretsFile: join(paths.vault, 'secrets.enc')
      })) ??
      createMemoryBackend(),
    metaFile: metaPathFor(dataDir)
  })
  await vault.init()

  // --- toolchain -----------------------------------------------------------
  const packagedRoot = app.isPackaged ? join(process.resourcesPath, 'app.asar.unpacked') : app.getAppPath()
  const ffmpegDirs = [join(process.resourcesPath, 'ffmpeg'), join(process.resourcesPath, 'ffmpeg', 'bin')]
  const tools = await locateFfmpeg(ffmpegDirs)
  const ffmpeg = new Ffmpeg(tools)
  const office = await locateOfficeCli(packagedRoot)

  // --- provider registry + jobs -------------------------------------------
  // FRAMEFORGE_DEV_PROVIDER / FRAMEFORGE_DEV_BASE_URL exist so the desktop app
  // can be exercised against a local gateway or a mock; unset in normal use.
  const devProvider = process.env.FRAMEFORGE_DEV_PROVIDER as ProviderId | undefined
  const devBaseUrl = process.env.FRAMEFORGE_DEV_BASE_URL
  const registry = createProviderRegistry(
    devProvider && devBaseUrl
      ? {
          baseUrls: { [devProvider]: devBaseUrl },
          allowLoopback: /^http:\/\/(127\.0\.0\.1|localhost)/.test(devBaseUrl)
        }
      : undefined
  )
  const store = new JobStore(paths.jobs)
  await store.init()
  await store.reconcile()

  // --- universal OpenAI-compatible LLM (user's own endpoint + key) ---------
  const settingsStore = new SettingsStore(dataDir)
  await settingsStore.init()

  const getLlm = async (): Promise<LlmClient | null> => {
    const config = settingsStore.llm.custom
    if (!config) return null
    const key = await vault.getSecret(CUSTOM_LLM_ID)
    if (!key) return null
    try {
      return createLlmClient(config, key)
    } catch {
      return null
    }
  }

  const runner = new JobRunner({
    store,
    getKey: (providerId) => vault.getSecret(providerId),
    getAdapter: (providerId) => registry.get(providerId),
    http: registry.http,
    ffmpeg,
    office: { info: office },
    getLlm,
    workspaceRoot: paths.root,
    renderCards: async (options) => {
      const url = compositions.register(options.html)
      await renderCardsWithChromium({ ...options, url })
    },
    onUpdate: (job) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(IPC.jobEvent, job)
      }
    }
  })

  const probe = async (): Promise<SystemProbe> => ({
    platform: process.platform,
    arch: process.arch,
    appVersion: app.getVersion(),
    electron: process.versions.electron,
    node: process.versions.node,
    chrome: process.versions.chrome,
    ffmpeg: toolInfo(tools.ffmpeg),
    ffprobe: toolInfo(tools.ffprobe),
    officecli: {
      available: office.available,
      path: office.path,
      version: office.version,
      authoring: office.available ? 'llm' : 'unknown'
    },
    hyperframes: {
      playerVersion: PACKAGE_VERSIONS['@hyperframes/player'] ?? null,
      studioVersion: PACKAGE_VERSIONS['@hyperframes/studio'] ?? null
    },
    dataDir,
    networkFree: true
  })

  // --- protocol for composition documents ---------------------------------
  await protocol.handle('ffcomp', async (request) => {
    const token = new URL(request.url).pathname.replace(/^\/+/, '')
    const html = compositions.get(token)
    if (smokeMode) console.log(`[ffcomp] ${request.url} -> ${html ? `${html.length}b` : 'MISS'}`)
    if (!html) return new Response('Composition not found', { status: 404 })
    return new Response(html, {
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'content-security-policy': cardCsp(),
        'x-content-type-options': 'nosniff'
      }
    })
  })

  applyCsp(sessionDefault(), contentSecurityPolicy())
  registerIpc({ vault, registry, runner, store, settings: settingsStore, getLlm, workspaceRoot: paths.root, probe, registerComposition: (html) => compositions.register(html) })

  mainWindow = createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow()
  })

  if (smokeMode) runSmoke(mainWindow, { probe, paths: paths.root })
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1400,
    height: 940,
    minWidth: 1120,
    minHeight: 720,
    show: false,
    backgroundColor: '#0a0a0f',
    title: 'FrameForge Studio',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false,
      devTools: isDev
    }
  })

  hardenWebContents(win.webContents, isDev ? ['http://localhost:5173', 'http://localhost:', 'devtools://'] : ['file://'])

  win.once('ready-to-show', () => win.show())

  if (isDev && process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  win.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    if (level >= 2 || smokeMode) console.log(`[renderer:${level}] ${message} (${sourceId}:${line})`)
  })

  win.webContents.on('preload-error', (_event, path, error) => {
    console.error(`[frameforge] preload failed (${path}): ${error.message}`)
  })

  win.webContents.on('did-fail-load', (_event, code, description) => {
    console.error(`[frameforge] renderer failed to load: ${code} ${description}`)
  })

  return win
}

function toolInfo(info: ToolInfo): { available: boolean; path: string | null; version: string | null } {
  return { available: info.available, path: info.path, version: info.version }
}

export function sessionDefault(): Electron.Session {
  return session.defaultSession
}

/**
 * Headless self-check used by CI and by `pnpm smoke`: boots the real app,
 * captures the window, and prints structured facts for the build log.
 */
function runSmoke(
  win: BrowserWindow,
  ctx: { probe: () => Promise<SystemProbe>; paths: string }
): void {
  win.webContents.once('did-finish-load', () => {
    setTimeout(async () => {
      try {
        const probe = await ctx.probe()
        const tab = process.env.FRAMEFORGE_SMOKE_TAB
        if (tab) {
          await win.webContents.executeJavaScript(
            `(() => { const t = [...document.querySelectorAll('[role="tab"]')].find(el => (el.textContent || '').toLowerCase().includes(${JSON.stringify(tab.toLowerCase())})); if (t) { t.click(); return true } return false })()`
          )
          await new Promise((r) => setTimeout(r, 700))
        }

        // Optional: point the universal LLM at a mock endpoint so the packaged
        // app exercises the storyboard and prompt-enhancement paths too.
        const llmUrl = process.env.FRAMEFORGE_SMOKE_LLM_URL
        let llmCheck: unknown = null
        if (llmUrl) {
          llmCheck = await win.webContents.executeJavaScript(`(async () => {
            const bridge = window.frameforge
            await bridge.llm.saveSettings({ custom: { name: 'Smoke LLM', baseUrl: ${JSON.stringify(llmUrl)}, model: 'smoke-model' } })
            await bridge.vault.set({ providerId: 'custom', key: 'sk-smoke-llm-key-123456789' })
            const settings = await bridge.llm.settings()
            const status = await bridge.vault.status()
            const entry = status.providers.find((p) => p.providerId === 'custom')
            const test = await bridge.llm.test()
            return {
              model: settings.custom ? settings.custom.model : null,
              keyConfigured: entry ? entry.configured : false,
              last4: entry ? entry.last4 : null,
              test
            }
          })()`)
        }

        let jobResult: unknown = null
        if (process.env.FRAMEFORGE_SMOKE_JOB === '1') {
          const spec = {
            ...SMOKE_JOB_SPEC,
            office: { ...SMOKE_JOB_SPEC.office, storyboard: Boolean(llmUrl) },
            enhancePrompts: Boolean(llmUrl)
          }
          jobResult = await win.webContents.executeJavaScript(`(async () => {
            const bridge = window.frameforge
            if (${JSON.stringify(spec.providerId !== 'motion')}) {
              await bridge.vault.set({ providerId: ${JSON.stringify(spec.providerId)}, key: 'smoke-run-key-123456789' })
            }
            const created = await bridge.jobs.create(${JSON.stringify(spec)})
            let job = created
            for (let i = 0; i < 300; i += 1) {
              job = await bridge.jobs.get(created.id)
              if (job && ['succeeded', 'failed', 'cancelled'].includes(job.status)) break
              await new Promise((resolve) => setTimeout(resolve, 1000))
            }
            return {
              id: job.id,
              status: job.status,
              progress: job.progress,
              error: job.error,
              stages: job.stages.map((s) => ({ id: s.id, status: s.status, detail: s.detail })),
              artifacts: job.artifacts.map((a) => ({ kind: a.kind, path: a.path, bytes: a.bytes }))
            }
          })()`)
          await win.webContents.executeJavaScript(
            `(() => { const t = [...document.querySelectorAll('[role="tab"]')].find(el => (el.textContent || '').toLowerCase().includes('jobs')); if (t) t.click() })()`
          )
          await new Promise((r) => setTimeout(r, 900))
        }

        const image = await win.webContents.capturePage()
        const out = process.env.FRAMEFORGE_SMOKE_OUT ?? join(app.getPath('temp'), 'frameforge-smoke.png')
        const { promises: fs } = await import('node:fs')
        await fs.writeFile(out, image.toPNG())
        const title = await win.webContents.executeJavaScript('document.title')
        const bridgeReady = await win.webContents.executeJavaScript('Boolean(window.frameforge && window.frameforge.jobs)')
        const frameState = await win.webContents.executeJavaScript(
          `(() => { const f = document.querySelector('iframe'); if (!f) return null; return { src: f.src, w: f.clientWidth, h: f.clientHeight, hasWindow: Boolean(f.contentWindow) } })()`
        )

        // Round-trips a throwaway key through the real OS credential store and
        // removes it again, so the smoke run proves persistence, not just IPC.
        const vaultCheck = await win.webContents.executeJavaScript(`(async () => {
          const bridge = window.frameforge
          const before = await bridge.vault.status()
          const testKey = 'smoke-test-key-123456789'
          await bridge.vault.set({ providerId: 'runway', key: testKey })
          const after = await bridge.vault.status()
          const entry = after.providers.find((p) => p.providerId === 'runway')
          const rejected = await bridge.vault.set({ providerId: 'luma', key: 'has spaces in it' }).then(() => false).catch(() => true)
          await bridge.vault.remove('runway')
          const cleaned = await bridge.vault.status()
          return {
            backend: before.backend,
            configuredAfterSet: entry.configured,
            last4: entry.last4,
            rejectedBadKey: rejected,
            configuredAfterRemove: cleaned.providers.find((p) => p.providerId === 'runway').configured
          }
        })()`)
        console.log(
          `SMOKE_RESULT ${JSON.stringify({
            screenshot: out,
            title,
            bridgeReady,
            frameState,
            vaultCheck,
            llmCheck,
            jobResult,
            ffmpeg: probe.ffmpeg.available,
            officecli: probe.officecli.available,
            vaultElectron: probe.electron,
            dataDir: probe.dataDir,
            providers: PROVIDER_IDS.length
          })}`
        )
      } catch (error) {
        console.error(`SMOKE_FAILED ${error instanceof Error ? error.message : String(error)}`)
      } finally {
        app.exit(0)
      }
    }, 2_500)
  })
}
