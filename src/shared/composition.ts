import type { Aspect, JobSpec } from './contract'

/**
 * Title cards are plain HTML/CSS with a single deterministic time source, so
 * the same markup drives the in-app HyperFrames preview and the frame-by-frame
 * capture that FFmpeg encodes. No network, no fonts to fetch, no clock drift.
 */

export interface CompositionOptions {
  kind: 'intro' | 'outro'
  width: number
  height: number
  durationSeconds: number
  fps: number
  /**
   * `capture` (default) includes the pause/seek driver used by the frame
   * grabber. `preview` ships the same card without any script, because a framed
   * document inherits the app's strict CSP — an inline script there is blocked
   * in production and would leave the frame blank. The settled look is carried
   * by the `body.preview` rules instead.
   */
  mode?: 'preview' | 'capture'
}

const ASPECT_LABEL: Record<Aspect, string> = {
  '16:9': '16:9 · LANDSCAPE',
  '9:16': '9:16 · PORTRAIT',
  '1:1': '1:1 · SQUARE'
}

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function scale(width: number): number {
  // Type sizes are authored against a 1080px short edge.
  return Math.max(0.55, Math.min(width, 1920) / 1080)
}

export function buildCompositionHtml(spec: JobSpec, options: CompositionOptions): string {
  const s = scale(options.width)
  const headline = escapeHtml(options.kind === 'intro' ? spec.titles.headline || spec.title : 'Delivered')
  const subhead = escapeHtml(
    options.kind === 'intro' ? spec.titles.subhead || spec.shots[0]?.prompt.slice(0, 90) || '' : `${spec.shots.length} shots · ${spec.durationSeconds}s each`
  )
  const accent = /^#[0-9a-fA-F]{6}$/.test(spec.titles.accent) ? spec.titles.accent : '#7C5CFF'
  const shotCount = String(spec.shots.length).padStart(2, '0')
  const metaLeft = options.kind === 'intro' ? `${shotCount} SHOTS` : 'LOCAL RENDER'
  const metaRight = ASPECT_LABEL[spec.aspect]
  const brand = 'FRAMEFORGE STUDIO'
  const mode = options.mode ?? 'capture'
  const previewClass = mode === 'preview' ? 'preview' : ''

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=${options.width}, initial-scale=1" />
<title>${headline}</title>
<style>
  :root {
    --accent: ${accent};
    --bg: #08080c;
    --ink: #f5f5f7;
    --muted: rgba(245,245,247,0.56);
    --unit: ${Math.round(16 * s)}px;
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: 100%; height: 100%; overflow: hidden; background: var(--bg); }
  body {
    font-family: "Segoe UI Variable Display", "Segoe UI", -apple-system, "Helvetica Neue", Arial, sans-serif;
    color: var(--ink);
    -webkit-font-smoothing: antialiased;
  }
  .frame { position: relative; width: 100%; height: 100%; overflow: hidden; background: var(--bg); }

  .glow {
    position: absolute; inset: -25%;
    background:
      radial-gradient(42% 42% at 22% 18%, color-mix(in srgb, var(--accent) 62%, transparent) 0%, transparent 68%),
      radial-gradient(46% 46% at 82% 84%, color-mix(in srgb, var(--accent) 34%, #22d3ee) 0%, transparent 70%),
      radial-gradient(70% 70% at 50% 50%, #101018 0%, #06060a 100%);
    filter: blur(${Math.round(10 * s)}px);
    opacity: 0;
    transform: scale(1.06);
    animation: drift 6s cubic-bezier(0.22, 1, 0.36, 1) both;
  }
  .grid {
    position: absolute; inset: 0;
    background-image:
      linear-gradient(to right, rgba(255,255,255,0.045) 1px, transparent 1px),
      linear-gradient(to bottom, rgba(255,255,255,0.045) 1px, transparent 1px);
    background-size: ${Math.round(96 * s)}px ${Math.round(96 * s)}px;
    mask-image: radial-gradient(70% 70% at 50% 45%, #000 25%, transparent 88%);
    opacity: 0;
    animation: fadeIn 1.2s ease-out 0.1s both;
  }
  .vignette {
    position: absolute; inset: 0;
    background: radial-gradient(120% 100% at 50% 50%, transparent 35%, rgba(0,0,0,0.55) 100%);
  }

  .content {
    position: absolute; inset: 0;
    display: flex; flex-direction: column; justify-content: flex-end;
    padding: ${Math.round(104 * s)}px ${Math.round(112 * s)}px;
  }

  .eyebrow {
    display: flex; align-items: center; gap: ${Math.round(14 * s)}px;
    font-size: ${Math.round(15 * s)}px; letter-spacing: ${(2.6 * s).toFixed(2)}px;
    text-transform: uppercase; color: var(--muted);
    opacity: 0; animation: rise 0.9s cubic-bezier(0.22,1,0.36,1) 0.15s both;
  }
  .eyebrow .dot { width: ${Math.round(7 * s)}px; height: ${Math.round(7 * s)}px; border-radius: 99px; background: var(--accent); box-shadow: 0 0 ${Math.round(18 * s)}px var(--accent); }
  .eyebrow .rule { width: ${Math.round(60 * s)}px; height: 1px; background: rgba(255,255,255,0.18); }

  h1 {
    margin-top: ${Math.round(30 * s)}px;
    font-size: ${Math.round(112 * s)}px;
    line-height: 0.94;
    letter-spacing: ${(-3.2 * s).toFixed(2)}px;
    font-weight: 680;
    max-width: ${Math.round(1020 * s)}px;
    text-wrap: balance;
    opacity: 0;
    animation: rise 1.15s cubic-bezier(0.22,1,0.36,1) 0.28s both;
  }
  .subhead {
    margin-top: ${Math.round(26 * s)}px;
    max-width: ${Math.round(820 * s)}px;
    font-size: ${Math.round(26 * s)}px;
    line-height: 1.45;
    color: var(--muted);
    font-weight: 400;
    opacity: 0;
    animation: rise 1.05s cubic-bezier(0.22,1,0.36,1) 0.42s both;
  }

  .bar {
    margin-top: ${Math.round(46 * s)}px;
    height: ${Math.round(5 * s)}px;
    width: 0;
    border-radius: 99px;
    background: linear-gradient(90deg, var(--accent), color-mix(in srgb, var(--accent) 30%, #ffffff));
    box-shadow: 0 0 ${Math.round(26 * s)}px color-mix(in srgb, var(--accent) 60%, transparent);
    animation: grow 1.4s cubic-bezier(0.22,1,0.36,1) 0.5s both;
  }

  .footer {
    position: absolute; left: ${Math.round(112 * s)}px; right: ${Math.round(112 * s)}px;
    bottom: ${Math.round(58 * s)}px;
    display: flex; justify-content: space-between; align-items: center;
    font-size: ${Math.round(13 * s)}px; letter-spacing: ${(2.2 * s).toFixed(2)}px; text-transform: uppercase;
    color: rgba(255,255,255,0.42);
    opacity: 0; animation: fadeIn 1s ease-out 0.6s both;
  }
  .footer .brand { color: rgba(255,255,255,0.78); letter-spacing: ${(3 * s).toFixed(2)}px; }
  .footer .left { display: flex; align-items: center; gap: ${Math.round(18 * s)}px; }

  .progress {
    position: absolute; left: 0; bottom: 0; height: ${Math.round(3 * s)}px; width: 0%;
    background: linear-gradient(90deg, var(--accent), transparent);
  }

  @keyframes rise { from { opacity: 0; transform: translateY(${Math.round(28 * s)}px); filter: blur(${Math.round(6 * s)}px); } to { opacity: 1; transform: none; filter: none; } }
  @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
  @keyframes grow { from { width: 0; } to { width: ${Math.round(340 * s)}px; } }
  @keyframes drift { from { opacity: 0; transform: scale(1.06); } to { opacity: 0.92; transform: scale(1); } }

  /* Everything is paused and driven by seek() for frame-accurate capture. */
  * { animation-play-state: paused !important; }

  /* Static poster state for the embedded preview: the same card, settled at
     roughly the point the capture driver parks it, with no JavaScript needed. */
  body.preview * { animation: none !important; }
  body.preview .glow { opacity: 0.92; transform: none; }
  body.preview .grid { opacity: 1; }
  body.preview .eyebrow,
  body.preview .subhead,
  body.preview h1,
  body.preview .footer { opacity: 1; }
  body.preview .bar { width: ${Math.round(340 * s)}px; }
  body.preview .progress { width: 45%; }
</style>
</head>
<body class="${previewClass}">
  <div class="frame">
    <div class="glow"></div>
    <div class="grid"></div>
    <div class="vignette"></div>
    <div class="content">
      <div class="eyebrow"><span class="dot"></span><span>${options.kind === 'intro' ? 'OPENING CARD' : 'CLOSING CARD'}</span><span class="rule"></span><span>${metaLeft}</span></div>
      <h1>${headline}</h1>
      <div class="subhead">${subhead}</div>
      <div class="bar"></div>
    </div>
    <div class="footer">
      <span class="brand">${brand}</span>
      <span class="left"><span>${metaRight}</span><span>${spec.durationSeconds}s × ${shotCount}</span></span>
    </div>
    <div class="progress" id="progress"></div>
  </div>
<script>
  (function () {
    var duration = ${options.durationSeconds};
    var animations = [];
    function collect() {
      animations = document.getAnimations ? document.getAnimations() : [];
      animations.forEach(function (a) { try { a.pause(); } catch (e) {} });
      var progress = document.getElementById('progress');
      if (progress) progress.style.width = '0%';
    }
    window.__ff = {
      ready: false,
      duration: duration,
      seek: function (t) {
        var ms = Math.max(0, t) * 1000;
        animations.forEach(function (a) { try { a.currentTime = ms; } catch (e) {} });
        var progress = document.getElementById('progress');
        if (progress) progress.style.width = Math.max(0, Math.min(1, t / duration)) * 100 + '%';
        return true;
      }
    };
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(function () { collect(); window.__ff.ready = true; });
    } else {
      collect(); window.__ff.ready = true;
    }
    collect();
    window.__ff.ready = true;
    // Park on a representative frame so an embedded preview shows the designed
    // card instead of the opacity-0 start state. Capture seeks explicitly.
    try { window.__ff.seek(duration * 0.45); } catch (e) {}
  })();
</script>
</body>
</html>`

  if (mode !== 'preview') return html
  // No driver in the preview: CSS carries the settled state instead.
  return html.replace(/\n?<script>[\s\S]*?<\/script>/, '')
}

export function compositionDurationSeconds(spec: JobSpec): { intro: number; outro: number } {
  const base = spec.aspect === '9:16' ? 2.6 : 3.2
  return { intro: base, outro: Math.max(2.2, base - 0.4) }
}
