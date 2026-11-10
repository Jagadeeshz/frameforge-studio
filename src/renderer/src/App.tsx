import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Clapperboard, KeyRound, ListChecks, MonitorCog, AlertTriangle, CheckCircle2 } from 'lucide-react'
import { Tabs, TabsList, Tab } from '@hyperframes/studio/ui'
import type { Job, JobSpec, ProviderDescriptor, SystemProbe, VaultStatus } from '../../shared/contract'
import { api, DEFAULT_SPEC, upsertJob } from './lib/api'
import { Pill } from './components/Bits'
import { StudioView } from './components/StudioView'
import { JobsView } from './components/JobsView'
import { KeysView } from './components/KeysView'
import { SystemView } from './components/SystemView'

export type TabId = 'studio' | 'jobs' | 'keys' | 'system'

interface Banner {
  tone: 'ok' | 'err' | 'warn'
  text: string
}

export function App(): ReactNode {
  const [tab, setTab] = useState<TabId>('studio')
  const [probe, setProbe] = useState<SystemProbe | null>(null)
  const [vault, setVault] = useState<VaultStatus | null>(null)
  const [providers, setProviders] = useState<ProviderDescriptor[]>([])
  const [jobs, setJobs] = useState<Job[]>([])
  const [spec, setSpec] = useState<JobSpec>(DEFAULT_SPEC)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [banner, setBanner] = useState<Banner | null>(null)
  const [bootError, setBootError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    const boot = async (): Promise<void> => {
      try {
        const bridge = api()
        const [probeResult, vaultResult, providerResult, jobResult] = await Promise.all([
          bridge.systemProbe(),
          bridge.vault.status(),
          bridge.providers.list(),
          bridge.jobs.list()
        ])
        if (cancelled) return
        setProbe(probeResult)
        setVault(vaultResult)
        setProviders(providerResult)
        setJobs(jobResult)
        if (jobResult[0]) setSelectedJobId(jobResult[0].id)
      } catch (error) {
        if (!cancelled) setBootError(error instanceof Error ? error.message : 'Bridge failed to start')
      }
    }
    void boot()
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    const bridge = api()
    const unsubscribe = bridge.jobs.onEvent((job) => {
      setJobs((prev) => upsertJob(prev, job))
      setSelectedJobId((current) => current ?? job.id)
    })
    return unsubscribe
  }, [])

  // Live composition preview: debounced so typing does not thrash Chromium.
  useEffect(() => {
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const { url } = await api().composition.preview(spec)
          setPreviewUrl(url)
        } catch {
          // A preview failure should never block authoring.
        }
      })()
    }, 420)
    return () => clearTimeout(timer)
  }, [spec])

  const configured = useMemo(() => {
    const map = new Map<string, boolean>()
    for (const entry of vault?.providers ?? []) map.set(entry.providerId, entry.configured)
    return map
  }, [vault])

  const selectedJob = useMemo(() => jobs.find((job) => job.id === selectedJobId) ?? null, [jobs, selectedJobId])

  const handleRender = useCallback(async (): Promise<void> => {
    setSubmitting(true)
    setBanner(null)
    try {
      const job = await api().jobs.create(spec)
      setJobs((prev) => upsertJob(prev, job))
      setSelectedJobId(job.id)
      setTab('jobs')
      setBanner({ tone: 'ok', text: `Queued “${job.spec.title}” · ${job.stages.length} stages` })
    } catch (error) {
      setBanner({ tone: 'err', text: error instanceof Error ? error.message : 'Could not queue the render' })
    } finally {
      setSubmitting(false)
    }
  }, [spec])

  const handleKeySave = useCallback(async (providerId: JobSpec['providerId'], key: string): Promise<void> => {
    const status = await api().vault.set({ providerId, key })
    setVault(status)
  }, [])

  const handleKeyRemove = useCallback(async (providerId: JobSpec['providerId']): Promise<void> => {
    const status = await api().vault.remove(providerId)
    setVault(status)
  }, [])

  const handleVaultRefresh = useCallback(async (): Promise<void> => {
    setVault(await api().vault.status())
  }, [])

  if (bootError) {
    return (
      <div className="ff-app">
        <div className="ff-pane">
          <div className="ff-err">
            <strong>Could not reach the main process.</strong>
            <div style={{ marginTop: 6 }}>{bootError}</div>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="ff-app">
      <header className="ff-header">
        <div className="ff-brand">
          <div className="ff-brand-mark">FF</div>
          <div>
            <div className="ff-brand-title">FrameForge Studio</div>
            <div className="ff-brand-sub">Local render · BYO keys</div>
          </div>
        </div>

        <Tabs value={tab} onValueChange={(value: string) => setTab(value as TabId)}>
          <TabsList aria-label="Workspace">
            <Tab value="studio">
              <span className="ff-row" style={{ gap: 6 }}>
                <Clapperboard size={13} /> Studio
              </span>
            </Tab>
            <Tab value="jobs">
              <span className="ff-row" style={{ gap: 6 }}>
                <ListChecks size={13} /> Jobs
              </span>
            </Tab>
            <Tab value="keys">
              <span className="ff-row" style={{ gap: 6 }}>
                <KeyRound size={13} /> Keys
              </span>
            </Tab>
            <Tab value="system">
              <span className="ff-row" style={{ gap: 6 }}>
                <MonitorCog size={13} /> System
              </span>
            </Tab>
          </TabsList>
        </Tabs>

        <div className="ff-row" style={{ marginLeft: 'auto', gap: 8 }}>
          <Pill
            label={probe?.ffmpeg.available ? `FFmpeg ${probe.ffmpeg.version ?? ''}`.trim() : 'FFmpeg missing'}
            state={probe?.ffmpeg.available ? 'ok' : 'bad'}
            title={probe?.ffmpeg.path ?? 'FFmpeg not found on PATH'}
          />
          <Pill
            label={probe?.officecli.available ? 'OfficeCLI ready' : 'OfficeCLI off'}
            state={probe?.officecli.available ? 'ok' : 'warn'}
            title={probe?.officecli.path ?? 'Install with: npm i -g officecli'}
          />
          <Pill
            label={vault?.backend === 'keyring' ? 'OS keychain' : vault?.backend === 'safeStorage' ? 'safeStorage' : 'Vault'}
            state={vault?.encryptionAvailable ? 'ok' : 'warn'}
            title={vault?.backendLabel ?? 'Key vault'}
          />
          <span className="ff-pill" title="Interface built with HyperFrames Studio UI primitives">
            <span className="ff-dot" data-state="ok" /> HyperFrames UI
          </span>
        </div>
      </header>

      <main className="ff-body" data-tab={tab}>
        {tab === 'studio' ? (
          <>
            <StudioView
              spec={spec}
              onChange={setSpec}
              providers={providers}
              configured={configured}
              previewUrl={previewUrl}
              submitting={submitting}
              onRender={() => void handleRender()}
              ffmpegReady={probe?.ffmpeg.available ?? false}
              officeReady={probe?.officecli.available ?? false}
              onOpenKeys={() => setTab('keys')}
            />
            <section className="ff-pane">
              <PreviewStage spec={spec} previewUrl={previewUrl} onRender={() => void handleRender()} submitting={submitting} recent={jobs[0] ?? null} configured={configured} />
            </section>
          </>
        ) : null}

        {tab === 'jobs' ? (
          <JobsView
            jobs={jobs}
            selected={selectedJob}
            onSelect={setSelectedJobId}
            onCancel={async (id) => {
              const job = await api().jobs.cancel(id)
              if (job) setJobs((prev) => upsertJob(prev, job))
            }}
            onRemove={async (id) => {
              await api().jobs.remove(id)
              setJobs((prev) => prev.filter((job) => job.id !== id))
              setSelectedJobId(null)
            }}
            onRefresh={async () => setJobs(await api().jobs.list())}
            banner={banner}
          />
        ) : null}

        {tab === 'keys' ? (
          <KeysView
            providers={providers}
            vault={vault}
            onSave={handleKeySave}
            onRemove={handleKeyRemove}
            onTest={async (providerId) => api().vault.test({ providerId })}
            onRefresh={handleVaultRefresh}
          />
        ) : null}

        {tab === 'system' ? <SystemView probe={probe} vault={vault} onRefresh={async () => setProbe(await api().systemProbe())} /> : null}
      </main>

      {banner ? (
        <div style={{ position: 'fixed', right: 18, bottom: 18, maxWidth: 420, zIndex: 50 }}>
          <div className={banner.tone === 'ok' ? 'ff-ok' : banner.tone === 'warn' ? 'ff-warn' : 'ff-err'}>
            <div className="ff-row" style={{ gap: 8, alignItems: 'flex-start' }}>
              {banner.tone === 'ok' ? <CheckCircle2 size={15} /> : <AlertTriangle size={15} />}
              <span>{banner.text}</span>
            </div>
            <button className="ff-link" style={{ marginTop: 8 }} onClick={() => setBanner(null)}>
              Dismiss
            </button>
          </div>
        </div>
      ) : null}
    </div>
  )
}

