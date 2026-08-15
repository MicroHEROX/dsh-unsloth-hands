import { describe, expect, it } from 'vitest'
import { ANALYZE_PROMPT, COMPARE_PROMPT, OCR_PROMPT, resolveVisionPrompt } from '../src/prompts.js'
import { isSupportedImagePath, mimeOf } from '../src/images.js'

describe('vision prompt templates', () => {
  it('analyze produces the 8-section report contract', () => {
    expect(ANALYZE_PROMPT).toContain('# Image Analysis Report')
    for (const section of ['Summary', 'Image Metadata', 'Layout & Composition', 'Visible Text (VERBATIM)',
      'Objects & Elements', 'People & Actions', 'Semantic Context & Inferences', 'Uncertainties & Gaps']) {
      expect(ANALYZE_PROMPT).toContain(section)
    }
    expect(ANALYZE_PROMPT).toContain('do NOT fix typos')
  })

  it('ocr demands character-exact extraction', () => {
    expect(OCR_PROMPT).toContain('verbatim, character-exact')
    expect(OCR_PROMPT).toContain('Do NOT fix typos')
    expect(OCR_PROMPT).toContain('reading order')
  })

  it('compare produces the 5-section contract', () => {
    expect(COMPARE_PROMPT).toContain('# Image Comparison Report')
    for (const section of ['Per-Image Summaries', 'Common Elements', 'Key Differences',
      'Text Differences (VERBATIM)', 'Overall Conclusion']) {
      expect(COMPARE_PROMPT).toContain(section)
    }
  })

  it('resolveVisionPrompt prefers a custom prompt over the mode template', () => {
    expect(resolveVisionPrompt('analyze')).toBe(ANALYZE_PROMPT)
    expect(resolveVisionPrompt('ocr')).toBe(OCR_PROMPT)
    expect(resolveVisionPrompt('compare')).toBe(COMPARE_PROMPT)
    expect(resolveVisionPrompt('analyze', 'what color is the car?')).toBe('what color is the car?')
    expect(resolveVisionPrompt('ocr', '   ')).toBe(OCR_PROMPT)
  })
})

describe('image path helpers', () => {
  it('maps supported extensions to MIME types', () => {
    expect(mimeOf('a.png')).toBe('image/png')
    expect(mimeOf('a.JPG')).toBe('image/jpeg')
    expect(mimeOf('a.jpeg')).toBe('image/jpeg')
    expect(mimeOf('a.webp')).toBe('image/webp')
    expect(mimeOf('a.gif')).toBe('image/gif')
    expect(mimeOf('a.bmp')).toBe('image/bmp')
    expect(mimeOf('a.txt')).toBeUndefined()
    expect(isSupportedImagePath('a.png')).toBe(true)
    expect(isSupportedImagePath('a.pdf')).toBe(false)
  })
})
