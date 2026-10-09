import { createContext, useContext, useEffect, type ReactNode } from 'react'
import {
  useThemePreference,
  type ThemeContextValue,
} from '@copilot-api/shared/theme'

const ThemeContext = createContext<ThemeContextValue | null>(null)

export function ThemeProvider({ children }: { children: ReactNode }) {
  const value = useThemePreference()
  const { setThemePref } = value
  useEffect(() => {
    let active = true
    window.electronAPI
      .getSettings()
      .then((settings) => {
        if (active) setThemePref(settings.theme)
      })
      .catch(() => {})
    return () => {
      active = false
    }
  }, [setThemePref])

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext)
  if (!ctx) throw new Error('useTheme must be used within ThemeProvider')
  return ctx
}
