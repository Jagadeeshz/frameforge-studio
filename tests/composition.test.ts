import { describe, expect, it } from 'vitest'
import { buildCompositionHtml } from '../src/shared/composition'
import { DEFAULT_TEST_SPEC } from './helpers'

describe('composition html', () => {
  const spec = DEFAULT_TEST_SPEC

  it('renders the headline, subhead and accent into the card', () => {
    const html = buildCompositionHtml(spec, { kind: 'intro', width: 1920, height: 1080, durationSeconds: 3, fps: 30 })
    expect(html).toContain('Built for the next launch')
    expect(html).toContain('Quantocos')
    expect(html).toContain('#7C5CFF')
    expect(html).toContain('window.__ff')
    expect(html).toContain('animation-play-state: paused')
  })

  it('escapes user-supplied copy instead of injecting it', () => {
    const hostile = {
      ...spec,
      titles: { ...spec.titles, headline: '<script>alert(1)</script>', subhead: '"><img src=x onerror=alert(1)>' }
    }
    const html = buildCompositionHtml(hostile, { kind: 'intro', width: 1080, height: 1920, durationSeconds: 3, fps: 30 })
    expect(html).not.toContain('<script>alert(1)</script>')
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(html).not.toContain('onerror=alert(1)>')
  })

  it('falls back to a safe accent when the colour is malformed', () => {
    const bad = { ...spec, titles: { ...spec.titles, accent: 'red; background:url(javascript:1)' } }
    const html = buildCompositionHtml(bad, { kind: 'intro', width: 1920, height: 1080, durationSeconds: 3, fps: 30 })
    expect(html).toContain('--accent: #7C5CFF')
    expect(html).not.toContain('javascript:1')
  })

  it('scales type down for portrait output', () => {
    const landscape = buildCompositionHtml(spec, { kind: 'intro', width: 1920, height: 1080, durationSeconds: 3, fps: 30 })
    const portrait = buildCompositionHtml({ ...spec, aspect: '9:16' }, { kind: 'intro', width: 1080, height: 1920, durationSeconds: 3, fps: 30 })
    const size = (html: string): number => Number(/font-size: (\d+)px;\n    line-height: 0\.94/.exec(html)?.[1] ?? 0)
    expect(size(portrait)).toBeLessThan(size(landscape))
  })

  it('labels the closing card differently from the opening card', () => {
    const intro = buildCompositionHtml(spec, { kind: 'intro', width: 1920, height: 1080, durationSeconds: 3, fps: 30 })
    const outro = buildCompositionHtml(spec, { kind: 'outro', width: 1920, height: 1080, durationSeconds: 3, fps: 30 })
    expect(intro).toContain('OPENING CARD')
    expect(outro).toContain('CLOSING CARD')
    expect(outro).toContain('LOCAL RENDER')
  })
})
