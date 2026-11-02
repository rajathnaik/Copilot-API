import { useEffect, useRef, useState } from 'react'
import type {
  AvailableModel,
  Protocol,
  ReasoningEffort,
} from '@modelbridge/runtime/contracts'
import { protocolLabels } from './apps'
import { failure, formatDuration, formatTokens } from './format'
import { CopyButton, copyText, send } from './gateway-client'
import {
  buildRequest,
  createStreamParser,
  curlSnippet,
  parseErrorBody,
  parseReply,
  pythonSnippet,
  type ParsedReply,
  type Turn,
} from './chat-protocol'

export interface PlaygroundPreset {
  protocol: Protocol
  model?: string
  // Changes on every request so the same preset can be applied twice.
  nonce: number
}

const speakers: Record<Protocol, string> = {
  responses: 'Codex',
  'chat-completions': 'Hermes, OpenClaw and OpenAI SDKs',
  messages: 'Claude Code and Anthropic SDKs',
}

interface Exchange {
  prompt: string
  reply: ParsedReply
  pending: boolean
  stopped?: boolean
  status?: number
  durationMs?: number
  firstChunkMs?: number | null
  protocol: Protocol
  model: string
}

export function gatewayBase(localUrl: string) {
  return localUrl.replace(/\/v1\/?$/u, '')
}

