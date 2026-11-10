// Screenshots an HTML file at A4 width for visual review.
//   electron scripts/shot-html.cjs <html> <png> [height] [scrollY]
const { app, BrowserWindow } = require('electron')
const { pathToFileURL } = require('node:url')
const { resolve } = require('node:path')
const { writeFile } = require('node:fs/promises')

const [htmlArg, pngArg, heightArg, scrollArg] = process.argv.slice(2)
const html = resolve(htmlArg)
const png = resolve(pngArg)

const watchdog = setTimeout(() => {
  console.error('shot-html timed out')
  app.exit(1)
}, 25_000)

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 794, // A4 at 96dpi
    height: Number(heightArg ?? 1123),
    show: true,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false }
  })

  await win.loadURL(pathToFileURL(html).toString())
  await new Promise((r) => setTimeout(r, 900))
  if (scrollArg) {
    await win.webContents.executeJavaScript(`window.scrollTo(0, ${Number(scrollArg)})`)
    await new Promise((r) => setTimeout(r, 350))
  }
  const image = await win.webContents.capturePage()
  await writeFile(png, image.toPNG())
  console.log(`wrote ${png}`)
  clearTimeout(watchdog)
  app.exit(0)
})
