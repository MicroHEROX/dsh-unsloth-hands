#!/usr/bin/env node
/**
 * Real-behavior driver: boots a REAL Cordis composition through the same app
 * boot path a deployment uses (`dsh-app-boot` -> Cordis Loader -> cordis.yml)
 * with THIS plugin pointed at the user's running Unsloth Desktop, then
 * exercises real tool calls and verifies the world externally.
 *
 * Scenarios:
 *   main       — good API key: unsloth_run replies REAL_OK (real model),
 *                unsloth_vision completes the wire path, fiber dispose
 *                unregisters the tools AND leaves the external Unsloth
 *                Desktop untouched (port still answers).
 *   auth       — wrong API key: the real server answers 401; the probe still
 *                counts the server as reachable, and the tool call itself
 *                must fail with an AUTH-style isError.
 *   notrunning — baseURL points at a closed port: the tool must fail with a
 *                clear SERVER_NOT_RUNNING-style message, and nothing is
 *                touched anywhere.
 *
 * Usage: node real-driver.mjs <main|auth|notrunning> <reportPath>
 *
 * Environment:
 *   UNSLOTH_BASE_URL  (default http://127.0.0.1:8888)
 *   UNSLOTH_API_KEY   (from Unsloth Settings → API; required for main)
 */

import { writeFile } from 'node:fs/promises'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { boot } from '@deepseek-ai/dsh-app-boot'
import { CallId } from '@deepseek-ai/dsh-llm'

const scenario = process.argv[2]
const reportPath = process.argv[3]
if (!['main', 'auth', 'notrunning'].includes(scenario ?? '') || reportPath === undefined) {
  throw new Error('usage: real-driver.mjs <main|auth|notrunning> <reportPath>')
}

const BASE_URL = scenario === 'notrunning'
  ? 'http://127.0.0.1:39999'
  : (process.env.UNSLOTH_BASE_URL ?? 'http://127.0.0.1:8888')
// The auth scenario deliberately uses a wrong key against the REAL server.
const API_KEY = scenario === 'auth'
  ? 'sk-unsloth-definitely-wrong-key'
  : process.env.UNSLOTH_API_KEY
// ESM specifiers on Windows must be file:// URLs or relative paths.
const pluginEntry = new URL('../src/index.ts', import.meta.url).href

const configPath = join(mkdtempSync(join(tmpdir(), 'dsh-real-')), 'cordis.yml')
writeFileSync(configPath, [
  '# generated real-behavior composition',
  '- id: system-prompt',
  "  name: '@deepseek-ai/dsh-system-prompt'",
  '',
  '- id: tools',
  "  name: '@deepseek-ai/dsh-tools'",
  '',
  '- id: unsloth-tool',
  `  name: ${JSON.stringify(pluginEntry)}`,
  '  config:',
  `    baseURL: ${JSON.stringify(BASE_URL)}`,
  ...API_KEY === undefined ? [] : [`    apiKey: ${JSON.stringify(API_KEY)}`],
  '    timeoutMs: 300000',
  '    maxTokens: 128',
  '',
].join('\n'))

const report = { scenario, baseURL: BASE_URL }

async function runTool(ctx, name, args) {
  const result = await ctx.tools.execute({
    signal: new AbortController().signal,
    callId: CallId(`${scenario}-${Date.now() % 100000}`),
    name,
    arguments: args,
  })
  return {
    isError: result.isError,
    value: result.value ?? undefined,
    content: result.content.filter(block => block.type === 'text').map(block => block.text).join(''),
  }
}

const portAnswers = async (url) => {
  try {
    const response = await fetch(`${url}/v1/models`, { signal: AbortSignal.timeout(1500) })
    return { answer: true, status: response.status }
  } catch {
    return { answer: false }
  }
}

const ctx = await boot('dsh-unsloth-real', configPath)
try {
  report.toolsRegistered = ctx.tools.schemas().map(schema => schema.name)
  report.run = await runTool(ctx, 'unsloth_run', {
    prompt: 'Reply with exactly: REAL_OK',
    max_tokens: 64,
  })

  if (scenario === 'main') {
    // Vision tool against a real 1x1 PNG. Qwen3.8-27B is text-only, so the
    // request must still complete the wire path and report usage; the model
    // simply cannot see the image (documented limitation).
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    )
    const imagePath = join(tmpdir(), `dsh-real-${scenario}-tiny.png`)
    writeFileSync(imagePath, png)
    report.vision = await runTool(ctx, 'unsloth_vision', {
      mode: 'ocr',
      image_paths: [imagePath],
      max_tokens: 64,
    })
    // External verification: the Unsloth server state before dispose.
    report.serverBeforeDispose = await portAnswers(BASE_URL)
  } else if (scenario === 'auth') {
    // The server answers (401 = reachable); the tool itself must fail AUTH.
    report.serverProbe = await portAnswers(BASE_URL)
  }

  await ctx.fiber.dispose()
  await new Promise(resolve => setTimeout(resolve, 2500))
  // The external Unsloth Desktop must NOT be stopped by the plugin.
  report.serverAfterDispose = await portAnswers(BASE_URL)
} finally {
  await ctx.fiber.dispose().catch(() => {})
}

await writeFile(reportPath, JSON.stringify(report, null, 2))
process.exit(0)
