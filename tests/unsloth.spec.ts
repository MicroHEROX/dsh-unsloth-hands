import { describe, expect, it } from 'vitest'
import { chatCompletion, httpErrorCode, portOf, probeServer } from '../src/unsloth.js'
import { closeMockServers, mockServer, textBody, thinkingBody } from './mock-server.js'

const signal = new AbortController().signal

describe('portOf', () => {
  it('parses the port from a base URL with an 8888 default', () => {
    expect(portOf('http://127.0.0.1:8888')).toBe(8888)
    expect(portOf('https://host.example:8080')).toBe(8080)
    expect(portOf('http://127.0.0.1')).toBe(8888)
    expect(portOf('not a url')).toBe(8888)
  })
})

describe('probeServer', () => {
  it('passes when the server answers (any HTTP status counts as reachable)', async () => {
    const mock = await mockServer([])
    await expect(probeServer(mock.url, undefined)).resolves.toBeUndefined()
    await closeMockServers()
  })

  it('passes when the server answers 401 (missing/wrong key — the call itself reports AUTH)', async () => {
    const mock = await mockServer([])
    // The mock answers /v1/models unconditionally; simulate a keyed server by
    // pointing the probe at the URL with a key that the mock ignores.
    await expect(probeServer(mock.url, 'sk-unsloth-somekey')).resolves.toBeUndefined()
    await closeMockServers()
  })

  it('throws SERVER_NOT_RUNNING with a clear message when nothing answers', async () => {
    await expect(probeServer('http://127.0.0.1:1', undefined, 500))
      .rejects.toMatchObject({ code: 'SERVER_NOT_RUNNING' })
  })
})

describe('httpErrorCode', () => {
  it('maps the standard vocabulary', () => {
    expect(httpErrorCode(401)).toBe('AUTH')
    expect(httpErrorCode(403)).toBe('AUTH')
    expect(httpErrorCode(429)).toBe('RATE_LIMIT')
    expect(httpErrorCode(400)).toBe('INVALID_REQUEST')
    expect(httpErrorCode(500)).toBe('SERVER')
    expect(httpErrorCode(418)).toBe('HTTP_418')
  })

  it('classifies context overflow and quota wording', () => {
    expect(httpErrorCode(400, { message: 'Prompt too long for the model context window' }))
      .toBe('CONTEXT_WINDOW_EXCEEDED')
    expect(httpErrorCode(400, { code: 'context_length_exceeded' })).toBe('CONTEXT_WINDOW_EXCEEDED')
    expect(httpErrorCode(402, { type: 'insufficient_quota' })).toBe('QUOTA')
  })
})

