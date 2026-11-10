// Verifies the generated manual: page count, per-page text, key content and
// encoding. Uses pdf.js (dev dependency) so it reads what a viewer reads.
//   node scripts/verify-pdf.mjs docs/FrameForge-Studio-Guide.pdf
import { readFile } from 'node:fs/promises'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'

const path = process.argv[2] ?? 'docs/FrameForge-Studio-Guide.pdf'
const buffer = await readFile(path)
const data = new Uint8Array(buffer)

const doc = await getDocument({ data, useSystemFonts: true, disableFontFace: true }).promise
const pages = []
for (let n = 1; n <= doc.numPages; n += 1) {
  const page = await doc.getPage(n)
  const content = await page.getTextContent()
  pages.push(content.items.map((item) => ('str' in item ? item.str : '')).join(' ').replace(/\s+/g, ' ').trim())
}

const all = pages.join('\n')

console.log(`file    ${path}`)
console.log(`bytes   ${buffer.length}`)
console.log(`pages   ${doc.numPages}`)
console.log(`text    ${all.length} chars\n`)

let failures = 0
const check = (ok, label, detail = '') => {
  if (!ok) failures += 1
  console.log(`${ok ? 'ok  ' : 'MISS'}  ${label.padEnd(22)} ${detail}`)
}

check((pages[0] ?? '').includes('FrameForge Studio'), 'cover title', (pages[0] ?? '').slice(0, 52))
check((pages[0] ?? '').includes('Guide & Operations Manual'), 'cover subtitle')
check((pages[1] ?? '').includes('Contents'), 'table of contents', (pages[1] ?? '').slice(0, 46))
check((pages[2] ?? '').includes('What FrameForge Studio is'), 'section 1 on page 3', (pages[2] ?? '').slice(0, 46))

const required = [
  'What FrameForge Studio is',
  'How a render is put together',
  'System requirements',
  'Install and first run',
  'The interface',
  'API keys',
  'Making your first video',
  'Writing shots',
  'Providers, cost and timing',
  'Files and folders',
  'Checking your installation',
  'Troubleshooting',
  'Security and privacy',
  'Distributing the application',
  'Environment variables',
  'Glossary'
]
const missing = required.filter((heading) => !all.includes(heading))
check(missing.length === 0, 'all 16 sections', missing.length ? `missing: ${missing.join(', ')}` : '')

check(all.includes('Validate inputs & toolchain'), 'stage table content')

// pdf.js inserts spaces where a subset font's glyph runs split, so compare the
// monospace strings with all whitespace removed.
const compact = all.replace(/\s+/g, '')
check(compact.includes('api.dev.runwayml.com'), 'host allowlist table')
check(compact.includes('FRAMEFORGE_FFMPEG_DIR'), 'environment variables')
check(compact.includes('provider:<id>'), 'vault account naming')

// Text extraction of subset fonts is the usual place for mojibake.
check(!/Ã.|â€|Â|ï¿½/.test(all), 'encoding clean')
check(all.length > 15000, 'body text volume', `${all.length} chars`)

// A one-page manual would be a failure; runaway pagination is also a bug.
check(doc.numPages >= 10 && doc.numPages <= 20, 'page count sane', `${doc.numPages} pages`)

const longPages = pages.filter((text) => text.length > 900).length
check(longPages >= 6, 'substantive body pages', `${longPages} pages with >900 chars`)

// Sections must appear in document order, not just somewhere.
const positions = required.map((heading) => all.indexOf(heading))
check(
  positions.every((position, index) => position >= 0 && (index === 0 || position > (positions[index - 1] ?? -1))),
  'sections in order'
)

await doc.destroy()

console.log(`\n${failures === 0 ? 'PDF VERIFIED' : `${failures} CHECK(S) FAILED`}`)
process.exit(failures === 0 ? 0 : 1)
