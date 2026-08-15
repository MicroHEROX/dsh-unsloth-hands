import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { LOADER_SMOKE_TEST_TIMEOUT_MS, runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'

/**
 * REAL-composition tier: boot the fixture `cordis.yml` through the same app
 * boot path a deployment uses (app bin -> Cordis Loader), execute a real
 * `unsloth_run` tool call through the real tool registry, and assert the
 * assembled model-visible surface. Only the external Unsloth is mocked.
 */

const driver = fileURLToPath(new URL('fixtures/loader/driver.mjs', import.meta.url))
const configPath = fileURLToPath(new URL('fixtures/loader/cordis.yml', import.meta.url))
const repoTsconfig = fileURLToPath(new URL('../tsconfig.json', import.meta.url))

interface LoaderReport {
  schemaParams: string[]
  visionParams: string[]
  isError: boolean
  text: string
  value: unknown
}

describe('dsh-unsloth through a real Loader composition', () => {
  it('registers unsloth_run and serves a local-model call', async () => {
    let report: LoaderReport | undefined
    const { stderr } = await runLoaderSmoke({
      label: 'dsh-unsloth loader smoke',
      tempDirPrefix: 'dsh-unsloth-loader-',
      binScript: driver,
      libBinScript: driver,
      configPath,
      tsconfigPath: repoTsconfig,
      mode: 'lib',
      inspect: async (cwd) => {
        report = JSON.parse(await readFile(join(cwd, 'loader-report.json'), 'utf8')) as LoaderReport
      },
    })
    expect(stderr).not.toContain('UNHANDLED')
    expect(report).toBeDefined()
    expect(report?.schemaParams).toEqual(expect.arrayContaining(['prompt', 'system', 'temperature', 'max_tokens', 'stop']))
    expect(report?.visionParams).toEqual(expect.arrayContaining(['mode', 'prompt', 'image_paths', 'image_urls']))
    expect(report?.isError).toBe(false)
    expect(report?.text).toContain('loader-ok from unsloth')
    expect(report?.value).toMatchObject({
      text: 'loader-ok from unsloth',
      model: 'unsloth/gemma-local',
      usage: { promptTokens: 9, completionTokens: 3 },
    })
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)
})
