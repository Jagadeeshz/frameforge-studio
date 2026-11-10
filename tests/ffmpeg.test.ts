import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { Ffmpeg, dimensionsFor } from '../src/main/ffmpeg'
import { locateFfmpeg } from '../src/main/ffmpeg/locate'

const run = promisify(execFile)
let dir = ''

beforeAll(async () => {
  dir = await fs.mkdtemp(join(process.env.TMPDIR ?? tmpdir(), 'ff-media-'))
})

afterAll(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

async function makeClip(path: string, seconds: number, color: string): Promise<void> {
  await run('ffmpeg', [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    `color=c=${color}:s=640x360:d=${seconds}:r=30`,
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    path
  ])
}

describe('ffmpeg toolchain', () => {
  it('finds ffmpeg and ffprobe on this machine', async () => {
    const tools = await locateFfmpeg()
    expect(tools.ffmpeg.available).toBe(true)
    expect(tools.ffprobe.available).toBe(true)
    expect(tools.ffmpeg.version).toMatch(/^\d+\./)
  }, 60_000)

  it('probes a real clip', async () => {
    const tools = await locateFfmpeg()
    const ffmpeg = new Ffmpeg(tools)
    const clip = join(dir, 'probe.mp4')
    await makeClip(clip, 2, 'navy')

    const info = await ffmpeg.probe(clip)
    expect(info.width).toBe(640)
    expect(info.height).toBe(360)
    expect(info.durationSeconds).toBeGreaterThan(1.5)
    expect(info.durationSeconds).toBeLessThan(2.6)
    expect(info.videoCodec).toBe('h264')
    expect(info.sizeBytes).toBeGreaterThan(1000)
  })

  it('normalises mismatched sources to the project frame', async () => {
    const tools = await locateFfmpeg()
    const ffmpeg = new Ffmpeg(tools)
    const source = join(dir, 'wide.mp4')
    const output = join(dir, 'wide-norm.mp4')
    await makeClip(source, 1, 'darkgreen')

    const { width, height } = dimensionsFor('9:16')
    const info = await ffmpeg.normalize(source, output, { width, height, fps: 30 })
    expect(info.width).toBe(width)
    expect(info.height).toBe(height)
  })

  it('joins clips with a crossfade and keeps both durations', async () => {
    const tools = await locateFfmpeg()
    const ffmpeg = new Ffmpeg(tools)
    const a = join(dir, 'a.mp4')
    const b = join(dir, 'b.mp4')
    const joined = join(dir, 'joined.mp4')
    await makeClip(a, 2, 'black')
    await makeClip(b, 2, 'white')

    const info = await ffmpeg.concat([a, b], joined, {
      width: 640,
      height: 360,
      fps: 30,
      transition: 'crossfade',
      transitionSeconds: 0.5
    })
    expect(info.durationSeconds).toBeGreaterThan(3)
    expect(info.durationSeconds).toBeLessThan(4.5)
  })

  it('encodes a PNG sequence into video (the card-capture path)', async () => {
    const tools = await locateFfmpeg()
    const ffmpeg = new Ffmpeg(tools)
    const frame = join(dir, 'seed.png')
    await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=purple:s=320x180:d=1', '-frames:v', '1', frame])

    const framesDir = join(dir, 'frames')
    await fs.mkdir(framesDir, { recursive: true })
    const png = await fs.readFile(frame)
    for (let i = 0; i < 30; i += 1) {
      await fs.writeFile(join(framesDir, `frame_${String(i).padStart(5, '0')}.png`), png)
    }

    const output = join(dir, 'cards.mp4')
    const info = await ffmpeg.encodeFrames({ framesDir, output, width: 320, height: 180, fps: 30 })
    expect(info.durationSeconds).toBeGreaterThan(0.8)
    expect(info.width).toBe(320)
  })

  it('extracts a poster frame', async () => {
    const tools = await locateFfmpeg()
    const ffmpeg = new Ffmpeg(tools)
    const clip = join(dir, 'poster-src.mp4')
    const poster = join(dir, 'poster.jpg')
    await makeClip(clip, 2, 'teal')
    await ffmpeg.extractPoster(clip, poster, 0.5)
    const stat = await fs.stat(poster)
    expect(stat.size).toBeGreaterThan(500)
  })

  it('refuses to run when the toolchain is absent', async () => {
    const ffmpeg = new Ffmpeg({ ffmpeg: { available: false, path: null, version: null }, ffprobe: { available: false, path: null, version: null } })
    expect(ffmpeg.available).toBe(false)
    await expect(ffmpeg.probe('nope.mp4')).rejects.toThrow(/FFmpeg was not found|ffprobe was not found/)
  })
})
