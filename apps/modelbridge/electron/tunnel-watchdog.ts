import type { TunnelHealthSettings } from '@modelbridge/runtime/contracts'
import { describeError } from './diagnostics'

export interface TunnelHealthState {
  phase: 'idle' | 'checking' | 'confirming' | 'reconnecting' | 'waiting'
  // Last relay answer: true when a host connection was reported.
  connected: boolean | null
  checkedAt: string | null
  reconnectedAt: string | null
  message: string | null
  // When the next automatic attempt runs after a failure.
  retryAt: string | null
}
export type TunnelHealth = TunnelHealthSettings & TunnelHealthState

export interface WatchdogTimers {
  once(callback: () => void, ms: number): unknown
  cancel(handle: unknown): void
  every(callback: () => void, ms: number): unknown
  stopEvery(handle: unknown): void
}

const realTimers: WatchdogTimers = {
  once: (callback, ms) => setTimeout(callback, ms).unref(),
  cancel: (handle) => clearTimeout(handle as NodeJS.Timeout),
  every: (callback, ms) => setInterval(callback, ms).unref(),
  stopEvery: (handle) => clearInterval(handle as NodeJS.Timeout),
}

export interface TunnelWatchdogOptions {
  settings(): TunnelHealthSettings
  // True while the user wants remote sharing on, even if the tunnel is down.
  active(): boolean
  hostConnections(): Promise<number>
  // Restarts the tunnel host; resolves once Dev Tunnels reports it ready.
  reconnect(): Promise<void>
  log(event: string, detail?: string): void
  now?: () => number
  timers?: WatchdogTimers
}

export const confirmDelayMs = 20_000
export const retryMinutes = [1, 2, 5, 10] as const
const idle: TunnelHealthState = {
  phase: 'idle',
  connected: null,
  checkedAt: null,
  reconnectedAt: null,
  message: null,
  retryAt: null,
}

/**
 * I check the tunnel only when something suggests it broke (wake from sleep,
 * a network change, a host warning or exit), when asked, or on an optional
 * backstop schedule. Each check is one `devtunnel show` call. I reconnect
 * only after the relay reports no host twice, then back off between failures.
 */
export class TunnelWatchdog {
  private state: TunnelHealthState = { ...idle }
  private timer: unknown = null
  private timerAt = 0
  private backstop: unknown = null
  private running: Promise<void> | null = null
  private attempt = 0
  private generation = 0
  private readonly timers: WatchdogTimers
  private readonly now: () => number

  constructor(private readonly options: TunnelWatchdogOptions) {
    this.timers = options.timers ?? realTimers
    this.now = options.now ?? Date.now
  }

  health(): TunnelHealth {
    return { ...this.options.settings(), ...this.state }
  }

  /** Requests an automatic check after `delayMs`; ignored while auto-reconnect is off. */
  notify(reason: string, { delayMs = 15_000, confirmed = false } = {}): void {
    if (!this.options.settings().autoReconnect || !this.options.active()) return
    this.options.log('tunnel check scheduled', reason)
    this.schedule(() => this.run(reason, confirmed, true), delayMs)
  }

  /** Checks immediately and reconnects at once if the relay reports no host. */
  async checkNow(): Promise<TunnelHealth> {
    if (!this.options.active())
      throw new Error('Remote sharing is off. Enable remote access first.')
    this.cancelTimer()
    this.attempt = 0
    await this.run('manual check', true, false)
    return this.health()
  }

  /** Forgets pending work, e.g. when the user starts or stops sharing. */
  reset(): void {
    this.generation++
    this.cancelTimer()
    this.attempt = 0
    this.state = { ...idle, reconnectedAt: this.state.reconnectedAt }
    this.configure()
  }

  /** Re-arms the backstop schedule after settings or sharing change. */
  configure(): void {
    if (this.backstop !== null) this.timers.stopEvery(this.backstop)
    this.backstop = null
    const settings = this.options.settings()
    if (!settings.autoReconnect) {
      this.cancelTimer()
      if (this.state.phase === 'waiting' || this.state.phase === 'confirming')
        this.state = { ...this.state, phase: 'idle', retryAt: null }
    }
    if (
      settings.autoReconnect
      && settings.checkMinutes > 0
      && this.options.active()
    )
      this.backstop = this.timers.every(() => {
        this.notify('scheduled check', { delayMs: 0 })
      }, settings.checkMinutes * 60_000)
  }

