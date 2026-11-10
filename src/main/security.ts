import { app, type Session, type WebContents } from 'electron'

const DEV_CSP = [
  "default-src 'none'",
  "script-src 'self' 'unsafe-eval' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "font-src 'self' data:",
  "connect-src 'self' ws://localhost:* http://localhost:*",
  'frame-src ffcomp:'
].join('; ')

const PROD_CSP = [
  "default-src 'none'",
  // The packaged renderer is loaded from file://, where 'self' does not cover
  // the document's own opaque origin — file: has to be named explicitly.
  "script-src 'self' file:",
  "style-src 'self' file: 'unsafe-inline'",
  "img-src 'self' file: data: blob:",
  "media-src 'self' file: blob:",
  "font-src 'self' file: data:",
  "connect-src 'self'",
  'frame-src ffcomp:'
].join('; ')

/** Composition documents get their own CSP that permits their inline driver. */
const CARD_CSP = ["default-src 'none'", "style-src 'unsafe-inline'", "script-src 'unsafe-inline'", "img-src data:"].join('; ')

export function contentSecurityPolicy(): string {
  return app.isPackaged ? PROD_CSP : DEV_CSP
}

export function cardCsp(): string {
  return CARD_CSP
}

/** Applies the app CSP to every response in the default session. */
export function applyCsp(target: Session, policy: string): void {
  target.webRequest.onHeadersReceived((details, callback) => {
    // Composition documents carry their own policy from protocol.handle; if the
    // app policy replaced it, their driver script would be blocked and every
    // captured frame would come out blank.
    if (details.url.startsWith('ffcomp://')) {
      callback({ responseHeaders: details.responseHeaders })
      return
    }
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [policy],
        'X-Content-Type-Options': ['nosniff']
      }
    })
  })
}

/**
 * Denies everything the studio does not need: camera, mic, notifications,
 * midi, and any attempt to open a second window or navigate away.
 */
export function hardenWebContents(contents: WebContents, allowedOrigins: string[]): void {
  contents.setWindowOpenHandler(() => ({ action: 'deny' }))

  const isAllowed = (target: string): boolean =>
    target.startsWith('devtools://') || allowedOrigins.some((origin) => target.startsWith(origin))

  contents.on('will-navigate', (event, target) => {
    if (!isAllowed(target)) event.preventDefault()
  })

  contents.on('will-attach-webview', (event) => {
    event.preventDefault()
  })

  contents.session.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(permission === 'clipboard-sanitized-write')
  })
  contents.session.setPermissionCheckHandler(() => false)
}
