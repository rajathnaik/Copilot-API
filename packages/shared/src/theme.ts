import { useEffect, useState, useCallback } from 'react'

import type { ThemePreference } from './types'
export type { ThemePreference } from './types'
type ResolvedTheme = 'light' | 'dark'

export interface ThemeContextValue {
  themePref: ThemePreference
  resolvedTheme: ResolvedTheme
  setThemePref: (pref: ThemePreference) => void
}

function getSystemTheme(): ResolvedTheme {
  if (typeof window === 'undefined') return 'light'
  return window.matchMedia('(prefers-color-scheme: dark)').matches ?
      'dark'
    : 'light'
}

function resolveTheme(pref: ThemePreference): ResolvedTheme {
  return pref === 'auto' ? getSystemTheme() : pref
}

function applyThemeClass(theme: ResolvedTheme): void {
  const root = document.documentElement
  root.style.colorScheme = theme
  if (theme === 'dark') {
    root.classList.add('dark')
  } else {
    root.classList.remove('dark')
  }
}

export function useThemePreference(
  initialPreference: ThemePreference = 'auto',
): ThemeContextValue {
  const [themePref, setThemePrefState] =
    useState<ThemePreference>(initialPreference)
  const [resolvedTheme, setResolvedTheme] = useState<ResolvedTheme>(() =>
    resolveTheme(initialPreference),
  )

  useEffect(() => {
    applyThemeClass(resolveTheme(themePref))
  }, [themePref])

  useEffect(() => {
    if (themePref !== 'auto') return
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const handler = () => {
      const resolved = getSystemTheme()
      setResolvedTheme(resolved)
      applyThemeClass(resolved)
    }
    media.addEventListener('change', handler)
    return () => media.removeEventListener('change', handler)
  }, [themePref])

  const setThemePref = useCallback((pref: ThemePreference) => {
    setThemePrefState(pref)
    const resolved = resolveTheme(pref)
    setResolvedTheme(resolved)
    applyThemeClass(resolved)
  }, [])

  return { themePref, resolvedTheme, setThemePref }
}
