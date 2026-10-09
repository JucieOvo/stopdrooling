/**
 * Whole-line removal for `remove: 'paragraph'`.
 *
 * A line matches when its body — one trailing CR removed, then surrounding
 * spaces and tabs trimmed — has the same canonical form as a configured
 * phrase. The canonical form lowercases ASCII A–Z, collapses runs of spaces
 * and tabs to one space, and treats `—`, `–`, `--`, and ` - ` as the same
 * dash. It does not apply NFKC, so `（写）` and `(写)` stay distinct.
 *
 * Every matching line whose start offset is at or after the cutoff is removed.
 * The cutoff is `Math.floor(text.length * (1 - tailFraction))` on the original
 * block text, before any edit. `text.length` is JavaScript string length
 * (UTF-16 code units). `tailFraction` 1 yields cutoff 0, so the whole block
 * stays eligible. A matching line that starts before the cutoff is kept as a
 * normal kept line, including when the line extends past the cutoff, and blank
 * runs are measured with that line still in place. `maxHitsPerBlock` does not
 * apply. The line's trailing `\n` is removed with it; a final line that has
 * no `\n` takes the preceding `\n` instead. Between two kept lines, a stretch
 * made only of blank lines and removed lines keeps the first longest blank
 * run, so blank runs that would otherwise be concatenated are not added
 * together. The same kind of stretch before the first kept line or after the
 * last one drops its blank lines as well. When that trailing stretch contains
 * a match and the block does not end in `\n`, the last kept line's `\n` is
 * removed too; a block that ends in `\n` keeps that one trailing newline.
 * A leading blank run that contains no match stays.
 */

import { removeRanges, type RawReverseMatch } from './matcher.ts'

const EM = '\u2014'
const EN = '\u2013'

export interface ParagraphPlan {
  /** Half-open UTF-16 spans removed from the original block. Empty when `skip` is set. */
  readonly ranges: readonly (readonly [number, number])[]
  /** One record per matched line. Present even when `skip` is set. */
  readonly hits: readonly RawReverseMatch[]
  /**
   * The block has matches, but applying `ranges` would leave it empty or
   * whitespace-only. The caller must keep the original block.
   */
  readonly skip: boolean
}

interface Line {
  readonly start: number
  readonly end: number
  /** Index of the terminating `\n`, or -1 when this line has none. */
  readonly nl: number
  readonly kind: 'keep' | 'hit' | 'blank'
  readonly phrase: string
  readonly folded: string
}

/** Trim spaces and tabs only. Other characters, including `\r`, stay. */
function trimSpaceTab(text: string): string {
  let start = 0
  let end = text.length
  while (start < end) {
    const code = text.charCodeAt(start)
    if (code !== 32 && code !== 9) break
    start++
  }
  while (end > start) {
    const code = text.charCodeAt(end - 1)
    if (code !== 32 && code !== 9) break
    end--
  }
  return text.slice(start, end)
}

function isSpaceTab(code: number): boolean {
  return code === 32 || code === 9
}

/**
 * Canonical paragraph key.
 * @param text - a line body or phrase, already trimmed of surrounding spaces and tabs.
 * @returns the comparison key. No NFKC.
 */
export function canonicalizeParagraph(text: string): string {
  let result = ''
  let pendingSpace = false
  const len = text.length
  let i = 0
  while (i < len) {
    const code = text.charCodeAt(i)
    if (isSpaceTab(code)) {
      if (result.length > 0) pendingSpace = true
      i++
      continue
    }
    if (code === EN.charCodeAt(0) || code === EM.charCodeAt(0)) {
      if (result.length > 0 && !result.endsWith(' ')) result += ' '
      result += EM
      pendingSpace = true
      i++
      continue
    }
    if (code === 0x2d && i + 1 < len && text.charCodeAt(i + 1) === 0x2d) {
      if (result.length > 0 && !result.endsWith(' ')) result += ' '
      result += EM
      pendingSpace = true
      i += 2
      continue
    }
    if (
      code === 0x2d
      && pendingSpace
      && i + 1 < len
      && isSpaceTab(text.charCodeAt(i + 1))
    ) {
      if (result.length > 0 && !result.endsWith(' ')) result += ' '
      result += EM
      pendingSpace = true
      i++
      while (i < len && isSpaceTab(text.charCodeAt(i))) i++
      continue
    }
    if (pendingSpace && result.length > 0 && !result.endsWith(' ')) result += ' '
    pendingSpace = false
    result += code >= 65 && code <= 90 ? String.fromCharCode(code + 32) : text[i]!
    i++
  }
  return result
}

