import type { ReactNode } from 'react'

export function Param(props: {
  label: string
  value: number
  min: number
  max: number
  step?: number
  onChange: (v: number) => void
  format?: (v: number) => string
}) {
  const { label, value, min, max, step = 1, onChange, format } = props
  return (
    <div className="param">
      <label>{label}</label>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} />
      <span className="val">{format ? format(value) : value}</span>
    </div>
  )
}

export function Select<T extends string>(props: {
  label?: string
  value: T
  options: readonly T[] | { value: T; label: string }[]
  onChange: (v: T) => void
}) {
  const opts = (props.options as (T | { value: T; label: string })[]).map((o) => (typeof o === 'string' ? { value: o, label: o } : o))
  const sel = (
    <select value={props.value} onChange={(e) => props.onChange(e.target.value as T)}>
      {opts.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  )
  if (!props.label) return sel
  return (
    <div className="param">
      <label>{props.label}</label>
      {sel}
      <span />
    </div>
  )
}

export function Card(props: { title: ReactNode; children: ReactNode; right?: ReactNode }) {
  return (
    <div className="card">
      <div className="row" style={{ marginBottom: 6 }}>
        <h3 style={{ margin: 0 }}>{props.title}</h3>
        <div className="spacer" />
        {props.right}
      </div>
      {props.children}
    </div>
  )
}

export function Meter({ label, value, cls }: { label: string; value: number; cls?: string }) {
  return (
    <div className="meter">
      <span>{label}</span>
      <div className="bar">
        <div className={cls} style={{ width: `${Math.min(100, Math.max(0, value * 100))}%` }} />
      </div>
    </div>
  )
}

export function downloadName(base: string, ext: string) {
  return `${base.replace(/[^\w\- ]+/g, '').trim() || 'untitled'}.${ext}`
}
