import { expect, test } from 'bun:test'
import type { TunnelHealthSettings } from '@modelbridge/runtime/contracts'
import {
  confirmDelayMs,
  TunnelWatchdog,
  type WatchdogTimers,
} from '../electron/tunnel-watchdog'

function harness(answers: Array<number | Error>) {
  let clock = 0
  let nextId = 0
  const pending = new Map<number, { callback: () => void; ms: number }>()
  const repeating = new Map<number, number>()
  const timers: WatchdogTimers = {
    once: (callback, ms) => {
      pending.set(++nextId, { callback, ms })
      return nextId
    },
    cancel: (handle) => pending.delete(handle as number),
    every: (_callback, ms) => {
      repeating.set(++nextId, ms)
      return nextId
    },
    stopEvery: (handle) => repeating.delete(handle as number),
  }
  const settings: TunnelHealthSettings = {
    autoReconnect: true,
    checkMinutes: 0,
  }
  const events: string[] = []
  let active = true
  let reconnects = 0
  let failReconnect = false
  const watchdog = new TunnelWatchdog({
    settings: () => settings,
    active: () => active,
    hostConnections: () => {
      const answer = answers.shift()
      if (answer === undefined) throw new Error('Unexpected relay check.')
      return answer instanceof Error ?
          Promise.reject(answer)
        : Promise.resolve(answer)
    },
    reconnect: () => {
      reconnects++
      return failReconnect ?
          Promise.reject(new Error('relay unreachable'))
        : Promise.resolve()
    },
    log: (event) => events.push(event),
    now: () => clock,
    timers,
  })
  // Runs the single pending timer and lets its async check settle.
  const fire = async () => {
    expect(pending.size).toBe(1)
    const [[id, timer]] = [...pending]
    pending.delete(id)
    clock += timer.ms
    timer.callback()
    for (let turn = 0; turn < 10; turn++) await Promise.resolve()
    return timer.ms
  }
  return {
    watchdog,
    settings,
    events,
    pending,
    repeating,
    fire,
    reconnects: () => reconnects,
    failReconnect: (value: boolean) => (failReconnect = value),
    setActive: (value: boolean) => (active = value),
  }
}

test('events check once and leave a connected tunnel alone', async () => {
  const run = harness([1])
  run.watchdog.notify('resumed from sleep')
  run.watchdog.notify('network changed')
  expect(await run.fire()).toBe(15_000)
  expect(run.reconnects()).toBe(0)
  expect(run.watchdog.health()).toMatchObject({
    phase: 'idle',
    connected: true,
    message: null,
  })
  expect(run.pending.size).toBe(0)
  run.settings.autoReconnect = false
  run.watchdog.notify('resumed from sleep')
  run.settings.autoReconnect = true
  run.setActive(false)
  run.watchdog.notify('resumed from sleep')
  expect(run.pending.size).toBe(0)
})

test('a missing host is confirmed before reconnecting, then failures back off', async () => {
  const run = harness([0, 0, 0, 0, 0])
  run.watchdog.notify('resumed from sleep')
  await run.fire()
  expect(run.watchdog.health().phase).toBe('confirming')
  expect(run.reconnects()).toBe(0)
  run.failReconnect(true)
  expect(await run.fire()).toBe(confirmDelayMs)
  expect(run.reconnects()).toBe(1)
  expect(run.watchdog.health()).toMatchObject({
    phase: 'waiting',
    connected: false,
  })
  expect(run.watchdog.health().message).toContain('relay unreachable')
  expect(await run.fire()).toBe(60_000)
  expect(await run.fire()).toBe(2 * 60_000)
  expect(run.reconnects()).toBe(3)
  run.failReconnect(false)
  run.watchdog.notify('network changed', { delayMs: 0, confirmed: true })
  await run.fire()
  expect(run.reconnects()).toBe(4)
  expect(run.watchdog.health()).toMatchObject({
    phase: 'idle',
    connected: true,
    retryAt: null,
  })
  expect(run.watchdog.health().reconnectedAt).not.toBeNull()
  expect(run.events).toContain('tunnel reconnected')
})

test('a failed relay check never restarts the tunnel and is retried later', async () => {
  const run = harness([new Error('offline'), 1])
  run.watchdog.notify('network changed')
  await run.fire()
  expect(run.reconnects()).toBe(0)
  expect(run.watchdog.health().message).toContain('offline')
  expect(await run.fire()).toBe(60_000)
  expect(run.watchdog.health().connected).toBe(true)
})

test('manual checks reconnect immediately, even with automatic reconnect off', async () => {
  const run = harness([0])
  run.settings.autoReconnect = false
  const health = await run.watchdog.checkNow()
  expect(run.reconnects()).toBe(1)
  expect(health.connected).toBe(true)
  run.setActive(false)
  await expect(run.watchdog.checkNow()).rejects.toThrow('sharing is off')
})

test('stopping sharing discards pending work and the backstop follows settings', async () => {
  const run = harness([0])
  run.watchdog.notify('resumed from sleep')
  await run.fire()
  expect(run.pending.size).toBe(1)
  run.watchdog.reset()
  expect(run.pending.size).toBe(0)
  expect(run.watchdog.health().phase).toBe('idle')
  run.settings.checkMinutes = 30
  run.watchdog.configure()
  expect([...run.repeating.values()]).toEqual([30 * 60_000])
  run.settings.autoReconnect = false
  run.watchdog.configure()
  expect(run.repeating.size).toBe(0)
})
