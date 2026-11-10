import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import type { KeyStatus, ProviderId, VaultBackendName, VaultStatus } from '../shared/contract'
import { writeJsonAtomic } from './fsx'

/**
 * The vault never stores plaintext on disk. Two OS-native backends are
 * supported, in order of preference:
 *
 *  1. keyring  -> Windows Credential Manager / macOS Keychain / libsecret
 *  2. safeStorage -> Electron's DPAPI / Keychain / libsecret wrapper
 *
 * Only the main process ever holds a decrypted secret. The renderer learns
 * nothing beyond "configured: true, last4: ...".
 */

export const KEYRING_SERVICE = 'FrameForge Studio'

export interface SecretBackend {
  readonly name: Extract<VaultBackendName, 'keyring' | 'safeStorage' | 'memory'>
  readonly label: string
  readonly encryptionAvailable: boolean
  get(account: string): Promise<string | null>
  set(account: string, secret: string): Promise<void>
  delete(account: string): Promise<void>
}

export interface StoredKeyMeta {
  last4: string
  fingerprint: string
  updatedAt: string
}

interface MetaFile {
  version: 1
  keys: Record<string, StoredKeyMeta>
}

const EMPTY_META: MetaFile = { version: 1, keys: {} }

export function accountFor(providerId: ProviderId): string {
  return `provider:${providerId}`
}

/** Short, non-reversible identifier so the UI can tell two keys apart. */
export function fingerprint(secret: string): string {
  return createHash('sha256').update(secret).digest('hex').slice(0, 12)
}

export function lastFour(secret: string): string {
  return secret.slice(-4)
}

/**
 * Rejects material that is obviously not an API key: whitespace, control
 * characters, or values pasted from a shell with quotes attached.
 */
