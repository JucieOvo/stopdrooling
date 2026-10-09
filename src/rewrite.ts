/**
 * Pure request-body rewrite: remove matched reasoning spans from assistant
 * messages that are about to be sent to the provider. Session history is
 * untouched; only the GenerateOptions.messages copy used on the wire changes.
 */

import type { Message, RequestMessage } from '@deepseek-ai/dsh-llm'
import {
  compileNeedles,
  removalRanges,
  removeRanges,
  reverseMatchRaw,
  type RawReverseMatch,
} from './matcher.ts'
import { planParagraph, reasoningCutoff, resolveTailFraction } from './paragraph.ts'

export type RemoveMode = 'match' | 'tail' | 'paragraph'

export interface RewriteConfig {
  phrases: readonly string[]
  remove: RemoveMode
  maxHitsPerBlock: number
  /**
   * Editable suffix of each reasoning block, in (0, 1].
   * Omitted means 1, so every hit stays eligible and existing callers keep
   * the previous cut. Plugin `Config.tailFraction` defaults to 0.25; `apply`
   * copies that resolved number onto this field.
   * The cutoff is `Math.floor(text.length * (1 - tailFraction))` on the
   * original block text. `text.length` counts UTF-16 code units.
   */
  tailFraction?: number
}

/** One reasoning block that will be shortened on the wire. */
export interface WireRedactHit {
  /** Index of the assistant message inside the request messages array. */
  readonly messageIndex: number
  readonly blockIndex: number
  readonly reasoningLength: number
  readonly ranges: readonly (readonly [number, number])[]
  readonly hits: readonly RawReverseMatch[]
  readonly removed: readonly string[]
}

/**
 * A reasoning block had paragraph hits, but deleting them would leave it
 * empty or whitespace-only. The block and its signature stay as they were.
 */
