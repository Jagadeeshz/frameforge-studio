import { z } from 'zod'
import type { JobSpec } from '../shared/contract'
import { buildCompositionHtml } from '../shared/composition'

/**
 * The free "motion scene" pipeline.
 *
 * The user's LLM writes scenes as self-contained HTML/CSS/SVG; this module
 * turns that reply into documents Chromium can render deterministically.
 *
 * Trust boundary: the HTML is model output, so it is treated as untrusted.
 * Scripts, frames and outbound URLs are stripped before it is ever loaded, and
 * the timeline driver is ours, injected after sanitising. The ffcomp:// policy
 * additionally forbids any network fetch.
 */

export const sceneSchema = z.object({
  title: z.string().trim().min(1).max(80),
  durationSeconds: z.number().min(1).max(15),
  html: z.string().min(40).max(140_000)
})
export type Scene = z.infer<typeof sceneSchema>

export const storyboardSchema = z.object({
  scenes: z.array(sceneSchema).min(1).max(10)
})

const MAX_HTML_BYTES = 140_000

/* ------------------------------------------------------------------ */
/* Prompting                                                          */
/* ------------------------------------------------------------------ */

export const SCENE_SYSTEM = [
  'You are a motion designer who writes production-ready HTML.',
  'You reply with JSON only — no prose, no markdown fences.',
  'Every scene is a complete, self-contained HTML document that renders as an animated motion graphic.',
  'Rules for each scene document:',
  '- No <script> tags at all. The renderer supplies the timeline driver and pauses every animation.',
  '- No external resources: no http(s) URLs, no fonts, no images, no @import, no <link>.',
  '  Use system font stacks (e.g. "Segoe UI", Helvetica, Arial), CSS gradients, and inline SVG instead.',
  '- Animate with CSS @keyframes only. Assume the document is paused and seeked frame by frame,',
  '  so avoid transitions that depend on user interaction or time-based JS.',
  '- Fill the viewport: html, body { width:100%; height:100%; margin:0; overflow:hidden }.',
  '- Design for the exact pixel size given. Type must be large enough to read at that size.',
  '- Keep each document under 40 KB.'
].join('\n')

export function buildSceneRequest(
  spec: JobSpec,
  options: { width: number; height: number; providerLabel: string }
): { system: string; prompt: string } {
  const target = spec.scenes ?? 4
  return {
    system: SCENE_SYSTEM,
    prompt: [
      `Create a ${spec.durationSeconds}-second ${spec.aspect} motion graphic (${options.width}x${options.height}px) from this brief.`,
      '',
      'Brief:',
      spec.brief || spec.title,
      '',
      `Split it into exactly ${target} scenes. Each scene must have:`,
      '  "title": a short label,',
      '  "durationSeconds": a number (1 to 15), all scenes summing to about ' + String(spec.durationSeconds) + ',',
      '  "html": the complete animated HTML document as a single JSON string.',
      '',
      'Vary the visual language between scenes: kinetic typography, gradient fields, geometric shapes,',
      'SVG line work, data-style counters, layered depth. Keep a consistent palette across scenes so it',
      'reads as one film. Use the accent colour ' + (spec.titles.accent || '#7C5CFF') + ' where colour is used.',
      '',
      'Reply with this exact shape:',
      '{"scenes":[{"title":"...","durationSeconds":3,"html":"<!doctype html>..."}]}'
    ].join('\n')
  }
}

/* ------------------------------------------------------------------ */
/* Parsing                                                            */
/* ------------------------------------------------------------------ */

/** Pulls a JSON object out of a reply that may include fences or prose. */
export function extractJson(raw: string): unknown {
  const trimmed = raw.trim()
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed)
  const candidates = [fenced?.[1], trimmed].filter((value): value is string => Boolean(value))

  for (const candidate of candidates) {
    const text = candidate.trim()
    const direct = tryParse(text)
    if (direct !== undefined) return direct
    // Fall back to the outermost braces.
    const start = text.indexOf('{')
    const end = text.lastIndexOf('}')
    if (start >= 0 && end > start) {
      const sliced = tryParse(text.slice(start, end + 1))
      if (sliced !== undefined) return sliced
    }
  }
  throw new Error('The model did not return valid JSON')
}

