import type { ReactNode } from 'react'
import { RefreshCw, ShieldCheck, ServerOff, Terminal } from 'lucide-react'
import { Button, HyperframesLogo } from '@hyperframes/studio/ui'
import type { SystemProbe, VaultStatus } from '../../../shared/contract'
import { Pill, SectionLabel } from './Bits'

const PROVIDER_HOSTS = [
  'api.dev.runwayml.com',
  'api.lumalabs.ai',
  'queue.fal.run',
  'api.replicate.com',
  'api.heygen.com',
  'api.openai.com'
]

export function SystemView({
  probe,
  vault,
  onRefresh
}: {
  probe: SystemProbe | null
  vault: VaultStatus | null
  onRefresh: () => Promise<void>
}): ReactNode {
  return (
    <section className="ff-pane" style={{ maxWidth: 980, margin: '0 auto', width: '100%' }}>
      <div className="flex items-start justify-between" style={{ marginBottom: 16 }}>
        <div>
          <div className="ff-label">System</div>
          <div className="ff-h2" style={{ marginTop: 4, fontSize: 18 }}>Local toolchain and network posture</div>
        </div>
        <div className="ff-row" style={{ gap: 10 }}>
          <HyperframesLogo />
          <Button variant="secondary" size="sm" icon={<RefreshCw size={12} />} onClick={() => void onRefresh()}>
            Re-probe
          </Button>
        </div>
      </div>

      <div className="ff-card">
        <SectionLabel right={<Pill label="no backend" state="ok" />}>Runtime</SectionLabel>
        <Row label="Electron" value={probe?.electron ?? '—'} />
        <Row label="Chromium" value={probe?.chrome ?? '—'} />
        <Row label="Node" value={probe?.node ?? '—'} />
        <Row label="FrameForge" value={probe ? `v${probe.appVersion}` : '—'} />
        <Row label="Platform" value={probe ? `${probe.platform} · ${probe.arch}` : '—'} />
      </div>

      <div className="ff-card">
        <SectionLabel>Toolchain</SectionLabel>
        <Row
          label="FFmpeg"
          value={probe?.ffmpeg.available ? `v${probe.ffmpeg.version}` : 'not found'}
          state={probe?.ffmpeg.available ? 'ok' : 'bad'}
          hint={probe?.ffmpeg.path ?? 'Install FFmpeg or set FRAMEFORGE_FFMPEG_DIR'}
        />
        <Row
          label="ffprobe"
          value={probe?.ffprobe.available ? `v${probe.ffprobe.version}` : 'not found'}
          state={probe?.ffprobe.available ? 'ok' : 'bad'}
        />
        <Row
          label="OfficeCLI"
          value={probe?.officecli.available ? `v${probe.officecli.version}` : 'not installed'}
          state={probe?.officecli.available ? 'ok' : 'warn'}
          hint={probe?.officecli.path ?? 'Document stages are skipped without it'}
        />
        <Row label="HyperFrames UI" value={probe?.hyperframes.studioVersion ? `studio ${probe.hyperframes.studioVersion}` : '—'} />
        <Row label="HyperFrames player" value={probe?.hyperframes.playerVersion ? `player ${probe.hyperframes.playerVersion}` : '—'} />
      </div>

      <div className="ff-card">
        <SectionLabel right={<Pill label={vault?.backend ?? 'unknown'} state={vault?.encryptionAvailable ? 'ok' : 'warn'} />}>
          Key vault
        </SectionLabel>
        <Row label="Backend" value={vault?.backendLabel ?? '—'} />
        <Row
          label="Encryption"
          value={vault?.encryptionAvailable ? 'OS-backed' : 'session only'}
          state={vault?.encryptionAvailable ? 'ok' : 'warn'}
        />
        <Row label="Stored keys" value={`${vault?.providers.filter((entry) => entry.configured).length ?? 0} of ${vault?.providers.length ?? 0}`} />
      </div>

      <div className="ff-card">
        <SectionLabel right={<ServerOff size={14} />}>Network posture</SectionLabel>
        <div className="ff-hint" style={{ marginBottom: 10 }}>
          The app ships no server and calls no FrameForge endpoint. Outbound traffic is limited to the provider you choose,
          from the main process, with your own key.
        </div>
        <div style={{ display: 'grid', gap: 6 }}>
          {PROVIDER_HOSTS.map((host) => (
            <div key={host} className="flex items-center justify-between ff-mono" style={{ color: 'var(--ff-muted)' }}>
              <span>{host}</span>
              <ShieldCheck size={12} style={{ color: 'var(--ff-ok)' }} />
            </div>
          ))}
        </div>
      </div>

      <div className="ff-card">
        <SectionLabel right={<Terminal size={14} />}>Workspace</SectionLabel>
        <Row label="Data directory" value={probe?.dataDir ?? '—'} mono />
        <Row label="Renders" value={probe ? `${probe.dataDir}\\workspace\\output` : '—'} mono />
      </div>
    </section>
  )
}

function Row({
  label,
  value,
  state,
  hint,
  mono
}: {
  label: string
  value: string
  state?: 'ok' | 'warn' | 'bad'
  hint?: string
  mono?: boolean
}): ReactNode {
  return (
    <div className="flex items-start justify-between" style={{ padding: '7px 0', borderBottom: '1px dashed rgba(255,255,255,0.05)', gap: 16 }}>
      <div style={{ minWidth: 0 }}>
        <div className="ff-row" style={{ gap: 8 }}>
          {state ? <span className="ff-dot" data-state={state} /> : null}
          <span style={{ fontSize: 12.5 }}>{label}</span>
        </div>
        {hint ? <div className="ff-mono" style={{ color: 'var(--ff-dim)', marginTop: 3, overflow: 'hidden', textOverflow: 'ellipsis' }}>{hint}</div> : null}
      </div>
      <span className={mono ? 'ff-mono' : ''} style={{ color: 'var(--ff-muted)', fontSize: 12, textAlign: 'right', wordBreak: 'break-all' }}>
        {value}
      </span>
    </div>
  )
}
