import { afterAll, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as plugin from '../src/index.js'
import { closeMockServers, mockServer, textBody } from './mock-server.js'

/**
 * Real wiring test: a Cordis Context with the harness ToolRuntime + SystemPrompt
 * services and THIS plugin mounted, pointed at an EXTERNAL Unsloth server (a
 * mock standing in for the user's running Unsloth Desktop). The plugin is a
 * pure client: it never spawns anything, and disposing it must leave the
 * external server completely untouched.
 */

const contexts: Context[] = []

afterAll(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await closeMockServers()
})

async function setup(): Promise<{
  ctx: Context
  mock: Awaited<ReturnType<typeof mockServer>>
  fiber: Awaited<ReturnType<Context['plugin']>>
}> {
  const mock = await mockServer([{ kind: 'json', body: textBody }], { requireAuth: 'sk-unsloth-external-key' })
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  const fiber = await ctx.plugin(plugin, {
    baseURL: mock.url,
    model: 'unsloth',
    apiKey: 'sk-unsloth-external-key',
  })
  return { ctx, mock, fiber }
}

describe('dsh-unsloth harness integration (pure client → external Unsloth)', () => {
  it('registers the unsloth_run tool on the real ToolRuntime', async () => {
    const { ctx } = await setup()
    const schema = ctx.tools.schemas().find(entry => entry.name === 'unsloth_run')
    expect(schema).toBeDefined()
    expect(schema?.description).toContain('LOCAL Unsloth')
  })

  it('executes the tool end-to-end against the external server with the configured key', async () => {
    const { ctx } = await setup()
    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('call-ext-1'),
      name: 'unsloth_run',
      arguments: { prompt: 'say pong', max_tokens: 50 },
    })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected success')
    const value = result.value as { text: string; usage: { promptTokens: number; completionTokens: number } }
    // The fake server answers 401 unless the request carries the configured
    // key — success proves the plugin authenticates every call.
    expect(value.text).toBe('hello from local')
    expect(value.usage).toEqual({ promptTokens: 7, completionTokens: 4 })
  }, 20_000)

  it('leaves the external server running when the fiber disposes', async () => {
    const { ctx, mock, fiber } = await setup()
    await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('call-ext-2'),
      name: 'unsloth_run',
      arguments: { prompt: 'ping' },
    })
    await fiber.dispose()
    // The plugin must never stop a server it did not start: the mock keeps
    // answering /v1/models after the plugin is gone.
    const response = await fetch(`${mock.url}/v1/models`, {
      signal: AbortSignal.timeout(1_000),
    })
    expect(response.ok).toBe(true)
  }, 20_000)
})
