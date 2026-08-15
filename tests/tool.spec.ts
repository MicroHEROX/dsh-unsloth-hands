import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as plugin from '../src/index.js'
import { closeMockServers, mockServer, textBody } from './mock-server.js'

const testToolSignal = new AbortController().signal
const contexts: Context[] = []

async function setup(over: Partial<plugin.Config> = {}): Promise<{
  ctx: Context
  mock: Awaited<ReturnType<typeof mockServer>>
  fiber: Awaited<ReturnType<Context['plugin']>>
}> {
  const mock = await mockServer([{ kind: 'json', body: textBody }], { requireAuth: 'sk-unsloth-testkey' })
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  const fiber = await ctx.plugin(plugin, {
    baseURL: mock.url,
    model: 'unsloth',
    apiKey: 'sk-unsloth-testkey',
    ...over,
  })
  return { ctx, mock, fiber }
}

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await closeMockServers()
})

function call(ctx: Context, args: unknown, counter: { n: number }) {
  return ctx.tools.execute({
    signal: testToolSignal,
    callId: CallId(`call-${++counter.n}`),
    name: 'unsloth_run',
    arguments: args,
  })
}

function callVision(ctx: Context, args: unknown, counter: { n: number }) {
  return ctx.tools.execute({
    signal: testToolSignal,
    callId: CallId(`call-v-${++counter.n}`),
    name: 'unsloth_vision',
    arguments: args,
  })
}

function textOf(content: { type: string; text?: string }[]): string {
  return content.filter(block => block.type === 'text').map(block => block.text).join('')
}

