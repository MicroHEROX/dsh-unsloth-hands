#!/usr/bin/env node
/**
 * Loader-smoke driver: boot the fixture `cordis.yml` through the real app
 * boot path, stand in a fake Unsloth server (the only external service,
 * enforcing the configured API key), drive one `unsloth_run` tool call
 * through the real ToolRuntime, and persist the observed model-visible
 * surface to `./loader-report.json`.
 */

import { createServer } from 'node:http'
import { writeFile } from 'node:fs/promises'
import { boot, resolveConfigPath } from '@deepseek-ai/dsh-app-boot'
import { CallId } from '@deepseek-ai/dsh-llm'

const configPath = process.argv[2]
if (configPath === undefined) throw new Error('loader driver requires a config path')

const FAKE_PORT = 39410
const FAKE_KEY = 'sk-unsloth-loader-key'

const server = createServer((req, res) => {
  const authorized = req.headers.authorization === `Bearer ${FAKE_KEY}`
  if (!authorized) {
    res.writeHead(401, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { message: 'unauthorized' } }))
    return
  }
  if (req.url === '/v1/models') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ object: 'list', data: [{ id: 'gemma-local' }] }))
    return
  }
  if (req.url.endsWith('/chat/completions')) {
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        model: 'unsloth/gemma-local',
        choices: [{ index: 0, message: { role: 'assistant', content: 'loader-ok from unsloth' } }],
        usage: { prompt_tokens: 9, completion_tokens: 3 },
      }))
    })
    return
  }
  res.writeHead(404).end('nope')
})
await new Promise(resolve => server.listen(FAKE_PORT, '127.0.0.1', resolve))

const ctx = await boot('dsh-unsloth-loader-smoke', resolveConfigPath(configPath, undefined))
try {
  // The composition pins port 39410, which is exactly where the fake server
  // above listens — the tool surface runs against its real registered schema
  // and execution pipeline, with only the external Unsloth mocked. The fake
  // enforces the API key, so success proves the key flow works end-to-end.
  const schema = ctx.tools.schemas().find(tool => tool.name === 'unsloth_run')
  if (schema === undefined) throw new Error('unsloth_run tool not registered by the composition')
  const visionSchema = ctx.tools.schemas().find(tool => tool.name === 'unsloth_vision')
  if (visionSchema === undefined) throw new Error('unsloth_vision tool not registered by the composition')

  const result = await ctx.tools.execute({
    signal: new AbortController().signal,
    callId: CallId('loader-1'),
    name: 'unsloth_run',
    arguments: { prompt: 'say loader-ok', max_tokens: 50 },
  })
  const text = result.content.filter(block => block.type === 'text').map(block => block.text).join('')
  await writeFile('./loader-report.json', JSON.stringify({
    schemaParams: Object.keys(schema.parameters.properties ?? {}),
    visionParams: Object.keys(visionSchema.parameters.properties ?? {}),
    isError: result.isError,
    text,
    value: result.value,
  }))
} finally {
  await ctx.fiber.dispose()
  await new Promise(resolve => server.close(resolve))
}