export function validateKeyMaterial(raw: string): { ok: true; value: string } | { ok: false; reason: string } {
  const value = raw.trim()
  if (value.length < 8) return { ok: false, reason: 'Key is shorter than 8 characters.' }
  if (value.length > 4096) return { ok: false, reason: 'Key is longer than 4096 characters.' }
  if (/[\s\u0000-\u001f\u007f]/.test(value)) {
    return { ok: false, reason: 'Key must not contain spaces, tabs, or control characters.' }
  }
  if (/^["']|["']$/.test(value)) {
    return { ok: false, reason: 'Key must not include surrounding quotes.' }
  }
  return { ok: true, value }
}

async function readMeta(file: string): Promise<MetaFile> {
  try {
    const raw = await fs.readFile(file, 'utf8')
    const parsed = JSON.parse(raw) as MetaFile
    if (parsed.version !== 1 || typeof parsed.keys !== 'object' || parsed.keys === null) return { ...EMPTY_META }
    return parsed
  } catch {
    return { ...EMPTY_META }
  }
}

async function writeMeta(file: string, meta: MetaFile): Promise<void> {
  await writeJsonAtomic(file, meta)
}

export class KeyVault {
  readonly #backend: SecretBackend
  readonly #metaFile: string
  #meta: MetaFile = { ...EMPTY_META }
  #loaded = false

  constructor(options: { backend: SecretBackend; metaFile: string }) {
    this.#backend = options.backend
    this.#metaFile = options.metaFile
  }

  get backendName(): SecretBackend['name'] {
    return this.#backend.name
  }

  async init(): Promise<void> {
    this.#meta = await readMeta(this.#metaFile)
    this.#loaded = true
  }

  async status(providerIds: readonly ProviderId[]): Promise<VaultStatus> {
    if (!this.#loaded) await this.init()
    const providers: KeyStatus[] = []
    for (const providerId of providerIds) {
      const meta = this.#meta.keys[providerId]
      providers.push({
        providerId,
        configured: Boolean(meta),
        last4: meta ? meta.last4 : null,
        fingerprint: meta ? meta.fingerprint.slice(0, 6) : null,
        updatedAt: meta ? meta.updatedAt : null
      })
    }
    return {
      backend: this.#backend.name,
      backendLabel: this.#backend.label,
      encryptionAvailable: this.#backend.encryptionAvailable,
      providers
    }
  }

  /** Main-process only. Never exposed over IPC. */
  async getSecret(providerId: ProviderId): Promise<string | null> {
    if (!this.#loaded) await this.init()
    if (!this.#meta.keys[providerId]) return null
    try {
      return await this.#backend.get(accountFor(providerId))
    } catch {
      // A stale metadata entry (credential deleted in the OS UI) should not
      // brick the app: treat it as "not configured".
      return null
    }
  }

  async setSecret(providerId: ProviderId, raw: string): Promise<KeyStatus> {
    if (!this.#loaded) await this.init()
    const validated = validateKeyMaterial(raw)
    if (!validated.ok) throw new VaultError(validated.reason)

    await this.#backend.set(accountFor(providerId), validated.value)
    const meta: StoredKeyMeta = {
      last4: lastFour(validated.value),
      fingerprint: fingerprint(validated.value),
      updatedAt: new Date().toISOString()
    }
    this.#meta = { ...this.#meta, keys: { ...this.#meta.keys, [providerId]: meta } }
    await writeMeta(this.#metaFile, this.#meta)
    return { providerId, configured: true, last4: meta.last4, fingerprint: meta.fingerprint.slice(0, 6), updatedAt: meta.updatedAt }
  }

  async deleteSecret(providerId: ProviderId): Promise<void> {
    if (!this.#loaded) await this.init()
    try {
      await this.#backend.delete(accountFor(providerId))
    } catch {
      // Deleting a missing credential is not an error.
    }
    const { [providerId]: _removed, ...rest } = this.#meta.keys
    this.#meta = { ...this.#meta, keys: rest }
    await writeMeta(this.#metaFile, this.#meta)
  }
}

export class VaultError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'VaultError'
  }
}

export function metaPathFor(userDataDir: string): string {
  return join(userDataDir, 'vault', 'keys.json')
}

interface KeyringEntry {
  setPassword(value: string): void
  getPassword(): string | null
  deletePassword(): void
}

interface KeyringModule {
  Entry: new (service: string, account: string) => KeyringEntry
}

/**
 * Windows Credential Manager / macOS Keychain / Linux Secret Service via
 * keyring-rs. Loaded lazily so a missing prebuilt binary degrades instead of
 * crashing the app at startup.
 */
export async function createKeyringBackend(options?: { loader?: () => Promise<KeyringModule> }): Promise<SecretBackend | null> {
  const loader = options?.loader ?? (() => import('@napi-rs/keyring') as Promise<KeyringModule>)
  let mod: KeyringModule
  try {
    mod = await loader()
  } catch {
    return null
  }
  try {
    const probe = new mod.Entry(KEYRING_SERVICE, '__probe__')
    probe.setPassword('probe')
    const ok = probe.getPassword() === 'probe'
    probe.deletePassword()
    if (!ok) return null
  } catch {
    return null
  }

  return {
    name: 'keyring',
    label:
      process.platform === 'win32'
        ? 'Windows Credential Manager'
        : process.platform === 'darwin'
          ? 'macOS Keychain'
          : 'Secret Service (libsecret)',
    encryptionAvailable: true,
    async get(account) {
      const entry = new mod.Entry(KEYRING_SERVICE, account)
      return entry.getPassword()
    },
    async set(account, secret) {
      new mod.Entry(KEYRING_SERVICE, account).setPassword(secret)
    },
    async delete(account) {
      new mod.Entry(KEYRING_SERVICE, account).deletePassword()
    }
  }
}

interface SafeStorageLike {
  isEncryptionAvailable(): boolean
  encryptString(plain: string): Buffer
  decryptString(encrypted: Buffer): string
  getSelectedStorageBackend?(): string
}

/**
 * Electron's own OS-backed encryption. Used when the native keyring module is
 * unavailable (e.g. a locked-down Linux box without libsecret).
 */
export async function createSafeStorageBackend(opts: {
  safeStorage: SafeStorageLike
  secretsFile: string
}): Promise<SecretBackend | null> {
  const { safeStorage, secretsFile } = opts
  if (!safeStorage.isEncryptionAvailable()) return null
  // Electron reports 'basic_text' when no real keyring is present on Linux.
  if (process.platform === 'linux' && safeStorage.getSelectedStorageBackend?.() === 'basic_text') return null

  let map: Record<string, string> = {}
  try {
    const raw = await fs.readFile(secretsFile, 'utf8')
    map = JSON.parse(raw) as Record<string, string>
  } catch {
    map = {}
  }

  const persist = async (): Promise<void> => {
    await writeJsonAtomic(secretsFile, map)
  }

  return {
    name: 'safeStorage',
    label: process.platform === 'win32' ? 'Windows DPAPI (Electron safeStorage)' : 'OS keychain (Electron safeStorage)',
    encryptionAvailable: true,
    async get(account) {
      const payload = map[account]
      if (!payload) return null
      try {
        return safeStorage.decryptString(Buffer.from(payload, 'base64'))
      } catch {
        return null
      }
    },
    async set(account, secret) {
      map[account] = safeStorage.encryptString(secret).toString('base64')
      await persist()
    },
    async delete(account) {
      delete map[account]
      await persist()
    }
  }
}

/** Deterministic backend for tests and for a last-resort degraded mode. */
export function createMemoryBackend(): SecretBackend {
  const store = new Map<string, string>()
  return {
    name: 'memory',
    label: 'In-memory (not persisted)',
    encryptionAvailable: false,
    async get(account) {
      return store.get(account) ?? null
    },
    async set(account, secret) {
      store.set(account, secret)
    },
    async delete(account) {
      store.delete(account)
    }
  }
}
