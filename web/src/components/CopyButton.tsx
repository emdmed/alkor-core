/**
 * Copy-to-clipboard with an honest failure.
 *
 * `navigator.clipboard` is unavailable on an insecure origin and can be refused by
 * permission, and both look identical to a button that always says "copied". A dashboard
 * served over plain http on a LAN address hits this on the first click, so the failure is
 * reported rather than assumed away — the text is still selectable in the page.
 */
import { useEffect, useRef, useState } from 'react'
import { Check, Copy, X } from 'lucide-react'
import { Button } from './ui/button'

type CopyState = 'idle' | 'copied' | 'failed'

export const CopyButton = ({
  text,
  label = 'Copy',
  title,
}: {
  /** Read at click time, so a log that is still growing copies its latest form. */
  text: () => string
  label?: string
  title?: string
}) => {
  const [state, setState] = useState<CopyState>('idle')
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current)
  }, [])

  const flash = (next: CopyState) => {
    setState(next)
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => setState('idle'), 2000)
  }

  const copy = async () => {
    const value = text()
    try {
      if (!navigator.clipboard) throw new Error('clipboard unavailable on this origin')
      await navigator.clipboard.writeText(value)
      flash('copied')
    } catch {
      flash('failed')
    }
  }

  return (
    <Button
      variant="ghost"
      size="sm"
      type="button"
      onClick={copy}
      title={state === 'failed' ? 'clipboard refused — select the text and copy manually' : title ?? label}
    >
      {state === 'copied' ? <Check size={13} aria-hidden="true" /> : state === 'failed' ? <X size={13} aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />}
      {state === 'copied' ? 'copied' : state === 'failed' ? 'select manually' : label}
    </Button>
  )
}