export function Playground({
  models,
  localUrl,
  preset,
}: {
  models: AvailableModel[]
  localUrl: string
  preset: PlaygroundPreset | null
}) {
  const [modelId, setModelId] = useState('')
  const [protocol, setProtocol] = useState<Protocol>('chat-completions')
  const [system, setSystem] = useState('')
  const [maxTokens, setMaxTokens] = useState(4096)
  const [effort, setEffort] = useState<ReasoningEffort | ''>('')
  const [stream, setStream] = useState(true)
  const [exchanges, setExchanges] = useState<Exchange[]>([])
  const [draft, setDraft] = useState('')
  const [running, setRunning] = useState<string | null>(null)
  const [raw, setRaw] = useState('')
  const [code, setCode] = useState<'curl' | 'python' | null>(null)
  const [error, setError] = useState('')
  const transcript = useRef<HTMLOListElement>(null)

  useEffect(() => {
    if (!preset) return
    setProtocol(preset.protocol)
    if (preset.model) setModelId(preset.model)
  }, [preset])

  const model =
    models.find((item) => item.id === modelId)
    ?? models.find((item) => item.protocols.includes(protocol))
    ?? models[0]
  const protocols = model?.protocols ?? []
  const active = protocols.includes(protocol) ? protocol : protocols[0]
  const efforts = model?.reasoningEfforts ?? []
  const chosenEffort = effort && efforts.includes(effort) ? effort : undefined
  const sources = [...new Set(models.map((item) => item.sourceLabel))]

  useEffect(() => {
    transcript.current?.lastElementChild?.scrollIntoView({ block: 'end' })
  }, [exchanges])

  const history = (prompt: string): Turn[] => [
    ...exchanges
      .filter(
        (item) => !item.pending && !item.reply.error && item.reply.text.trim(),
      )
      .flatMap((item): Turn[] => [
        { role: 'user', text: item.prompt },
        { role: 'assistant', text: item.reply.text },
      ]),
    { role: 'user', text: prompt },
  ]
  const request = (prompt: string) =>
    model && active ?
      buildRequest(active, {
        model: model.id,
        system,
        turns: history(prompt),
        maxTokens,
        effort: chosenEffort,
        stream,
      })
    : null

  async function submit() {
    const prompt = draft.trim()
    const built = request(prompt)
    if (!prompt || !built || !model || !active || running) return
    setError('')
    setDraft('')
    const index = exchanges.length
    const update = (patch: Partial<Exchange>) =>
      setExchanges((current) =>
        current.map((item, position) =>
          position === index ? { ...item, ...patch } : item,
        ),
      )
    setExchanges((current) => [
      ...current,
      {
        prompt,
        reply: { text: '', reasoning: '' },
        pending: true,
        protocol: active,
        model: model.name,
      },
    ])
    const parser = createStreamParser(active)
    try {
      const sent = await send(
        built.path,
        built.body,
        stream ? (chunk) => update({ reply: parser.push(chunk) }) : undefined,
        setRunning,
      )
      const { result } = sent
      setRaw(sent.body)
      const ok = result.status >= 200 && result.status < 300
      const reply: ParsedReply =
        result.cancelled ? parser.finish()
        : !ok ?
          {
            text: '',
            reasoning: '',
            error: parseErrorBody(sent.body, result.status),
          }
        : result.contentType.includes('text/event-stream') ? parser.finish()
        : parseReply(active, JSON.parse(sent.body) as unknown)
      update({
        reply,
        pending: false,
        stopped: result.cancelled,
        status: result.status,
        durationMs: result.durationMs,
        firstChunkMs: result.firstChunkMs,
      })
    } catch (reason) {
      update({
        pending: false,
        reply: {
          text: '',
          reasoning: '',
          error: failure(reason, 'The request failed.'),
        },
      })
    } finally {
      setRunning(null)
    }
  }

  const snippet =
    code && active ?
      (() => {
        const built = request(draft.trim() || 'Hello!')
        if (!built) return ''
        return code === 'curl' ?
            curlSnippet(gatewayBase(localUrl), active, built)
          : pythonSnippet(gatewayBase(localUrl), active, built)
      })()
    : ''

  if (!models.length)
    return (
      <section>
        <h2>Playground</h2>
        <p className="muted">
          Add a Copilot source or a remote host first. The playground lists
          every model this machine can use.
        </p>
      </section>
    )

  return (
    <section className="playground">
      <div className="section-head">
        <div>
          <h2>Playground</h2>
          <p className="muted">
            Chat with any model the way your coding tools do. Requests go
            through this machine&apos;s ModelBridge endpoint
            {models.some((item) => item.sourceLabel !== models[0].sourceLabel) ?
              ''
            : ` to ${models[0].sourceLabel}`}{' '}
            and appear on the Dashboard as Playground usage.
          </p>
        </div>
        <button
          type="button"
          disabled={!exchanges.length || !!running}
          onClick={() => {
            setExchanges([])
            setRaw('')
          }}
        >
          New conversation
        </button>
      </div>
      <div className="playground-controls">
        <label>
          Model
          <select
            value={model?.id ?? ''}
            onChange={(event) => setModelId(event.target.value)}
          >
            {sources.map((source) => (
              <optgroup key={source} label={source}>
                {models
                  .filter((item) => item.sourceLabel === source)
                  .map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                      {item.premiumMultiplier !== undefined
                        && ` (${item.premiumMultiplier}x premium)`}
                    </option>
                  ))}
              </optgroup>
            ))}
          </select>
        </label>
        <label>
          API
          <select
            value={active ?? ''}
            onChange={(event) => setProtocol(event.target.value as Protocol)}
          >
            {protocols.map((item) => (
              <option key={item} value={item}>
                {protocolLabels[item]}: like {speakers[item]}
              </option>
            ))}
          </select>
        </label>
        {efforts.length > 0 && (
          <label>
            Reasoning effort
            <select
              value={chosenEffort ?? ''}
              onChange={(event) =>
                setEffort(event.target.value as ReasoningEffort | '')
              }
            >
              <option value="">Model default</option>
              {efforts.map((item) => (
                <option key={item} value={item}>
                  {item}
                </option>
              ))}
            </select>
          </label>
        )}
        <label>
          Max output tokens
          <input
            type="number"
            min={16}
            max={model?.maxOutputTokens ?? 128_000}
            value={maxTokens}
            onChange={(event) =>
              setMaxTokens(Math.max(16, Number(event.target.value) || 16))
            }
          />
        </label>
        <label className="checkbox inline">
          <input
            type="checkbox"
            checked={stream}
            onChange={(event) => setStream(event.target.checked)}
          />
          Stream reply
        </label>
      </div>
      <details className="system-prompt">
        <summary>System prompt{system.trim() ? ' (set)' : ''}</summary>
        <textarea
          rows={3}
          value={system}
          onChange={(event) => setSystem(event.target.value)}
          placeholder="Optional instructions for the model"
        />
      </details>
      {error && (
        <div role="alert" className="error">
          {error}
        </div>
      )}
      <ol className="transcript" ref={transcript} aria-live="polite">
        {!exchanges.length && (
          <li className="muted empty-transcript">
            Send a message to start. Each reply shows its latency, tokens and
            the API it used.
          </li>
        )}
        {exchanges.map((item, index) => (
          <li key={index}>
            <div className="bubble user">{item.prompt}</div>
            <div
              className={`bubble assistant${item.reply.error ? ' failed' : ''}`}
            >
              {item.reply.reasoning && (
                <details className="reasoning">
                  <summary>Reasoning</summary>
                  <p>{item.reply.reasoning}</p>
                </details>
              )}
              {item.reply.text ?
                <p className="reply-text">{item.reply.text}</p>
              : item.pending ?
                <p className="muted">Waiting for the model…</p>
              : !item.reply.error && (
                  <p className="muted">
                    (No text returned. Raise the output token limit if the model
                    spent it on reasoning.)
                  </p>
                )
              }
              {item.reply.error && <p role="alert">{item.reply.error}</p>}
              <p className="reply-meta">
                {item.model} · {protocolLabels[item.protocol]}
                {item.status ? ` · HTTP ${item.status}` : ''}
                {item.firstChunkMs != null
                  && ` · first byte ${formatDuration(item.firstChunkMs)}`}
                {item.durationMs != null
                  && ` · total ${formatDuration(item.durationMs)}`}
                {item.reply.usage?.inputTokens != null
                  && ` · ${formatTokens(item.reply.usage.inputTokens)} in`}
                {item.reply.usage?.outputTokens != null
                  && ` · ${formatTokens(item.reply.usage.outputTokens)} out`}
                {item.stopped && ' · stopped'}
              </p>
            </div>
          </li>
        ))}
      </ol>
      <form
        className="composer"
        onSubmit={(event) => {
          event.preventDefault()
          void submit()
        }}
      >
        <label className="wide">
          <span className="sr-only">Message</span>
          <textarea
            rows={3}
            value={draft}
            placeholder="Message (Ctrl+Enter to send)"
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                event.preventDefault()
                void submit()
              }
            }}
          />
        </label>
        <div className="actions wide">
          {running ?
            <button
              type="button"
              className="danger"
              onClick={() =>
                void window.modelbridge
                  .playgroundCancel(running)
                  .then((result) => {
                    if (!result.ok) setError(result.error)
                  })
              }
            >
              Stop
            </button>
          : <button
              className="primary"
              disabled={!draft.trim() || !model || !active}
            >
              Send
            </button>
          }
          <div className="segmented" role="group" aria-label="Show code">
            {(['curl', 'python'] as const).map((item) => (
              <button
                type="button"
                key={item}
                aria-pressed={code === item}
                onClick={() => setCode(code === item ? null : item)}
              >
                {item === 'curl' ? 'curl' : 'Python'}
              </button>
            ))}
          </div>
        </div>
      </form>
      {snippet && (
        <div className="snippet">
          <div className="section-head">
            <p className="muted">
              This request as {code === 'curl' ? 'curl' : 'Python'}. Replace the
              key placeholder with your ModelBridge key.
            </p>
            <CopyButton copy={copyText(snippet)} />
          </div>
          <pre>{snippet}</pre>
        </div>
      )}
      {raw && (
        <details>
          <summary>Raw reply from the endpoint</summary>
          <pre className="raw">
            {raw.length > 40_000 ? `${raw.slice(0, 40_000)}\n…` : raw}
          </pre>
        </details>
      )}
    </section>
  )
}
