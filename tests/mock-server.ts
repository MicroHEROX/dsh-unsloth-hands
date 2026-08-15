import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'

/** One scripted behavior for the next request the mock server receives. */
export type Behavior =
  | { kind: 'json'; status?: number; body: unknown; delayMs?: number }
  | { kind: 'http-error'; status: number; body: string; contentType?: string; headers?: Record<string, string> }

export interface MockServer {
  url: string
  /** Bodies of received requests, in order. */
  requests: unknown[]
  /** Header bags of received requests, in order (parallel to `requests`). */
  headers: IncomingMessage['headers'][]
  close(): Promise<void>
}

const servers: Server[] = []

/** Close every server opened since the last call; run from each spec's afterEach. */
export async function closeMockServers(): Promise<void> {
  await Promise.all(servers.splice(0).map(server => new Promise(resolve => server.close(resolve))))
}

/** A minimal complete text completion, reused by request-shape assertions. */
export const textBody = {
  model: 'unsloth/gemma-local',
  choices: [{ index: 0, message: { role: 'assistant', content: 'hello from local' } }],
  usage: { prompt_tokens: 7, completion_tokens: 4 },
}

/** A thinking-mode completion (llama-server `reasoning_content` in the message). */
export const thinkingBody = {
  model: 'unsloth/gemma-local',
  choices: [{
    index: 0,
    message: { role: 'assistant', content: 'final answer', reasoning_content: 'let me think' },
  }],
  usage: { prompt_tokens: 5, completion_tokens: 6 },
}

export interface MockServerOptions {
  /**
   * When set, every non-`/v1/models` request must carry
   * `authorization: Bearer <token>` or the mock answers 401 — mirroring
   * Unsloth's authenticated API.
   */
  requireAuth?: string
}

/**
 * Local Unsloth stand-in: replays scripted behaviors per request. The health
 * endpoint answers unconditionally (the launch manager probes it) and must
 * NOT consume scripted chat-completions behaviors.
 */
export async function mockServer(script: Behavior[], options: MockServerOptions = {}): Promise<MockServer> {
  const requests: unknown[] = []
  const headers: IncomingMessage['headers'][] = []
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    let body = ''
    request.on('data', (chunk: Buffer) => { body += chunk.toString('utf8') })
    request.on('end', () => {
      if (request.url === '/v1/models') {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ object: 'list', data: [{ id: 'gemma-local' }] }))
        return
      }
      const auth = request.headers.authorization
      if (options.requireAuth !== undefined && auth !== `Bearer ${options.requireAuth}`) {
        requests.push(body.length > 0 ? JSON.parse(body) : null)
        headers.push(request.headers)
        response.writeHead(401, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: { message: 'unauthorized: missing or wrong API key', type: 'auth_error' } }))
        return
      }
      requests.push(body.length > 0 ? JSON.parse(body) : null)
      headers.push(request.headers)
      const behavior = script.shift()
      if (!behavior) {
        response.writeHead(500).end(JSON.stringify({ error: { message: 'mock script exhausted' } }))
        return
      }
      const finish = (): void => {
        if (behavior.kind === 'http-error') {
          response.writeHead(behavior.status, {
            'content-type': behavior.contentType ?? 'application/json',
            ...behavior.headers,
          })
          response.end(behavior.body)
          return
        }
        response.writeHead(behavior.status ?? 200, { 'content-type': 'application/json' })
        response.end(JSON.stringify(behavior.body))
      }
      if (behavior.kind === 'json' && behavior.delayMs !== undefined) {
        setTimeout(finish, behavior.delayMs)
      } else {
        finish()
      }
    })
  })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no port')
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    headers,
    close: () => new Promise(resolve => server.close(() => { resolve() })),
  }
}
