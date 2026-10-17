// What a controller button just did ("✕ - Vibration Only"), shown over the top of the 3D view
// for half a second, then faded out.

import { useEffect, useState } from 'react'
import { onButtonHint } from '../store'

const SHOW_MS = 500

export function ButtonHint() {
  const [hint, setHint] = useState<{ text: string; n: number } | null>(null)
  const [fading, setFading] = useState(false)

  // n changes on every press, so pressing the same button again restarts the timer
  useEffect(() => onButtonHint((text) => setHint((h) => ({ text, n: (h?.n ?? 0) + 1 }))) as unknown as () => void, [])
  useEffect(() => {
    if (!hint) return
    setFading(false)
    const t = window.setTimeout(() => setFading(true), SHOW_MS)
    return () => window.clearTimeout(t)
  }, [hint])

  return (
    <div className="button-hint-anchor">
      {hint && (
        <div key={hint.n} className={`button-hint ${fading ? 'fading' : ''}`}>
          {hint.text}
        </div>
      )}
    </div>
  )
}
