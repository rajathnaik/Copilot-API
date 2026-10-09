import { useState, useEffect, type CSSProperties } from 'react'

type ElectronAppRegionStyle = CSSProperties & {
  WebkitAppRegion?: 'drag' | 'no-drag'
}

const noDragRegionStyle: ElectronAppRegionStyle = { WebkitAppRegion: 'no-drag' }

export default function WindowControls() {
  const [maximized, setMaximized] = useState(false)

  useEffect(() => {
    let active = true
    window.electronAPI
      .windowIsMaximized()
      .then((value) => {
        if (active) setMaximized(value)
      })
      .catch(() => {})
    const unsubscribe = window.electronAPI.onWindowMaximizeChange((value) => {
      setMaximized(value)
    })
    return () => {
      active = false
      unsubscribe()
    }
  }, [])

  return (
    <div
      className="flex items-stretch shrink-0 self-stretch -mr-4"
      style={noDragRegionStyle}
    >
      <button
        onClick={() => window.electronAPI.windowMinimize()}
        className="flex w-[46px] items-center justify-center text-ink-soft hover:bg-sunken transition-colors"
        title="Minimize"
      >
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
          <rect x="0" y="4.5" width="10" height="1" fill="currentColor" />
        </svg>
      </button>

      <button
        onClick={() => window.electronAPI.windowMaximizeToggle()}
        className="flex w-[46px] items-center justify-center text-ink-soft hover:bg-sunken transition-colors"
        title={maximized ? 'Restore' : 'Maximize'}
      >
        {maximized ?
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
            <rect
              x="2.5"
              y="0.5"
              width="7"
              height="7"
              rx="1"
              fill="none"
              stroke="currentColor"
              strokeWidth="1"
            />
            <rect
              x="0.5"
              y="2.5"
              width="7"
              height="7"
              rx="1"
              fill="var(--color-surface)"
              stroke="currentColor"
              strokeWidth="1"
            />
          </svg>
        : <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
            <rect
              x="0.5"
              y="0.5"
              width="9"
              height="9"
              rx="1"
              fill="none"
              stroke="currentColor"
              strokeWidth="1"
            />
          </svg>
        }
      </button>

      <button
        onClick={() => window.electronAPI.windowClose()}
        className="flex w-[46px] items-center justify-center text-ink-soft hover:bg-red-500 hover:text-white transition-colors"
        title="Close"
      >
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
          <path
            d="M0.5 0.5 L9.5 9.5 M9.5 0.5 L0.5 9.5"
            stroke="currentColor"
            strokeWidth="1"
            strokeLinecap="round"
          />
        </svg>
      </button>
    </div>
  )
}
