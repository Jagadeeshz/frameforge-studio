import type { Job, JobSpec, JobStatus } from '../../../shared/contract'

export const api = (): Window['frameforge'] => {
  if (!window.frameforge) throw new Error('Preload bridge unavailable — run inside Electron.')
  return window.frameforge
}

export const DEFAULT_SPEC: JobSpec = {
  title: 'Q4 Launch — Motion Teaser',
  providerId: 'motion',
  model: 'deepseek-chat',
  aspect: '16:9',
  durationSeconds: 15,
  shots: [],
  brief:
    'A 15-second kinetic-typography teaser for a Q4 product launch. Open on the line "Built for the next launch", ' +
    'then build momentum with the words Ship, Measure, Repeat — geometric shapes locking into place, a violet-to-cyan ' +
    'gradient field, and a final card pointing at quantocos.com. Confident, technical, no stock imagery.',
  scenes: 4,
  transition: 'crossfade',
  titles: {
    enabled: true,
    headline: 'Built for the next launch',
    subhead: 'Quantocos · Q4 2026',
    accent: '#7C5CFF'
  },
  office: { storyboard: true, deliveryDeck: false },
  enhancePrompts: false,
  outputName: 'q4-teaser'
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1048576).toFixed(1)} MB`
  return `${(bytes / 1073741824).toFixed(2)} GB`
}

export function since(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(ms / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

export function statusTone(status: JobStatus): 'ok' | 'warn' | 'bad' | 'idle' {
  switch (status) {
    case 'succeeded':
      return 'ok'
    case 'running':
    case 'queued':
      return 'warn'
    case 'failed':
      return 'bad'
    default:
      return 'idle'
  }
}

export function upsertJob(list: Job[], job: Job): Job[] {
  const next = list.filter((entry) => entry.id !== job.id)
  return [job, ...next].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

export const STAGE_ICON: Record<string, string> = {
  pending: '○',
  running: '◐',
  succeeded: '●',
  failed: '✕',
  skipped: '–'
}

export const STAGE_TONE: Record<string, string> = {
  pending: 'var(--ff-dim)',
  running: 'var(--ff-warn)',
  succeeded: 'var(--ff-ok)',
  failed: 'var(--ff-bad)',
  skipped: 'var(--ff-dim)'
}
