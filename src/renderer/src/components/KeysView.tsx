import { useState, type ReactNode } from 'react'
import { CheckCircle2, ExternalLink, KeyRound, ShieldCheck, Trash2, Zap } from 'lucide-react'
import { Button, Input, Tooltip, HyperframesLoader } from '@hyperframes/studio/ui'
import type { ConnectionResult, LlmSettings, ProviderDescriptor, ProviderId, VaultStatus } from '../../../shared/contract'
import { Pill, SectionLabel } from './Bits'
import { CustomLlmCard } from './CustomLlmCard'

export function KeysView({
  providers,
  vault,
  llmSettings,
  onSave,
  onRemove,
  onTest,
  onRefresh,
  onLlmChanged
}: {
  providers: ProviderDescriptor[]
  vault: VaultStatus | null
  llmSettings: LlmSettings | null
  onSave: (providerId: ProviderId, key: string) => Promise<void>
  onRemove: (providerId: ProviderId) => Promise<void>
  onTest: (providerId: ProviderId) => Promise<ConnectionResult>
  onRefresh: () => Promise<void>
  onLlmChanged: () => Promise<void>
}): ReactNode {
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState<string | null>(null)
  const [results, setResults] = useState<Record<string, ConnectionResult>>({})
  const [error, setError] = useState<string | null>(null)

  const statusFor = (id: ProviderId) => vault?.providers.find((entry) => entry.providerId === id) ?? null

  const save = async (id: ProviderId): Promise<void> => {
    const value = (drafts[id] ?? '').trim()
    if (!value) return
    setBusy(id)
    setError(null)
    try {
      await onSave(id, value)
      setDrafts((prev) => ({ ...prev, [id]: '' }))
      setResults((prev) => {
        const next = { ...prev }
        delete next[id]
        return next
      })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not store the key')
    } finally {
      setBusy(null)
    }
  }

  const test = async (id: ProviderId): Promise<void> => {
    setBusy(id)
    setError(null)
    try {
      const result = await onTest(id)
      setResults((prev) => ({ ...prev, [id]: result }))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Connection test failed')
    } finally {
      setBusy(null)
    }
  }

  const remove = async (id: ProviderId): Promise<void> => {
    setBusy(id)
    try {
      await onRemove(id)
      setResults((prev) => {
        const next = { ...prev }
        delete next[id]
        return next
      })
    } finally {
      setBusy(null)
    }
  }

  return (
    <section className="ff-pane" style={{ maxWidth: 980, margin: '0 auto', width: '100%' }}>
      <div className="flex items-start justify-between" style={{ marginBottom: 16 }}>
        <div>
          <div className="ff-label">Key vault</div>
          <div className="ff-h2" style={{ marginTop: 4, fontSize: 18 }}>
            Your keys, your account, this machine only
          </div>
          <div className="ff-hint" style={{ maxWidth: 620, marginTop: 6 }}>
            Keys are written to {vault?.backendLabel ?? 'the OS credential store'} and read only inside the main process when a
            provider call is made. They are never sent to a FrameForge server, never written to a project file, and never
            returned to the UI.
          </div>
        </div>
        <div className="ff-row" style={{ gap: 8 }}>
          <Pill label={vault?.backendLabel ?? 'detecting…'} state={vault?.encryptionAvailable ? 'ok' : 'warn'} />
          <Tooltip label="Re-read vault status">
            <Button variant="ghost" size="sm" onClick={() => void onRefresh()}>
              Refresh
            </Button>
          </Tooltip>
        </div>
      </div>

      {vault && !vault.encryptionAvailable ? (
        <div className="ff-warn" style={{ marginBottom: 12 }}>
          No OS-backed encryption was available, so keys are held in memory for this session only. Install a keyring
          (libsecret on Linux) or run on Windows/macOS for persistent storage.
        </div>
      ) : null}

      {error ? <div className="ff-err" style={{ marginBottom: 12 }}>{error}</div> : null}

      <CustomLlmCard
        settings={llmSettings}
        keyStatus={vault?.providers.find((entry) => entry.providerId === 'custom') ?? null}
        onSaved={onLlmChanged}
      />

      {providers.length === 0 ? (
        <HyperframesLoader title="Reading providers" detail="Loading the local provider registry" />
      ) : (
        <div style={{ display: 'grid', gap: 12 }}>
          {providers.map((provider) => {
            const status = statusFor(provider.id)
            const result = results[provider.id]
            const draft = drafts[provider.id] ?? ''
            return (
              <div className="ff-card" key={provider.id}>
                <div className="flex items-start justify-between" style={{ gap: 14 }}>
                  <div style={{ minWidth: 0 }}>
                    <div className="ff-row" style={{ gap: 8 }}>
                      <KeyRound size={14} />
                      <span style={{ fontWeight: 600, fontSize: 13.5 }}>{provider.label}</span>
                      {status?.configured ? <Pill label="configured" state="ok" /> : <Pill label="no key" state="idle" />}
                    </div>
                    <div className="ff-hint" style={{ marginTop: 6 }}>{provider.note}</div>
                    {status?.configured ? (
                      <div className="ff-mono" style={{ marginTop: 8, color: 'var(--ff-dim)' }}>
                        ends ····{status.last4} · fp {status.fingerprint} · {provider.capability}
                      </div>
                    ) : null}
                  </div>
                  <a className="ff-link" href={provider.docsUrl} onClick={(event) => event.preventDefault()} style={{ flexShrink: 0 }}>
                    docs <ExternalLink size={11} style={{ display: 'inline' }} />
                  </a>
                </div>

                <div className="flex items-end" style={{ gap: 10, marginTop: 12 }}>
                  <div style={{ flex: 1 }}>
                    <Input
                      key={`${provider.id}-${status?.updatedAt ?? 'empty'}`}
                      value={draft}
                      type="password"
                      autoComplete="off"
                      spellCheck={false}
                      placeholder={provider.keyPlaceholder}
                      onCommit={(value) => setDrafts((prev) => ({ ...prev, [provider.id]: value }))}
                    />
                  </div>
                  <Button
                    variant="primary"
                    size="sm"
                    disabled={draft.trim().length < 8 || busy === provider.id}
                    onClick={() => void save(provider.id)}
                  >
                    {busy === provider.id ? 'Saving…' : 'Store key'}
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    icon={<Zap size={12} />}
                    disabled={!status?.configured || busy === provider.id}
                    onClick={() => void test(provider.id)}
                  >
                    Test
                  </Button>
                  {status?.configured ? (
                    <Button variant="danger" size="sm" icon={<Trash2 size={12} />} disabled={busy === provider.id} onClick={() => void remove(provider.id)}>
                      Remove
                    </Button>
                  ) : null}
                </div>

                {result ? (
                  <div className={result.ok ? 'ff-ok' : 'ff-err'} style={{ marginTop: 10 }}>
                    <div className="ff-row" style={{ gap: 8 }}>
                      {result.ok ? <CheckCircle2 size={14} /> : <ShieldCheck size={14} />}
                      <span>
                        {result.message} · {result.latencyMs}ms
                      </span>
                    </div>
                  </div>
                ) : null}
              </div>
            )
          })}
        </div>
      )}

      <div className="ff-card" style={{ marginTop: 12 }}>
        <SectionLabel>How storage works</SectionLabel>
        <ul className="ff-hint" style={{ margin: 0, paddingLeft: 18, display: 'grid', gap: 6 }}>
          <li>Windows: Credential Manager entry per provider, scoped to your Windows account.</li>
          <li>macOS: Keychain item. Linux: Secret Service (libsecret).</li>
          <li>If the native keyring module is unavailable, Electron safeStorage (DPAPI/Keychain) is used instead.</li>
          <li>Only a truncated SHA-256 fingerprint and the last four characters are kept in plain metadata.</li>
        </ul>
      </div>
    </section>
  )
}
