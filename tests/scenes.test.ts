import { describe, expect, it } from 'vitest'
import {
  buildSceneRequest,
  extractJson,
  parseStoryboard,
  sanitizeSceneHtml,
  sceneDocument,
  storyboardSchema
} from '../src/main/scenes'
import { DEFAULT_TEST_SPEC } from './helpers'

const spec = { ...DEFAULT_TEST_SPEC, providerId: 'motion' as const, durationSeconds: 12, scenes: 3, shots: [] }

const sceneHtml = (text: string): string =>
  `<!doctype html><html><head><style>body{margin:0;background:#08080c;color:#fff}` +
  `@keyframes rise{from{opacity:0}to{opacity:1}} h1{animation:rise 1s both}</style></head>` +
  `<body><h1>${text}</h1></body></html>`

describe('scene storyboard parsing', () => {
  it('extracts JSON from a fenced reply', () => {
    const parsed = extractJson('```json\n{"scenes":[]}\n```')
    expect(parsed).toEqual({ scenes: [] })
  })

  it('extracts JSON surrounded by prose', () => {
    const parsed = extractJson('Here you go:\n{"scenes":[]}\nEnjoy.')
    expect(parsed).toEqual({ scenes: [] })
  })

  it('rejects a reply with no JSON at all', () => {
    expect(() => extractJson('I cannot help with that.')).toThrow(/valid JSON/)
  })

  it('parses a valid storyboard', () => {
    const raw = JSON.stringify({
      scenes: [
        { title: 'Open', durationSeconds: 3, html: sceneHtml('One') },
        { title: 'Build', durationSeconds: 4, html: sceneHtml('Two') },
        { title: 'Close', durationSeconds: 3, html: sceneHtml('Three') }
      ]
    })
    const scenes = parseStoryboard(raw, spec)
    expect(scenes).toHaveLength(3)
    expect(scenes.map((scene) => scene.title)).toEqual(['Open', 'Build', 'Close'])
  })

  it('rescales scene durations so the film matches the requested length', () => {
    const raw = JSON.stringify({
      scenes: [
        { title: 'A', durationSeconds: 10, html: sceneHtml('A') },
        { title: 'B', durationSeconds: 10, html: sceneHtml('B') }
      ]
    })
    const scenes = parseStoryboard(raw, { ...spec, durationSeconds: 12 })
    const total = scenes.reduce((sum, scene) => sum + scene.durationSeconds, 0)
    expect(total).toBeCloseTo(12, 0)
  })

  it('truncates a reply that returns more scenes than requested', () => {
    const raw = JSON.stringify({
      scenes: Array.from({ length: 6 }, (_, index) => ({ title: `S${index}`, durationSeconds: 2, html: sceneHtml(`S${index}`) }))
    })
    expect(parseStoryboard(raw, { ...spec, scenes: 3 })).toHaveLength(3)
  })

  it('refuses a storyboard with no scenes', () => {
    expect(() => parseStoryboard('{"scenes":[]}', spec)).toThrow(/not usable/)
    expect(storyboardSchema.safeParse({ scenes: [] }).success).toBe(false)
  })

  it('refuses scenes without html', () => {
    expect(() => parseStoryboard('{"scenes":[{"title":"x","durationSeconds":3}]}', spec)).toThrow(/not usable/)
  })
})

describe('sanitising model html', () => {
  it('strips scripts entirely', () => {
    const dirty = `${sceneHtml('Hi')}<script>window.location='https://evil.test'</script>`
    const clean = sanitizeSceneHtml(dirty)
    expect(clean).not.toContain('<script')
    expect(clean).not.toContain('window.location')
  })

  it('strips iframes, objects, embeds, links and forms', () => {
    const dirty =
      `${sceneHtml('Hi')}<iframe src="https://evil.test"></iframe><object data="x"></object>` +
      `<embed src="x" /><link rel="stylesheet" href="https://evil.test/a.css"><form action="/x"><input name="a"></form>`
    const clean = sanitizeSceneHtml(dirty)
    for (const tag of ['<iframe', '<object', '<embed', '<link', '<form', '<input']) {
      expect(clean.toLowerCase()).not.toContain(tag)
    }
  })

  it('strips inline event handlers in every quoting style', () => {
    const dirty = `<div onclick="alert(1)" ONMOUSEOVER='alert(2)' onload=alert(3)>x</div>`
    const clean = sanitizeSceneHtml(dirty)
    expect(clean).not.toMatch(/onclick|onmouseover|onload/i)
  })

  it('blocks remote fetches in attributes and css', () => {
    const dirty = `${sceneHtml('Hi')}<img src="https://evil.test/a.png"><style>body{background:url('https://evil.test/b.png')}@import 'x.css';</style>`
    const clean = sanitizeSceneHtml(dirty)
    expect(clean).not.toContain('https://evil.test')
    expect(clean).not.toContain('@import')
  })

  it('keeps the animation the scene actually needs', () => {
    const clean = sanitizeSceneHtml(sceneHtml('Keep me'))
    expect(clean).toContain('@keyframes rise')
    expect(clean).toContain('animation:rise 1s both')
    expect(clean).toContain('Keep me')
  })
})

describe('renderer document', () => {
  it('injects the pause/seek driver and nothing else executable', () => {
    const doc = sceneDocument({ title: 'T', durationSeconds: 3, html: sceneHtml('Ship it') })
    expect(doc).toContain('window.__ff')
    expect(doc).toContain('a.pause()')
    // The driver is ours; the model's scripts were removed before injection.
    expect(doc.match(/<script/g)?.length).toBe(1)
    expect(doc).toContain('Ship it')
  })

  it('appends the driver when the reply has no closing body tag', () => {
    const doc = sceneDocument({ title: 'T', durationSeconds: 3, html: '<div>fragment</div>' })
    expect(doc).toContain('fragment')
    expect(doc).toContain('window.__ff')
  })
})

describe('prompt', () => {
  it('carries the brief, the scene count and the hard constraints', () => {
    const { system, prompt } = buildSceneRequest(spec, { width: 1920, height: 1080, providerLabel: 'DeepSeek' })
    expect(prompt).toContain(spec.brief)
    expect(prompt).toContain('3 scenes')
    expect(prompt).toContain('1920x1080')
    expect(system).toMatch(/No <script> tags/)
    expect(system).toMatch(/No external resources/)
    expect(system).toMatch(/JSON only/)
  })
})
