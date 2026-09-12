/**
 * The theme, and the one place it is decided.
 *
 * Light is the default and dark is the alternative, which is a product decision rather
 * than a platform one: this surface is operated at a desk in daylight, beside the machine
 * doing the work, for an hour at a stretch. The system preference is deliberately not
 * consulted — a user who wants dark says so once, and that choice then persists across
 * sessions and survives a reload.
 *
 * The initial value is read from the DOM rather than from storage, because `index.html`
 * has already resolved it synchronously before first paint. Reading storage again here
 * would work, but it would put the source of truth in two places and invite them to drift.
 */
import { useCallback, useEffect, useState } from 'react'

export type Theme = 'light' | 'dark'

const STORAGE_KEY = 'alkor.theme'

const currentTheme = (): Theme =>
  typeof document === 'undefined' || document.documentElement.dataset.theme !== 'dark'
    ? 'light'
    : 'dark'

export const useTheme = (): { theme: Theme; toggle: () => void } => {
  const [theme, setTheme] = useState<Theme>(currentTheme)

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    try {
      window.localStorage.setItem(STORAGE_KEY, theme)
    } catch {
      // A browser refusing storage is not a reason to refuse the theme; the choice simply
      // does not outlive the tab.
    }
  }, [theme])

  const toggle = useCallback(() => {
    // Suppress transitions for the duration of the swap. Without this, every surface,
    // border and control animates its colour independently and the change reads as a
    // sixty-element cascade rather than one deliberate act.
    const root = document.documentElement
    root.classList.add('is-theme-switching')
    setTheme((t) => (t === 'dark' ? 'light' : 'dark'))
    window.setTimeout(() => root.classList.remove('is-theme-switching'), 0)
  }, [])

  return { theme, toggle }
}
