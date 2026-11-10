import { promises as fs, type Dirent } from 'node:fs'
import { delimiter, join } from 'node:path'
import { runBinary } from '../ffmpeg/locate'
import type { Artifact, JobSpec } from '../../shared/contract'

/**
 * OfficeCLI is the document-orchestration stage: it turns the same shot list
 * that drives rendering into an editable storyboard (.docx) and delivery deck
 * (.pptx). It runs as a child process on this machine — it is not our server,
 * and the app works without it (the stage is skipped with a clear reason).
 */

export type OfficeDocKind = 'docx' | 'pptx'

export interface OfficeCliInfo {
  available: boolean
  path: string | null
  version: string | null
  mode: 'anonymous' | 'account' | 'api-key' | 'unknown'
}

export const OFFICE_MISSING: OfficeCliInfo = { available: false, path: null, version: null, mode: 'unknown' }

function sanitizedEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  if (process.platform === 'win32') {
    // MSYS/git-bash puts its own `tar` first on PATH, and the OfficeCLI wrapper
    // uses tar to unpack its binary. Windows' bsdtar handles "C:\..." paths.
    const system32 = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')
    env.PATH = [system32, process.env.PATH ?? ''].filter(Boolean).join(delimiter)
    env.Path = env.PATH
  }
  env.OFFICECLI_NO_TELEMETRY = '1'
  return env
}

function binaryName(): string {
  return process.platform === 'win32' ? 'officecli.exe' : 'officecli'
}

async function exists(path: string): Promise<boolean> {
  try {
    await fs.access(path)
    return true
  } catch {
    return false
  }
}

