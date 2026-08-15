/**
 * Unsloth chat-completions client for the tool plugin: one non-streaming
 * `POST {baseURL}/v1/chat/completions` call per invocation (tools get the full
 * answer at once — no SSE machinery needed), authenticated with the Unsloth
 * API key (`Authorization: Bearer sk-unsloth-…`), with harness-class error
 * mapping so the online model sees a clean, actionable failure message.
 *
 * This plugin is a pure client: it only CONNECTS to a Unsloth Desktop the
 * user is running (model selection/loading happens in the app), and never
 * starts, owns, or stops any process.
 *
 * @module dsh-unsloth/unsloth
 */

import { CONTEXT_WINDOW_EXCEEDED_CODE, isContextWindowExceededError, isQuotaExceededError, LlmError } from '@deepseek-ai/dsh-llm'

/** Stable codes surfaced in tool failure messages. */
export type UnslothErrorCode =
  | 'SERVER_NOT_RUNNING'
  | 'TIMEOUT'
  | 'ABORTED'
  | 'TRANSPORT'
  | 'AUTH'
  | 'QUOTA'
  | 'RATE_LIMIT'
  | 'CONTEXT_WINDOW_EXCEEDED'
  | 'INVALID_REQUEST'
  | 'SERVER'
  | 'EMPTY_RESPONSE'
  | `HTTP_${number}`

/** The Unsloth Desktop default port. */
const DEFAULT_PORT = 8888

/** Parse the port from a base URL; fall back to the Unsloth default. */
export function portOf(baseURL: string): number {
  try {
    const port = new URL(baseURL).port
    return port === '' ? DEFAULT_PORT : Number(port)
  } catch {
    return DEFAULT_PORT
  }
}

/** One non-streaming chat-completions request. */
export interface ChatCompletionRequest {
  model: string
  /**
   * Unsloth API key (`sk-unsloth-…`). Every request must authenticate with
   * `Authorization: Bearer <key>`; when absent the server answers 401.
   */
  apiKey?: string
  /** Optional system instructions (the server applies its chat template). */
  system?: string
  /** The user-role prompt sent to the local model. */
  prompt: string
  /**
   * Images attached to the user turn, as `data:image/...;base64,...` URLs
   * (multimodal models only — the model loaded in Unsloth must support
   * vision). When present, the prompt and images become one OpenAI-style
   * content array.
   */
  images?: string[]
  temperature?: number
  maxTokens?: number
  stop?: string[]
  signal: AbortSignal
}

/** The completed local-model answer. */
export interface ChatCompletion {
  /** The model's visible text output. */
  text: string
  /** Thinking content when the GGUF emits it (Qwen3, DeepSeek-R1 etc.). */
  reasoning?: string
  /** The server's reported model id. */
  model: string
  /** Token accounting; estimated from character counts when the server omits it. */
  usage: { promptTokens: number; completionTokens: number }
}

/** Non-2xx error body. */
interface WireError {
  error?: { message?: string; type?: string; code?: string }
}

interface WireMessage {
  role: 'system' | 'user'
  content: string | WireContentPart[]
}

/** One OpenAI-style content part of a multimodal user message. */
export interface WireContentPart {
  type: 'text' | 'image_url'
  text?: string
  image_url?: { url: string }
}

interface WireResponse {
  model?: string
  choices?: Array<{
    message?: {
      content?: string | null
      reasoning_content?: string | null
    }
  }>
  usage?: { prompt_tokens?: number; completion_tokens?: number }
}

/**
 * Map an HTTP status to a stable failure code.
 * @param status - status of a non-2xx provider response.
 * @param error - parsed provider error body, when available.
 * @returns the normalized failure code.
 */
export function httpErrorCode(status: number, error?: WireError['error']): UnslothErrorCode {
  if (status === 401 || status === 403) return 'AUTH'
  const detail = [error?.code, error?.type, error?.message].filter(Boolean).join(' ')
  if (isQuotaExceededError(detail)) return 'QUOTA'
  if (status === 429) return 'RATE_LIMIT'
  if (status === 400) {
    if (isContextWindowExceededError(detail)) return 'CONTEXT_WINDOW_EXCEEDED'
    return 'INVALID_REQUEST'
  }
  if (status >= 500) return 'SERVER'
  return `HTTP_${status}`
}

/**
 * One reachability probe against the running Unsloth Desktop. Any HTTP answer
 * counts as reachable — Unsloth answers `/v1/models` with 401 when the probe
 * carries no (or a wrong) API key, but the server is demonstrably running.
 * @throws {@link LlmError} with code `SERVER_NOT_RUNNING` when nothing answers.
 */
