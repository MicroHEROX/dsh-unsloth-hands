/**
 * Built-in prompt templates for the vision tool: a structured,
 * machine-verifiable report shape
 * that a downstream model can consume without hallucinated detail. The online
 * model selects a mode (or writes its own prompt); the local vision model gets
 * the template verbatim.
 *
 * @module dsh-unsloth/prompts
 */

/** Vision modes exposed by the tool. */
export type VisionMode = 'analyze' | 'ocr' | 'compare'

/** Analyzer mode: one structured "# Image Analysis Report" with fixed sections. */
export const ANALYZE_PROMPT =
  'You are analyzing an image. Produce an "# Image Analysis Report" in Markdown '
  + 'with exactly these sections:\n'
  + '1. Summary — a 2–4 sentence overview of the image.\n'
  + '2. Image Metadata — type, style, and dominant color palette (with hex codes).\n'
  + '3. Layout & Composition — spatial arrangement and visual hierarchy.\n'
  + '4. Visible Text (VERBATIM) — every readable character exactly as written, '
  + 'in reading order; do NOT fix typos, do NOT drop or add symbols, do NOT rephrase.\n'
  + '5. Objects & Elements — what is depicted.\n'
  + '6. People & Actions — if any are present.\n'
  + '7. Semantic Context & Inferences — grounded only in what is visible.\n'
  + '8. Uncertainties & Gaps — honestly mark anything you cannot resolve instead of guessing.'

/** OCR mode: character-exact text extraction, nothing else. */
export const OCR_PROMPT =
  'Extract ALL text from the image verbatim, character-exact, in reading order. '
  + 'Do NOT fix typos, do NOT drop or add symbols, do NOT rephrase, do NOT '
  + 'summarize. If a glyph cannot be resolved, note it explicitly in brackets. '
  + 'Output the raw text only.'

/** Compare mode (2–4 images): one structured "# Image Comparison Report". */
export const COMPARE_PROMPT =
  'Compare the provided images together. Produce an "# Image Comparison Report" '
  + 'in Markdown with exactly these sections:\n'
  + '1. Per-Image Summaries — one short paragraph per image.\n'
  + '2. Common Elements — what the images share.\n'
  + '3. Key Differences — how they differ.\n'
  + '4. Text Differences (VERBATIM) — quote differing text exactly as written, '
  + 'character-exact, without fixing typos or rephrasing.\n'
  + '5. Overall Conclusion — one paragraph tying it together.'

/** The model-facing fidelity rule appended to the tool description. */
export const VISION_FIDELITY_RULE =
  'When relaying the local model\'s output, keep full fidelity: never rephrase, '
  + 'shorten, "fix", or invent visual details the report did not return; preserve '
  + 'any uncertainty the report explicitly states.'

/**
 * Resolve the prompt for one call: a caller-supplied custom prompt wins; the
 * mode template is the default.
 * @param mode - selected vision mode.
 * @param prompt - optional custom instruction.
 * @returns the prompt to send to the local model.
 */
export function resolveVisionPrompt(mode: VisionMode, prompt?: string): string {
  if (prompt !== undefined && prompt.trim().length > 0) return prompt
  switch (mode) {
    case 'analyze': return ANALYZE_PROMPT
    case 'ocr': return OCR_PROMPT
    case 'compare': return COMPARE_PROMPT
  }
}