export async function locateOfficeCli(rootDir: string): Promise<OfficeCliInfo> {
  const candidates: string[] = []
  if (process.env.FRAMEFORGE_OFFICECLI) candidates.push(process.env.FRAMEFORGE_OFFICECLI)
  candidates.push(
    join(rootDir, 'node_modules', 'officecli', 'runtime', binaryName()),
    join(rootDir, 'node_modules', '.pnpm')
  )
  // Any `officecli` already on PATH.
  candidates.push('officecli')

  for (const candidate of candidates) {
    if (candidate.includes('.pnpm')) continue
    if (candidate !== 'officecli' && !(await exists(candidate))) continue
    try {
      const result = await runBinary(candidate, ['--version'], { timeoutMs: 20_000, env: sanitizedEnv() })
      const version = /officecli version ([^\s(]+)/.exec(result.stdout)?.[1] ?? null
      const mode = await readMode(candidate)
      return { available: true, path: candidate, version, mode }
    } catch {
      continue
    }
  }
  return OFFICE_MISSING
}

async function readMode(binary: string): Promise<OfficeCliInfo['mode']> {
  try {
    const result = await runBinary(binary, ['whoami'], { timeoutMs: 20_000, env: sanitizedEnv() })
    const text = `${result.stdout}\n${result.stderr}`.toLowerCase()
    if (text.includes('api key')) return 'api-key'
    if (text.includes('account')) return 'account'
    if (text.includes('anonymous')) return 'anonymous'
    return 'unknown'
  } catch {
    return 'unknown'
  }
}

export function buildStoryboardPrompt(spec: JobSpec): string {
  const shots = spec.shots
    .map((shot) => `Shot ${shot.index + 1} (${spec.durationSeconds}s): ${shot.prompt}`)
    .join('\n')
  return [
    `Write a concise video production brief for a ${spec.aspect} piece titled "${spec.title}".`,
    `It is generated with ${spec.providerId} using ${spec.model}, ${shots ? spec.shots.length : 1} shots of ${spec.durationSeconds} seconds, joined with ${spec.transition === 'cut' ? 'hard cuts' : 'crossfades'}.`,
    'Include: objective, audience, visual direction, the shot list with prompt text, on-screen copy, and a delivery checklist.',
    'Shot list:',
    shots
  ].join('\n')
}

export function buildDeliveryDeckPrompt(spec: JobSpec): string {
  return [
    `Create a 4-slide delivery deck for the video project "${spec.title}".`,
    `Slides: 1) Title and one-line summary, 2) What was generated and with which model (${spec.providerId} · ${spec.model}), 3) Shot-by-shot rundown, 4) Sign-off and next steps.`,
    `Keep it terse and client-ready. Do not invent metrics. Runtime is ${spec.shots.length * spec.durationSeconds} seconds of source footage.`
  ].join('\n')
}

export interface OfficeResult {
  artifact: Artifact
  command: string
}

export async function generateOfficeDocument(options: {
  binary: string
  kind: OfficeDocKind
  title: string
  prompt: string
  outDir: string
  signal?: AbortSignal
}): Promise<OfficeResult> {
  await fs.mkdir(options.outDir, { recursive: true })
  const args = [
    'new',
    options.kind,
    options.title,
    '--prompt',
    options.prompt,
    '--out',
    options.outDir,
    '--mode',
    'fast',
    '--no-publish',
    '--json'
  ]
  const result = await runBinary(options.binary, args, {
    timeoutMs: 240_000,
    signal: options.signal,
    env: sanitizedEnv()
  })
  if (result.code !== 0) {
    const detail = `${result.stderr}\n${result.stdout}`.trim().split('\n').slice(-3).join(' | ')
    throw new Error(`OfficeCLI exited with code ${result.code}: ${detail || 'no output'}`)
  }

  const produced = extractPath(result.stdout) ?? (await newestFile(options.outDir, options.kind))
  if (!produced) throw new Error('OfficeCLI finished but no document was found')
  const stat = await fs.stat(produced)
  return {
    command: `officecli ${args.map((a) => (a.includes(' ') ? `"${a}"` : a)).join(' ')}`,
    artifact: {
      kind: options.kind === 'docx' ? 'storyboard' : 'deck',
      label: options.kind === 'docx' ? 'Storyboard (.docx)' : 'Delivery deck (.pptx)',
      path: produced,
      bytes: stat.size,
      createdAt: new Date().toISOString()
    }
  }
}

/** Pulls a documents path out of the JSON envelope without trusting a fixed schema. */
function extractPath(stdout: string): string | null {
  const lines = stdout.split(/\r?\n/).map((l) => l.trim())
  for (const line of lines.reverse()) {
    if (!line.startsWith('{') || !line.endsWith('}')) continue
    try {
      const parsed: unknown = JSON.parse(line)
      const found = deepFindDocument(parsed)
      if (found) return found
    } catch {
      continue
    }
  }
  return null
}

function deepFindDocument(value: unknown, depth = 0): string | null {
  if (depth > 6) return null
  if (typeof value === 'string') {
    return /\.(docx|pptx)$/i.test(value) ? value : null
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = deepFindDocument(item, depth + 1)
      if (found) return found
    }
    return null
  }
  if (value && typeof value === 'object') {
    for (const entry of Object.values(value as Record<string, unknown>)) {
      const found = deepFindDocument(entry, depth + 1)
      if (found) return found
    }
  }
  return null
}

async function newestFile(dir: string, ext: OfficeDocKind): Promise<string | null> {
  const matches: { path: string; mtime: number }[] = []
  const walk = async (current: string, depth: number): Promise<void> => {
    if (depth > 3) return
    let entries: Dirent[]
    try {
      entries = await fs.readdir(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(current, entry.name)
      if (entry.isDirectory()) {
        await walk(full, depth + 1)
      } else if (entry.name.toLowerCase().endsWith(`.${ext}`)) {
        const stat = await fs.stat(full)
        matches.push({ path: full, mtime: stat.mtimeMs })
      }
    }
  }
  await walk(dir, 0)
  matches.sort((a, b) => b.mtime - a.mtime)
  return matches[0]?.path ?? null
}
