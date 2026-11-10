import type { ReactNode } from 'react'
import { Download, FolderOpen, RefreshCw, Square, Trash2, XCircle } from 'lucide-react'
import { Button, IconButton, Tooltip } from '@hyperframes/studio/ui'
import type { Job } from '../../../shared/contract'
import { Empty, Pill, SectionLabel } from './Bits'
import { api, formatBytes, since, statusTone, STAGE_ICON, STAGE_TONE } from '../lib/api'

export function JobsView({
  jobs,
  selected,
  onSelect,
  onCancel,
  onRemove,
  onRefresh,
  banner
}: {
  jobs: Job[]
  selected: Job | null
  onSelect: (id: string) => void
  onCancel: (id: string) => Promise<void>
  onRemove: (id: string) => Promise<void>
  onRefresh: () => Promise<void>
  banner: { tone: 'ok' | 'err' | 'warn'; text: string } | null
}): ReactNode {
  return (
    <>
      <section className="ff-pane">
        <div className="flex items-center justify-between" style={{ marginBottom: 12 }}>
          <div>
            <div className="ff-label">Render queue</div>
            <div className="ff-h2" style={{ marginTop: 4 }}>{jobs.length} job{jobs.length === 1 ? '' : 's'}</div>
          </div>
          <IconButton icon={<RefreshCw size={14} />} aria-label="Refresh jobs" onClick={() => void onRefresh()} />
        </div>

        {banner ? <div className={banner.tone === 'ok' ? 'ff-ok' : 'ff-err'} style={{ marginBottom: 10 }}>{banner.text}</div> : null}

        {jobs.length === 0 ? (
          <Empty icon={<Download size={22} />} title="No renders yet" detail="Compose a piece in Studio and press Render locally." />
        ) : (
          <div style={{ display: 'grid', gap: 8 }}>
            {jobs.map((job) => (
              <button
                key={job.id}
                className="ff-job"
                data-active={selected?.id === job.id}
                onClick={() => onSelect(job.id)}
              >
                <div className="flex items-center justify-between" style={{ gap: 8 }}>
                  <span style={{ fontSize: 12.5, fontWeight: 560, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {job.spec.title}
                  </span>
                  <Pill label={job.status} state={statusTone(job.status)} />
                </div>
                <div className="ff-progress" style={{ marginTop: 8 }}>
                  <span style={{ width: `${job.progress}%` }} />
                </div>
                <div className="flex items-center justify-between" style={{ marginTop: 7 }}>
                  <span className="ff-mono" style={{ color: 'var(--ff-dim)' }}>
                    {job.spec.providerId} · {job.spec.shots.length}×{job.spec.durationSeconds}s
                  </span>
                  <span className="ff-mono" style={{ color: 'var(--ff-dim)' }}>{since(job.createdAt)}</span>
                </div>
              </button>
            ))}
          </div>
        )}
      </section>

      <section className="ff-pane">
        {!selected ? (
          <Empty icon={<FolderOpen size={22} />} title="Select a job" detail="Stage-by-stage progress, artifacts and logs appear here." />
        ) : (
          <div className="flex flex-col gap-4">
            <div className="flex items-start justify-between" style={{ gap: 12 }}>
              <div>
                <div className="ff-label">Job</div>
                <div className="ff-h2" style={{ marginTop: 4, fontSize: 18 }}>{selected.spec.title}</div>
                <div className="ff-hint" style={{ marginTop: 6 }}>
                  {selected.spec.providerId} · {selected.spec.model} · {selected.spec.aspect} ·{' '}
                  {selected.spec.shots.length * selected.spec.durationSeconds}s source
                </div>
              </div>
              <div className="ff-row" style={{ gap: 6 }}>
                {selected.status === 'running' || selected.status === 'queued' ? (
                  <Button variant="secondary" size="sm" icon={<Square size={12} />} onClick={() => void onCancel(selected.id)}>
                    Cancel
                  </Button>
                ) : null}
                <Tooltip label="Remove this job record (rendered files stay on disk)">
                  <IconButton icon={<Trash2 size={14} />} aria-label="Delete job" onClick={() => void onRemove(selected.id)} />
                </Tooltip>
              </div>
            </div>

            <div className="ff-card">
              <div className="flex items-center justify-between" style={{ marginBottom: 8 }}>
                <span className="ff-label">Progress</span>
                <span className="ff-mono" style={{ color: 'var(--ff-dim)' }}>{selected.progress}%</span>
              </div>
              <div className="ff-progress">
                <span style={{ width: `${selected.progress}%` }} />
              </div>
              {selected.error ? <div className="ff-err" style={{ marginTop: 10 }}>{selected.error}</div> : null}
            </div>

            <div className="ff-card">
              <SectionLabel>Pipeline</SectionLabel>
              {selected.stages.map((stage) => (
                <div className="ff-stage" key={stage.id}>
                  <span style={{ color: STAGE_TONE[stage.status], fontSize: 12 }}>{STAGE_ICON[stage.status]}</span>
                  <div style={{ minWidth: 0 }}>
                    <div className="ff-stage-name">{stage.label}</div>
                    {stage.detail ? <div className="ff-mono" style={{ color: 'var(--ff-dim)', marginTop: 2 }}>{stage.detail}</div> : null}
                  </div>
                  <span className="ff-stage-detail">{stage.status}</span>
                </div>
              ))}
            </div>

            <div className="ff-card">
              <SectionLabel right={<span className="ff-kbd">{selected.artifacts.length}</span>}>Artifacts</SectionLabel>
              {selected.artifacts.length === 0 ? (
                <div className="ff-hint">Nothing written yet.</div>
              ) : (
                <div style={{ display: 'grid', gap: 8 }}>
                  {selected.artifacts.map((artifact) => (
                    <div key={`${artifact.kind}-${artifact.path}`} className="flex items-center justify-between" style={{ gap: 10 }}>
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontSize: 12.5 }}>{artifact.label}</div>
                        <div className="ff-mono" style={{ color: 'var(--ff-dim)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 460 }}>
                          {artifact.path}
                        </div>
                      </div>
                      <div className="ff-row" style={{ gap: 6 }}>
                        <span className="ff-mono" style={{ color: 'var(--ff-dim)' }}>{formatBytes(artifact.bytes)}</span>
                        <Tooltip label="Show in folder">
                          <IconButton
                            icon={<FolderOpen size={14} />}
                            aria-label={`Reveal ${artifact.label}`}
                            onClick={() => void api().reveal(artifact.path)}
                          />
                        </Tooltip>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {selected.status === 'failed' ? (
              <div className="ff-warn">
                <div className="ff-row" style={{ gap: 8 }}>
                  <XCircle size={14} />
                  <span>Failure details are in the stage rows above. Fix the cause, then re-queue from Studio.</span>
                </div>
              </div>
            ) : null}
          </div>
        )}
      </section>
    </>
  )
}
