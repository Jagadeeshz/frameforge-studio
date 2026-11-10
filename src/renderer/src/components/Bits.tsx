import type { ReactNode } from 'react'

export function Pill({ label, state = 'idle', title }: { label: string; state?: 'ok' | 'warn' | 'bad' | 'idle'; title?: string }): ReactNode {
  return (
    <span className="ff-pill" title={title}>
      <span className="ff-dot" data-state={state} />
      {label}
    </span>
  )
}

export function SectionLabel({ children, right }: { children: ReactNode; right?: ReactNode }): ReactNode {
  return (
    <div className="flex items-center justify-between" style={{ marginBottom: 10 }}>
      <span className="ff-label">{children}</span>
      {right}
    </div>
  )
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }): ReactNode {
  return (
    <div className="ff-field">
      <span className="ff-label">{label}</span>
      {children}
      {hint ? <span style={{ fontSize: 11, color: 'var(--ff-dim)' }}>{hint}</span> : null}
    </div>
  )
}

export function Empty({ icon, title, detail }: { icon: ReactNode; title: string; detail: string }): ReactNode {
  return (
    <div className="ff-empty">
      <div style={{ opacity: 0.6 }}>{icon}</div>
      <div style={{ color: 'var(--ff-ink)', fontWeight: 560 }}>{title}</div>
      <div style={{ maxWidth: 320 }}>{detail}</div>
    </div>
  )
}
