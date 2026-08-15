/**
 * dsh-unsloth-hands — a tool plugin for DeepSeek Harness that hands the ONLINE
 * model a `unsloth_run` tool backed by a LOCAL Unsloth Desktop (Unsloth
 * Studio / llama-server) endpoint.
 *
 * The main conversation model stays wherever the deployment puts it; when it
 * wants cheap, repetitive, token-wasting labor done (batch rewrites, name
 * translations, string munging, short summarization), it calls
 * `unsloth_run` and the local model does the work.
 *
 * The plugin is a PURE CLIENT: it connects to the Unsloth Desktop the user is
 * already running. Model selection, downloading, quantization and context
 * settings all happen in the Unsloth app itself; this plugin never starts,
 * owns, or stops any process, and never kills an external server.
 *
 * @module dsh-unsloth
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import { launchEnvironmentOf, type LaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
import { chatCompletion, portOf, probeServer } from './unsloth.ts'
import { collectSessionImageDataUrls, imageFileToDataUrl, imageUrlToDataUrl } from './images.ts'
import { resolveVisionPrompt, VISION_FIDELITY_RULE } from './prompts.ts'

export { chatCompletion, httpErrorCode, portOf, probeServer } from './unsloth.ts'
export type { ChatCompletion, ChatCompletionRequest, UnslothErrorCode } from './unsloth.ts'
export { collectSessionImageDataUrls, imageFileToDataUrl, imageUrlToDataUrl, mimeOf } from './images.ts'
export { ANALYZE_PROMPT, COMPARE_PROMPT, OCR_PROMPT, resolveVisionPrompt, VISION_FIDELITY_RULE } from './prompts.ts'
export type { VisionMode } from './prompts.ts'

export const name = 'unsloth-tool'
export const inject = ['tools']

const NS = settingsNamespace('llm-unsloth')
/** Default endpoint of a local Unsloth Desktop / Studio server. */
const DEFAULT_BASE_URL = 'http://127.0.0.1:8888'
/** Default wire model id (Unsloth serves the one model currently loaded). */
const DEFAULT_MODEL = 'unsloth'
/** Default tool name the online model calls. */
const DEFAULT_TOOL_NAME = 'unsloth_run'
/** Default vision tool name. */
const DEFAULT_VISION_TOOL_NAME = 'unsloth_vision'
/** Default per-call budget for one local-model invocation. */
const DEFAULT_TIMEOUT_MS = 120_000
/** Default per-request output cap. */
const DEFAULT_MAX_TOKENS = 8_192
/** Environment variable carrying a pre-created Unsloth API key, honored from trusted layers. */
const API_KEY_ENV = 'UNSLOTH_API_KEY'

const DEFAULT_DESCRIPTION =
  'Run one prompt on the LOCAL Unsloth model — a small offline GGUF model '
  + 'loaded in Unsloth Desktop on this machine. Use it for simple, repetitive, '
  + 'token-cheap labor instead of spending main-model tokens: batch rewrites, '
  + 'name translations, string munging, deduplication, short-text '
  + 'summarization, structured extraction, and other mechanical text work. '
  + 'The prompt is sent to the local model as a user message (the server '
  + 'applies its own chat template); returned is the raw output text plus '
  + 'token usage.'

const DEFAULT_VISION_DESCRIPTION =
  'Send one or more images to the LOCAL Unsloth vision model (a multimodal '
  + 'GGUF loaded in Unsloth Desktop on this machine) for image understanding: '
  + 'OCR / text extraction, describing or analyzing images, reading charts '
  + 'and screenshots. Use it to offload vision work from the main model, '
  + 'especially for repetitive batches. Images come from local file paths '
  + '(image_paths), data/http image URLs (image_urls), or — when both are '
  + 'omitted — the most recent image(s) attached to the current conversation. '
  + 'Requires the model currently loaded in Unsloth to be a multimodal one.\n\n'
  + 'Pick a mode for structured output, or pass your own prompt for a specific '
  + 'question (never both):\n'
  + '- `analyze` (default) — the local model produces an "# Image Analysis '
  + 'Report" with 8 fixed sections: Summary / Image Metadata / Layout & '
  + 'Composition / Visible Text (VERBATIM) / Objects & Elements / People & '
  + 'Actions / Semantic Context & Inferences / Uncertainties & Gaps.\n'
  + '- `ocr` — character-exact text extraction in reading order (the model does '
  + 'NOT "fix" typos or drop symbols; unresolvable glyphs are noted).\n'
  + '- `compare` — with 2–4 images, one "# Image Comparison Report": Per-Image '
  + 'Summaries / Common Elements / Key Differences / Text Differences (VERBATIM) '
  + '/ Overall Conclusion.\n'
  + 'For independent per-image analysis use one call per image; use `compare` '
  + 'only when the task needs joint reasoning across images.\n'
  + 'The local model may also return reasoning text (thinking) before its '
  + 'answer; it is reported separately as `reasoning`.\n'
  + VISION_FIDELITY_RULE

