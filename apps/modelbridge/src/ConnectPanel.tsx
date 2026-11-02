import { useState } from 'react'
import type { SourceInput } from '@modelbridge/runtime/contracts'
import type { AppStatus } from './types'
import type { Run } from './shared'
import { SourceCard, useCodexModel } from './SourceCard'

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
  const [adding, setAdding] = useState(false)
  const [notice, setNotice] = useState('')
  const codexModel = useCodexModel(status)
  const connected = status.sources.filter((source) => source.kind !== 'copilot')
  const showForm = adding || !connected.length
  return (
    <>
      {connected.length > 0 && (
        <section>
          <div className="section-head">
            <h2>Your hosts</h2>
            {!showForm && (
              <button
                className="primary"
                onClick={() => {
                  setNotice('')
                  setAdding(true)
                }}
              >
                Add a host
              </button>
            )}
          </div>
          <p className="muted">
            Check a connection, change its URL or access key, or remove hosts
            you no longer use. Codex sees the models from every host listed
            here.
          </p>
          {notice && (
            <p className="notice" role="status">
              {notice}
            </p>
          )}
          <div className="source-cards">
            {connected.map((source) => (
              <SourceCard
                key={source.id}
                source={source}
                status={status}
                codexModel={codexModel}
                busy={busy}
                run={run}
              />
            ))}
          </div>
        </section>
      )}
      {showForm && (
        <section>
          <h2>
            {connected.length ?
              'Connect another host or API'
            : 'Connect a host'}
          </h2>
          <p className="muted">
            Paste the host URL and access key shown on the host&apos;s Host
            setup tab. ModelBridge discovers its models automatically. Adding a
            host that is already connected updates it instead of adding it
            twice.
          </p>
          <form
            onSubmit={(event) => {
              event.preventDefault()
              const before = status.sources.length
              void run(() => window.modelbridge.addSource(input)).then(
                async (ok) => {
                  if (!ok) return
                  setInput(initialInput)
                  setAdding(false)
                  const result = await window.modelbridge.status()
                  if (result.ok && result.value.sources.length === before)
                    setNotice(
                      'This host was already connected. Its access key and models were updated.',
                    )
                  else onAdded()
                },
              )
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
              {connected.length > 0 && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    setInput(initialInput)
                    setAdding(false)
                  }}
                >
                  Cancel
                </button>
              )}
            </div>
          </form>
        </section>
      )}
    </>
  )
}
