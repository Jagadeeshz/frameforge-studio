import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { runBinary, type ToolInfo } from './locate'

export interface MediaInfo {
  path: string
  durationSeconds: number
  width: number
  height: number
  fps: number
  videoCodec: string | null
  hasAudio: boolean
  sizeBytes: number
}

export interface FfmpegTools {
  ffmpeg: ToolInfo
  ffprobe: ToolInfo
}

export interface RenderOptions {
  width: number
  height: number
  fps: number
  crf?: number
  preset?: string
  audioPath?: string | null
  signal?: AbortSignal
}

export class FfmpegUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FfmpegUnavailableError'
  }
}

export const OUTPUT_DIMENSIONS = {
  '16:9': { width: 1920, height: 1080 },
  '9:16': { width: 1080, height: 1920 },
  '1:1': { width: 1080, height: 1080 }
} as const

export function dimensionsFor(aspect: '16:9' | '9:16' | '1:1'): { width: number; height: number } {
  return OUTPUT_DIMENSIONS[aspect]
}

interface ProbeStream {
  codec_type?: string
  codec_name?: string
  width?: number
  height?: number
  avg_frame_rate?: string
  r_frame_rate?: string
  duration?: string
}

interface ProbeJson {
  streams?: ProbeStream[]
  format?: { duration?: string; size?: string }
}

function parseRate(rate: string | undefined): number {
  if (!rate) return 0
  const [num, den] = rate.split('/')
  const n = Number(num)
  const d = Number(den ?? '1')
  if (!Number.isFinite(n) || !Number.isFinite(d) || d === 0) return 0
  return Math.round((n / d) * 1000) / 1000
}

export class Ffmpeg {
  readonly #tools: FfmpegTools
  constructor(tools: FfmpegTools) {
    this.#tools = tools
  }

  get available(): boolean {
    return this.#tools.ffmpeg.available && this.#tools.ffprobe.available
  }

