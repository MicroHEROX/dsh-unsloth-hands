/**
 * Image preparation for the vision tool: local files and HTTP(S) URLs become
 * `data:image/...;base64,...` URLs, and images attached to the calling agent's
 * session (harness ImageBlocks, persisted through the attachment service) can
 * be collected as well — so a multimodal online model can hand "the picture in
 * this conversation" to the local vision model without re-sending bytes.
 *
 * @module dsh-unsloth/images
 */

import { readFile, stat } from 'node:fs/promises'
import { extname } from 'node:path'
import { deriveEventMessage } from '@deepseek-ai/dsh-session'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { Context } from '@deepseek-ai/cordis'

/** Per-image byte cap, comfortably under llama-server's default request limit. */
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024

/** MIME type for one supported image extension. */
export function mimeOf(path: string): string | undefined {
  switch (extname(path).toLowerCase()) {
    case '.png': return 'image/png'
    case '.jpg':
    case '.jpeg': return 'image/jpeg'
    case '.webp': return 'image/webp'
    case '.gif': return 'image/gif'
    case '.bmp': return 'image/bmp'
    default: return undefined
  }
}

/** Whether the path's extension is an accepted image format. */
export function isSupportedImagePath(path: string): boolean {
  return mimeOf(path) !== undefined
}

/**
 * Read one local image file and encode it as a data URL.
 * @param path - absolute or relative file path.
 * @param signal - optional cancellation for the file read.
 * @returns `data:<mime>;base64,<bytes>`.
 * @throws with a clear message for missing files, unsupported formats, or
 *   oversized images.
 */
export async function imageFileToDataUrl(path: string, signal?: AbortSignal): Promise<string> {
  const mime = mimeOf(path)
  if (mime === undefined) {
    throw new Error(`unsupported image format "${path}"; supported: png, jpg, jpeg, webp, gif, bmp`)
  }
  let info
  try {
    info = await stat(path)
  } catch {
    throw new Error(`image file not found: ${path}`)
  }
  if (!info.isFile()) throw new Error(`not a file: ${path}`)
  if (info.size > MAX_IMAGE_BYTES) {
    throw new Error(`image too large (${Math.round(info.size / 1024 / 1024)} MB > ${MAX_IMAGE_BYTES / 1024 / 1024} MB): ${path}`)
  }
  const bytes = await readFile(path, { signal })
  return `data:${mime};base64,${bytes.toString('base64')}`
}

/**
 * Download one HTTP(S) image and encode it as a data URL. `data:` URLs pass
 * through unchanged.
 * @param url - `data:image/...` or `http(s)://` URL.
 * @param signal - required cancellation for the download.
 * @returns a `data:<mime>;base64,<bytes>` URL.
 */
export async function imageUrlToDataUrl(url: string, signal: AbortSignal): Promise<string> {
  if (url.startsWith('data:image')) return url
  const response = await fetch(url, { signal })
  if (!response.ok) {
    throw new Error(`failed to fetch image ${url}: HTTP ${response.status}`)
  }
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (bytes.byteLength > MAX_IMAGE_BYTES) {
    throw new Error(`image too large (${Math.round(bytes.byteLength / 1024 / 1024)} MB > ${MAX_IMAGE_BYTES / 1024 / 1024} MB): ${url}`)
  }
  const mime = response.headers.get('content-type') ?? 'image/png'
  return `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`
}

/** Minimal shape of the tool execution context (structural, no dsh-tools import). */
export interface VisionExecContext {
  readonly signal: AbortSignal
  readonly agent?: { readonly session: { readonly events: readonly unknown[] } }
}

/**
 * Collect image bytes from the calling agent's session: every user message
 * image block (harness ImageBlock) that the attachment service can resolve.
 * Deduplicated by attachment id, newest first. No agent or no attachment
 * service means no images.
 * @param ctx - harness context (for the optional `attachments` service).
 * @param exec - the tool execution (agent + cancellation signal).
 * @returns data URLs for the session images, newest first.
 */
export async function collectSessionImageDataUrls(
  ctx: Context,
  exec: VisionExecContext,
): Promise<string[]> {
  const attachments = ctx.get('attachments')
  if (attachments === undefined || exec.agent === undefined) return []
  const refs: ImageAttachmentRef[] = []
  const seen = new Set<string>()
  for (const event of exec.agent.session.events) {
    const message = deriveEventMessage(event as Parameters<typeof deriveEventMessage>[0])
    if (message === null) continue
    for (const block of message.content) {
      if (block.type !== 'image') continue
      const id = String(block.attachment.attachmentId)
      if (seen.has(id)) continue
      seen.add(id)
      refs.push(block.attachment)
    }
  }
  // Newest first: the most recently attached image is the one being discussed.
  refs.reverse()
  const urls: string[] = []
  for (const ref of refs) {
    try {
      const stored = await attachments.readImage(ref, exec.signal)
      urls.push(`data:${ref.mediaType};base64,${Buffer.from(stored.data).toString('base64')}`)
    } catch {
      // A missing/expired attachment must not fail the whole call; skip it.
    }
  }
  return urls
}
