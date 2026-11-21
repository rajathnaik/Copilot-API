type Fetch = (url: string, init?: RequestInit) => Promise<Response>

export interface StreamTimeouts {
  // Longest wait for the response to start.
  headers: number
  // Longest wait for the next chunk once the response has started.
  idle: number
}

/**
 * I limit how long an upstream request may sit silent, not how long it may
 * run. A long answer that keeps streaming is never cut off, while one that
 * stalls still fails. The idle clock runs only while a reader is waiting on
 * upstream, so a slow client never counts against the source.
 */
export function withStreamTimeouts(
  fetcher: Fetch,
  limits: StreamTimeouts,
): Fetch {
  return async (url, init = {}) => {
    const controller = new AbortController()
    const client = init.signal
    const follow = () => {
      controller.abort(client?.reason)
    }
    if (client?.aborted) follow()
    else client?.addEventListener('abort', follow, { once: true })
    const expire = (stage: string) => () => {
      controller.abort(
        new DOMException(`Upstream ${stage} timed out.`, 'TimeoutError'),
      )
    }
    let timer = setTimeout(expire('response'), limits.headers)
    const release = () => {
      clearTimeout(timer)
      client?.removeEventListener('abort', follow)
    }
    let response: Response
    try {
      response = await fetcher(url, { ...init, signal: controller.signal })
    } catch (error) {
      release()
      throw error
    }
    clearTimeout(timer)
    if (!response.body) {
      release()
      return response
    }
    const reader = response.body.getReader()
    // Some fetch implementations ignore an abort once the body has started,
    // so I race each read against it as well.
    const aborted = new Promise<never>((_, reject) => {
      const fail = () => {
        reject(
          controller.signal.reason instanceof Error ?
            controller.signal.reason
          : new Error('Upstream request was cancelled.'),
        )
      }
      if (controller.signal.aborted) fail()
      else controller.signal.addEventListener('abort', fail, { once: true })
    })
    aborted.catch(() => undefined)
    const body = new ReadableStream<Uint8Array>({
      async pull(stream) {
        timer = setTimeout(expire('stream'), limits.idle)
        try {
          const next = await Promise.race([reader.read(), aborted])
          clearTimeout(timer)
          if (next.done) {
            release()
            stream.close()
            return
          }
          stream.enqueue(next.value)
        } catch (error) {
          release()
          await reader.cancel(error).catch(() => undefined)
          stream.error(error)
        }
      },
      async cancel(reason) {
        release()
        await reader.cancel(reason)
      },
    })
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    })
  }
}
