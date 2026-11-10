// Renders docs/GUIDE.md into a print-styled HTML, then asks Chromium (via
// Electron) for a PDF. One source document, no second copy to drift.
//   node scripts/md-to-pdf.mjs [in.md] [out.pdf]
import { readFile, writeFile, rm } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'

const require = createRequire(import.meta.url)
const electronPath = require('electron')

const root = process.cwd()
const input = resolve(process.argv[2] ?? join(root, 'docs', 'GUIDE.md'))
const output = resolve(process.argv[3] ?? join(root, 'docs', 'FrameForge-Studio-Guide.pdf'))
const htmlPath = join(root, 'docs', '.guide.build.html')

const md = await readFile(input, 'utf8')
const { html, title, subtitle, meta, toc } = render(md)

const printPdf = (htmlFile, pdfFile) =>
  new Promise((resolvePromise, reject) => {
    const child = spawn(electronPath, [join(root, 'scripts', 'print-pdf.cjs'), htmlFile, pdfFile], {
      stdio: ['ignore', 'pipe', 'pipe']
    })
    child.stdout.on('data', (c) => process.stdout.write(c))
    child.stderr.on('data', (c) => process.stderr.write(c))
    child.on('exit', (code) => (code === 0 ? resolvePromise() : reject(new Error(`print-pdf exited ${code}`))))
  })

// Pass 1: lay the document out to learn which page each section starts on.
await writeFile(htmlPath, page({ title, subtitle, meta, toc, body: html, pageMap: {} }), 'utf8')
const pass1 = join(root, 'docs', '.guide.pass1.pdf')
await printPdf(htmlPath, pass1)

// Pass 2: same document with a table of contents carrying real page numbers.
const pageMap = await mapSectionPages(pass1, toc)
await writeFile(htmlPath, page({ title, subtitle, meta, toc, body: html, pageMap }), 'utf8')
await printPdf(htmlPath, output)
await rm(pass1, { force: true })

console.log(`\nPDF written to ${output}`)

/** Finds the first page (after cover and contents) where each heading is typeset. */
async function mapSectionPages(pdfPath, headings) {
  const data = new Uint8Array(await readFile(pdfPath))
  const doc = await getDocument({ data, useSystemFonts: true, disableFontFace: true }).promise
  const pages = []
  for (let n = 1; n <= doc.numPages; n += 1) {
    const page = await doc.getPage(n)
    const content = await page.getTextContent()
    pages.push(
      content.items
        .filter((item) => 'str' in item)
        .map((item) => ({ str: item.str.replace(/\s+/g, ' '), height: item.height ?? 0 }))
    )
  }

  // Headings are 15.5pt against 10.2pt body copy, so height identifies them and
  // a passing mention of the same words in a paragraph cannot be mistaken for one.
  const HEADING_MIN_HEIGHT = 12
  const map = {}
  for (const heading of headings) {
    const label = heading.replace(/^\d+\.\s*/, '')
    for (let n = 2; n < pages.length; n += 1) {
      const hit = pages[n].some((item) => item.height >= HEADING_MIN_HEIGHT && item.str.includes(label))
      if (hit) {
        map[heading] = String(n + 1)
        break
      }
    }
  }
  await doc.destroy()
  return map
}

