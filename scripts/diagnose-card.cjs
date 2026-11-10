// Loads the card document top-level (no iframe) and reports what actually
// renders: animation count, computed opacity, and average luminance.
// Usage: electron scripts/diagnose-card.cjs <card.html> <screenshot.png>
const { app, BrowserWindow } = require('electron')
const { writeFile } = require('node:fs/promises')

const cardPath = process.argv[2]
const shotPath = process.argv[3]

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1280,
    height: 720,
    show: false,
    backgroundColor: '#08080c',
    webPreferences: { offscreen: true, sandbox: true, contextIsolation: true, nodeIntegration: false }
  })

  win.webContents.on('console-message', (_e, level, message) => console.log(`[card:${level}] ${message}`))

  await win.loadFile(cardPath)
  await new Promise((r) => setTimeout(r, 800))

  const state = await win.webContents.executeJavaScript(`(() => {
    const h1 = document.querySelector('h1')
    const anims = document.getAnimations ? document.getAnimations() : []
    return {
      ready: Boolean(window.__ff && window.__ff.ready),
      animations: anims.length,
      states: anims.slice(0, 4).map(a => ({ name: a.animationName, currentTime: a.currentTime, playState: a.playState })),
      h1Opacity: h1 ? getComputedStyle(h1).opacity : null,
      h1Rect: h1 ? { w: h1.getBoundingClientRect().width, h: h1.getBoundingClientRect().height } : null,
      bodyBg: getComputedStyle(document.body).backgroundColor
    }
  })()`)

  console.log(`CARD_STATE ${JSON.stringify(state)}`)

  const image = await win.webContents.capturePage()
  if (shotPath) await writeFile(shotPath, image.toPNG())
  app.exit(0)
})
