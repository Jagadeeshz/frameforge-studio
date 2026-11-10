import { contextBridge, ipcRenderer } from 'electron'
import { IPC, type FrameForgeBridge } from '../shared/bridge'
import type { ConnectionResult, Job, JobSpec, LlmSettings, ProviderDescriptor, ProviderId, SetKeyInput, SystemProbe, TestKeyInput, VaultStatus } from '../shared/contract'

/**
 * The only surface the renderer gets. No node, no fs, no ipcRenderer — and no
 * way to read a stored secret: keys are written here and used in the main
 * process when a provider call is made.
 */
const bridge: FrameForgeBridge = {
  systemProbe: (): Promise<SystemProbe> => ipcRenderer.invoke(IPC.systemProbe) as Promise<SystemProbe>,

  vault: {
    status: (): Promise<VaultStatus> => ipcRenderer.invoke(IPC.vaultStatus) as Promise<VaultStatus>,
    set: (input: SetKeyInput): Promise<VaultStatus> => ipcRenderer.invoke(IPC.vaultSet, input) as Promise<VaultStatus>,
    remove: (providerId: ProviderId): Promise<VaultStatus> =>
      ipcRenderer.invoke(IPC.vaultDelete, { providerId }) as Promise<VaultStatus>,
    test: (input: TestKeyInput): Promise<ConnectionResult> =>
      ipcRenderer.invoke(IPC.vaultTest, input) as Promise<ConnectionResult>
  },

  providers: {
    list: (): Promise<ProviderDescriptor[]> => ipcRenderer.invoke(IPC.providersList) as Promise<ProviderDescriptor[]>
  },

  jobs: {
    create: (spec: JobSpec): Promise<Job> => ipcRenderer.invoke(IPC.jobCreate, spec) as Promise<Job>,
    list: (): Promise<Job[]> => ipcRenderer.invoke(IPC.jobList) as Promise<Job[]>,
    get: (jobId: string): Promise<Job | null> => ipcRenderer.invoke(IPC.jobGet, { jobId }) as Promise<Job | null>,
    cancel: (jobId: string): Promise<Job> => ipcRenderer.invoke(IPC.jobCancel, { jobId }) as Promise<Job>,
    remove: (jobId: string): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke(IPC.jobDelete, { jobId }) as Promise<{ ok: boolean }>,
    onEvent: (listener: (job: Job) => void): (() => void) => {
      const handler = (_event: Electron.IpcRendererEvent, job: Job): void => listener(job)
      ipcRenderer.on(IPC.jobEvent, handler)
      return () => {
        ipcRenderer.removeListener(IPC.jobEvent, handler)
      }
    }
  },

  composition: {
    preview: (spec: JobSpec): Promise<{ url: string }> =>
      ipcRenderer.invoke(IPC.compositionPreview, spec) as Promise<{ url: string }>
  },

  llm: {
    settings: (): Promise<LlmSettings> => ipcRenderer.invoke(IPC.llmSettingsGet) as Promise<LlmSettings>,
    saveSettings: (next: LlmSettings): Promise<LlmSettings> =>
      ipcRenderer.invoke(IPC.llmSettingsSet, next) as Promise<LlmSettings>,
    test: (): Promise<ConnectionResult> => ipcRenderer.invoke(IPC.llmTest) as Promise<ConnectionResult>
  },

  reveal: (path: string): Promise<{ ok: boolean }> => ipcRenderer.invoke(IPC.reveal, { path }) as Promise<{ ok: boolean }>
}

contextBridge.exposeInMainWorld('frameforge', bridge)
