import type { ReactNode } from 'react'
import { Wand2 } from 'lucide-react'
import { HyperframesLoader } from '@hyperframes/studio/ui'
import type { LlmSettings, VaultStatus } from '../../../shared/contract'
import { Pill } from './Bits'
import { CustomLlmCard } from './CustomLlmCard'

/**
 * Only the universal LLM lives here now. Video providers are gone from the
 * workflow, so asking for a Runway/Luma key here would be a dead end.
 */
export function KeysView({
  vault,
  llmSettings,
  onLlmChanged
}: {
  vault: VaultStatus | null
  llmSettings: LlmSettings | null
  onLlmChanged: () => Promise<void>
}): ReactNode {
  const keyConfigured = vault?.providers.find((entry) => entry.providerId === 'custom')?.configured === true

  return (
    <section className="ff-pane" style={{ maxWidth: 980, margin: '0 auto', width: '100%' }}>
      <div className="flex items-start justify-between" style={{ marginBottom: 16 }}>
        <div>
          <div className="ff-label">Key vault</div>
          <div className="ff-h2" style={{ marginTop: 4, fontSize: 18 }}>
            One key: your language model
          </div>
          <div className="ff-hint" style={{ maxWidth: 640, marginTop: 6 }}>
            Frames are drawn locally from HTML the model writes, so there is no video API to pay for. This key is
            stored in {vault?.backendLabel ?? 'the OS credential store'} and read only inside the main process.
          </div>
        </div>
        <div className="ff-row" style={{ gap: 8 }}>
          <Pill label={vault?.backendLabel ?? 'detecting…'} state={vault?.encryptionAvailable ? 'ok' : 'warn'} />
          <Pill label={keyConfigured ? 'key stored' : 'no key'} state={keyConfigured ? 'ok' : 'idle'} />
        </div>
      </div>

      {vault && !vault.encryptionAvailable ? (
        <div className="ff-warn" style={{ marginBottom: 12 }}>
          No OS-backed encryption was available, so the key is held in memory for this session only.
        </div>
      ) : null}

      {llmSettings === null ? (
        <HyperframesLoader title="Reading settings" detail="Loading the model configuration" />
      ) : (
        <CustomLlmCard
          settings={llmSettings}
          keyStatus={vault?.providers.find((entry) => entry.providerId === 'custom') ?? null}
          onSaved={onLlmChanged}
        />
      )}

      <div className="ff-card">
        <div className="ff-row" style={{ gap: 8, marginBottom: 8 }}>
          <Wand2 size={14} />
          <span className="ff-label">What this key does</span>
        </div>
        <ul className="ff-hint" style={{ margin: 0, paddingLeft: 18, display: 'grid', gap: 6 }}>
          <li>Writes a multi-scene storyboard from your brief, as animated HTML/CSS/SVG.</li>
          <li>Each scene is rendered frame by frame here, then encoded to H.264 by FFmpeg.</li>
          <li>Verified with a single authenticated <code>GET /models</code> — testing costs no tokens.</li>
          <li>Stored under <code>provider:custom</code>; only its last four characters and a fingerprint are kept in plain metadata.</li>
        </ul>
      </div>
    </section>
  )
}
