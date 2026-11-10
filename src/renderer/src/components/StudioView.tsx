import type { ReactNode } from 'react'
import { Clapperboard, FileText, Play, Presentation, Sparkles, Wand2 } from 'lucide-react'
import { Button, Input, Select, Toggle, Tooltip } from '@hyperframes/studio/ui'
import { MOTION_PROVIDER_ID, type JobSpec } from '../../../shared/contract'
import { Field, Pill, SectionLabel } from './Bits'

/**
 * Motion mode is the whole authoring surface now: one brief, a target length,
 * a scene count. The LLM writes the scenes; this machine renders them. Paid
 * video providers are deliberately absent from this workflow.
 */

const DURATIONS = [8, 10, 12, 15, 20, 30] as const
const SCENE_COUNTS = [2, 3, 4, 5, 6, 8] as const

export function StudioView({
  spec,
  onChange,
  submitting,
  onRender,
  ffmpegReady,
  llmLabel,
  onOpenKeys
}: {
  spec: JobSpec
  onChange: (next: JobSpec) => void
  submitting: boolean
  onRender: () => void
  ffmpegReady: boolean
  llmLabel: string | null
  onOpenKeys: () => void
}): ReactNode {
  const llmReady = Boolean(llmLabel)
  const briefReady = spec.brief.trim().length >= 12
  const perScene = (spec.durationSeconds / Math.max(1, spec.scenes)).toFixed(1)

  const patch = (partial: Partial<JobSpec>): void => onChange({ ...spec, ...partial })

  return (
    <section className="ff-pane" style={{ padding: 0, display: 'flex', flexDirection: 'column' }}>
      <div style={{ flex: 1, overflowY: 'auto', padding: 20 }}>
        <div className="flex items-center justify-between" style={{ marginBottom: 14 }}>
          <div>
            <div className="ff-label">Project</div>
            <div className="ff-h2" style={{ marginTop: 4 }}>
              Describe the piece — the model writes the scenes
            </div>
          </div>
          <Tooltip label="No video API is used. Your LLM writes HTML; Chromium and FFmpeg do the rest on this machine.">
            <span className="ff-pill">
              <Sparkles size={12} /> $0 video
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
              llmReady ? (
                <Pill label="model connected" state="ok" />
              ) : (
                <button className="ff-link" onClick={onOpenKeys}>
                  add key →
                </button>
              )
            }
          >
            Engine
          </SectionLabel>

          <div className="flex items-center justify-between" style={{ gap: 12, marginBottom: 12 }}>
            <div className="ff-row" style={{ gap: 8 }}>
              <Wand2 size={14} />
              <span style={{ fontSize: 13, fontWeight: 560 }}>Motion scenes (free)</span>
            </div>
            <span className="ff-mono" style={{ color: 'var(--ff-dim)' }}>
              {llmLabel ?? 'no model configured'}
            </span>
          </div>

          <div className="grid grid-cols-3" style={{ gap: 12 }}>
            <Field label="Length" hint="total film">
              <Select
                label="Film length"
                value={String(spec.durationSeconds)}
                options={DURATIONS.map((value) => ({ value: String(value), label: `${value} seconds` }))}
                onCommit={(value) => patch({ durationSeconds: Number(value) })}
              />
            </Field>
            <Field label="Scenes" hint={`~${perScene}s each`}>
              <Select
                label="Scene count"
                value={String(spec.scenes)}
                options={SCENE_COUNTS.map((value) => ({ value: String(value), label: `${value} scenes` }))}
                onCommit={(value) => patch({ scenes: Number(value) })}
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

          <div className="ff-hint" style={{ marginTop: 10 }}>
            {llmReady
              ? 'The model writes one self-contained animated HTML document per scene. Titles and grade come from the brief and the accent below.'
              : 'Add your DeepSeek (or any OpenAI-compatible) key under Keys. No video subscription is needed anywhere.'}
          </div>
        </div>

        <div className="ff-card">
          <SectionLabel right={<span className="ff-kbd">{spec.brief.length}/4000</span>}>Brief</SectionLabel>
          <textarea
            value={spec.brief}
            onChange={(event) => patch({ brief: event.target.value.slice(0, 4000) })}
            rows={7}
            placeholder="What is this film about? Name the message, the audience, the mood, any words that must appear on screen, and the palette."
            style={{
              width: '100%',
              resize: 'vertical',
              background: 'rgba(0,0,0,0.35)',
              border: '1px solid var(--ff-line)',
              borderRadius: 9,
              color: 'var(--ff-ink)',
              padding: '10px 12px',
              fontSize: 12.5,
              lineHeight: 1.55,
              outline: 'none'
            }}
          />
          <div className="ff-hint" style={{ marginTop: 8 }}>
            {spec.scenes} scenes × ~{perScene}s = {spec.durationSeconds}s, rendered at 30 fps.
          </div>
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
            Bookend cards
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
          <div className="ff-hint" style={{ marginTop: 8 }}>
            Added before and after the generated scenes, using the same brand template.
          </div>
        </div>

        <div className="ff-card">
          <SectionLabel>Deliverables</SectionLabel>
          <div style={{ display: 'grid', gap: 10 }}>
            <div className="flex items-center justify-between">
              <span className="ff-row" style={{ gap: 8, fontSize: 12.5 }}>
                <FileText size={14} /> Scene list + brief (.json)
              </span>
              <Toggle
                label="Storyboard file"
                checked={spec.office.storyboard}
                onCommit={(next) => patch({ office: { ...spec.office, storyboard: next } })}
              />
            </div>
            <div className="flex items-center justify-between">
              <span className="ff-row" style={{ gap: 8, fontSize: 12.5 }}>
                <Presentation size={14} /> Delivery deck (.pptx, OfficeCLI)
              </span>
              <Toggle
                label="Delivery deck"
                checked={spec.office.deliveryDeck}
                onCommit={(next) => patch({ office: { ...spec.office, deliveryDeck: next } })}
              />
            </div>
          </div>
          <div className="ff-hint" style={{ marginTop: 10 }}>
            The scene list is always written next to the film; it is the brief→scenes record you can re-run later.
          </div>
        </div>
      </div>

      <div className="ff-actionbar">
        <div className="flex items-center justify-between">
          <div>
            <div className="ff-label">Cost</div>
            <div className="ff-h2" style={{ marginTop: 2 }}>
              $0.00
              <span className="ff-hint" style={{ marginLeft: 8, fontWeight: 400 }}>
                no video API · {spec.scenes} scenes · {spec.durationSeconds}s
              </span>
            </div>
          </div>
          <Button
            variant="primary"
            size="lg"
            icon={submitting ? <Clapperboard size={15} /> : <Play size={15} />}
            loading={submitting}
            disabled={!ffmpegReady || !llmReady || !briefReady}
            onClick={onRender}
          >
            Generate scenes
          </Button>
        </div>
        {!ffmpegReady ? <div className="ff-warn" style={{ marginTop: 10 }}>FFmpeg not found. Install it or set FRAMEFORGE_FFMPEG_DIR.</div> : null}
        {!llmReady ? <div className="ff-hint" style={{ marginTop: 8 }}>Add your universal LLM key before rendering.</div> : null}
        {llmReady && !briefReady ? <div className="ff-hint" style={{ marginTop: 8 }}>Write a brief of at least a sentence.</div> : null}
      </div>
    </section>
  )
}

export const MOTION_MODE_ID = MOTION_PROVIDER_ID