/* ------------------------------------------------------------------ */
/* Markdown subset renderer                                           */
/* ------------------------------------------------------------------ */

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function inline(text) {
  const codes = []
  let s = text.replace(/`([^`]+)`/g, (_m, code) => {
    codes.push(code)
    return `\u0000${codes.length - 1}\u0000`
  })
  s = escapeHtml(s)
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  s = s.replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<em>$2</em>')
  s = s.replace(/\u0000(\d+)\u0000/g, (_m, index) => `<code>${escapeHtml(codes[Number(index)])}</code>`)
  return s
}

function render(markdown) {
  const lines = markdown.split(/\r?\n/)
  const out = []
  const toc = []
  let title = ''
  let subtitle = ''
  let meta = ''
  let i = 0
  let seenSubtitle = false

  while (i < lines.length) {
    const line = lines[i] ?? ''

    if (line.startsWith('```')) {
      const lang = line.slice(3).trim()
      const buf = []
      i += 1
      while (i < lines.length && !(lines[i] ?? '').startsWith('```')) {
        buf.push(lines[i] ?? '')
        i += 1
      }
      i += 1
      out.push(`<pre class="code"${lang ? ` data-lang="${escapeHtml(lang)}"` : ''}><code>${escapeHtml(buf.join('\n'))}</code></pre>`)
      continue
    }

    if (/^#\s/.test(line)) {
      title = line.replace(/^#\s+/, '').trim()
      i += 1
      continue
    }

    if (/^###\s/.test(line) && !seenSubtitle) {
      subtitle = line.replace(/^###\s+/, '').trim()
      seenSubtitle = true
      i += 1
      continue
    }

    if (/^##\s/.test(line)) {
      const text = line.replace(/^##\s+/, '').trim()
      toc.push(text)
      out.push(`<h2 id="s${toc.length}"><span class="num">${escapeHtml((text.match(/^(\d+)\./) ?? [])[1] ?? '')}</span>${inline(text.replace(/^\d+\.\s*/, ''))}</h2>`)
      i += 1
      continue
    }

    if (/^###\s/.test(line)) {
      out.push(`<h3>${inline(line.replace(/^###\s+/, '').trim())}</h3>`)
      i += 1
      continue
    }

    if (/^---+\s*$/.test(line)) {
      out.push('<hr />')
      i += 1
      continue
    }

    if (/^\|/.test(line) && /^\|[\s:|-]+\|?\s*$/.test(lines[i + 1] ?? '')) {
      const header = splitRow(line)
      i += 2
      const rows = []
      while (i < lines.length && /^\|/.test(lines[i] ?? '')) {
        rows.push(splitRow(lines[i] ?? ''))
        i += 1
      }
      const head = `<tr>${header.map((cell) => `<th>${inline(cell)}</th>`).join('')}</tr>`
      const body = rows.map((row) => `<tr>${row.map((cell) => `<td>${inline(cell)}</td>`).join('')}</tr>`).join('')
      out.push(`<table><thead>${head}</thead><tbody>${body}</tbody></table>`)
      continue
    }

    if (/^[-*]\s/.test(line)) {
      const items = []
      while (i < lines.length && /^[-*]\s/.test(lines[i] ?? '')) {
        items.push(`<li>${inline((lines[i] ?? '').replace(/^[-*]\s+/, ''))}</li>`)
        i += 1
      }
      out.push(`<ul>${items.join('')}</ul>`)
      continue
    }

    if (/^\d+\.\s/.test(line)) {
      const items = []
      while (i < lines.length && /^\d+\.\s/.test(lines[i] ?? '')) {
        items.push(`<li>${inline((lines[i] ?? '').replace(/^\d+\.\s+/, ''))}</li>`)
        i += 1
      }
      out.push(`<ol>${items.join('')}</ol>`)
      continue
    }

    if (!line.trim()) {
      i += 1
      continue
    }

    const para = []
    while (i < lines.length) {
      const current = lines[i] ?? ''
      if (!current.trim() || /^(#|\||```|---|[-*]\s|\d+\.\s)/.test(current)) break
      para.push(current.trim())
      i += 1
    }
    const text = para.join(' ')
    if (/^\*\*Version/.test(text)) {
      meta = text
      continue
    }
    out.push(`<p>${inline(text)}</p>`)
  }

  return { html: out.join('\n'), title, subtitle, meta, toc }
}

function splitRow(line) {
  return line
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim())
}

/* ------------------------------------------------------------------ */
/* Print layout                                                       */
/* ------------------------------------------------------------------ */

function page({ title, subtitle, meta, toc, body, pageMap = {} }) {
  const today = new Date().toISOString().slice(0, 10)
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>${escapeHtml(title)} — Guide</title>
<style>
  @page { size: A4; }
  * { box-sizing: border-box; }
  html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  body {
    margin: 0;
    font-family: "Segoe UI", "Helvetica Neue", Arial, sans-serif;
    font-size: 10.2pt;
    line-height: 1.58;
    color: #16161d;
  }
  h2, h3 { break-after: avoid; page-break-after: avoid; }
  table, pre { break-inside: avoid; page-break-inside: avoid; }

  /* ---------- cover ---------- */
  .cover { height: 247mm; display: flex; flex-direction: column; justify-content: space-between; page-break-after: always; }
  .cover .mark {
    width: 46px; height: 46px; border-radius: 12px;
    background: linear-gradient(145deg, #7c5cff, #22d3ee);
    display: flex; align-items: center; justify-content: center;
    color: #08080c; font-weight: 700; font-size: 17px; letter-spacing: -0.04em;
  }
  .cover .top { display: flex; align-items: center; gap: 14px; }
  .cover .brand { font-size: 11pt; font-weight: 600; letter-spacing: -0.01em; }
  .cover .brand small { display: block; font-weight: 400; color: #6b6b7b; font-size: 8.4pt; letter-spacing: 0.14em; text-transform: uppercase; }
  .cover h1 {
    font-size: 44pt; line-height: 0.98; letter-spacing: -0.03em; margin: 0 0 10mm 0; font-weight: 660;
  }
  .cover .sub { font-size: 15pt; color: #4a4a5a; font-weight: 400; margin-bottom: 12mm; }
  .cover .rule { height: 4px; width: 64mm; background: #7c5cff; margin-bottom: 8mm; }
  .cover .meta { font-size: 9.4pt; color: #5a5a6a; }
  .cover .meta strong { color: #16161d; }
  .cover .foot { font-size: 8.6pt; color: #7a7a8a; border-top: 1px solid #e2e2ea; padding-top: 4mm; }

  /* ---------- toc ---------- */
  .toc { page-break-after: always; }
  .toc h2 { font-size: 16pt; margin: 0 0 8mm 0; letter-spacing: -0.01em; }
  .toc ol { list-style: none; margin: 0; padding: 0; }
  .toc li { display: flex; justify-content: space-between; gap: 12px; padding: 2.1mm 0; border-bottom: 1px solid #ececf2; font-size: 10pt; }
  .toc li .n { font-style: normal; color: #7c5cff; font-variant-numeric: tabular-nums; margin-right: 3.4mm; font-weight: 600; }
  .toc li span:last-child { color: #8a8a9a; font-variant-numeric: tabular-nums; }

  /* ---------- body ---------- */
  h2 {
    font-size: 15.5pt; letter-spacing: -0.015em; margin: 9mm 0 3mm; padding-top: 4mm;
    border-top: 2px solid #16161d; font-weight: 640;
  }
  h2 .num { color: #7c5cff; margin-right: 3mm; font-variant-numeric: tabular-nums; }
  h3 { font-size: 11.6pt; margin: 6mm 0 2mm; font-weight: 620; }
  p { margin: 0 0 3.2mm; }
  strong { font-weight: 620; }
  em { color: #3a3a4a; }
  ul, ol { margin: 0 0 3.6mm; padding-left: 6mm; }
  li { margin-bottom: 1.4mm; }
  hr { border: 0; border-top: 1px solid #e2e2ea; margin: 7mm 0; }
  code { font-family: "Cascadia Mono", Consolas, monospace; font-size: 8.9pt; background: #f2f2f7; padding: 0.4mm 1.4mm; border-radius: 2px; }
  pre.code {
    background: #f7f7fa; border: 1px solid #e6e6ee; border-left: 3px solid #7c5cff;
    padding: 3.4mm 4mm; border-radius: 4px; overflow: hidden; margin: 0 0 4mm;
  }
  pre.code code { background: none; padding: 0; font-size: 8.8pt; line-height: 1.5; white-space: pre-wrap; }
  table { width: 100%; border-collapse: collapse; margin: 0 0 5mm; font-size: 9pt; }
  th {
    text-align: left; font-weight: 620; font-size: 8.2pt; letter-spacing: 0.06em; text-transform: uppercase;
    color: #4a4a5a; border-bottom: 1.5px solid #16161d; padding: 2mm 2.4mm;
  }
  td { padding: 2mm 2.4mm; border-bottom: 1px solid #ececf2; vertical-align: top; }
  td code, th code { font-size: 8.4pt; }
  tbody tr:nth-child(even) td { background: #fafafc; }
</style>
</head>
<body>
  <section class="cover">
    <div class="top">
      <div class="mark">FF</div>
      <div class="brand">FrameForge Studio<small>Local video studio</small></div>
    </div>
    <div>
      <div class="rule"></div>
      <h1>${escapeHtml(title)}</h1>
      <div class="sub">${escapeHtml(subtitle)}</div>
      <div class="meta">${meta ? inline(meta) : ''}</div>
    </div>
    <div class="foot">Rendered on this machine · ${today} · No backend server</div>
  </section>

  <section class="toc">
    <h2>Contents</h2>
    <ol>
      ${toc
        .map((entry) => {
          const number = (entry.match(/^(\d+)\./) ?? [])[1] ?? ''
          const label = entry.replace(/^\d+\.\s*/, '')
          return `<li><span><em class="n">${escapeHtml(number.padStart(2, '0'))}</em>${escapeHtml(label)}</span><span>${escapeHtml(pageMap[entry] ?? '')}</span></li>`
        })
        .join('\n      ')}
    </ol>
  </section>

  ${body}
</body>
</html>`
}
