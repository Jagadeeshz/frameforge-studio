import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { BrowserWindow } from 'electron'

/**
 * Frame-accurate capture of a title card. Chromium renders the same HTML the
 * preview shows; we pause every animation, seek to t, capture, repeat. FFmpeg
 * then encodes the PNG sequence. Nothing is streamed to a server.
 */
export async function renderCardsWithChromium(options: {
  url: string
  durationSeconds: number
  fps: number
  width: number
  height: number
  framesDir: string
  signal: AbortSignal
}): Promise<{ frames: number }> {
  const { url, durationSeconds, fps, width, height, framesDir, signal } = options
  await fs.mkdir(framesDir, { recursive: true })

  const win = new BrowserWindow({
    show: false,
    width,
    height,
    frame: false,
    backgroundColor: '#08080c',
    webPreferences: {
      offscreen: true,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  })
  win.webContents.setBackgroundThrottling(false)

  try {
    await win.loadURL(url)
    const ready = await waitFor(async () => {
      const value = await win.webContents.executeJavaScript('Boolean(window.__ff && window.__ff.ready)')
      return value === true
    }, 8_000)
    if (!ready) throw new Error('Composition never signalled ready')

    const total = Math.max(1, Math.round(durationSeconds * fps))
    for (let i = 0; i < total; i += 1) {
      if (signal.aborted) throw new Error('Cancelled')
      const t = i / fps
      await win.webContents.executeJavaScript(
        `window.__ff.seek(${t}); new Promise(function(r){requestAnimationFrame(function(){requestAnimationFrame(function(){r(true)})})})`
      )
      const image = await win.webContents.capturePage()
      if (image.isEmpty()) throw new Error(`Frame ${i} captured empty`)
      const png = image.toPNG()
      if (png.byteLength < 512) throw new Error(`Frame ${i} captured suspiciously small (${png.byteLength}b)`)
      await fs.writeFile(join(framesDir, `frame_${String(i).padStart(5, '0')}.png`), png)
    }
    return { frames: total }
  } finally {
    if (!win.isDestroyed()) win.destroy()
  }
}

async function waitFor(check: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      if (await check()) return true
    } catch {
      // window may not be ready yet
    }
    await new Promise((r) => setTimeout(r, 60))
  }
  return false
}
