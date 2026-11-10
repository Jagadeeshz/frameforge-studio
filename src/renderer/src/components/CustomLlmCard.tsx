import { useState, type ReactNode } from 'react'
import { CheckCircle2, Globe2, Save, ShieldCheck, Trash2, Zap } from 'lucide-react'
import { Button, Input, Tooltip } from '@hyperframes/studio/ui'
import { CUSTOM_LLM_ID, type ConnectionResult, type CustomLlmConfig, type KeyStatus, type LlmSettings } from '../../../shared/contract'
import { api } from '../lib/api'
import { Field, Pill, SectionLabel } from './Bits'

/**
 * Any OpenAI-compatible endpoint: DeepSeek, OpenRouter, Groq, Together, vLLM,
 * LM Studio, Ollama. Name and endpoint are non-secret and live in settings; the
 * key goes to the same OS credential store as the video providers.
 */

const PRESETS: Array<{ label: string; config: CustomLlmConfig }> = [
  { label: 'DeepSeek', config: { name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' } },
  { label: 'OpenRouter', config: { name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', model: 'deepseek/deepseek-chat' } },
  { label: 'Groq', config: { name: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', model: 'llama-3.3-70b-versatile' } },
  { label: 'Ollama (local)', config: { name: 'Ollama', baseUrl: 'http://localhost:11434/v1', model: 'llama3.1' } }
]

export function CustomLlmCard({
  settings,
  keyStatus,
  onSaved
}: {
  settings: LlmSettings | null
  keyStatus: KeyStatus | null
  onSaved: () => Promise<void>
}): ReactNode {
  const current = settings?.custom ?? null
  const [draft, setDraft] = useState<CustomLlmConfig>(
    current ?? { name: '', baseUrl: '', model: '' }
  )
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState<'save' | 'key' | 'test' | 'remove' | null>(null)
  const [result, setResult] = useState<ConnectionResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  const configured = Boolean(current)
  const keyConfigured = keyStatus?.configured === true
  const ready = configured && keyConfigured

  const saveConfig = async (next: CustomLlmConfig): Promise<void> => {
    setBusy('save')
    setError(null)
    try {
      await api().llm.saveSettings({ custom: next })
      setDraft(next)
      await onSaved()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not save the provider')
    } finally {
      setBusy(null)
    }
  }

  const saveKey = async (): Promise<void> => {
    setBusy('key')
    setError(null)
    try {
      await api().vault.set({ providerId: CUSTOM_LLM_ID, key })
      setKey('')
      setResult(null)
      await onSaved()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not store the key')
    } finally {
      setBusy(null)
    }
  }

  const removeKey = async (): Promise<void> => {
    setBusy('remove')
    try {
      await api().vault.remove(CUSTOM_LLM_ID)
      setResult(null)
      await onSaved()
    } finally {
      setBusy(null)
    }
  }

  const test = async (): Promise<void> => {
    setBusy('test')
    setError(null)
    try {
      setResult(await api().llm.test())
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Connection test failed')
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="ff-card" style={{ marginBottom: 12 }}>
      <div className="flex items-start justify-between" style={{ gap: 14 }}>
        <div style={{ minWidth: 0 }}>
          <div className="ff-row" style={{ gap: 8 }}>
            <Globe2 size={14} />
            <span style={{ fontWeight: 600, fontSize: 13.5 }}>Custom / Universal provider</span>
            {ready ? <Pill label="ready" state="ok" /> : <Pill label={configured ? 'add key' : 'not configured'} state="idle" />}
          </div>
          <div className="ff-hint" style={{ marginTop: 6, maxWidth: 640 }}>
            Any OpenAI-compatible chat endpoint. It writes the animated scenes that this machine renders into
            your film, so it is the only key the app needs — there is no video API anywhere in this build.
          </div>
        </div>
        <span className="ff-kbd">/chat/completions</span>
      </div>

      <div className="flex flex-wrap" style={{ gap: 6, marginTop: 12 }}>
        {PRESETS.map((preset) => (
          <Button
            key={preset.label}
            variant="secondary"
            size="sm"
            disabled={busy !== null}
            onClick={() => void saveConfig(preset.config)}
          >
            {preset.label}
          </Button>
        ))}
      </div>

      <div className="grid grid-cols-3" style={{ gap: 12, marginTop: 14 }}>
        <Field label="Provider name">
          <Input
            key={`name-${draft.name}`}
            value={draft.name}
            placeholder="DeepSeek"
            onCommit={(value) => setDraft((prev) => ({ ...prev, name: value }))}
          />
        </Field>
        <Field label="Base URL" hint="https://api.deepseek.com/v1">
          <Input
            key={`url-${draft.baseUrl}`}
            value={draft.baseUrl}
            placeholder="https://api.deepseek.com/v1"
            onCommit={(value) => setDraft((prev) => ({ ...prev, baseUrl: value }))}
          />
        </Field>
        <Field label="Model ID" hint="deepseek-chat">
          <Input
            key={`model-${draft.model}`}
            value={draft.model}
            placeholder="deepseek-chat"
            onCommit={(value) => setDraft((prev) => ({ ...prev, model: value }))}
          />
        </Field>
      </div>

      <div className="flex items-center justify-between" style={{ marginTop: 12, gap: 12 }}>
        <div className="ff-hint">
          {configured ? (
            <span className="ff-mono">
              {current?.name} · {current?.model}
            </span>
          ) : (
            'Pick a preset or fill the three fields, then save.'
          )}
        </div>
        <Button
          variant="primary"
          size="sm"
          icon={<Save size={12} />}
          disabled={busy !== null || draft.name.trim().length === 0 || draft.baseUrl.trim().length === 0 || draft.model.trim().length === 0}
          onClick={() => void saveConfig(draft)}
        >
          Save provider
        </Button>
      </div>

      <div style={{ marginTop: 14, paddingTop: 14, borderTop: '1px solid var(--ff-line)' }}>
        <SectionLabel
          right={
            keyConfigured ? (
              <span className="ff-mono" style={{ color: 'var(--ff-dim)' }}>
                ends ····{keyStatus?.last4} · fp {keyStatus?.fingerprint}
              </span>
            ) : null
          }
        >
          API key
        </SectionLabel>
        <div className="flex items-end" style={{ gap: 10 }}>
          <div style={{ flex: 1 }}>
            <Input
              key={`key-${keyStatus?.updatedAt ?? 'empty'}`}
              value={key}
              type="password"
              autoComplete="off"
              spellCheck={false}
              placeholder="sk-… (kept in Windows Credential Manager)"
              onCommit={setKey}
            />
          </div>
          <Button variant="primary" size="sm" disabled={key.trim().length < 8 || busy !== null} onClick={() => void saveKey()}>
            {busy === 'key' ? 'Storing…' : 'Store key'}
          </Button>
          <Tooltip label="Checks the endpoint with one authenticated request">
            <Button variant="secondary" size="sm" icon={<Zap size={12} />} disabled={!ready || busy !== null} onClick={() => void test()}>
              Test
            </Button>
          </Tooltip>
          {keyConfigured ? (
            <Button variant="danger" size="sm" icon={<Trash2 size={12} />} disabled={busy !== null} onClick={() => void removeKey()}>
              Remove
            </Button>
          ) : null}
        </div>

        {error ? (
          <div className="ff-err" style={{ marginTop: 10 }}>
            {error}
          </div>
        ) : null}
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
    </div>
  )
}
