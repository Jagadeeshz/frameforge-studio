import type {
  ConnectionResult,
  Job,
  JobSpec,
  ProviderDescriptor,
  ProviderId,
  SetKeyInput,
  SystemProbe,
  TestKeyInput,
  VaultStatus
} from './contract'

/**
 * The IPC surface, deliberately free of runtime dependencies (no zod, no node).
 *
 * The renderer builds are bundled, but the preload runs in Electron's sandbox
 * where `require` is limited to a small allowlist — importing the zod-based
 * contract module there throws before contextBridge can expose anything.
 * Everything here is types plus one frozen constant.
 */

export const IPC = {
  systemProbe: 'system:probe',
  vaultStatus: 'vault:status',
  vaultSet: 'vault:set',
  vaultDelete: 'vault:delete',
  vaultTest: 'vault:test',
  providersList: 'providers:list',
  jobCreate: 'job:create',
  jobList: 'job:list',
  jobGet: 'job:get',
  jobCancel: 'job:cancel',
  jobDelete: 'job:delete',
  jobEvent: 'job:event',
  compositionPreview: 'composition:preview',
  reveal: 'shell:reveal'
} as const

export type IpcChannel = (typeof IPC)[keyof typeof IPC]

/** Shape of the object exposed to the renderer on `window.frameforge`. */
export interface FrameForgeBridge {
  systemProbe(): Promise<SystemProbe>
  vault: {
    status(): Promise<VaultStatus>
    set(input: SetKeyInput): Promise<VaultStatus>
    remove(providerId: ProviderId): Promise<VaultStatus>
    test(input: TestKeyInput): Promise<ConnectionResult>
  }
  providers: {
    list(): Promise<ProviderDescriptor[]>
  }
  jobs: {
    create(spec: JobSpec): Promise<Job>
    list(): Promise<Job[]>
    get(jobId: string): Promise<Job | null>
    cancel(jobId: string): Promise<Job>
    remove(jobId: string): Promise<{ ok: boolean }>
    onEvent(listener: (job: Job) => void): () => void
  }
  composition: {
    preview(spec: JobSpec): Promise<{ url: string }>
  }
  reveal(path: string): Promise<{ ok: boolean }>
}