export async function probeServer(baseURL: string, apiKey: string | undefined, probeTimeoutMs = 3_000): Promise<void> {
  const headers: Record<string, string> = {}
  if (apiKey !== undefined && apiKey.length > 0) {
    headers.authorization = `Bearer ${apiKey}`
  }
  try {
    const response = await fetch(`${baseURL}/v1/models`, {
      headers,
      signal: AbortSignal.timeout(probeTimeoutMs),
    })
    if (response.status === 401) {
      // The server is up; the key is missing or wrong. The chat call itself
      // surfaces the AUTH error with an actionable hint.
      return
    }
  } catch {
    throw new LlmError(
      'no Unsloth Desktop server is running at ' + baseURL
      + '; start Unsloth Desktop, load a model, and check baseURL',
      'SERVER_NOT_RUNNING',
    )
  }
}

/** Coarse token estimate (≈4 chars/token), used only when the server omits usage. */
function estimateTokens(chars: number): number {
  return Math.ceil(Math.max(0, chars) / 4)
}

/**
 * Run one local-model completion. Throws {@link LlmError} with stable codes:
 * `TRANSPORT` (network), `AUTH`/`RATE_LIMIT`/`CONTEXT_WINDOW_EXCEEDED`/
 * `INVALID_REQUEST`/`SERVER`/`HTTP_<n>` (HTTP), `TIMEOUT` (budget exceeded),
 * `ABORTED` (caller cancellation), `EMPTY_RESPONSE` (no text produced).
 * @param baseURL - server endpoint, `/v1/chat/completions` is appended.
 * @param request - the assembled call.
 * @returns the completed answer.
 */
export async function chatCompletion(baseURL: string, request: ChatCompletionRequest): Promise<ChatCompletion> {
  const userContent: string | WireContentPart[] = request.images !== undefined && request.images.length > 0
    ? [
      { type: 'text', text: request.prompt },
      ...request.images.map(image => ({ type: 'image_url' as const, image_url: { url: image } })),
    ]
    : request.prompt
  const messages: WireMessage[] = []
  if (request.system !== undefined && request.system.length > 0) {
    messages.push({ role: 'system', content: request.system })
  }
  messages.push({ role: 'user', content: userContent })
  const payload = JSON.stringify({
    model: request.model,
    messages,
    ...request.temperature === undefined ? {} : { temperature: request.temperature },
    ...request.maxTokens === undefined ? {} : { max_tokens: request.maxTokens },
    ...request.stop !== undefined && request.stop.length > 0 ? { stop: request.stop } : {},
  })

  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'accept': 'application/json',
  }
  if (request.apiKey !== undefined && request.apiKey.length > 0) {
    headers.authorization = `Bearer ${request.apiKey}`
  }

  let response: Response
  try {
    response = await fetch(`${baseURL}/v1/chat/completions`, {
      method: 'POST',
      headers,
      body: payload,
      signal: request.signal,
    })
  } catch (error: unknown) {
    if (request.signal.aborted) {
      const reason = request.signal.reason
      if (reason instanceof DOMException && reason.name === 'TimeoutError') {
        throw new LlmError('Unsloth call timed out', 'TIMEOUT', { cause: error })
      }
      throw new LlmError('Unsloth call aborted by caller', 'ABORTED', { cause: error })
    }
    throw new LlmError(`Unsloth request to ${baseURL} failed`, 'TRANSPORT', { cause: error })
  }

  if (!response.ok) {
    let message = `Unsloth API error (HTTP ${response.status})`
    let providerError: WireError['error']
    try {
      const parsed = await response.json() as WireError
      providerError = parsed.error
      if (providerError?.message) message = providerError.message
    } catch {
      // Only swallow error-body parsing: the HTTP status still identifies the
      // failure, so malformed gateway JSON must not mask it.
    }
    const detail = [providerError?.code, providerError?.type, providerError?.message].filter(Boolean).join(' ')
    const code = httpErrorCode(response.status, providerError)
    const hint = code === 'AUTH'
      ? ' check the Unsloth API key (Settings → API in Unsloth, or the apiKey / UNSLOTH_API_KEY config)'
      : ''
    throw new LlmError(
      `${message} (code ${code}${detail ? `; ${detail}` : ''}${hint})`,
      code,
      { status: response.status },
    )
  }

  let parsed: WireResponse
  try {
    parsed = await response.json() as WireResponse
  } catch (error: unknown) {
    throw new LlmError('Unsloth returned a malformed response body', 'INVALID_REQUEST', { cause: error })
  }

  const message = parsed.choices?.[0]?.message
  const text = (message?.content ?? '').trim()
  if (text.length === 0) {
    throw new LlmError('the local model returned an empty response', 'EMPTY_RESPONSE')
  }
  const reasoning = message?.reasoning_content ?? undefined
  const promptTokens = parsed.usage?.prompt_tokens ?? estimateTokens(payload.length)
  const completionTokens = parsed.usage?.completion_tokens ?? estimateTokens(text.length)
  return {
    text,
    ...reasoning !== undefined && reasoning.length > 0 ? { reasoning } : {},
    model: parsed.model ?? request.model,
    usage: { promptTokens, completionTokens },
  }
}

export { CONTEXT_WINDOW_EXCEEDED_CODE }