  dispose(): void {
    this.generation++
    this.cancelTimer()
    if (this.backstop !== null) this.timers.stopEvery(this.backstop)
    this.backstop = null
  }

  private schedule(task: () => Promise<void>, delayMs: number): void {
    const at = this.now() + delayMs
    if (this.timer !== null && this.timerAt <= at) return
    this.cancelTimer()
    this.timerAt = at
    this.timer = this.timers.once(() => {
      this.timer = null
      void task()
    }, delayMs)
  }

  private cancelTimer(): void {
    if (this.timer !== null) this.timers.cancel(this.timer)
    this.timer = null
  }

  private async run(
    reason: string,
    confirmed: boolean,
    automatic: boolean,
  ): Promise<void> {
    if (this.running) return this.running
    this.running = this.execute(reason, confirmed, automatic).finally(() => {
      this.running = null
    })
    return this.running
  }

  private stamp(): string {
    return new Date(this.now()).toISOString()
  }

  private async execute(
    reason: string,
    confirmed: boolean,
    automatic: boolean,
  ): Promise<void> {
    const generation = this.generation
    const stale = () =>
      generation !== this.generation
      || !this.options.active()
      || (automatic && !this.options.settings().autoReconnect)
    if (stale()) return
    this.state = { ...this.state, phase: 'checking' }
    let hosts: number
    try {
      hosts = await this.options.hostConnections()
    } catch (error) {
      if (generation !== this.generation) return
      this.options.log('tunnel check failed', describeError(error))
      this.state = {
        ...this.state,
        phase: 'idle',
        connected: null,
        checkedAt: this.stamp(),
        message: `Could not check the tunnel: ${error instanceof Error ? error.message : 'unknown error'}`,
      }
      this.retry(reason)
      return
    }
    if (stale()) return
    if (hosts > 0) {
      this.attempt = 0
      this.state = {
        ...this.state,
        phase: 'idle',
        connected: true,
        checkedAt: this.stamp(),
        message: null,
        retryAt: null,
      }
      this.options.log('tunnel check ok', `${hosts} host connection(s)`)
      return
    }
    this.state = { ...this.state, connected: false, checkedAt: this.stamp() }
    if (!confirmed) {
      this.options.log('tunnel relay reports no host', reason)
      this.state = {
        ...this.state,
        phase: 'confirming',
        message:
          'Microsoft’s relay reports no host connection. Confirming before reconnecting…',
      }
      this.cancelTimer()
      this.schedule(() => this.run(reason, true, automatic), confirmDelayMs)
      return
    }
    this.state = {
      ...this.state,
      phase: 'reconnecting',
      message: 'Reconnecting the tunnel…',
    }
    this.options.log('tunnel reconnecting', reason)
    try {
      await this.options.reconnect()
    } catch (error) {
      if (generation !== this.generation) return
      this.options.log('tunnel reconnect failed', describeError(error))
      this.state = {
        ...this.state,
        phase: 'idle',
        connected: false,
        message: `Reconnecting failed: ${error instanceof Error ? error.message : 'unknown error'}`,
      }
      this.retry(reason)
      return
    }
    if (generation !== this.generation) return
    this.attempt = 0
    this.state = {
      phase: 'idle',
      connected: true,
      checkedAt: this.stamp(),
      reconnectedAt: this.stamp(),
      message: `Reconnected after: ${reason}.`,
      retryAt: null,
    }
    this.options.log('tunnel reconnected', reason)
  }

  private retry(reason: string): void {
    if (!this.options.settings().autoReconnect || !this.options.active()) {
      this.state = { ...this.state, retryAt: null }
      return
    }
    const minutes =
      retryMinutes[Math.min(this.attempt, retryMinutes.length - 1)]
    this.attempt++
    const delay = minutes * 60_000
    this.state = {
      ...this.state,
      phase: 'waiting',
      retryAt: new Date(this.now() + delay).toISOString(),
    }
    this.cancelTimer()
    this.schedule(() => this.run(reason, true, true), delay)
  }
}
