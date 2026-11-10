// Chromium's own print pipeline, driving printToPDF. Usage:
//   electron scripts/print-pdf.cjs <html> <pdf>
const { app, BrowserWindow } = require('electron')
const { writeFile } = require('node:fs/promises')

const [htmlPath, pdfPath] = process.argv.slice(2)

const FOOTER = `<div style="width:100%;padding:0 16mm;font-family:Segoe UI,Arial,sans-serif;font-size:8px;color:#8a8a9a;display:flex;justify-content:space-between;align-items:center;">
  <span>FrameForge Studio &mdash; Guide &amp; Operations Manual</span>
  <span><span class="pageNumber"></span> / <span class="totalPages"></span></span>
</div>`

const HEADER = `<div style="width:100%;padding:0 16mm;font-family:Segoe UI,Arial,sans-serif;font-size:8px;color:#b0b0be;text-align:right;">v0.1.0</div>`

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    width: 1200,
    height: 1600,
    backgroundColor: '#ffffff',
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false }
  })

  await win.loadFile(htmlPath)
  await new Promise((r) => setTimeout(r, 700))

  const pdf = await win.webContents.printToPDF({
    printBackground: true,
    preferCSSPageSize: true,
    displayHeaderFooter: true,
    headerTemplate: HEADER,
    footerTemplate: FOOTER,
    margins: { top: 0.62, bottom: 0.72, left: 0.63, right: 0.63 }
  })

  await writeFile(pdfPath, pdf)
  console.log(`pages written: ${pdf.length} bytes`)
  app.exit(0)
})