describe('chatCompletion', () => {
  it('posts a non-streaming chat-completions request and returns the answer', async () => {
    const mock = await mockServer([{ kind: 'json', body: textBody }])
    const result = await chatCompletion(mock.url, {
      model: 'unsloth',
      apiKey: 'sk-unsloth-testkey',
      prompt: 'translate this',
      system: 'be terse',
      temperature: 0.7,
      maxTokens: 128,
      stop: ['END'],
      signal,
    })
    expect(mock.requests).toHaveLength(1)
    expect(mock.requests[0]).toMatchObject({
      model: 'unsloth',
      temperature: 0.7,
      max_tokens: 128,
      stop: ['END'],
      messages: [
        { role: 'system', content: 'be terse' },
        { role: 'user', content: 'translate this' },
      ],
    })
    expect(mock.headers[0]!.authorization).toBe('Bearer sk-unsloth-testkey')
    expect(result).toEqual({
      text: 'hello from local',
      model: 'unsloth/gemma-local',
      usage: { promptTokens: 7, completionTokens: 4 },
    })
  })

  it('omits the Authorization header when no apiKey is provided', async () => {
    const mock = await mockServer([{ kind: 'json', body: textBody }])
    await chatCompletion(mock.url, { model: 'unsloth', prompt: 'hi', signal })
    expect(mock.headers[0]!.authorization).toBeUndefined()
  })

  it('omits optional wire fields so server defaults apply', async () => {
    const mock = await mockServer([{ kind: 'json', body: textBody }])
    await chatCompletion(mock.url, { model: 'unsloth', prompt: 'hi', signal })
    expect(mock.requests[0]).toMatchObject({
      messages: [{ role: 'user', content: 'hi' }],
    })
    expect((mock.requests[0] as Record<string, unknown>).temperature).toBeUndefined()
    expect((mock.requests[0] as Record<string, unknown>).max_tokens).toBeUndefined()
    expect((mock.requests[0] as Record<string, unknown>).stop).toBeUndefined()
  })

  it('carries reasoning_content through when the GGUF emits thinking', async () => {
    const mock = await mockServer([{ kind: 'json', body: thinkingBody }])
    const result = await chatCompletion(mock.url, { model: 'unsloth', prompt: 'think', signal })
    expect(result.reasoning).toBe('let me think')
    expect(result.text).toBe('final answer')
  })

  it('estimates usage when the server omits it', async () => {
    const mock = await mockServer([{
      kind: 'json',
      body: { model: 'x', choices: [{ index: 0, message: { content: '0123456789' } }] },
    }])
    const result = await chatCompletion(mock.url, { model: 'unsloth', prompt: 'p', signal })
    expect(result.usage.completionTokens).toBe(3)
    expect(result.usage.promptTokens).toBeGreaterThan(0)
  })

  it('maps HTTP errors to stable codes with provider detail', async () => {
    const mock = await mockServer([{
      kind: 'http-error',
      status: 500,
      body: JSON.stringify({ error: { message: 'boom', type: 'server_error' } }),
    }])
    await expect(chatCompletion(mock.url, { model: 'unsloth', prompt: 'x', signal }))
      .rejects.toMatchObject({ code: 'SERVER' })
  })

  it('maps 401 to AUTH with a config hint', async () => {
    const mock = await mockServer([{ kind: 'json', body: textBody }], { requireAuth: 'sk-unsloth-the-real-key' })
    await expect(chatCompletion(mock.url, {
      model: 'unsloth',
      apiKey: 'sk-unsloth-wrong',
      prompt: 'x',
      signal,
    })).rejects.toMatchObject({ code: 'AUTH' })
  })

  it('maps 400 context overflow', async () => {
    const mock = await mockServer([{
      kind: 'http-error',
      status: 400,
      body: JSON.stringify({ error: { message: 'Input exceeds the model context window' } }),
    }])
    await expect(chatCompletion(mock.url, { model: 'unsloth', prompt: 'x', signal }))
      .rejects.toMatchObject({ code: 'CONTEXT_WINDOW_EXCEEDED' })
  })

  it('throws TRANSPORT when the connection is refused', async () => {
    await expect(chatCompletion('http://127.0.0.1:1', { model: 'unsloth', prompt: 'x', signal }))
      .rejects.toMatchObject({ code: 'TRANSPORT' })
  })

  it('throws ABORTED on caller cancellation', async () => {
    const mock = await mockServer([{ kind: 'json', body: textBody, delayMs: 3000 }])
    const controller = new AbortController()
    const pending = chatCompletion(mock.url, { model: 'unsloth', prompt: 'x', signal: controller.signal })
    controller.abort()
    await expect(pending).rejects.toMatchObject({ code: 'ABORTED' })
  })

  it('throws TIMEOUT when the per-call budget expires', async () => {
    const mock = await mockServer([{ kind: 'json', body: textBody, delayMs: 3000 }])
    await expect(chatCompletion(mock.url, {
      model: 'unsloth',
      prompt: 'x',
      signal: AbortSignal.timeout(200),
    })).rejects.toMatchObject({ code: 'TIMEOUT' })
  })

  it('throws EMPTY_RESPONSE when the model produces no text', async () => {
    const mock = await mockServer([{
      kind: 'json',
      body: { model: 'x', choices: [{ index: 0, message: { content: '' } }] },
    }])
    await expect(chatCompletion(mock.url, { model: 'unsloth', prompt: 'x', signal }))
      .rejects.toMatchObject({ code: 'EMPTY_RESPONSE' })
  })

  it('sends images as an OpenAI-style multimodal content array', async () => {
    const mock = await mockServer([{ kind: 'json', body: textBody }])
    const result = await chatCompletion(mock.url, {
      model: 'unsloth',
      prompt: 'what is in this image?',
      images: ['data:image/png;base64,AAAA', 'data:image/jpeg;base64,BBBB'],
      signal,
    })
    expect(result.text).toBe('hello from local')
    expect(mock.requests[0]).toMatchObject({
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'what is in this image?' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
          { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,BBBB' } },
        ],
      }],
    })
  })

  it('keeps the plain string form when no images are attached', async () => {
    const mock = await mockServer([{ kind: 'json', body: textBody }])
    await chatCompletion(mock.url, { model: 'unsloth', prompt: 'plain', signal })
    expect(mock.requests[0]).toMatchObject({
      messages: [{ role: 'user', content: 'plain' }],
    })
  })

  it('surfaces vision-model failures through the same error mapping', async () => {
    const mock = await mockServer([{
      kind: 'http-error',
      status: 503,
      body: JSON.stringify({ error: { message: 'No Vision model loaded', type: 'service_unavailable' } }),
    }])
    await expect(chatCompletion(mock.url, {
      model: 'unsloth',
      prompt: 'describe',
      images: ['data:image/png;base64,AAAA'],
      signal,
    })).rejects.toMatchObject({ code: 'SERVER' })
  })
})