/**
 * UTF-16 index where edits may begin.
 * @param textLength - `text.length` of the original reasoning block.
 * @param tailFraction - editable suffix in (0, 1]. 1 yields 0.
 * @returns `Math.floor(textLength * (1 - tailFraction))`.
 */
export function reasoningCutoff(textLength: number, tailFraction: number): number {
  return Math.floor(textLength * (1 - tailFraction))
}

/**
 * Fraction of a block that may be edited.
 * An omitted value is 1 so pure helpers keep whole-block removal. Plugin
 * `Config.tailFraction` defaults to 0.25 and `apply` passes that number in.
 * @param tailFraction - caller value, or `undefined` when the field was omitted.
 * @returns the fraction used for the cutoff.
 * @throws when the value is not in (0, 1], including `NaN`.
 */
export function resolveTailFraction(tailFraction: number | undefined): number {
  if (tailFraction === undefined) return 1
  if (!(tailFraction > 0 && tailFraction <= 1)) {
    throw new Error(`reasoning-reverse-match: tailFraction must be in (0, 1], got ${tailFraction}`)
  }
  return tailFraction
}

/** First configured phrase wins when two phrases share a canonical key. */
export function compileParagraphPhrases(phrases: readonly string[]): Map<string, string> {
  const table = new Map<string, string>()
  for (const phrase of phrases) {
    const trimmed = trimSpaceTab(phrase)
    if (trimmed.length === 0) continue
    const key = canonicalizeParagraph(trimmed)
    if (key.length === 0 || table.has(key)) continue
    table.set(key, phrase)
  }
  return table
}

function stripTrailingCr(text: string, start: number, end: number): string {
  if (end > start && text.charCodeAt(end - 1) === 13) end--
  return text.slice(start, end)
}

function parseLines(text: string): { start: number; end: number; nl: number }[] {
  const lines: { start: number; end: number; nl: number }[] = []
  let start = 0
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) !== 10) continue
    lines.push({ start, end: i, nl: i })
    start = i + 1
  }
  if (start < text.length || lines.length === 0) {
    lines.push({ start, end: text.length, nl: -1 })
  }
  return lines
}

function classify(text: string, table: Map<string, string>): Line[] {
  return parseLines(text).map((line) => {
    const body = trimSpaceTab(stripTrailingCr(text, line.start, line.end))
    if (body.length === 0) {
      return { ...line, kind: 'blank' as const, phrase: '', folded: '' }
    }
    const folded = canonicalizeParagraph(body)
    const phrase = table.get(folded)
    if (phrase === undefined) {
      return { ...line, kind: 'keep' as const, phrase: '', folded }
    }
    return { ...line, kind: 'hit' as const, phrase, folded }
  })
}

/** Matching lines that start before `cutoff` stay, and count as ordinary kept lines. */
function demoteIneligibleHits(lines: readonly Line[], cutoff: number): Line[] {
  if (cutoff <= 0) return lines.slice()
  return lines.map((line) => {
    if (line.kind !== 'hit' || line.start >= cutoff) return line
    return { ...line, kind: 'keep' as const, phrase: '', folded: '' }
  })
}

function mergeRanges(ranges: readonly (readonly [number, number])[]): [number, number][] {
  if (ranges.length === 0) return []
  const sorted = [...ranges].sort((a, b) => a[0] - b[0] || a[1] - b[1])
  const out: [number, number][] = []
  let start = sorted[0]![0]
  let end = sorted[0]![1]
  for (let i = 1; i < sorted.length; i++) {
    const next = sorted[i]!
    if (next[0] <= end) end = Math.max(end, next[1])
    else {
      out.push([start, end])
      start = next[0]
      end = next[1]
    }
  }
  out.push([start, end])
  return out
}

/**
 * Spans to delete. Between two kept lines, blank lines that survive are the
 * first longest blank run in that gap. A gap before the first kept line or
 * after the last one drops its blank lines with the matched lines. When that
 * trailing gap contains a match and `text` does not end in `\n`, the last
 * kept line's `\n` is removed as well.
 * @param lines - classified lines of one block.
 * @param text - the original block, used only for its final character.
 */
