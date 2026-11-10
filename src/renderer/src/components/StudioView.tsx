import type { ReactNode } from 'react'
import { Plus, Trash2, Play, Sparkles, FileText, Presentation } from 'lucide-react'
import { Button, IconButton, Input, Select, Toggle, Tooltip } from '@hyperframes/studio/ui'
import type { JobSpec, ProviderDescriptor, ProviderId } from '../../../shared/contract'
import { Field, SectionLabel } from './Bits'

const COST_PER_SECOND: Record<ProviderId, number> = {
  runway: 0.1,
  luma: 0.09,
  fal: 0.07,
  replicate: 0.06,
  heygen: 0.05,
  openai: 0.1
}

const DURATIONS = ['4', '5', '6', '8', '10'] as const

export function StudioView({
  spec,
  onChange,
  providers,
  configured,
  submitting,
  onRender,
  ffmpegReady,
  officeReady,
  onOpenKeys
}: {
  spec: JobSpec
  onChange: (next: JobSpec) => void
  providers: ProviderDescriptor[]
  configured: Map<string, boolean>
  previewUrl: string | null
  submitting: boolean
  onRender: () => void
  ffmpegReady: boolean
  officeReady: boolean
  onOpenKeys: () => void
}): ReactNode {
  const active = providers.find((provider) => provider.id === spec.providerId)
  const estimate = Math.round(spec.shots.length * spec.durationSeconds * (COST_PER_SECOND[spec.providerId] ?? 0.08) * 100) / 100
  const keyReady = configured.get(spec.providerId) === true
  const shotsValid = spec.shots.every((shot) => shot.prompt.trim().length > 3)

  const patch = (partial: Partial<JobSpec>): void => onChange({ ...spec, ...partial })

  const setShot = (index: number, prompt: string): void => {
    patch({ shots: spec.shots.map((shot) => (shot.index === index ? { ...shot, prompt } : shot)) })
  }

  const addShot = (): void => {
    if (spec.shots.length >= 6) return
    patch({ shots: [...spec.shots, { index: spec.shots.length, prompt: '' }] })
  }

  const removeShot = (index: number): void => {
    if (spec.shots.length === 1) return
    patch({ shots: spec.shots.filter((shot) => shot.index !== index).map((shot, position) => ({ ...shot, index: position })) })
  }

  return (
    <section className="ff-pane" style={{ padding: 0, display: 'flex', flexDirection: 'column' }}>
      <div style={{ flex: 1, overflowY: 'auto', padding: 20 }}>
      <div className="flex items-center justify-between" style={{ marginBottom: 14 }}>
        <div>
          <div className="ff-label">Project</div>
          <div className="ff-h2" style={{ marginTop: 4 }}>
            Describe the piece, pick a provider, render locally
          </div>
        </div>
        <Tooltip label="Everything runs on this machine. The only network calls are your own provider API.">
          <span className="ff-pill">
            <Sparkles size={12} /> No backend
          </span>
        </Tooltip>
      </div>

      <div className="ff-card">
        <Field label="Title">
          <Input value={spec.title} onCommit={(value) => patch({ title: value || spec.title })} placeholder="Launch teaser" />
        </Field>
        <div className="grid grid-cols-2" style={{ gap: 12, marginTop: 12 }}>
          <Field label="Output file" hint="Saved to /output">
            <Input value={spec.outputName} onCommit={(value) => patch({ outputName: value || spec.outputName })} />
          </Field>
          <Field label="Aspect">
            <Select
              label="Aspect ratio"
              value={spec.aspect}
              options={[
                { value: '16:9', label: '16:9 landscape' },
                { value: '9:16', label: '9:16 portrait' },
                { value: '1:1', label: '1:1 square' }
              ]}
              onCommit={(value) => patch({ aspect: value as JobSpec['aspect'] })}
            />
          </Field>
        </div>
      </div>

      <div className="ff-card">
        <SectionLabel
          right={
            keyReady ? (
              <span className="ff-pill" style={{ borderColor: 'rgba(52,211,153,.35)' }}>
                key stored
              </span>
            ) : (
              <button className="ff-link" onClick={onOpenKeys}>
                add key →
              </button>
            )
          }
        >
          Provider
        </SectionLabel>
        <div className="grid grid-cols-2" style={{ gap: 12 }}>
          <Field label="Service">
            <Select
              label="Provider"
              value={spec.providerId}
              options={providers.map((provider) => ({ value: provider.id, label: provider.label }))}
              onCommit={(value) => {
                const next = providers.find((provider) => provider.id === value)
                patch({
                  providerId: value as ProviderId,
                  model: next?.defaultModel ?? spec.model
                })
              }}
            />
          </Field>
          <Field label="Model">
            <Select
              label="Model"
              value={spec.model}
              options={(active?.models ?? [spec.model]).map((model) => ({ value: model, label: model }))}
              onCommit={(value) => patch({ model: value })}
            />
          </Field>
          <Field label="Shot length">
            <Select
              label="Shot length"
              value={String(spec.durationSeconds)}
              options={DURATIONS.map((value) => ({ value, label: `${value} seconds` }))}
              onCommit={(value) => patch({ durationSeconds: Number(value) as JobSpec['durationSeconds'] })}
            />
          </Field>
          <Field label="Join">
            <Select
              label="Transition"
              value={spec.transition}
              options={[
                { value: 'crossfade', label: 'Crossfade' },
                { value: 'cut', label: 'Hard cut' }
              ]}
              onCommit={(value) => patch({ transition: value as JobSpec['transition'] })}
            />
          </Field>
        </div>
        {active ? <div className="ff-hint" style={{ marginTop: 10 }}>{active.note}</div> : null}
      </div>

      <div className="ff-card">
        <SectionLabel right={<span className="ff-kbd">{spec.shots.length}/6</span>}>Shot list</SectionLabel>
        <div style={{ display: 'grid', gap: 10 }}>
          {spec.shots.map((shot) => (
            <div className="ff-shot" key={shot.index}>
              <div className="ff-shot-head">
                <span className="ff-label">Shot {String(shot.index + 1).padStart(2, '0')}</span>
                <IconButton
                  icon={<Trash2 size={13} />}
                  aria-label={`Remove shot ${shot.index + 1}`}
                  onClick={() => removeShot(shot.index)}
                  disabled={spec.shots.length === 1}
                />
              </div>
              <textarea
                value={shot.prompt}
                onChange={(event) => setShot(shot.index, event.target.value)}
                rows={2}
                placeholder="Describe camera, subject, light, mood…"
                style={{
                  width: '100%',
                  resize: 'vertical',
                  background: 'rgba(0,0,0,0.35)',
                  border: '1px solid var(--ff-line)',
                  borderRadius: 9,
                  color: 'var(--ff-ink)',
                  padding: '9px 10px',
                  fontSize: 12.5,
                  lineHeight: 1.5,
                  outline: 'none'
                }}
              />
            </div>
          ))}
        </div>
        <Button variant="secondary" size="sm" icon={<Plus size={13} />} onClick={addShot} disabled={spec.shots.length >= 6} style={{ marginTop: 10 }}>
          Add shot
        </Button>
      </div>

      <div className="ff-card">
        <SectionLabel
          right={
            <Toggle
              label="Show titles"
              checked={spec.titles.enabled}
              onCommit={(next) => patch({ titles: { ...spec.titles, enabled: next } })}
            />
          }
        >
          Title cards
        </SectionLabel>
        <div className="grid grid-cols-2" style={{ gap: 12 }}>
          <Field label="Headline">
            <Input value={spec.titles.headline} onCommit={(value) => patch({ titles: { ...spec.titles, headline: value } })} />
          </Field>
          <Field label="Subhead">
            <Input value={spec.titles.subhead} onCommit={(value) => patch({ titles: { ...spec.titles, subhead: value } })} />
          </Field>
        </div>
        <div className="ff-row" style={{ marginTop: 12, gap: 10 }}>
          <span className="ff-label">Accent</span>
          <input
            type="color"
            value={spec.titles.accent}
            onChange={(event) => patch({ titles: { ...spec.titles, accent: event.target.value } })}
            style={{ width: 34, height: 24, borderRadius: 6, border: '1px solid var(--ff-line)', background: 'transparent' }}
          />
          <span className="ff-mono" style={{ color: 'var(--ff-dim)' }}>{spec.titles.accent}</span>
        </div>
      </div>

      <div className="ff-card">
        <SectionLabel>Office deliverables</SectionLabel>
        <div style={{ display: 'grid', gap: 10 }}>
          <div className="flex items-center justify-between">
            <span className="ff-row" style={{ gap: 8, fontSize: 12.5 }}>
              <FileText size={14} /> Storyboard brief (.docx)
            </span>
            <Toggle
              label="Storyboard brief"
              checked={spec.office.storyboard}
              onCommit={(next) => patch({ office: { ...spec.office, storyboard: next } })}
              disabled={!officeReady}
            />
          </div>
          <div className="flex items-center justify-between">
            <span className="ff-row" style={{ gap: 8, fontSize: 12.5 }}>
              <Presentation size={14} /> Delivery deck (.pptx)
            </span>
            <Toggle
              label="Delivery deck"
              checked={spec.office.deliveryDeck}
              onCommit={(next) => patch({ office: { ...spec.office, deliveryDeck: next } })}
              disabled={!officeReady}
            />
          </div>
        </div>
        {!officeReady ? <div className="ff-hint" style={{ marginTop: 10 }}>OfficeCLI not detected — document stages will be skipped.</div> : null}
      </div>
      </div>

      <div className="ff-actionbar">
        <div className="flex items-center justify-between">
          <div>
            <div className="ff-label">Estimate</div>
            <div className="ff-h2" style={{ marginTop: 2 }}>
              ~${estimate.toFixed(2)}
              <span className="ff-hint" style={{ marginLeft: 8, fontWeight: 400 }}>
                {spec.shots.length} × {spec.durationSeconds}s on {spec.providerId}
              </span>
            </div>
          </div>
          <Button
            variant="primary"
            size="lg"
            icon={<Play size={15} />}
            loading={submitting}
            disabled={!ffmpegReady || !keyReady || !shotsValid}
            onClick={onRender}
          >
            Render locally
          </Button>
        </div>
        {!ffmpegReady ? <div className="ff-warn" style={{ marginTop: 10 }}>FFmpeg not found. Install it or set FRAMEFORGE_FFMPEG_DIR.</div> : null}
        {!keyReady ? <div className="ff-hint" style={{ marginTop: 8 }}>Add a {spec.providerId} key before rendering.</div> : null}
      </div>
    </section>
  )
}
