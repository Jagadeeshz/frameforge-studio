// Writes the real composition document to disk so Electron can load it
// top-level for diagnosis: node scripts/build-card.mjs
import { writeFile } from 'node:fs/promises'
import { buildCompositionHtml } from '../src/shared/composition.ts'

const spec = {
  title: 'Diag',
  providerId: 'runway',
  model: 'gen4_turbo',
  aspect: '16:9',
  durationSeconds: 5,
  shots: [
    { index: 0, prompt: 'shot one' },
    { index: 1, prompt: 'shot two' },
    { index: 2, prompt: 'shot three' }
  ],
  transition: 'crossfade',
  titles: { enabled: true, headline: 'Built for the next launch', subhead: 'Quantocos · Q4 2026', accent: '#7C5CFF' },
  office: { storyboard: false, deliveryDeck: false },
  outputName: 'diag'
}

const html = buildCompositionHtml(spec, { kind: 'intro', width: 1920, height: 1080, durationSeconds: 3.2, fps: 30 })
const out = process.argv[2] ?? 'card.html'
await writeFile(out, html, 'utf8')
console.log(`wrote ${out} (${html.length} bytes)`)