/** Plugin configuration (also the `llm-unsloth` settings-section shape). */
export interface Config {
  /** Endpoint the running Unsloth Desktop answers on; default `http://127.0.0.1:8888`. */
  baseURL?: string
  /** Wire model id sent to the server; default `unsloth`. */
  model?: string
  /**
   * Unsloth API key (`sk-unsloth-…`), created in Unsloth Settings → API
   * (or `$UNSLOTH_API_KEY`).
   */
  apiKey?: string
  /** Model-facing tool name; default `unsloth_run`. */
  toolName?: string
  /** Override the model-facing tool description. */
  toolDescription?: string
  /** Register the vision tool; default true. */
  enableVisionTool?: boolean
  /** Vision tool name; default `unsloth_vision`. */
  visionToolName?: string
  /** Override the vision tool description. */
  visionToolDescription?: string
  /** Per-call budget for one local-model invocation; default 120000 ms. */
  timeoutMs?: number
  /** Default output cap for local-model calls; default 8192 tokens. */
  maxTokens?: number
}

export const Config: z<Config> = z.object({
  baseURL: z.string().default(DEFAULT_BASE_URL),
  model: z.string().default(DEFAULT_MODEL),
  apiKey: z.string(),
  toolName: z.string().default(DEFAULT_TOOL_NAME),
  toolDescription: z.string(),
  enableVisionTool: z.boolean().default(true),
  visionToolName: z.string().default(DEFAULT_VISION_TOOL_NAME),
  visionToolDescription: z.string(),
  timeoutMs: z.number().min(1).default(DEFAULT_TIMEOUT_MS),
  maxTokens: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(DEFAULT_MAX_TOKENS),
})

/** Validated connection and call facts for one operation. */
export interface ResolvedOptions {
  baseURL: string
  model: string
  apiKey?: string
  toolName: string
  toolDescription: string
  enableVisionTool: boolean
  visionToolName: string
  visionToolDescription: string
  timeoutMs: number
  maxTokens: number
}

/**
 * The one explicit resolve step from raw config to validated facts.
 * @param config - raw plugin config or resolved settings snapshot.
 * @param environment - this run's environment layers, or `undefined` outside
 * the product CLI.
 * @returns validated connection facts.
 */
export function resolveOptions(config: Config, environment?: LaunchEnvironmentSnapshot): ResolvedOptions {
  const baseURL = config.baseURL ?? DEFAULT_BASE_URL
  let parsed: URL
  try {
    parsed = new URL(baseURL)
  } catch {
    throw new Error(`llm-unsloth: baseURL "${baseURL}" is not a valid URL`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`llm-unsloth: baseURL "${baseURL}" must be http(s)`)
  }
  const port = portOf(baseURL)
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`llm-unsloth: baseURL "${baseURL}" has an invalid port`)
  }
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error('llm-unsloth: timeoutMs must be a positive finite number')
  }
  const maxTokens = config.maxTokens ?? DEFAULT_MAX_TOKENS
  if (!Number.isSafeInteger(maxTokens) || maxTokens <= 0) {
    throw new Error('llm-unsloth: maxTokens must be a positive safe integer')
  }
  const toolName = config.toolName ?? DEFAULT_TOOL_NAME
  if (toolName.length === 0 || !/^[a-z][a-z0-9_]*$/.test(toolName)) {
    throw new Error(`llm-unsloth: toolName "${toolName}" must match ^[a-z][a-z0-9_]*$`)
  }
  const toolDescription = config.toolDescription ?? DEFAULT_DESCRIPTION
  if (toolDescription.length === 0) {
    throw new Error('llm-unsloth: toolDescription must not be empty')
  }
  const visionToolName = config.visionToolName ?? DEFAULT_VISION_TOOL_NAME
  if (visionToolName.length === 0 || !/^[a-z][a-z0-9_]*$/.test(visionToolName)) {
    throw new Error(`llm-unsloth: visionToolName "${visionToolName}" must match ^[a-z][a-z0-9_]*$`)
  }
  if (visionToolName === toolName) {
    throw new Error('llm-unsloth: visionToolName must differ from toolName')
  }
  const visionToolDescription = config.visionToolDescription ?? DEFAULT_VISION_DESCRIPTION
  if (visionToolDescription.length === 0) {
    throw new Error('llm-unsloth: visionToolDescription must not be empty')
  }
  const apiKey = config.apiKey ?? environment?.get(API_KEY_ENV)?.value
  if (apiKey !== undefined && apiKey.length === 0) {
    throw new Error('llm-unsloth: apiKey must not be empty when provided')
  }
  return {
    baseURL,
    model: config.model ?? DEFAULT_MODEL,
    ...apiKey === undefined ? {} : { apiKey },
    toolName,
    toolDescription,
    enableVisionTool: config.enableVisionTool ?? true,
    visionToolName,
    visionToolDescription,
    timeoutMs,
    maxTokens,
  }
}

