import { z } from 'zod'

/**
 * Single source of truth for every value that crosses the preload bridge.
 * The renderer imports the types (never the secrets); the main process
 * re-parses each request through these schemas before touching the OS.
 */

export const PROVIDER_IDS = [
  'runway',
  'luma',
  'fal',
  'replicate',
  'heygen',
  'openai'
] as const

export const providerIdSchema = z.enum(PROVIDER_IDS)
export type ProviderId = z.infer<typeof providerIdSchema>

export const aspectSchema = z.enum(['16:9', '9:16', '1:1'])
export type Aspect = z.infer<typeof aspectSchema>

export const transitionSchema = z.enum(['cut', 'crossfade'])
export type Transition = z.infer<typeof transitionSchema>

export const providerDescriptorSchema = z.object({
  id: providerIdSchema,
  label: z.string(),
  capability: z.enum(['text-to-video', 'avatar-video', 'image-to-video']),
  docsUrl: z.string(),
  keyPlaceholder: z.string(),
  keyPrefix: z.string().nullable(),
  defaultModel: z.string(),
  models: z.array(z.string()),
  note: z.string()
})
export type ProviderDescriptor = z.infer<typeof providerDescriptorSchema>

export const vaultBackendSchema = z.enum(['keyring', 'safeStorage', 'memory', 'unavailable'])
export type VaultBackendName = z.infer<typeof vaultBackendSchema>

export const keyStatusSchema = z.object({
  providerId: providerIdSchema,
  configured: z.boolean(),
  last4: z.string().nullable(),
  fingerprint: z.string().nullable(),
  updatedAt: z.string().nullable()
})
export type KeyStatus = z.infer<typeof keyStatusSchema>

export const vaultStatusSchema = z.object({
  backend: vaultBackendSchema,
  backendLabel: z.string(),
  encryptionAvailable: z.boolean(),
  providers: z.array(keyStatusSchema)
})
export type VaultStatus = z.infer<typeof vaultStatusSchema>

export const setKeySchema = z.object({
  providerId: providerIdSchema,
  key: z.string().min(8).max(4096)
})
export type SetKeyInput = z.infer<typeof setKeySchema>

export const testKeySchema = z.object({
  providerId: providerIdSchema
})
export type TestKeyInput = z.infer<typeof testKeySchema>

export const providerIdInputSchema = z.object({ providerId: providerIdSchema })

export const connectionResultSchema = z.object({
  ok: z.boolean(),
  latencyMs: z.number(),
  message: z.string()
})
export type ConnectionResult = z.infer<typeof connectionResultSchema>

export const shotSchema = z.object({
  index: z.number().int().min(0).max(11),
  prompt: z.string().min(1).max(2000)
})
export type Shot = z.infer<typeof shotSchema>

export const jobSpecSchema = z.object({
  title: z.string().min(1).max(120),
  providerId: providerIdSchema,
  model: z.string().min(1).max(120),
  aspect: aspectSchema,
  durationSeconds: z.union([z.literal(4), z.literal(5), z.literal(6), z.literal(8), z.literal(10)]),
  shots: z.array(shotSchema).min(1).max(6),
  transition: transitionSchema,
  titles: z.object({
    enabled: z.boolean(),
    headline: z.string().max(80),
    subhead: z.string().max(120),
    accent: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/)
      .default('#7C5CFF')
  }),
  office: z.object({
    storyboard: z.boolean(),
    deliveryDeck: z.boolean()
  }),
  outputName: z
    .string()
    .min(1)
    .max(80)
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9 _-]*$/, 'Use letters, numbers, spaces, dashes')
})
export type JobSpec = z.infer<typeof jobSpecSchema>

export const STAGE_IDS = [
  'validate',
  'storyboard',
  'generate',
  'download',
  'compose',
  'render',
  'export'
] as const
export const stageIdSchema = z.enum(STAGE_IDS)
export type StageId = z.infer<typeof stageIdSchema>

export const stageStatusSchema = z.enum(['pending', 'running', 'succeeded', 'failed', 'skipped'])
export type StageStatus = z.infer<typeof stageStatusSchema>

export const jobStatusSchema = z.enum(['queued', 'running', 'succeeded', 'failed', 'cancelled'])
export type JobStatus = z.infer<typeof jobStatusSchema>

export const stageSchema = z.object({
  id: stageIdSchema,
  label: z.string(),
  status: stageStatusSchema,
  detail: z.string().nullable(),
  startedAt: z.string().nullable(),
  endedAt: z.string().nullable()
})
export type Stage = z.infer<typeof stageSchema>

export const artifactSchema = z.object({
  kind: z.enum(['video', 'poster', 'storyboard', 'deck', 'composition', 'log', 'clip']),
  label: z.string(),
  path: z.string(),
  bytes: z.number(),
  createdAt: z.string()
})
export type Artifact = z.infer<typeof artifactSchema>

export const jobSchema = z.object({
  id: z.string(),
  spec: jobSpecSchema,
  status: jobStatusSchema,
  progress: z.number().min(0).max(100),
  createdAt: z.string(),
  updatedAt: z.string(),
  finishedAt: z.string().nullable(),
  stages: z.array(stageSchema),
  artifacts: z.array(artifactSchema),
  error: z.string().nullable(),
  costEstimateUsd: z.number().nullable(),
  compositionHtml: z.string().nullable()
})
export type Job = z.infer<typeof jobSchema>

export const jobIdSchema = z.object({ jobId: z.string().min(1).max(80) })

export const systemProbeSchema = z.object({
  platform: z.string(),
  arch: z.string(),
  appVersion: z.string(),
  electron: z.string(),
  node: z.string(),
  chrome: z.string(),
  ffmpeg: z.object({
    available: z.boolean(),
    path: z.string().nullable(),
    version: z.string().nullable()
  }),
  ffprobe: z.object({
    available: z.boolean(),
    path: z.string().nullable(),
    version: z.string().nullable()
  }),
  officecli: z.object({
    available: z.boolean(),
    path: z.string().nullable(),
    version: z.string().nullable(),
    authoring: z.enum(['structured', 'llm', 'unknown'])
  }),
  hyperframes: z.object({
    playerVersion: z.string().nullable(),
    studioVersion: z.string().nullable()
  }),
  dataDir: z.string(),
  networkFree: z.literal(true)
})
export type SystemProbe = z.infer<typeof systemProbeSchema>

export const revealSchema = z.object({
  path: z.string().min(1).max(1024)
})

export { IPC, type IpcChannel, type FrameForgeBridge } from './bridge'