export function PreviewStage({
  spec,
  previewUrl,
  onRender,
  submitting,
  recent,
  configured
}: {
  spec: JobSpec
  previewUrl: string | null
  onRender: () => void
  submitting: boolean
  recent: Job | null
  configured: Map<string, boolean>
}): ReactNode {
  const dims =
    spec.aspect === '16:9' ? { w: 1920, h: 1080 } : spec.aspect === '9:16' ? { w: 1080, h: 1920 } : { w: 1080, h: 1080 }
  const keyReady = configured.get(spec.providerId) === true

  // The card is authored at full output resolution, so the preview renders it
  // 1:1 and scales the frame down — squeezing the document itself would reflow
  // the layout and clip the type.
  const stageRef = useRef<HTMLDivElement>(null)
  const [scale, setScale] = useState(0)

  useEffect(() => {
    const element = stageRef.current
    if (!element) return
    const measure = (): void => setScale(element.clientWidth / dims.w)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [dims.w])

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <div>
          <div className="ff-label">Composition preview</div>
          <div className="ff-h2" style={{ marginTop: 4 }}>
            Opening card · rendered by Chromium, encoded by FFmpeg
          </div>
        </div>
        <span className="ff-kbd">{spec.aspect} · {spec.durationSeconds}s × {spec.shots.length}</span>
      </div>

      <div
        ref={stageRef}
        className="ff-preview"
        style={{ aspectRatio: `${dims.w} / ${dims.h}`, width: '100%', maxWidth: spec.aspect === '9:16' ? 260 : undefined, margin: '0 auto' }}
      >
        <span className="ff-preview-badge">HyperFrames composition · live</span>
        {previewUrl && scale > 0 ? (
          <div style={{ width: dims.w, height: dims.h, transform: `scale(${scale})`, transformOrigin: 'top left' }}>
            <iframe
              title="Composition preview"
              src={previewUrl}
              width={dims.w}
              height={dims.h}
              sandbox="allow-scripts"
              style={{ display: 'block', border: 0 }}
            />
          </div>
        ) : (
          <div className="ff-empty" style={{ border: 0, height: '100%' }}>
            Building composition…
          </div>
        )}
      </div>

      <div className="ff-card">
        <div className="flex items-center justify-between" style={{ marginBottom: 10 }}>
          <span className="ff-label">Render plan</span>
          <span className="ff-mono" style={{ color: 'var(--ff-dim)' }}>
            {spec.shots.length} shots · {spec.shots.length * spec.durationSeconds}s source
          </span>
        </div>
        <ol style={{ display: 'grid', gap: 8, margin: 0, padding: 0, listStyle: 'none' }}>
          {[
            ['Storyboard', spec.office.storyboard ? 'OfficeCLI · .docx' : 'skipped'],
            ['Generate', `${spec.providerId} · ${spec.model}`],
            ['Download', 'direct to project folder'],
            ['Compose', 'title cards · Chromium capture'],
            ['Render', 'FFmpeg · H.264 · yuv420p'],
            ['Export', spec.office.deliveryDeck ? 'MP4 + poster + .pptx' : 'MP4 + poster']
          ].map(([label, detail]) => (
            <li key={label} className="flex items-center justify-between" style={{ fontSize: 12 }}>
              <span style={{ color: 'var(--ff-ink)' }}>{label}</span>
              <span className="ff-mono" style={{ color: 'var(--ff-dim)' }}>{detail}</span>
            </li>
          ))}
        </ol>
      </div>

      {!keyReady ? (
        <div className="ff-warn">
          No key stored for <strong>{spec.providerId}</strong>. Add it under Keys — it is kept in the OS credential store and never leaves this machine.
        </div>
      ) : null}

      {recent ? (
        <div className="ff-card">
          <div className="flex items-center justify-between">
            <span className="ff-label">Latest job</span>
            <span className="ff-mono" style={{ color: 'var(--ff-dim)' }}>
              {recent.status.toUpperCase()} · {recent.progress}%
            </span>
          </div>
          <div className="ff-progress" style={{ marginTop: 8 }}>
            <span style={{ width: `${recent.progress}%` }} />
          </div>
          <div className="ff-hint" style={{ marginTop: 8 }}>
            {recent.error ?? recent.stages.find((stage) => stage.status === 'running')?.label ?? `${recent.artifacts.length} artifact(s)`}
          </div>
        </div>
      ) : null}

      <button className="ff-link" onClick={onRender} disabled={submitting} style={{ alignSelf: 'flex-start' }}>
        {submitting ? 'Queueing…' : 'Queue this render →'}
      </button>
    </div>
  )
}
