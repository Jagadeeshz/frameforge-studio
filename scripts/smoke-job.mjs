// End-to-end desktop check with no provider account: generates a clip with
// FFmpeg, serves it from a local mock provider, drives the real app through a
// full job, then verifies the exported MP4.
//   node scripts/smoke-job.mjs
import { spawn, execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, promises as fs } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)
const require = createRequire(import.meta.url)
const electronPath = require('electron')
const root = process.cwd()
const scratch = join(root, '.smoke')
const port = 8791

if (!existsSync(join(root, 'out', 'main', 'index.js'))) {
  console.error('Build first: pnpm build')
  process.exit(1)
}

await fs.mkdir(scratch, { recursive: true })
const clip = join(scratch, 'mock-clip.mp4')
if (!existsSync(clip)) {
  console.log('Rendering mock source clip…')
  await run('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30:duration=4',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', clip
  ])
}

console.log(`Starting mock provider on :${port}`)
const mock = spawn(process.execPath, [join(root, 'scripts', 'mock-provider.mjs'), String(port), clip], {
  stdio: ['ignore', 'pipe', 'pipe']
})
mock.stdout.on('data', (c) => process.stdout.write(`  ${c}`))

// Wait for the mock to answer.
for (let i = 0; i < 50; i += 1) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/v1/organization`)
    if (response.ok) break
  } catch {
    await new Promise((r) => setTimeout(r, 100))
  }
}

const out = join(scratch, 'job.png')
const child = spawn(electronPath, ['.'], {
  env: {
    ...process.env,
    FRAMEFORGE_SMOKE: '1',
    FRAMEFORGE_SMOKE_JOB: '1',
    FRAMEFORGE_SMOKE_OUT: out,
    FRAMEFORGE_DEV_PROVIDER: 'runway',
    FRAMEFORGE_DEV_BASE_URL: `http://127.0.0.1:${port}`
  },
  stdio: ['ignore', 'pipe', 'pipe']
})

let buffer = ''
child.stdout.on('data', (c) => (buffer += c.toString()))
child.stderr.on('data', (c) => (buffer += c.toString()))

await new Promise((resolve) => child.on('exit', resolve))
mock.kill()

const match = /SMOKE_RESULT (\{.*\})/.exec(buffer)
if (!match) {
  console.error('No SMOKE_RESULT emitted. Tail:')
  console.error(buffer.split('\n').slice(-25).join('\n'))
  process.exit(1)
}

const result = JSON.parse(match[1])
const job = result.jobResult
console.log(`\nJob: ${job.status} (${job.progress}%)`)
for (const stage of job.stages) console.log(`  ${stage.status.padEnd(9)} ${stage.id.padEnd(10)} ${stage.detail ?? ''}`)

const video = job.artifacts.find((a) => a.kind === 'video')
if (!video) {
  console.error('No video artifact produced.')
  process.exit(1)
}

const { stdout } = await run('ffprobe', [
  '-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', video.path
])
const probe = JSON.parse(stdout)
const stream = probe.streams.find((s) => s.codec_type === 'video')
console.log(`\nOutput: ${video.path}`)
console.log(`  ${stream.codec_name} ${stream.width}x${stream.height} ${Number(probe.format.duration).toFixed(2)}s ${(Number(probe.format.size) / 1048576).toFixed(2)} MB`)
console.log(`Screenshot: ${result.screenshot}`)

if (job.status !== 'succeeded') {
  console.error(`\nJob failed: ${job.error}`)
  process.exit(1)
}
console.log('\nEnd-to-end desktop render OK.')
