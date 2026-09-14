/**
 * The theme, and the one place it is decided.
 *
 * THE SYSTEM PREFERENCE IS THE DEFAULT, and an explicit choice overrides it. This surface used
 * to force light and deliberately ignore the OS, on the reasoning that it is operated at a desk
 * in daylight for an hour at a stretch; the alkor ledger world it now wears reasons just as
 * deliberately the other way, that it is read beside a terminal next to a run that takes
 * minutes. Both are guesses about a room neither one can see, and the OS is not guessing.
 *
 * So there are three states, not two: `light`, `dark`, and NOTHING STORED. The third is the one
 * that matters and it is the reason this hook is more than a `useState`. While nothing is
 * stored the dashboard follows the system live — a machine that flips to dark at sunset takes
 * the dashboard with it mid-session, without a reload. The moment someone uses the toggle, that
 * choice is written down and the system stops being consulted; it is their call from then on,
 * and it survives a reload.
 *
 * The initial value is read from the DOM rather than resolved again here, because `index.html`
 * has already done it synchronously before first paint. Reading storage or matchMedia a second
 * time would work, but it would put the source of truth in two places and invite them to drift.
 */
import { useCallback, useEffect, useState } from 'react'

export type Theme = 'light' | 'dark'

const STORAGE_KEY = 'alkor.theme'
const DARK_QUERY = '(prefers-color-scheme: dark)'

/** What the pre-paint script in index.html already stamped on `<html>`. */
const currentTheme = (): Theme =>
  typeof document === 'undefined' || document.documentElement.dataset.theme !== 'dark'
    ? 'light'
    : 'dark'

/** Whether the user has made a choice of their own. Absent means "follow the system". */
const storedTheme = (): Theme | null => {
  try {
    const t = window.localStorage.getItem(STORAGE_KEY)
    return t === 'dark' || t === 'light' ? t : null
  } catch {
    // A browser refusing storage cannot hold a choice, so it follows the system forever.
    return null
  }
}

export const useTheme = (): { theme: Theme; toggle: () => void } => {
  const [theme, setTheme] = useState<Theme>(currentTheme)

  // Stamp the DOM, but do NOT write storage here. An effect that persisted on every render
  // would record the system's current answer as though the user had chosen it, and the
  // dashboard would stop following the system the first time it ever rendered.
  useEffect(() => {
    document.documentElement.dataset.theme = theme
  }, [theme])

  // Follow the system, for as long as no choice has been made.
  useEffect(() => {
    if (storedTheme() !== null) return
    const mq = window.matchMedia(DARK_QUERY)
    const onChange = (e: MediaQueryListEvent) => setTheme(e.matches ? 'dark' : 'light')
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [theme])

  const toggle = useCallback(() => {
    // Suppress transitions for the duration of the swap. Without this, every surface,
    // border and control animates its colour independently and the change reads as a
    // sixty-element cascade rather than one deliberate act.
    const root = document.documentElement
    root.classList.add('is-theme-switching')
    setTheme((t) => {
      const next: Theme = t === 'dark' ? 'light' : 'dark'
      try {
        // This is the only write. Using the toggle is what makes the choice the user's.
        window.localStorage.setItem(STORAGE_KEY, next)
      } catch {
        // The choice simply does not outlive the tab, and the system resumes on reload.
      }
      return next
    })
    window.setTimeout(() => root.classList.remove('is-theme-switching'), 0)
  }, [])

  return { theme, toggle }
}
