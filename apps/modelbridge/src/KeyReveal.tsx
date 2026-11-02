export interface Revealed {
  remote: boolean
  key: string
}

export function KeyReveal({
  revealed,
  remote,
  onHide,
}: {
  revealed: Revealed | null
  remote: boolean
  onHide: () => void
}) {
  if (revealed?.remote !== remote) return null
  return (
    <div className="key">
      <code>{revealed.key}</code>
      <button onClick={onHide}>Hide key</button>
      <p className="muted">
        Share keys securely. Revealed keys clear when the window loses focus.
      </p>
    </div>
  )
}
