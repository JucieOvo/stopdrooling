/**
 * Reverse (tail-first) phrase matching over reasoning text, with fold→raw
 * UTF-16 offset mapping so a hit can be excised from the original string.
 *
 * Folding is char-local (NFKC + lowercase + drop non letters/digits), so
 * folding by code point equals folding the whole text, and streaming scanners
 * can search only the new tail.
 */

export interface ReverseMatch {
  /** The configured phrase that matched. */
  readonly phrase: string
  /** Folded form of the phrase. */
  readonly folded: string
  /** Start index of the hit in the folded reasoning. */
  readonly index: number
  /** Folded characters between the end of the hit and the end of the reasoning. */
  readonly offsetFromEnd: number
}

/** One hit expressed in both folded and raw UTF-16 coordinates. */
export interface RawReverseMatch extends ReverseMatch {
  /** Inclusive-exclusive UTF-16 range in the original reasoning text. */
  readonly rawRange: readonly [number, number]
}

const STRIP = /[^\p{L}\p{N}]+/gu

/** Char-local fold plus per-folded-char raw UTF-16 spans. */
export function foldWithMap(text: string): {
  folded: string
  starts: number[]
  ends: number[]
} {
  let folded = ''
  const starts: number[] = []
  const ends: number[] = []
  for (let i = 0; i < text.length;) {
    const cp = text.codePointAt(i)!
    const len = cp > 0xffff ? 2 : 1
    const kept = text.slice(i, i + len).normalize('NFKC').toLowerCase().replace(STRIP, '')
    for (const ch of kept) {
      folded += ch
      starts.push(i)
      ends.push(i + len)
    }
    i += len
  }
  return { folded, starts, ends }
}

export function fold(text: string): string {
  return foldWithMap(text).folded
}

/** Map a folded half-open range onto raw UTF-16 offsets. */
export function rawRangeFor(
  starts: readonly number[],
  ends: readonly number[],
  foldStart: number,
  foldEnd: number,
): [number, number] {
  if (foldStart < 0 || foldEnd <= foldStart || foldEnd > starts.length) {
    throw new RangeError(`folded range [${foldStart}, ${foldEnd}) is out of bounds`)
  }
  return [starts[foldStart]!, ends[foldEnd - 1]!]
}

interface Needle { phrase: string; folded: string }

export function compileNeedles(phrases: readonly string[]): Needle[] {
  const seen = new Set<string>()
  const needles: Needle[] = []
  for (const phrase of phrases) {
    const folded = fold(phrase)
    if (!folded || seen.has(folded)) continue
    seen.add(folded)
    needles.push({ phrase, folded })
  }
  return needles
}

/**
 * Search `folded` from the end backward and return the hit whose end lies
 * closest to the end of the text (ties go to the longer phrase). Only hits
 * ending at or after `minEnd` are considered.
 */
export function reverseFind(folded: string, needles: readonly Needle[], minEnd = 0): ReverseMatch | undefined {
  let best: ReverseMatch | undefined
  let bestEnd = -1
  for (const needle of needles) {
    const index = folded.lastIndexOf(needle.folded)
    if (index < 0) continue
    const end = index + needle.folded.length
    if (end < minEnd) continue
    if (end > bestEnd || (end === bestEnd && best && needle.folded.length > best.folded.length)) {
      bestEnd = end
      best = { phrase: needle.phrase, folded: needle.folded, index, offsetFromEnd: folded.length - end }
    }
  }
  return best
}

/**
 * Collect up to `maxHits` non-overlapping hits, always preferring the one
 * closest to the current end (then the next remaining end, and so on).
 */
export function reverseFindAll(
  folded: string,
  needles: readonly Needle[],
  maxHits: number,
): ReverseMatch[] {
  if (maxHits < 1 || !needles.length) return []
  const hits: ReverseMatch[] = []
  let limit = folded.length
  while (hits.length < maxHits && limit > 0) {
    const hit = reverseFind(folded.slice(0, limit), needles)
    if (!hit) break
    hits.push({
      ...hit,
      offsetFromEnd: folded.length - (hit.index + hit.folded.length),
    })
    limit = hit.index
  }
  return hits
}

/** Reverse-match `text` and return hits with raw UTF-16 ranges. */
export function reverseMatchRaw(
  text: string,
  needles: readonly Needle[],
  maxHits: number,
): RawReverseMatch[] {
  const { folded, starts, ends } = foldWithMap(text)
  return reverseFindAll(folded, needles, maxHits).map((hit) => ({
    ...hit,
    rawRange: rawRangeFor(starts, ends, hit.index, hit.index + hit.folded.length),
  }))
}

/**
 * Expand each match range for removal: `match` keeps the phrase span; `tail`
 * extends from the match start through the end of the text.
 */
export function removalRanges(
  textLength: number,
  hits: readonly RawReverseMatch[],
  mode: 'match' | 'tail',
): [number, number][] {
  if (mode === 'tail') {
    if (hits.length === 0) return []
    // Closest-to-end hit is first; its start is the earliest cut for a single tail.
    // With multiple hits under tail mode, remove from the earliest start to end.
    let start = textLength
    for (const hit of hits) start = Math.min(start, hit.rawRange[0])
    return start < textLength ? [[start, textLength]] : []
  }
  return hits
    .map(hit => [hit.rawRange[0], hit.rawRange[1]] as [number, number])
    .sort((a, b) => a[0] - b[0])
}

/** Remove half-open UTF-16 ranges from `text` (ranges may be unsorted / overlapping). */
export function removeRanges(text: string, ranges: readonly (readonly [number, number])[]): string {
  if (ranges.length === 0) return text
  const ordered = [...ranges].sort((a, b) => a[0] - b[0] || a[1] - b[1])
  let out = ''
  let cursor = 0
  for (const [start, end] of ordered) {
    const from = Math.max(cursor, Math.min(start, text.length))
    const to = Math.max(from, Math.min(end, text.length))
    if (from > cursor) out += text.slice(cursor, from)
    cursor = Math.max(cursor, to)
  }
  if (cursor < text.length) out += text.slice(cursor)
  return out
}

/** Incremental scanner for one assistant attempt's reasoning stream (legacy / tests). */
export class ReasoningScanner {
  private folded = ''
  private readonly maxLen: number
  hits = 0

  constructor(private readonly needles: readonly Needle[]) {
    this.maxLen = needles.reduce((max, n) => Math.max(max, n.folded.length), 0)
  }

  get length(): number {
    return this.folded.length
  }

  /** Append a reasoning delta; return a hit that ends inside the new tail. */
  push(delta: string): ReverseMatch | undefined {
    if (!this.needles.length) return undefined
    const before = this.folded.length
    const add = fold(delta)
    if (!add) return undefined
    this.folded += add
    const windowStart = Math.max(0, before - this.maxLen + 1)
    const window = this.folded.slice(windowStart)
    const hit = reverseFind(window, this.needles, before - windowStart + 1)
    if (!hit) return undefined
    return { ...hit, index: hit.index + windowStart, offsetFromEnd: hit.offsetFromEnd }
  }

  /** Scan the whole accumulated reasoning from the end backward. */
  scanAll(): ReverseMatch | undefined {
    return reverseFind(this.folded, this.needles)
  }
}