export function apply(ctx: Context, config: Config): void {
  let current: () => Config = () => config
  let lastRaw: Config | undefined
  let lastGood: ResolvedOptions | undefined
  const options = (): ResolvedOptions => {
    const raw = current()
    if (raw === lastRaw && lastGood !== undefined) return lastGood
    try {
      const next = resolveOptions(raw, launchEnvironmentOf(ctx))
      lastRaw = raw
      lastGood = next
      return next
    } catch (error) {
      // Static composition resolves before anything registers, so this branch
      // only sees a live settings snapshot failing a beyond-schema bound:
      // keep serving the last good facts and say so once per bad snapshot.
      if (lastGood === undefined) throw error
      lastRaw = raw
      ctx.logger.error('llm-unsloth: keeping the last good configuration after an invalid settings section')
      ctx.logger.error(error)
      return lastGood
    }
  }
  options()

  let unregister: (() => void) | undefined
  const register = (): void => {
    unregister?.()
    const resolved = options()
    const disposers: Array<() => void> = []

    disposers.push(ctx.tools.register(defineTool({
      name: resolved.toolName,
      description: resolved.toolDescription,
      timeoutMs: resolved.timeoutMs,
      parameters: {
        prompt: {
          type: 'string',
          required: true,
          description: 'The instruction or text to send to the local Unsloth model (a user-role message).',
        },
        system: {
          type: 'string',
          description: 'Optional system instruction prepended to the prompt.',
        },
        temperature: {
          type: 'number',
          description: 'Sampling temperature (0–2). Higher values produce more varied output.',
        },
        max_tokens: {
          type: 'integer',
          description: 'Maximum number of tokens the local model may generate; defaults to the deployment-configured cap.',
        },
        stop: {
          type: 'array',
          items: { type: 'string' },
          description: 'Stop sequences; generation halts at the first occurrence.',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            text: { type: 'string', required: true, description: 'The local model\'s raw text output.' },
            reasoning: { type: 'string', description: 'Thinking text when the local model emits it.' },
            model: { type: 'string', required: true, description: 'The model id the server reported.' },
            usage: {
              type: 'object',
              additionalProperties: false,
              required: true,
              properties: {
                promptTokens: { type: 'integer', required: true },
                completionTokens: { type: 'integer', required: true },
              },
            },
            elapsedMs: { type: 'integer', required: true },
          },
        },
        render: (_args, value) => [{
          type: 'text',
          text: `${value.text}`
            + `\n\n(ran on local ${value.model} · ${value.usage.promptTokens} in / ${value.usage.completionTokens} out tokens · ${value.elapsedMs}ms)`,
        }],
      },
      async execute(args, exec) {
        const started = Date.now()
        const resolved = options()
        const deadline = AbortSignal.any([exec.signal, AbortSignal.timeout(resolved.timeoutMs)])
        await probeServer(resolved.baseURL, resolved.apiKey)
        const key = resolved.apiKey
        const completion = await chatCompletion(resolved.baseURL, {
          model: resolved.model,
          ...key === undefined ? {} : { apiKey: key },
          ...args.system === undefined ? {} : { system: args.system },
          prompt: args.prompt,
          ...args.temperature === undefined ? {} : { temperature: args.temperature },
          maxTokens: args.max_tokens ?? resolved.maxTokens,
          ...args.stop === undefined ? {} : { stop: args.stop },
          signal: deadline,
        })
        return {
          text: completion.text,
          ...completion.reasoning === undefined ? {} : { reasoning: completion.reasoning },
          model: completion.model,
          usage: {
            promptTokens: completion.usage.promptTokens,
            completionTokens: completion.usage.completionTokens,
          },
          elapsedMs: Date.now() - started,
        }
      },
      presentCall: args => ({
        card: 'generic',
        title: `Run local model${args.system ? ' (with system)' : ''}`,
        kind: 'other',
        rawInput: args.prompt,
      }),
    })));

    if (resolved.enableVisionTool) {
      disposers.push(ctx.tools.register(defineTool({
        name: resolved.visionToolName,
        description: resolved.visionToolDescription,
        timeoutMs: resolved.timeoutMs,
        parameters: {
          mode: {
            type: 'string',
            enum: ['analyze', 'ocr', 'compare'],
            description: 'Built-in prompt template: analyze (structured 8-section report), '
              + 'ocr (verbatim text extraction), compare (multi-image 5-section report). '
              + 'Ignored when a custom prompt is given.',
          },
          prompt: {
            type: 'string',
            description: 'Custom instruction for the local vision model; omit it to use the mode template.',
          },
          image_paths: {
            type: 'array',
            items: { type: 'string' },
            description: 'Absolute paths of local image files (png/jpg/jpeg/webp/gif/bmp).',
          },
          image_urls: {
            type: 'array',
            items: { type: 'string' },
            description: 'Image URLs: data:image/... or http(s):// URLs.',
          },
          temperature: {
            type: 'number',
            description: 'Sampling temperature (0–2). Lower values are more deterministic — use ~0.2 for OCR.',
          },
          max_tokens: {
            type: 'integer',
            description: 'Maximum number of tokens the local model may generate; defaults to the deployment-configured cap.',
          },
          stop: {
            type: 'array',
            items: { type: 'string' },
            description: 'Stop sequences; generation halts at the first occurrence.',
          },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              text: { type: 'string', required: true, description: 'The local vision model\'s raw output (report or extracted text).' },
              reasoning: { type: 'string', description: 'Thinking text when the local model emits it.' },
              model: { type: 'string', required: true, description: 'The model id the server reported.' },
              images: { type: 'integer', required: true, description: 'How many images were analyzed.' },
              usage: {
                type: 'object',
                additionalProperties: false,
                required: true,
                properties: {
                  promptTokens: { type: 'integer', required: true },
                  completionTokens: { type: 'integer', required: true },
                },
              },
              elapsedMs: { type: 'integer', required: true },
            },
          },
          render: (_args, value) => [{
            type: 'text',
            text: `${value.text}`
              + `\n\n(ran on local ${value.model} · ${value.images} image${value.images === 1 ? '' : 's'} · `
              + `${value.usage.promptTokens} in / ${value.usage.completionTokens} out tokens · ${value.elapsedMs}ms)`,
          }],
        },
        async execute(args, exec) {
          const started = Date.now()
          const current = options()
          const deadline = AbortSignal.any([exec.signal, AbortSignal.timeout(current.timeoutMs)])
          await probeServer(current.baseURL, current.apiKey)
          const images: string[] = []
          for (const path of args.image_paths ?? []) {
            images.push(await imageFileToDataUrl(path, deadline))
          }
          for (const url of args.image_urls ?? []) {
            images.push(await imageUrlToDataUrl(url, deadline))
          }
          if (images.length === 0) {
            // No explicit images: fall back to the conversation's attachments.
            images.push(...await collectSessionImageDataUrls(ctx, exec))
          }
          if (images.length === 0) {
            throw new Error(
              'no images to analyze: provide image_paths or image_urls, or attach an image to the conversation first',
            )
          }
          const prompt = resolveVisionPrompt(args.mode ?? 'analyze', args.prompt)
          const key = current.apiKey
          const completion = await chatCompletion(current.baseURL, {
            model: current.model,
            ...key === undefined ? {} : { apiKey: key },
            prompt,
            images,
            ...args.temperature === undefined ? {} : { temperature: args.temperature },
            maxTokens: args.max_tokens ?? current.maxTokens,
            ...args.stop === undefined ? {} : { stop: args.stop },
            signal: deadline,
          })
          return {
            text: completion.text,
            ...completion.reasoning === undefined ? {} : { reasoning: completion.reasoning },
            model: completion.model,
            images: images.length,
            usage: {
              promptTokens: completion.usage.promptTokens,
              completionTokens: completion.usage.completionTokens,
            },
            elapsedMs: Date.now() - started,
          }
        },
        presentCall: args => ({
          card: 'generic',
          title: `Vision (${args.mode ?? 'analyze'}): ${args.image_paths?.length ?? 0} path(s), ${args.image_urls?.length ?? 0} url(s)`,
          kind: 'read',
          rawInput: args.prompt,
        }),
      })));
    }

    unregister = () => {
      for (const disposer of disposers) disposer()
    }
  }

  // Initial registration: runs even when no settings service is mounted (the
  // settings attach path below calls register() again only when it activates).
  register()

  installSettingsSection(ctx, NS, Config, config, {
    setSource: (source) => {
      current = source
    },
    onChange: () => {
      // The tool's description/timeout/endpoint derive from resolved options;
      // a settings change re-registers so the next model request sees it.
      register()
    },
  })
}
