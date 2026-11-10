import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { basename, delimiter, join } from 'node:path'

export interface ToolInfo {
  available: boolean
  path: string | null
  version: string | null
}

export const MISSING_TOOL: ToolInfo = { available: false, path: null, version: null }

interface RunResult {
  code: number | null
  stdout: string
  stderr: string
}

/** Runs a binary directly — never through a shell, so arguments cannot be injected. */
export function runBinary(
  bin: string,
  args: string[],
  options?: { timeoutMs?: number; signal?: AbortSignal; env?: NodeJS.ProcessEnv }
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      ...(options?.env ? { env: options.env } : {})
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true
        child.kill('SIGKILL')
        reject(new Error(`${basename(bin)} timed out`))
      }
    }, options?.timeoutMs ?? 120_000)

    const onAbort = (): void => {
      child.kill('SIGKILL')
    }
    options?.signal?.addEventListener('abort', onAbort, { once: true })

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
      if (stdout.length > 4_000_000) stdout = stdout.slice(-1_000_000)
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
      // ffmpeg is chatty on stderr; keep only a tail for diagnostics.
      if (stderr.length > 200_000) stderr = stderr.slice(-50_000)
    })
    child.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      options?.signal?.removeEventListener('abort', onAbort)
      reject(error)
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      options?.signal?.removeEventListener('abort', onAbort)
      resolve({ code, stdout, stderr })
    })
  })
}

function parseVersion(stdout: string, tool: 'ffmpeg' | 'ffprobe'): string | null {
  const match = new RegExp(`${tool} version (\\S+)`).exec(stdout)
  return match?.[1] ?? null
}

function candidateDirs(): string[] {
  const dirs: string[] = []
  if (process.env.FRAMEFORGE_FFMPEG_DIR) dirs.push(process.env.FRAMEFORGE_FFMPEG_DIR)
  if (process.env.FFMPEG_DIR) dirs.push(process.env.FFMPEG_DIR)
  if (process.platform === 'win32') {
    dirs.push('C:\\ffmpeg\\bin', 'C:\\Program Files\\ffmpeg\\bin')
    for (const drive of ['C:', 'D:']) dirs.push(`${drive}\\tools\\ffmpeg\\bin`)
  } else {
    dirs.push('/usr/local/bin', '/opt/homebrew/bin', '/usr/bin')
  }
  return dirs
}

async function locateOne(name: 'ffmpeg' | 'ffprobe', extraDirs: string[]): Promise<ToolInfo> {
  const exe = process.platform === 'win32' ? `${name}.exe` : name
  // 1. Whatever is on PATH (the common case).
  try {
    const result = await runBinary(name, ['-version'], { timeoutMs: 8_000 })
    if (result.code === 0) {
      return { available: true, path: name, version: parseVersion(result.stdout, name) }
    }
  } catch {
    // fall through to explicit paths
  }
  // 2. Conventional install locations, plus anything the user pointed at.
  for (const dir of [...extraDirs, ...candidateDirs()]) {
    const full = join(dir, exe)
    if (!existsSync(full)) continue
    try {
      const result = await runBinary(full, ['-version'], { timeoutMs: 8_000 })
      if (result.code === 0) {
        return { available: true, path: full, version: parseVersion(result.stdout, name) }
      }
    } catch {
      continue
    }
  }
  return MISSING_TOOL
}

export async function locateFfmpeg(extraDirs: string[] = []): Promise<{ ffmpeg: ToolInfo; ffprobe: ToolInfo }> {
  const [ffmpeg, ffprobe] = await Promise.all([locateOne('ffmpeg', extraDirs), locateOne('ffprobe', extraDirs)])
  return { ffmpeg, ffprobe }
}

export function pathDelimiter(): string {
  return delimiter
}
