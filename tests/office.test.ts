import { describe, expect, it } from 'vitest'
import { buildDeliveryDeckPrompt, buildStoryboardPrompt, locateOfficeCli } from '../src/main/office'
import { DEFAULT_TEST_SPEC } from './helpers'

describe('office orchestration', () => {
  it('turns the shot list into a storyboard brief', () => {
    const prompt = buildStoryboardPrompt(DEFAULT_TEST_SPEC)
    expect(prompt).toContain(DEFAULT_TEST_SPEC.title)
    for (const shot of DEFAULT_TEST_SPEC.shots) expect(prompt).toContain(shot.prompt)
    expect(prompt).toContain('16:9')
    expect(prompt).toContain('crossfades')
    expect(prompt).toMatch(/shot list/i)
  })

  it('asks for a client-ready deck without inventing metrics', () => {
    const prompt = buildDeliveryDeckPrompt(DEFAULT_TEST_SPEC)
    expect(prompt).toContain(DEFAULT_TEST_SPEC.providerId)
    expect(prompt).toMatch(/do not invent/i)
    expect(prompt).toContain('4-slide')
  })

  it('locates the OfficeCLI binary bundled with the project', async () => {
    const info = await locateOfficeCli(process.cwd())
    expect(info.available).toBe(true)
    expect(info.version).toMatch(/^\d+\.\d+/)
    expect(info.path).toBeTruthy()
  }, 60_000)
})
