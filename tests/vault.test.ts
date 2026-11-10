import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { KeyVault, createMemoryBackend, validateKeyMaterial, fingerprint, accountFor, metaPathFor, type SecretBackend } from '../src/main/vault'
import { PROVIDER_IDS } from '../src/shared/contract'

let dir = ''

beforeEach(async () => {
  dir = await fs.mkdtemp(join(process.env.TMPDIR ?? tmpdir(), 'ff-vault-'))
})

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

function vaultWith(backend: SecretBackend): KeyVault {
  return new KeyVault({ backend, metaFile: metaPathFor(dir) })
}

describe('key material validation', () => {
  it('accepts a normal bearer token', () => {
    const result = validateKeyMaterial('  sk-abc123456789  ')
    expect(result).toEqual({ ok: true, value: 'sk-abc123456789' })
  })

  it('rejects short, quoted, and whitespace-bearing values', () => {
    expect(validateKeyMaterial('short').ok).toBe(false)
    expect(validateKeyMaterial('"sk-abc123456789"').ok).toBe(false)
    expect(validateKeyMaterial('sk-abc 123456789').ok).toBe(false)
    expect(validateKeyMaterial('sk-abc\n123456789').ok).toBe(false)
  })

  it('produces a stable, non-reversible fingerprint', () => {
    expect(fingerprint('sk-abc123456789')).toBe(fingerprint('sk-abc123456789'))
    expect(fingerprint('sk-abc123456789')).not.toContain('sk-abc')
    expect(fingerprint('sk-abc123456789').length).toBe(12)
  })
})

describe('KeyVault', () => {
  it('stores secrets in the backend and only metadata on disk', async () => {
    const vault = vaultWith(createMemoryBackend())
    await vault.init()
    await vault.setSecret('runway', 'key_abcdef123456789')

    expect(await vault.getSecret('runway')).toBe('key_abcdef123456789')

    const meta = await fs.readFile(metaPathFor(dir), 'utf8')
    expect(meta).not.toContain('key_abcdef123456789')
    expect(meta).toContain('6789')

    const status = await vault.status(PROVIDER_IDS)
    expect(status.backend).toBe('memory')
    const runway = status.providers.find((entry) => entry.providerId === 'runway')
    expect(runway?.configured).toBe(true)
    expect(runway?.last4).toBe('6789')
  })

  it('scopes each provider to its own account name', async () => {
    const seen: string[] = []
    const backend: SecretBackend = {
      name: 'memory',
      label: 'test',
      encryptionAvailable: true,
      async get(account) {
        seen.push(`get:${account}`)
        return null
      },
      async set(account) {
        seen.push(`set:${account}`)
      },
      async delete(account) {
        seen.push(`delete:${account}`)
      }
    }
    const vault = vaultWith(backend)
    await vault.init()
    await vault.setSecret('luma', 'luma-1234567890')
    await vault.deleteSecret('luma')

    expect(seen).toEqual([`set:${accountFor('luma')}`, `delete:${accountFor('luma')}`])
    expect(accountFor('luma')).toBe('provider:luma')
  })

  it('rejects invalid key material without touching the backend', async () => {
    let writes = 0
    const backend: SecretBackend = {
      name: 'memory',
      label: 'test',
      encryptionAvailable: true,
      async get() {
        return null
      },
      async set() {
        writes += 1
      },
      async delete() {
        writes += 1
      }
    }
    const vault = vaultWith(backend)
    await vault.init()
    await expect(vault.setSecret('openai', 'bad key with spaces')).rejects.toThrow(/spaces/i)
    expect(writes).toBe(0)
  })

  it('survives a backend that throws on read (stale credential)', async () => {
    const backend: SecretBackend = {
      name: 'safeStorage',
      label: 'test',
      encryptionAvailable: true,
      async get() {
        throw new Error('decrypt failed')
      },
      async set() {},
      async delete() {}
    }
    const vault = vaultWith(backend)
    await vault.init()
    await vault.setSecret('replicate', 'r8_abcdefghijk')
    await expect(vault.getSecret('replicate')).resolves.toBeNull()
  })

  it('reloads metadata across instances', async () => {
    const first = vaultWith(createMemoryBackend())
    await first.init()
    await first.setSecret('fal', 'fal_1234567890')

    const second = vaultWith(createMemoryBackend())
    await second.init()
    const status = await second.status(PROVIDER_IDS)
    expect(status.providers.find((entry) => entry.providerId === 'fal')?.configured).toBe(true)
  })
})
