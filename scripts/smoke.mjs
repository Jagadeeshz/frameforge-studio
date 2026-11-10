// Boots the built app headless-ish and prints a structured self-check.
//   node scripts/smoke.mjs [--tab keys|jobs|system]
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { join } from 'node:path'

const require = createRequire(import.meta.url)
const electronPath = require('electron')

const tabIndex = process.argv.indexOf('--tab')
const tab = tabIndex > -1 ? process.argv[tabIndex + 1] : undefined
const out = join(process.cwd(), 'smoke.png')

const child = spawn(electronPath, ['.'], {
  env: { ...process.env, FRAMEFORGE_SMOKE: '1', FRAMEFORGE_SMOKE_OUT: out, ...(tab ? { FRAMEFORGE_SMOKE_TAB: tab } : {}) },
  stdio: ['ignore', 'pipe', 'pipe']
})

let buffer = ''
const onData = (chunk) => {
  buffer += chunk.toString()
  for (const line of chunk.toString().split(/\r?\n/)) {
    if (line.includes('SMOKE_RESULT') || line.includes('SMOKE_FAILED') || line.includes('preload failed')) {
      console.log(line)
    }
  }
}
child.stdout.on('data', onData)
child.stderr.on('data', onData)

child.on('exit', (code) => {
  const match = /SMOKE_RESULT (\{.*\})/.exec(buffer)
  if (match) {
    console.log('\nSmoke check passed. Screenshot:', JSON.parse(match[1]).screenshot)
  } else {
    console.error(`\nSmoke check failed (exit ${code}).`)
    process.exitCode = 1
  }
})