describe('dsh-unsloth tool plugin', () => {
  it('registers the unsloth_run tool with a prompt-centric schema', async () => {
    const { ctx } = await setup()
    const schema = ctx.tools.schemas().find(entry => entry.name === 'unsloth_run')
    expect(schema).toBeDefined()
    const props = (schema!.parameters as { properties?: Record<string, unknown> }).properties ?? {}
    expect(Object.keys(props).sort()).toEqual(['max_tokens', 'prompt', 'stop', 'system', 'temperature'])
    const prompt = props.prompt as { type: string; required?: boolean }
    expect(prompt.type).toBe('string')
    expect((schema!.parameters as { properties?: Record<string, unknown> }).properties
      && (props.prompt as { required?: boolean })).toBeDefined()
  })

  it('executes a local-model call and returns the canonical result', async () => {
    const { ctx, mock } = await setup()
    const result = await call(ctx, { prompt: 'translate: hello' }, { n: 0 })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected success')
    expect(result.value).toMatchObject({
      text: 'hello from local',
      model: 'unsloth/gemma-local',
      usage: { promptTokens: 7, completionTokens: 4 },
    })
    expect(typeof (result.value as { elapsedMs: number }).elapsedMs).toBe('number')
    // The request hit /v1/chat/completions authenticated with the API key.
    expect(mock.requests[0]).toMatchObject({
      messages: [{ role: 'user', content: 'translate: hello' }],
    })
    expect(mock.headers[0]!.authorization).toBe('Bearer sk-unsloth-testkey')
  })

  it('renders the model-facing text with a local-run footnote', async () => {
    const { ctx } = await setup()
    const result = await call(ctx, { prompt: 'hi' }, { n: 0 })
    if (result.isError) throw new Error('expected success')
    const text = textOf(result.content)
    expect(text).toContain('hello from local')
    expect(text).toContain('local')
    expect(text).toContain('tokens')
  })

  it('passes sampling knobs through to the wire request', async () => {
    const { ctx, mock } = await setup()
    const result = await call(ctx, {
      prompt: 'rewrite',
      system: 'formal tone',
      temperature: 0.9,
      max_tokens: 64,
      stop: ['STOP'],
    }, { n: 0 })
    expect(result.isError).toBe(false)
    expect(mock.requests[0]).toMatchObject({
      temperature: 0.9,
      max_tokens: 64,
      stop: ['STOP'],
      messages: [
        { role: 'system', content: 'formal tone' },
        { role: 'user', content: 'rewrite' },
      ],
    })
  })

  it('surfaces server failures as isError with a useful message', async () => {
    const failedMock = await mockServer([{
      kind: 'http-error',
      status: 500,
      body: JSON.stringify({ error: { message: 'vulkan oom' } }),
    }])
    // A second context pointed at the failing server keeps this test self-contained.
    const ctx2 = new Context()
    contexts.push(ctx2)
    await ctx2.plugin(SystemPrompt)
    await ctx2.plugin(ToolRuntime)
    await ctx2.plugin(plugin, { baseURL: failedMock.url })
    const result = await call(ctx2, { prompt: 'x' }, { n: 0 })
    expect(result.isError).toBe(true)
    const text = textOf(result.content)
    expect(text).toMatch(/vulkan oom|500|SERVER/)
  })

  it('gives a clear isError when Unsloth Desktop is not running', async () => {
    // Nothing listens on this port: the tool must fail with an actionable
    // SERVER_NOT_RUNNING-style message instead of a generic network error.
    const { ctx } = await setup({ baseURL: 'http://127.0.0.1:1' })
    const result = await call(ctx, { prompt: 'x' }, { n: 0 })
    expect(result.isError).toBe(true)
    const text = textOf(result.content)
    expect(text).toMatch(/not running|Unsloth Desktop|127.0.0.1/)
  })

  it('surfaces a wrong API key as isError with an AUTH code and hint', async () => {
    // The mock requires sk-unsloth-testkey; the plugin is configured with a
    // different one, so every call is rejected with 401.
    const { ctx } = await setup({ apiKey: 'sk-unsloth-wrong-key' })
    const result = await call(ctx, { prompt: 'x' }, { n: 0 })
    expect(result.isError).toBe(true)
    const text = textOf(result.content)
    expect(text).toMatch(/AUTH|401|API key/)
  })

  it('respects caller cancellation (aborted call becomes isError)', async () => {
    const { ctx } = await setup()
    const controller = new AbortController()
    const pending = ctx.tools.execute({
      signal: controller.signal,
      callId: CallId('call-abort'),
      name: 'unsloth_run',
      arguments: { prompt: 'slow work' },
    })
    controller.abort()
    const result = await pending
    expect(result.isError).toBe(true)
  })

  it('uses a custom tool name when configured', async () => {
    const { ctx } = await setup({ toolName: 'run_local' })
    const schema = ctx.tools.schemas().find(entry => entry.name === 'run_local')
    expect(schema).toBeDefined()
    expect(ctx.tools.schemas().find(entry => entry.name === 'unsloth_run')).toBeUndefined()
  })

  it('registers the vision tool with mode templates and image inputs', async () => {
    const { ctx } = await setup()
    const schema = ctx.tools.schemas().find(entry => entry.name === 'unsloth_vision')
    expect(schema).toBeDefined()
    const props = (schema!.parameters as { properties?: Record<string, unknown> }).properties ?? {}
    expect(Object.keys(props).sort()).toEqual([
      'image_paths', 'image_urls', 'max_tokens', 'mode', 'prompt', 'stop', 'temperature',
    ])
    expect((props.mode as { enum?: string[] }).enum).toEqual(['analyze', 'ocr', 'compare'])
  })

  it('skips the vision tool when disabled', async () => {
    const { ctx } = await setup({ enableVisionTool: false })
    expect(ctx.tools.schemas().find(entry => entry.name === 'unsloth_vision')).toBeUndefined()
    expect(ctx.tools.schemas().find(entry => entry.name === 'unsloth_run')).toBeDefined()
  })

  it('runs the vision tool against a local image file with the mode template', async () => {
    const { ctx, mock } = await setup()
    // 1x1 transparent PNG.
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    )
    const dir = mkdtempSync(join(tmpdir(), 'dsh-vision-'))
    try {
      const path = join(dir, 'tiny.png')
      writeFileSync(path, png)
      const result = await callVision(ctx, { mode: 'ocr', image_paths: [path] }, { n: 0 })
      expect(result.isError).toBe(false)
      if (result.isError) throw new Error('expected vision success')
      expect(result.value).toMatchObject({
        text: 'hello from local',
        images: 1,
        model: 'unsloth/gemma-local',
      })
      // The wire request carries the OCR template plus a data:image/png URL.
      const request = mock.requests[0] as {
        messages: Array<{ role: string; content: unknown }>
      }
      const user = request.messages.find(message => message.role === 'user')
      const content = (user?.content ?? []) as Array<{ type: string; text?: string; image_url?: { url: string } }>
      expect(content[0]).toMatchObject({ type: 'text' })
      expect(content[0]!.text).toContain('Extract ALL text from the image verbatim')
      expect(content[1]).toMatchObject({ type: 'image_url' })
      expect(content[1]!.image_url?.url).toContain('data:image/png;base64,')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('rejects a vision call without any images', async () => {
    const { ctx } = await setup()
    const result = await callVision(ctx, { mode: 'analyze' }, { n: 0 })
    expect(result.isError).toBe(true)
  })

  it('rejects a vision call with an unsupported image format', async () => {
    const { ctx } = await setup()
    const dir = mkdtempSync(join(tmpdir(), 'dsh-vision-'))
    try {
      const path = join(dir, 'doc.pdf')
      writeFileSync(path, '%PDF-1.4 fake')
      const result = await callVision(ctx, { image_paths: [path] }, { n: 0 })
      expect(result.isError).toBe(true)
      const text = result.content
        .filter(block => block.type === 'text')
        .map(block => block.text)
        .join('')
      expect(text).toMatch(/unsupported image format/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('unregisters every tool when the plugin fiber disposes', async () => {
    const { ctx, fiber } = await setup()
    expect(ctx.tools.schemas().some(schema => schema.name === 'unsloth_run')).toBe(true)
    expect(ctx.tools.schemas().some(schema => schema.name === 'unsloth_vision')).toBe(true)
    // Dispose only the plugin fiber: the tools service stays mounted, so the
    // registry itself proves the tools are gone (no residue in the harness).
    await fiber.dispose()
    expect(ctx.tools.schemas().some(schema => schema.name === 'unsloth_run')).toBe(false)
    expect(ctx.tools.schemas().some(schema => schema.name === 'unsloth_vision')).toBe(false)
    // Disposing twice is a no-op (cordis effect disposers are idempotent).
    await fiber.dispose()
    expect(ctx.tools.schemas().some(schema => schema.name === 'unsloth_run')).toBe(false)
  })

  it('a failed plugin load is loud but leaves the harness intact', async () => {
    // Invalid baseURL fails at resolve time (fail loud)…
    const bad = new Context()
    contexts.push(bad)
    await bad.plugin(SystemPrompt)
    await bad.plugin(ToolRuntime)
    await expect(bad.plugin(plugin, { baseURL: 'not a url' })).rejects.toThrow()
    // …and the tool registry keeps working for whatever else is mounted.
    const good = new Context()
    contexts.push(good)
    await good.plugin(SystemPrompt)
    await good.plugin(ToolRuntime)
    await good.plugin(plugin, { baseURL: 'http://127.0.0.1:1' })
    expect(good.tools.schemas().some(schema => schema.name === 'unsloth_run')).toBe(true)
  })
})
