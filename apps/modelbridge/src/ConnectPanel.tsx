import { useState } from 'react'
import type { SourceInput } from '@modelbridge/runtime/contracts'
import type { AppStatus } from './types'
import { plural } from './format'
import type { Run } from './shared'

const initialInput: SourceInput = {
  label: 'Remote Copilot host',
  kind: 'remote',
  baseUrl: '',
  protocol: 'responses',
  apiKey: '',
  shared: false,
}

export function ConnectPanel({
  status,
  busy,
  run,
  onAdded,
}: {
  status: AppStatus
  busy: boolean
  run: Run
  onAdded: () => void
}) {
  const [input, setInput] = useState(initialInput)
  const connected = status.sources.filter((source) => source.kind !== 'copilot')
  return (
    <>
      {connected.length > 0 && (
        <section>
          <h2>Connected hosts</h2>
          <ul className="source-list">
            {connected.map((source) => (
              <li key={source.id}>
                <div>
                  <strong>{source.label}</strong>
                  <code className="muted">{source.baseUrl}</code>
                </div>
                <span className="muted">
                  {source.kind === 'remote' ?
                    'ModelBridge host'
                  : 'Provider API'}{' '}
                  · {plural(source.models.length, 'model')}
                </span>
                <button
                  disabled={busy}
                  onClick={() =>
                    void run(() => window.modelbridge.refreshSource(source.id))
                  }
                >
                  Refresh models
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
      <section>
        <h2>
          {connected.length ? 'Connect another host or API' : 'Connect a host'}
        </h2>
        <p className="muted">
          Paste the host URL and access key shown on the host&apos;s Host setup
          tab. ModelBridge discovers its models automatically.
        </p>
        <form
          onSubmit={(event) => {
            event.preventDefault()
            void run(() => window.modelbridge.addSource(input)).then((ok) => {
              if (!ok) return
              setInput(initialInput)
              onAdded()
            })
          }}
        >
          <label>
            Name
            <input
              required
              name="label"
              autoComplete="off"
              value={input.label}
              onChange={(event) =>
                setInput({ ...input, label: event.target.value })
              }
            />
          </label>
          <label>
            Source type
            <select
              name="kind"
              value={input.kind}
              onChange={(event) =>
                setInput({
                  ...input,
                  kind: event.target.value === 'remote' ? 'remote' : 'api',
                })
              }
            >
              <option value="remote">Remote ModelBridge host</option>
              <option value="api">Provider API</option>
            </select>
          </label>
          <label className="wide">
            {input.kind === 'remote' ?
              'Host URL'
            : 'API base URL (including /v1 where required)'}
            <input
              required
              type="url"
              name="baseUrl"
              autoComplete="off"
              spellCheck={false}
              placeholder="https://…devtunnels.ms"
              value={input.baseUrl}
              onChange={(event) =>
                setInput({ ...input, baseUrl: event.target.value })
              }
            />
          </label>
          {input.kind === 'api' && (
            <label>
              Native protocol
              <select
                name="protocol"
                value={input.protocol}
                onChange={(event) => {
                  const value = event.target.value
                  if (
                    value === 'responses'
                    || value === 'messages'
                    || value === 'chat-completions'
                  )
                    setInput({ ...input, protocol: value })
                }}
              >
                <option value="responses">OpenAI Responses</option>
                <option value="messages">Anthropic Messages</option>
                <option value="chat-completions">
                  OpenAI Chat Completions
                </option>
              </select>
            </label>
          )}
          <label>
            Access key
            <input
              required
              type="password"
              name="apiKey"
              autoComplete="off"
              spellCheck={false}
              value={input.apiKey}
              onChange={(event) =>
                setInput({ ...input, apiKey: event.target.value })
              }
            />
          </label>
          <div className="actions wide">
            <button className="primary" disabled={busy} type="submit">
              {busy ? 'Working…' : 'Discover and add'}
            </button>
          </div>
        </form>
      </section>
    </>
  )
}
