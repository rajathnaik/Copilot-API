import { useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react'

import { useLanguage } from '../contexts/LanguageContext'
import {
  DEFAULT_MAX_TOKENS,
  PLAYGROUND_API_LABELS,
  buildCurlSnippet,
  buildPlaygroundRequest,
  buildPythonSnippet,
  createStreamParser,
  formatBytes,
  getAttachmentLimits,
  getSupportedApis,
  parseErrorBody,
  parsePlaygroundResponse,
  pickDefaultApi,
  validateAttachments,
  type PlaygroundApi,
  type PlaygroundAttachment,
  type PlaygroundMessage,
  type PlaygroundModel,
  type PlaygroundUsage,
} from '../lib/playground'

interface PlaygroundPageProps {
  models: Array<{ id: string; [key: string]: unknown }>
  openaiUrl: string
  anthropicUrl: string
  authHeaderName?: string
}

interface ChatEntry extends PlaygroundMessage {
  id: string
  pending?: boolean
  stopped?: boolean
  error?: string
  usage?: PlaygroundUsage
  latencyMs?: number
}

interface ActiveRequest {
  requestId: string
  assistantId: string
  parser: ReturnType<typeof createStreamParser>
}

type CodeTab = 'curl' | 'python'

const PREFERRED_MODEL_PATTERN = /claude-sonnet/i

function newId(): string {
  return crypto.randomUUID()
}

function readFileAsAttachment(file: File): Promise<PlaygroundAttachment> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : ''
      const commaIndex = result.indexOf(',')
      resolve({
        name: file.name,
        mediaType: file.type,
        data: commaIndex >= 0 ? result.slice(commaIndex + 1) : result,
        size: file.size,
      })
    }
    reader.onerror = () =>
      reject(reader.error ?? new Error(`Failed to read ${file.name}`))
    reader.readAsDataURL(file)
  })
}

