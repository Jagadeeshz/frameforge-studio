import type { JobSpec } from '../src/shared/contract'

export const DEFAULT_TEST_SPEC: JobSpec = {
  title: 'Test Reel',
  providerId: 'runway',
  model: 'gen4_turbo',
  aspect: '16:9',
  durationSeconds: 4,
  shots: [
    { index: 0, prompt: 'A slow orbit around a matte black product pedestal' },
    { index: 1, prompt: 'Cut to a close up of hands assembling a device' }
  ],
  transition: 'crossfade',
  titles: {
    enabled: true,
    headline: 'Built for the next launch',
    subhead: 'Quantocos · Q4 2026',
    accent: '#7C5CFF'
  },
  office: { storyboard: false, deliveryDeck: false },
  enhancePrompts: false,
  outputName: 'test-reel'
}