  #ffmpeg(): string {
    if (!this.#tools.ffmpeg.available || !this.#tools.ffmpeg.path) {
      throw new FfmpegUnavailableError('FFmpeg was not found on this system. Install it or set FRAMEFORGE_FFMPEG_DIR.')
    }
    return this.#tools.ffmpeg.path
  }

  #ffprobe(): string {
    if (!this.#tools.ffprobe.available || !this.#tools.ffprobe.path) {
      throw new FfmpegUnavailableError('ffprobe was not found on this system. Install it or set FRAMEFORGE_FFMPEG_DIR.')
    }
    return this.#tools.ffprobe.path
  }

  async probe(file: string): Promise<MediaInfo> {
    const result = await runBinary(
      this.#ffprobe(),
      ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file],
      { timeoutMs: 30_000 }
    )
    if (result.code !== 0) throw new Error(`ffprobe failed: ${result.stderr.slice(-400) || 'unknown error'}`)
    const parsed = JSON.parse(result.stdout) as ProbeJson
    const video = parsed.streams?.find((s) => s.codec_type === 'video')
    const audio = parsed.streams?.find((s) => s.codec_type === 'audio')
    const stat = await fs.stat(file)
    return {
      path: file,
      durationSeconds: Number(parsed.format?.duration ?? video?.duration ?? 0),
      width: video?.width ?? 0,
      height: video?.height ?? 0,
      fps: parseRate(video?.avg_frame_rate ?? video?.r_frame_rate),
      videoCodec: video?.codec_name ?? null,
      hasAudio: Boolean(audio),
      sizeBytes: stat.size
    }
  }

  /** Normalises a provider clip to the project frame, so mixed sources can be joined. */
  async normalize(input: string, output: string, options: RenderOptions): Promise<MediaInfo> {
    const { width, height, fps } = options
    const vf = [
      `scale=${width}:${height}:force_original_aspect_ratio=decrease`,
      `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black`,
      'setsar=1',
      `fps=${fps}`
    ].join(',')
    const args = ['-y', '-i', input, '-vf', vf, '-an', '-c:v', 'libx264', '-preset', options.preset ?? 'veryfast', '-crf', String(options.crf ?? 20), '-pix_fmt', 'yuv420p', '-movflags', '+faststart', output]
    await this.#exec(args, options.signal)
    return this.probe(output)
  }

  /**
   * Joins normalised clips. `cut` uses the concat demuxer (stream copy, fast);
   * `crossfade` builds an xfade chain using probed durations for the offsets.
   */
  async concat(inputs: string[], output: string, options: RenderOptions & { transition: 'cut' | 'crossfade'; transitionSeconds?: number }): Promise<MediaInfo> {
    if (inputs.length === 0) throw new Error('Nothing to concatenate')
    if (inputs.length === 1) {
      await fs.copyFile(inputs[0] as string, output)
      return this.probe(output)
    }

    if (options.transition === 'cut') {
      const listFile = `${output}.concat.txt`
      const body = inputs.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join('\n')
      await fs.writeFile(listFile, `${body}\n`, 'utf8')
      try {
        await this.#exec(
          ['-y', '-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', '-movflags', '+faststart', output],
          options.signal
        )
      } finally {
        await fs.rm(listFile, { force: true })
      }
      return this.probe(output)
    }

    const duration = options.transitionSeconds ?? 0.6
    const infos = await Promise.all(inputs.map((input) => this.probe(input)))
    const args = ['-y']
    for (const input of inputs) args.push('-i', input)
    const filters: string[] = []
    let lastLabel = '0:v'
    let elapsed = infos[0]?.durationSeconds ?? 0
    for (let i = 1; i < inputs.length; i += 1) {
      const offset = Math.max(0, elapsed - duration)
      const label = i === inputs.length - 1 ? 'vout' : `v${i}`
      filters.push(`[${lastLabel}][${i}:v]xfade=transition=fade:duration=${duration}:offset=${offset.toFixed(3)}[${label}]`)
      lastLabel = label
      const clipDuration = infos[i]?.durationSeconds ?? 0
      elapsed = offset + duration + Math.max(0, clipDuration - duration)
    }
    args.push('-filter_complex', filters.join(';'), '-map', '[vout]', '-an')
    args.push('-c:v', 'libx264', '-preset', options.preset ?? 'veryfast', '-crf', String(options.crf ?? 20), '-pix_fmt', 'yuv420p', '-r', String(options.fps), '-movflags', '+faststart', output)
    await this.#exec(args, options.signal)
    return this.probe(output)
  }

  /** Encodes a captured PNG sequence (one file per frame) into a video. */
  async encodeFrames(options: {
    framesDir: string
    output: string
    width: number
    height: number
    fps: number
    crf?: number
    signal?: AbortSignal
  }): Promise<MediaInfo> {
    const pattern = join(options.framesDir, 'frame_%05d.png').replace(/\\/g, '/')
    const args = [
      '-y',
      '-framerate', String(options.fps),
      '-i', pattern,
      '-c:v', 'libx264',
      '-preset', 'medium',
      '-crf', String(options.crf ?? 18),
      '-pix_fmt', 'yuv420p',
      '-r', String(options.fps),
      '-s', `${options.width}x${options.height}`,
      '-movflags', '+faststart',
      options.output
    ]
    await this.#exec(args, options.signal)
    return this.probe(options.output)
  }

  /** Muxes an audio track onto a silent video, trimming to the shorter stream. */
  async muxAudio(video: string, audio: string, output: string, signal?: AbortSignal): Promise<MediaInfo> {
    await this.#exec(
      ['-y', '-i', video, '-i', audio, '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-shortest', '-movflags', '+faststart', output],
      signal
    )
    return this.probe(output)
  }

  async extractPoster(video: string, output: string, atSeconds = 1, signal?: AbortSignal): Promise<void> {
    await this.#exec(['-y', '-ss', String(atSeconds), '-i', video, '-frames:v', '1', '-q:v', '2', output], signal)
  }

  async #exec(args: string[], signal?: AbortSignal): Promise<void> {
    const result = await runBinary(this.#ffmpeg(), ['-hide_banner', '-loglevel', 'error', ...args], {
      timeoutMs: 30 * 60 * 1000,
      signal
    })
    if (result.code !== 0) {
      const tail = result.stderr.trim().split('\n').slice(-4).join(' | ')
      throw new Error(`FFmpeg exited with code ${result.code}: ${tail || 'no diagnostics'}`)
    }
  }
}