function deletionRanges(lines: readonly Line[], text: string): [number, number][] {
  const keepAt: number[] = []
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.kind === 'keep') keepAt.push(i)
  }
  const gaps: [number, number][] = []
  if (keepAt.length === 0) gaps.push([0, lines.length])
  else {
    if (keepAt[0]! > 0) gaps.push([0, keepAt[0]!])
    for (let k = 0; k < keepAt.length - 1; k++) {
      const from = keepAt[k]! + 1
      const to = keepAt[k + 1]!
      if (from < to) gaps.push([from, to])
    }
    const last = keepAt[keepAt.length - 1]!
    if (last < lines.length - 1) gaps.push([last + 1, lines.length])
  }

  const ranges: [number, number][] = []
  let stripLastKeptNewline = false
  for (const [from, to] of gaps) {
    let hasHit = false
    for (let i = from; i < to; i++) {
      if (lines[i]!.kind === 'hit') hasHit = true
    }
    if (!hasHit) continue

    const runs: { at: number; len: number }[] = []
    let i = from
    while (i < to) {
      if (lines[i]!.kind !== 'blank') {
        i++
        continue
      }
      const at = i
      while (i < to && lines[i]!.kind === 'blank') i++
      runs.push({ at, len: i - at })
    }
    const edge = keepAt.length > 0 && (from === 0 || to === lines.length)
    let desired = 0
    if (!edge) {
      for (const run of runs) desired = Math.max(desired, run.len)
    }
    if (edge && to === lines.length && !text.endsWith('\n')) stripLastKeptNewline = true
    let kept = -1
    if (desired > 0) {
      for (let r = 0; r < runs.length; r++) {
        if (runs[r]!.len === desired) {
          kept = r
          break
        }
      }
    }

    for (let index = from; index < to; index++) {
      const line = lines[index]!
      if (line.kind === 'blank') {
        const runIndex = runs.findIndex(run => index >= run.at && index < run.at + run.len)
        if (runIndex === kept) continue
      }
      if (line.nl >= 0) ranges.push([line.start, line.nl + 1])
      else if (index > 0 && lines[index - 1]!.nl >= 0) ranges.push([lines[index - 1]!.nl, line.end])
      else ranges.push([line.start, line.end])
    }
  }
  if (stripLastKeptNewline) {
    const nl = lines[keepAt[keepAt.length - 1]!]!.nl
    if (nl >= 0) ranges.push([nl, nl + 1])
  }
  return mergeRanges(ranges)
}

function lineHit(text: string, lines: readonly Line[], index: number): RawReverseMatch {
  const line = lines[index]!
  let rawStart = line.start
  let rawEnd = line.nl >= 0 ? line.nl + 1 : line.end
  if (line.nl < 0 && index > 0 && lines[index - 1]!.nl >= 0) rawStart = lines[index - 1]!.nl
  return {
    phrase: line.phrase,
    folded: line.folded,
    index: rawStart,
    offsetFromEnd: text.length - rawEnd,
    rawRange: [rawStart, rawEnd],
  }
}

/**
 * Plan whole-line removal.
 * @param text - one reasoning block, unchanged. The cutoff uses this string's UTF-16 length.
 * @param phrases - configured phrases; empty and duplicate canonical keys are ignored.
 * @param tailFraction - editable suffix. Omitted means 1 (the whole block).
 * @returns `undefined` when no eligible line matches. `skip` when eligible lines must stay
 * because the block would otherwise be empty or whitespace-only.
 */
export function planParagraph(
  text: string,
  phrases: readonly string[],
  tailFraction = 1,
): ParagraphPlan | undefined {
  const fraction = resolveTailFraction(tailFraction)
  const table = compileParagraphPhrases(phrases)
  if (table.size === 0) return undefined
  const lines = demoteIneligibleHits(classify(text, table), reasoningCutoff(text.length, fraction))
  const matched: number[] = []
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.kind === 'hit') matched.push(i)
  }
  if (matched.length === 0) return undefined
  const ranges = deletionRanges(lines, text)
  const hits = matched.map(index => lineHit(text, lines, index))
  if (removeRanges(text, ranges).trim().length === 0) {
    return { ranges: [], hits, skip: true }
  }
  return { ranges, hits, skip: false }
}