export interface SkippedReasoningBlock {
  readonly messageIndex: number
  readonly blockIndex: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Drop the replay signature of the given block indexes, when present. */
export function dropSignatures(source: Message['source'], blockIndexes: ReadonlySet<number>): Message['source'] {
  const replayState: unknown = (source as { replayState?: unknown }).replayState
  if (!isRecord(replayState) || !Array.isArray(replayState['blocks'])) return source
  let changed = false
  const blocks = (replayState['blocks'] as unknown[]).map((block, index) => {
    if (!blockIndexes.has(index) || !isRecord(block) || !('signature' in block)) return block
    changed = true
    const { signature: _stale, ...rest } = block
    return Object.freeze(rest)
  })
  if (!changed) return source
  return Object.freeze({
    ...source,
    replayState: Object.freeze({ ...replayState, blocks: Object.freeze(blocks) }),
  }) as Message['source']
}

/**
 * Return an immutable copy of `original` with each listed reasoning block's
 * ranges removed and stale signatures dropped.
 */
export function redactReasoningBlocks(
  original: Message,
  edits: ReadonlyMap<number, readonly (readonly [number, number])[]>,
): Message {
  const content = original.content.map((block, index) => {
    const ranges = edits.get(index)
    if (ranges === undefined) return block
    if (block.type !== 'reasoning') {
      throw new Error(`rewrite: block ${index} is not reasoning`)
    }
    return Object.freeze({ ...block, text: removeRanges(block.text, ranges) })
  })
  return Object.freeze({
    ...original,
    content: Object.freeze(content) as Message['content'],
    source: dropSignatures(original.source, new Set(edits.keys())),
  }) as Message
}

interface MessagePlan {
  edits: Map<number, [number, number][]>
  hits: Omit<WireRedactHit, 'messageIndex'>[]
  skipped: number[]
}

function pushHit(
  hits: Omit<WireRedactHit, 'messageIndex'>[],
  blockIndex: number,
  text: string,
  ranges: readonly (readonly [number, number])[],
  matched: readonly RawReverseMatch[],
): void {
  hits.push({
    blockIndex,
    reasoningLength: text.length,
    ranges,
    hits: matched,
    removed: ranges.map(([start, end]) => text.slice(start, end).slice(0, 200)),
  })
}

/** Whole-line plan. `maxHitsPerBlock` is ignored; every eligible matching line is included. */
function planParagraphMessage(
  message: Message,
  phrases: readonly string[],
  tailFraction: number,
): MessagePlan | undefined {
  const edits = new Map<number, [number, number][]>()
  const hits: Omit<WireRedactHit, 'messageIndex'>[] = []
  const skipped: number[] = []
  message.content.forEach((block, blockIndex) => {
    if (block.type !== 'reasoning' || !block.text) return
    const planned = planParagraph(block.text, phrases, tailFraction)
    if (planned === undefined) return
    if (planned.skip) {
      skipped.push(blockIndex)
      return
    }
    const ranges = planned.ranges.map(range => [range[0], range[1]] as [number, number])
    edits.set(blockIndex, ranges)
    pushHit(hits, blockIndex, block.text, ranges, planned.hits)
  })
  if (edits.size === 0 && skipped.length === 0) return undefined
  return { edits, hits, skipped }
}

/** Scan one assistant message; return edits + hit records, or undefined. */
export function planMessageRedaction(
  message: Message,
  config: RewriteConfig,
): { edits: Map<number, [number, number][]>; hits: Omit<WireRedactHit, 'messageIndex'>[]; skipped: number[] } | undefined {
  const remove = config.remove
  const tailFraction = resolveTailFraction(config.tailFraction)
  if (remove === 'paragraph') return planParagraphMessage(message, config.phrases, tailFraction)
  const needles = compileNeedles(config.phrases)
  if (needles.length === 0) return undefined
  const edits = new Map<number, [number, number][]>()
  const hits: Omit<WireRedactHit, 'messageIndex'>[] = []
  message.content.forEach((block, blockIndex) => {
    if (block.type !== 'reasoning' || !block.text) return
    const cutoff = reasoningCutoff(block.text.length, tailFraction)
    // Drop hits that start before the cutoff, then apply the cap. A hit in the
    // head does not consume a maxHitsPerBlock slot.
    const matched = reverseMatchRaw(block.text, needles, Number.POSITIVE_INFINITY)
      .filter((hit) => hit.rawRange[0] >= cutoff)
      .slice(0, config.maxHitsPerBlock)
    if (matched.length === 0) return
    const ranges = removalRanges(block.text.length, matched, remove)
    if (ranges.length === 0) return
    edits.set(blockIndex, ranges)
    pushHit(hits, blockIndex, block.text, ranges, matched)
  })
  if (edits.size === 0) return undefined
  return { edits, hits, skipped: [] }
}

/** Rewritten messages, wire hits, and blocks left untouched because they would become blank. */
export interface RewriteResult {
  /**
   * Shortened messages, or the input array when `passthrough` is set.
   * A passthrough result keeps that array's identity.
   */
  readonly messages: RequestMessage[]
  readonly hits: readonly WireRedactHit[]
  readonly skipped: readonly SkippedReasoningBlock[]
  /** No block was edited. The caller must keep the original request. */
  readonly passthrough: boolean
}

/**
 * Build a new messages array with matched reasoning spans removed from every
 * assistant message. Returns `undefined` when nothing matched (stable
 * cache key / no-op identity for the llm/stream listener). A paragraph block
 * that would become empty or whitespace-only is listed in `skipped` and is
 * not edited. If those are the only matches, `passthrough` is set and
 * `messages` is the input array.
 */
export function rewriteRequestMessages(
  messages: readonly RequestMessage[],
  config: RewriteConfig,
): RewriteResult | undefined {
  if (config.remove !== 'paragraph') {
    const needles = compileNeedles(config.phrases)
    if (needles.length === 0) return undefined
  }
  let changed = false
  const hits: WireRedactHit[] = []
  const skipped: SkippedReasoningBlock[] = []
  const out = messages.map((message, messageIndex): RequestMessage => {
    if (message.role !== 'assistant') return message
    const planned = planMessageRedaction(message, config)
    if (planned === undefined) return message
    for (const blockIndex of planned.skipped) skipped.push({ messageIndex, blockIndex })
    if (planned.edits.size === 0) return message
    changed = true
    for (const hit of planned.hits) hits.push({ messageIndex, ...hit })
    return redactReasoningBlocks(message, planned.edits) as RequestMessage
  })
  if (!changed && skipped.length === 0) return undefined
  if (!changed) return { messages: messages as RequestMessage[], hits, skipped, passthrough: true }
  return { messages: Object.freeze(out) as RequestMessage[], hits, skipped, passthrough: false }
}
