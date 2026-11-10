import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { emptyLlmSettings, llmSettingsSchema, type LlmSettings } from '../shared/contract'
import { writeJsonAtomic } from './fsx'

/**
 * Non-secret configuration only. The custom provider's API key lives in the OS
 * credential store; its name, base URL and model id live here so the app can
 * rebuild the client at startup.
 */

interface SettingsFile {
  version: 1
  llm: LlmSettings
}

export class SettingsStore {
  readonly #file: string
  #state: SettingsFile = { version: 1, llm: { ...emptyLlmSettings } }

  constructor(dataDir: string) {
    this.#file = join(dataDir, 'settings.json')
  }

  async init(): Promise<void> {
    try {
      const raw = await fs.readFile(this.#file, 'utf8')
      const parsed = JSON.parse(raw) as Partial<SettingsFile>
      const llm = llmSettingsSchema.safeParse(parsed.llm)
      if (llm.success) this.#state = { version: 1, llm: llm.data }
    } catch {
      // Missing or corrupt settings fall back to defaults; nothing is lost that
      // matters, since keys live in the vault.
    }
  }

  get llm(): LlmSettings {
    return this.#state.llm
  }

  async setLlm(next: LlmSettings): Promise<LlmSettings> {
    const validated = llmSettingsSchema.parse(next)
    this.#state = { version: 1, llm: validated }
    await writeJsonAtomic(this.#file, this.#state, 0o600)
    return validated
  }
}
