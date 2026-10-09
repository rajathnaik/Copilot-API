import { useEffect, useRef, useState } from 'react'

import { useLanguage } from '@copilot-api/shared/language'
import {
  buildModelMappingsFromRows,
  createModelMappingRow,
  modelMappingsToRows,
  type ModelMappingRow,
} from '../lib/model-mappings-editor'

interface ModelMappingsPageProps {
  serverRunning: boolean
}

export default function ModelMappingsPage({
  serverRunning,
}: ModelMappingsPageProps) {
  const { t } = useLanguage()
  const translationRef = useRef(t)
  const [configPath, setConfigPath] = useState('')
  const [rows, setRows] = useState<ModelMappingRow[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [saveMessage, setSaveMessage] = useState('')

  useEffect(() => {
    translationRef.current = t
  }, [t])

  useEffect(() => {
    if (serverRunning) {
      return
    }

    setLoading(false)
    setConfigPath('')
    setRows([])
    setSaveMessage('')
    setError(t('advancedConfig.serverRequired'))
  }, [serverRunning, t])

  useEffect(() => {
    if (!serverRunning) {
      return
    }

    let cancelled = false

    const loadModelMappings = async () => {
      setLoading(true)
      setError('')

      try {
        const result = await window.electronAPI.getModelMappingsConfig()
        if (cancelled) {
          return
        }

        setConfigPath(result.configPath)
        setRows(modelMappingsToRows(result.modelMappings))
      } catch (err) {
        if (cancelled) {
          return
        }

        setError(
          `${translationRef.current('advancedConfig.loadFailed')}: ${(err as Error).message}`,
        )
      } finally {
        if (!cancelled) {
          setLoading(false)
        }
      }
    }

    void loadModelMappings()

    return () => {
      cancelled = true
    }
  }, [serverRunning])

  const handleRowChange = (
    id: string,
    field: 'source' | 'target',
    value: string,
  ) => {
    setRows((currentRows) =>
      currentRows.map((row) =>
        row.id === id ? { ...row, [field]: value } : row,
      ),
    )
    setError('')
    setSaveMessage('')
  }

  const handleAddRow = () => {
    setRows((currentRows) => [...currentRows, createModelMappingRow()])
    setError('')
    setSaveMessage('')
  }

  const handleRemoveRow = (id: string) => {
    setRows((currentRows) => currentRows.filter((row) => row.id !== id))
    setError('')
    setSaveMessage('')
  }

  const buildModelMappings = (): Record<string, string> | null => {
    const result = buildModelMappingsFromRows(rows)
    if (result.ok) {
      return result.modelMappings
    }

    if (result.reason === 'duplicate') {
      setError(
        t('advancedConfig.validationDuplicate', { model: result.model ?? '' }),
      )
      return null
    }

    setError(t('advancedConfig.validationIncomplete'))
    return null
  }

  const handleSave = async () => {
    setError('')
    setSaveMessage('')

    const nextModelMappings = buildModelMappings()
    if (!nextModelMappings) {
      return
    }

    setSaving(true)
    try {
      await window.electronAPI.saveModelMappings(nextModelMappings)
      setRows(modelMappingsToRows(nextModelMappings))
      setSaveMessage(t('advancedConfig.saved'))
    } catch (err) {
      setError(`${t('advancedConfig.saveFailed')}: ${(err as Error).message}`)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="h-full bg-canvas p-4 overflow-hidden flex flex-col">
      <div className="relative flex flex-col gap-3 flex-1 min-h-0">
        <div className="shrink-0 flex flex-col gap-3 rounded-lg border border-line bg-surface px-3 py-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <h2 className="text-[15px] font-semibold text-ink">
              {t('advancedConfig.modelMappingsTitle')}
            </h2>
            <p className="mt-1 max-w-3xl text-[13px] leading-relaxed text-ink-soft">
              {t('advancedConfig.modelMappingsDesc')}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <button
              onClick={handleAddRow}
              disabled={!serverRunning}
              className="inline-flex h-8 items-center justify-center rounded-md border border-line bg-surface px-3 text-[13px] font-medium text-ink-soft transition-colors hover:bg-sunken disabled:cursor-not-allowed disabled:opacity-50"
            >
              {t('advancedConfig.addMapping')}
            </button>
            <button
              onClick={handleSave}
              disabled={!serverRunning || loading || saving}
              className="inline-flex h-8 items-center justify-center rounded-md bg-accent-strong px-4 text-[13px] font-semibold text-white transition-colors hover:bg-accent-strong/90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {saving ? t('settings.saving') : t('settings.save')}
            </button>
          </div>
        </div>

        {error && (
          <div className="shrink-0 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[13px] text-red-700 dark:border-red-500/30 dark:bg-red-500/15 dark:text-red-400">
            {error}
          </div>
        )}

        {saveMessage && !error && (
          <div className="shrink-0 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-[13px] text-emerald-700 dark:border-emerald-500/30 dark:bg-emerald-500/15 dark:text-emerald-400">
            {saveMessage}
          </div>
        )}

        <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_320px] flex-1 min-h-0">
          <section className="min-w-0 overflow-hidden rounded-lg border border-line bg-surface flex flex-col">
            <div className="hidden grid-cols-[minmax(0,1fr)_minmax(0,1fr)_72px] gap-2 border-b border-line-soft bg-sunken px-3 py-2 text-[12px] font-semibold text-ink-faint lg:grid shrink-0">
              <div>{t('advancedConfig.sourceModel')}</div>
              <div>{t('advancedConfig.targetModel')}</div>
              <div />
            </div>

            {loading ?
              <div className="px-3 py-8 text-center text-[13px] text-ink-faint">
                {t('dashboard.loading')}
              </div>
            : rows.length === 0 ?
              <div className="px-3 py-10 text-center">
                <div className="text-[14px] font-semibold text-ink">
                  {t('advancedConfig.emptyTitle')}
                </div>
                <p className="mx-auto mt-2 max-w-xl text-[13px] leading-relaxed text-ink-soft">
                  {t('advancedConfig.emptyDescription')}
                </p>
              </div>
            : <div className="divide-y divide-line-soft flex-1 overflow-y-auto">
                {rows.map((row) => (
                  <div
                    key={row.id}
                    className="grid gap-2 px-3 py-2 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_72px] lg:items-center"
                  >
                    <label className="block min-w-0">
                      <div className="mb-1 text-[12px] font-medium text-ink-soft lg:hidden">
                        {t('advancedConfig.sourceModel')}
                      </div>
                      <input
                        type="text"
                        value={row.source}
                        onChange={(event) =>
                          handleRowChange(row.id, 'source', event.target.value)
                        }
                        placeholder="gpt-5.5"
                        className="h-8 w-full rounded-md border border-line bg-sunken px-2.5 text-[13px] text-ink placeholder-ink-faint transition-colors focus:bg-surface focus:outline-none focus:ring-2 focus:ring-accent/40"
                      />
                    </label>

                    <label className="block min-w-0">
                      <div className="mb-1 text-[12px] font-medium text-ink-soft lg:hidden">
                        {t('advancedConfig.targetModel')}
                      </div>
                      <input
                        type="text"
                        value={row.target}
                        onChange={(event) =>
                          handleRowChange(row.id, 'target', event.target.value)
                        }
                        placeholder="codex/gpt-5.5"
                        className="h-8 w-full rounded-md border border-line bg-sunken px-2.5 text-[13px] text-ink placeholder-ink-faint transition-colors focus:bg-surface focus:outline-none focus:ring-2 focus:ring-accent/40"
                      />
                    </label>

                    <button
                      onClick={() => handleRemoveRow(row.id)}
                      className="inline-flex h-8 items-center justify-center rounded-md border border-red-200 px-2 text-[13px] font-medium text-red-600 transition-colors hover:bg-red-50 dark:border-red-500/30 dark:hover:bg-red-500/15"
                    >
                      {t('advancedConfig.remove')}
                    </button>
                  </div>
                ))}
              </div>
            }
          </section>

          <aside className="flex min-w-0 flex-col gap-3">
            <div className="rounded-lg border border-line bg-surface px-3 py-3">
              <div className="text-[12px] font-semibold uppercase tracking-wide text-ink-faint">
                {t('advancedConfig.configPath')}
              </div>
              <div
                className="mt-2 break-all rounded-md bg-sunken px-2.5 py-2 font-mono text-[12px] leading-relaxed text-ink-soft"
                title={configPath || undefined}
              >
                {configPath || '—'}
              </div>
            </div>

            <div className="rounded-lg border border-line bg-surface px-3 py-3">
              <div className="text-[12px] font-semibold uppercase tracking-wide text-ink-faint">
                {t('advancedConfig.scopeLabel')}
              </div>
              <p className="mt-2 text-[13px] leading-relaxed text-ink-soft">
                {t('advancedConfig.scopeNote')}
              </p>
              <p className="mt-2 text-[12px] leading-relaxed text-emerald-700 dark:text-emerald-400">
                {t('advancedConfig.restartNote')}
              </p>
            </div>

            <div className="rounded-lg border border-line bg-surface px-3 py-3 text-[13px] leading-relaxed text-ink-soft">
              {t('advancedConfig.saveHelp')}
            </div>
          </aside>
        </div>
      </div>
    </div>
  )
}