function mediaTypeLabel(type: string): string {
  if (type === 'application/pdf') return 'PDF'
  return type.replace(/^image\//, '').toUpperCase()
}

export default function PlaygroundPage({
  models,
  openaiUrl,
  anthropicUrl,
  authHeaderName,
}: PlaygroundPageProps) {
  const { t } = useLanguage()
  const chatModels = useMemo(
    () =>
      (models as PlaygroundModel[]).filter(
        (model) => getSupportedApis(model).length > 0,
      ),
    [models],
  )
  const [modelId, setModelId] = useState('')
  const [api, setApi] = useState<PlaygroundApi>('messages')
  const [system, setSystem] = useState('')
  const [maxTokens, setMaxTokens] = useState(DEFAULT_MAX_TOKENS)
  const [stream, setStream] = useState(true)
  const [entries, setEntries] = useState<ChatEntry[]>([])
  const [input, setInput] = useState('')
  const [attachments, setAttachments] = useState<PlaygroundAttachment[]>([])
  const [attachError, setAttachError] = useState('')
  const [activeRequestId, setActiveRequestId] = useState<string | null>(null)
  const [showCode, setShowCode] = useState(false)
  const [codeTab, setCodeTab] = useState<CodeTab>('curl')
  const [copied, setCopied] = useState(false)
  const activeRef = useRef<ActiveRequest | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  const model = chatModels.find((item) => item.id === modelId)
  const supportedApis = useMemo(
    () => (model ? getSupportedApis(model) : []),
    [model],
  )
  const limits = getAttachmentLimits(model, api)
  const sending = activeRequestId !== null

  // Pick an initial model once the list arrives, preferring Claude Sonnet.
  useEffect(() => {
    if (chatModels.length === 0) return
    if (chatModels.some((item) => item.id === modelId)) return
    const preferred =
      chatModels.find((item) => PREFERRED_MODEL_PATTERN.test(item.id))
      ?? chatModels[0]
    setModelId(preferred.id)
  }, [chatModels, modelId])

  useEffect(() => {
    if (supportedApis.length > 0 && !supportedApis.includes(api)) {
      setApi(pickDefaultApi(supportedApis) ?? supportedApis[0])
    }
  }, [supportedApis, api])

  useEffect(() => {
    setAttachError(validateAttachments(attachments, limits) ?? '')
    // limits is derived from model/api, which are the real dependencies.
  }, [attachments, modelId, api])

  useEffect(() => {
    return window.electronAPI.onPlaygroundChunk((requestId, chunk) => {
      const active = activeRef.current
      if (!active || active.requestId !== requestId) return
      const update = active.parser.push(chunk)
      if (!update.textDelta && !update.usage && !update.error) return
      setEntries((prev) =>
        prev.map((entry) =>
          entry.id === active.assistantId ?
            {
              ...entry,
              text: entry.text + update.textDelta,
              usage: update.usage ?? entry.usage,
              error: update.error ?? entry.error,
            }
          : entry,
        ),
      )
    })
  }, [])

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [entries])

  // Abort any in-flight request when leaving the tab.
  useEffect(() => {
    return () => {
      const active = activeRef.current
      if (active) void window.electronAPI.playgroundCancel(active.requestId)
    }
  }, [])

  const historyForRequest = (extra?: PlaygroundMessage): PlaygroundMessage[] =>
    [
      ...entries.filter(
        (entry) =>
          !entry.pending
          && !entry.error
          && (entry.text || entry.attachments?.length),
      ),
      ...(extra ? [extra] : []),
    ].map(({ role, text, attachments: files }) => ({
      role,
      text,
      attachments: files,
    }))

  const draftMessage: PlaygroundMessage | undefined =
    input.trim() || attachments.length > 0 ?
      { role: 'user', text: input.trim(), attachments }
    : undefined

  const codeRequest = useMemo(() => {
    if (!model) return undefined
    const history = historyForRequest(draftMessage)
    return buildPlaygroundRequest(api, {
      model: model.id,
      system,
      messages:
        history.length > 0 ? history : [{ role: 'user', text: 'Hello!' }],
      maxTokens,
      stream,
    })
    // historyForRequest/draftMessage are derived from the listed state.
  }, [model, api, system, maxTokens, stream, entries, input, attachments])

  const snippetAuth =
    authHeaderName ? { headerName: authHeaderName } : undefined
  const snippet =
    !codeRequest ? ''
    : codeTab === 'curl' ?
      buildCurlSnippet(anthropicUrl, codeRequest, snippetAuth)
    : buildPythonSnippet(api, anthropicUrl, codeRequest, snippetAuth)

  const updateEntry = (id: string, patch: Partial<ChatEntry>) => {
    setEntries((prev) =>
      prev.map((entry) => (entry.id === id ? { ...entry, ...patch } : entry)),
    )
  }

  const handleSend = async () => {
    if (!model || sending || !draftMessage || attachError) return
    const userEntry: ChatEntry = { id: newId(), ...draftMessage }
    const assistantId = newId()
    const request = buildPlaygroundRequest(api, {
      model: model.id,
      system,
      messages: historyForRequest(draftMessage),
      maxTokens,
      stream,
    })
    const requestId = newId()
    const parser = createStreamParser(api)
    activeRef.current = { requestId, assistantId, parser }
    setActiveRequestId(requestId)
    setEntries((prev) => [
      ...prev,
      userEntry,
      { id: assistantId, role: 'assistant', text: '', pending: true },
    ])
    setInput('')
    setAttachments([])

    const startedAt = performance.now()
    try {
      const result = await window.electronAPI.playgroundSend(
        requestId,
        request.path,
        request.body,
      )
      const latencyMs = performance.now() - startedAt
      if (result.aborted) {
        updateEntry(assistantId, { pending: false, stopped: true, latencyMs })
      } else if (result.streamed) {
        const final = parser.finish()
        setEntries((prev) =>
          prev.map((entry) =>
            entry.id === assistantId ?
              {
                ...entry,
                text: entry.text + final.textDelta,
                usage: final.usage ?? entry.usage,
                error: final.error ?? entry.error,
                pending: false,
                latencyMs,
              }
            : entry,
          ),
        )
      } else if (!result.ok) {
        updateEntry(assistantId, {
          pending: false,
          error: parseErrorBody(result.text ?? '', result.status),
          latencyMs,
        })
      } else {
        let payload: unknown
        try {
          payload = JSON.parse(result.text ?? '')
        } catch {
          payload = result.text
        }
        const parsed = parsePlaygroundResponse(api, payload)
        updateEntry(assistantId, {
          pending: false,
          text: parsed.text,
          usage: parsed.usage,
          error: parsed.error,
          latencyMs,
        })
      }
    } catch (error) {
      updateEntry(assistantId, {
        pending: false,
        error: error instanceof Error ? error.message : String(error),
      })
    } finally {
      activeRef.current = null
      setActiveRequestId(null)
    }
  }

  const handleStop = () => {
    if (activeRequestId) {
      void window.electronAPI.playgroundCancel(activeRequestId)
    }
  }

  const handleClear = () => {
    handleStop()
    setEntries([])
    setAttachError('')
  }

  const handleFiles = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? [])
    event.target.value = ''
    if (files.length === 0) return
    try {
      const loaded = await Promise.all(files.map(readFileAsAttachment))
      setAttachments((prev) => [...prev, ...loaded])
    } catch (error) {
      setAttachError(error instanceof Error ? error.message : String(error))
    }
  }

  const handleCopy = async () => {
    await navigator.clipboard.writeText(snippet)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  const formatUsage = (entry: ChatEntry) =>
    t('playground.usage', {
      input: entry.usage?.inputTokens ?? '–',
      output: entry.usage?.outputTokens ?? '–',
      seconds: ((entry.latencyMs ?? 0) / 1000).toFixed(1),
    })

  const labelClass =
    'block text-[12px] font-semibold text-ink-faint uppercase tracking-wide mb-1'
  const fieldClass =
    'w-full px-2.5 py-1.5 bg-sunken border border-line rounded-md text-[13px] text-ink focus:outline-none focus:border-accent'

  return (
    <div className="p-4 h-full flex gap-4 min-h-0">
      {/* Settings */}
      <aside className="w-[260px] shrink-0 bg-surface border border-line rounded-xl p-3 flex flex-col gap-3 overflow-y-auto">
        <div>
          <label className={labelClass} htmlFor="playground-model">
            {t('playground.model')}
          </label>
          <select
            id="playground-model"
            className={fieldClass}
            value={modelId}
            onChange={(event) => setModelId(event.target.value)}
            disabled={sending || chatModels.length === 0}
          >
            {chatModels.length === 0 && (
              <option value="">{t('playground.noModels')}</option>
            )}
            {chatModels.map((item) => (
              <option key={item.id} value={item.id}>
                {item.id}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className={labelClass} htmlFor="playground-api">
            {t('playground.api')}
          </label>
          <select
            id="playground-api"
            className={fieldClass}
            value={api}
            onChange={(event) => setApi(event.target.value as PlaygroundApi)}
            disabled={sending}
          >
            {supportedApis.map((item) => (
              <option key={item} value={item}>
                {PLAYGROUND_API_LABELS[item]}
              </option>
            ))}
          </select>
          <p className="mt-1 text-[12px] text-ink-faint">
            {t('playground.apiHint')}
          </p>
        </div>

        <div>
          <label className={labelClass} htmlFor="playground-system">
            {t('playground.system')}
          </label>
          <textarea
            id="playground-system"
            className={`${fieldClass} resize-y min-h-[80px]`}
            value={system}
            placeholder={t('playground.systemPlaceholder')}
            onChange={(event) => setSystem(event.target.value)}
          />
        </div>

        <div className="flex items-end gap-3">
          <div className="flex-1">
            <label className={labelClass} htmlFor="playground-max-tokens">
              {t('playground.maxTokens')}
            </label>
            <input
              id="playground-max-tokens"
              type="number"
              min={1}
              max={128000}
              className={fieldClass}
              value={maxTokens}
              onChange={(event) =>
                setMaxTokens(
                  Math.max(1, Number(event.target.value) || DEFAULT_MAX_TOKENS),
                )
              }
            />
          </div>
          <label className="flex items-center gap-1.5 pb-2 text-[13px] text-ink-soft cursor-pointer">
            <input
              type="checkbox"
              checked={stream}
              onChange={(event) => setStream(event.target.checked)}
            />
            {t('playground.stream')}
          </label>
        </div>

        <div className="mt-auto flex flex-col gap-2">
          <button
            type="button"
            onClick={() => setShowCode((value) => !value)}
            className="w-full px-3 py-1.5 border border-line rounded-md text-[13px] text-ink-soft hover:bg-sunken"
          >
            {showCode ? t('playground.hideCode') : t('playground.viewCode')}
          </button>
          <button
            type="button"
            onClick={handleClear}
            disabled={entries.length === 0}
            className="w-full px-3 py-1.5 border border-line rounded-md text-[13px] text-ink-soft hover:bg-sunken disabled:opacity-50"
          >
            {t('playground.clear')}
          </button>
        </div>
      </aside>

      {/* Conversation */}
      <section className="flex-1 min-w-0 bg-surface border border-line rounded-xl flex flex-col min-h-0">
        <div
          ref={scrollRef}
          className="flex-1 overflow-y-auto p-4 space-y-4 min-h-0"
        >
          {entries.length === 0 && (
            <div className="h-full flex flex-col items-center justify-center text-center gap-1.5 px-6">
              <p className="text-[15px] font-semibold text-ink">
                {t('playground.emptyTitle')}
              </p>
              <p className="text-[13px] text-ink-faint max-w-md">
                {t('playground.emptyDescription')}
              </p>
            </div>
          )}
          {entries.map((entry) => (
            <div
              key={entry.id}
              className={`flex flex-col ${entry.role === 'user' ? 'items-end' : 'items-start'}`}
            >
              <span className="text-[11px] font-semibold text-ink-faint uppercase tracking-wide mb-1">
                {entry.role === 'user' ?
                  t('playground.you')
                : `${t('playground.assistant')} · ${model?.id ?? ''}`}
              </span>
              <div
                className={`max-w-[85%] rounded-xl px-3 py-2 text-[13px] leading-relaxed whitespace-pre-wrap break-words ${
                  entry.role === 'user' ?
                    'bg-accent-strong text-white'
                  : 'bg-sunken text-ink'
                }`}
              >
                {entry.attachments && entry.attachments.length > 0 && (
                  <div className="flex flex-wrap gap-1.5 mb-1.5">
                    {entry.attachments.map((file, index) => (
                      <span
                        key={`${file.name}-${index}`}
                        className="px-2 py-0.5 rounded bg-black/15 text-[12px]"
                      >
                        📎 {file.name}
                      </span>
                    ))}
                  </div>
                )}
                {entry.text}
                {entry.pending && !entry.text && (
                  <span className="text-ink-faint animate-pulse">
                    {t('playground.waiting')}
                  </span>
                )}
                {entry.error && (
                  <div className="mt-1 text-red-600 dark:text-red-400">
                    ⚠️ {entry.error}
                  </div>
                )}
              </div>
              {entry.role === 'assistant' && !entry.pending && (
                <span className="mt-1 text-[11px] text-ink-faint">
                  {entry.stopped ? `${t('playground.stopped')} · ` : ''}
                  {formatUsage(entry)}
                </span>
              )}
            </div>
          ))}
        </div>

        {/* Composer */}
        <div className="border-t border-line-soft p-3 flex flex-col gap-2 shrink-0">
          {attachments.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {attachments.map((file, index) => (
                <span
                  key={`${file.name}-${index}`}
                  className="flex items-center gap-1.5 px-2 py-0.5 bg-sunken border border-line rounded text-[12px] text-ink-soft"
                >
                  📎 {file.name} ({formatBytes(file.size)})
                  <button
                    type="button"
                    className="text-ink-faint hover:text-red-500"
                    title={t('playground.removeAttachment')}
                    onClick={() =>
                      setAttachments((prev) =>
                        prev.filter((_, itemIndex) => itemIndex !== index),
                      )
                    }
                  >
                    ✕
                  </button>
                </span>
              ))}
            </div>
          )}
          {attachError && (
            <p className="text-[12px] text-red-600 dark:text-red-400">
              {attachError}
            </p>
          )}
          <textarea
            className={`${fieldClass} resize-none h-[72px]`}
            value={input}
            placeholder={t('playground.placeholder')}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault()
                void handleSend()
              }
            }}
          />
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 min-w-0">
              <input
                ref={fileInputRef}
                type="file"
                multiple
                className="hidden"
                accept={limits.mediaTypes.join(',')}
                onChange={(event) => void handleFiles(event)}
              />
              <button
                type="button"
                disabled={!limits.enabled || sending}
                onClick={() => fileInputRef.current?.click()}
                title={
                  limits.enabled ? undefined : t('playground.attachDisabled')
                }
                className="px-3 py-1.5 border border-line rounded-md text-[13px] text-ink-soft hover:bg-sunken disabled:opacity-50"
              >
                📎 {t('playground.attach')}
              </button>
              <span className="text-[12px] text-ink-faint truncate">
                {limits.enabled ?
                  t('playground.attachHint', {
                    types: limits.mediaTypes.map(mediaTypeLabel).join(', '),
                    count: limits.maxCount,
                    size: formatBytes(limits.maxBytes),
                  })
                : t('playground.attachDisabled')}
              </span>
            </div>
            {sending ?
              <button
                type="button"
                onClick={handleStop}
                className="px-4 py-1.5 rounded-md text-[13px] font-medium bg-red-500 text-white hover:bg-red-600"
              >
                {t('playground.stop')}
              </button>
            : <button
                type="button"
                onClick={() => void handleSend()}
                disabled={!model || !draftMessage || Boolean(attachError)}
                className="px-4 py-1.5 rounded-md text-[13px] font-medium bg-accent-strong text-white hover:opacity-90 disabled:opacity-50"
              >
                {t('playground.send')}
              </button>
            }
          </div>
        </div>
      </section>

      {/* Code panel */}
      {showCode && (
        <aside className="w-[380px] shrink-0 bg-surface border border-line rounded-xl p-3 flex flex-col gap-2 min-h-0">
          <div className="flex items-center justify-between gap-2">
            <div className="flex gap-1">
              {(['curl', 'python'] as const).map((item) => (
                <button
                  key={item}
                  type="button"
                  onClick={() => setCodeTab(item)}
                  className={`px-2.5 py-1 rounded-md text-[12px] font-medium ${
                    codeTab === item ? 'bg-sunken text-ink' : (
                      'text-ink-faint hover:text-ink-soft'
                    )
                  }`}
                >
                  {item === 'curl' ? 'curl' : 'Python'}
                </button>
              ))}
            </div>
            <button
              type="button"
              onClick={() => void handleCopy()}
              className="px-2.5 py-1 border border-line rounded-md text-[12px] text-ink-soft hover:bg-sunken"
            >
              {copied ? t('playground.copied') : t('playground.copy')}
            </button>
          </div>
          <p className="text-[12px] text-ink-faint">
            {t('playground.codeHint')}
          </p>
          <div className="text-[12px] text-ink-soft space-y-0.5">
            <div>
              <span className="text-ink-faint">Anthropic:</span>{' '}
              <code>{anthropicUrl}</code>
            </div>
            <div>
              <span className="text-ink-faint">OpenAI:</span>{' '}
              <code>{openaiUrl}</code>
            </div>
          </div>
          <pre className="flex-1 min-h-0 overflow-auto bg-black text-green-400 rounded-lg p-3 text-[12px] leading-relaxed font-mono whitespace-pre">
            {snippet}
          </pre>
        </aside>
      )}
    </div>
  )
}