function tryParse(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/**
 * Validates the storyboard, then rescales scene durations so the film matches
 * the requested length. Oversized replies are truncated rather than rejected.
 */
export function parseStoryboard(raw: string, spec: JobSpec): Scene[] {
  const parsed = storyboardSchema.safeParse(extractJson(raw))
  if (!parsed.success) {
    const detail = parsed.error.issues[0]
    throw new Error(`The model's storyboard was not usable: ${detail?.path.join('.') ?? 'unknown'} ${detail?.message ?? ''}`.trim())
  }

  const limit = spec.scenes ?? 4
  const scenes = parsed.data.scenes.slice(0, Math.max(1, limit)).map((scene) => ({
    ...scene,
    html: scene.html.length > MAX_HTML_BYTES ? scene.html.slice(0, MAX_HTML_BYTES) : scene.html
  }))

  const total = scenes.reduce((sum, scene) => sum + scene.durationSeconds, 0)
  const target = spec.durationSeconds
  if (total > 0 && Math.abs(total - target) > 0.5) {
    const factor = target / total
    for (const scene of scenes) {
      scene.durationSeconds = Math.min(15, Math.max(1, Math.round(scene.durationSeconds * factor * 10) / 10))
    }
  }
  return scenes
}

/* ------------------------------------------------------------------ */
/* Sanitising model HTML                                              */
/* ------------------------------------------------------------------ */

const BLOCKED_TAGS = ['script', 'iframe', 'object', 'embed', 'link', 'base', 'form', 'input', 'button', 'meta']

/**
 * Removes anything that executes, navigates or fetches. The CSP would also stop
 * network access, but stripping first means a hostile reply never reaches the
 * renderer at all.
 */
export function sanitizeSceneHtml(raw: string): string {
  let html = raw

  // Paired and self-closing dangerous elements.
  for (const tag of BLOCKED_TAGS) {
    html = html.replace(new RegExp(`<${tag}\\b[\\s\\S]*?</${tag}\\s*>`, 'gi'), '')
    html = html.replace(new RegExp(`<${tag}\\b[^>]*/?>`, 'gi'), '')
  }

  // Inline event handlers.
  html = html.replace(/\son[a-z]+\s*=\s*"[^"]*"/gi, '')
  html = html.replace(/\son[a-z]+\s*=\s*'[^']*'/gi, '')
  html = html.replace(/\son[a-z]+\s*=\s*[^\s>]+/gi, '')

  // Anything that could pull a remote resource: attribute values, CSS url()
  // and @import. Data URIs stay (they cannot fetch).
  html = html.replace(/\s(?:src|href|srcset|poster|action|data)\s*=\s*"[^"]*(?:https?:)?\/\/[^"]*"/gi, '')
  html = html.replace(/\s(?:src|href|srcset|poster|action|data)\s*=\s*'[^']*(?:https?:)?\/\/[^']*'/gi, '')
  html = html.replace(/\s(?:src|href|srcset|poster|action|data)\s*=\s*(?:https?:)?\/\/[^\s>]+/gi, '')
  html = html.replace(/url\(\s*['"]?\s*(?:https?:)?\/\/[^)]*\)/gi, 'none')
  html = html.replace(/@import[^;]*;/gi, '')

  return html.slice(0, MAX_HTML_BYTES)
}

const DRIVER = `
<script>
  (function () {
    var animations = [];
    function collect() {
      animations = document.getAnimations ? document.getAnimations() : [];
      animations.forEach(function (a) { try { a.pause(); } catch (e) {} });
    }
    window.__ff = {
      ready: false,
      seek: function (t) {
        var ms = Math.max(0, t) * 1000;
        animations.forEach(function (a) { try { a.currentTime = ms; } catch (e) {} });
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
    try { window.__ff.seek(0); } catch (e) {}
  })();
</script>`

/** Sanitised scene plus our own pause/seek driver. */
export function sceneDocument(scene: Scene): string {
  const safe = sanitizeSceneHtml(scene.html)
  if (/<\/body\s*>/i.test(safe)) return safe.replace(/<\/body\s*>/i, `${DRIVER}\n</body>`)
  return `${safe}\n${DRIVER}`
}

/** Used when a scene's HTML was unusable, so the film still renders. */
export function fallbackSceneHtml(scene: Scene, spec: JobSpec, width: number, height: number): string {
  return buildCompositionHtml(
    {
      ...spec,
      title: scene.title,
      titles: { ...spec.titles, headline: scene.title, subhead: spec.title }
    },
    { kind: 'intro', width, height, durationSeconds: scene.durationSeconds, fps: 30, mode: 'capture' }
  )
}
