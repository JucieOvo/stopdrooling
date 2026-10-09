/**
 * reasoning-reverse-match: tail-first phrase matching over assistant reasoning.
 *
 * Streaming is never cancelled and the session log is never rewritten. When a
 * request that replays assistant reasoning reaches `llm/stream` (agent-loop
 * steps, subagents, compaction summaries), this plugin copies it with matched
 * reasoning spans removed and re-enters `ctx.llm.stream` with that copy.
 * The DeepSeek adapter serializes the redacted body. The web client paints the
 * same spans red by re-running the paragraph matcher over assistant/message
 * events. That copy embeds the loop phrase table; the client module graph does
 * not carry plugin config (no durable redact event).
 *
 * The copy carries `Symbol.for('dsh.reasoning-reverse-match.reentry')`:
 * non-enumerable, non-writable, and non-configurable. A listener from a second
 * `apply`, or from a module evaluated again after reload, still sees that
 * global symbol. A marked request returns `next()` and is never rewritten
 * again. Object spread does not copy the mark, so a fresh `{...clone}` can
 * still be rewritten.
 *
 * The copy is not passed to `markAgentLoopRequest`. Reconstructability
 * compares `deriveMessages()` with the original marked request only; the
 * re-entered copy has no agent-loop mark, so that comparison does not run on
 * the shortened `messages`. Marking the copy would fail the comparison.
 *
 * Re-entry calls `LlmRuntime.stream`, which starts a new waterfall and does
 * not keep the prepared-call adapter generation. `adapter.prepareCall` runs
 * again, and the prepared handle's single-dispatch check does not cover this
 * second entry. Keeping that generation would require `LlmRuntime` to let a
 * listener replace the options the rest of the original chain observes.
 *
 * The listener is not prepended, so checkpoint and invariant listeners observe
 * the original request before this plugin returns the re-entered stream.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import Schema from '@deepseek-ai/schemastery'
import { appendFileSync } from 'node:fs'
import { resolveTailFraction } from './paragraph.ts'
import { loadPhrasesFile, mergePhrases } from './phrases.ts'
import type { RemoveMode, RewriteConfig, SkippedReasoningBlock, WireRedactHit } from './rewrite.ts'
import { rewriteRequestMessages } from './rewrite.ts'

export { dropSignatures, planMessageRedaction, redactReasoningBlocks, rewriteRequestMessages } from './rewrite.ts'
export type { RemoveMode, RewriteConfig, SkippedReasoningBlock, WireRedactHit } from './rewrite.ts'

export const name = 'reasoning-reverse-match'
/** llm is required so ctx.llm.stream re-entry is available; sessions unused. */
export const inject = ['llm']

export interface Config {
  phrases: string[]
  phrasesFile?: string
  remove: RemoveMode
  maxHitsPerBlock: number
  /**
   * Editable suffix of each reasoning block. The schema default is 0.25.
   * `RewriteConfig.tailFraction`, when omitted, is 1 inside the pure rewrite
   * helpers; `apply` always passes this resolved value through.
   */
  tailFraction: number
  excerptChars: number
  logFile?: string
}

export const Config: Schema<Config> = Schema.object({
  phrases: Schema.array(String)
    .default(['letsgo', "ok i'll do it"])
    .description('Inline phrases. match and tail fold case, spaces, and punctuation, so "letsgo" also matches "Let\'s go". paragraph compares a whole line to a phrase (ASCII case, collapsed spaces/tabs, equivalent dashes). Merged with phrasesFile; exact duplicates are dropped.'),
  phrasesFile: Schema.string()
    .description('Optional TSV or CSV path. The first column is merged into phrases. The header row is skipped and empty rows are ignored. .csv splits on commas and honors double quotes; .tsv splits on tabs; any other suffix sniffs the first line. Read once at startup. A missing, unreadable, or unparsable file throws.'),
  remove: Schema.union(['match', 'tail', 'paragraph'] as const)
    .default('match')
    .description('match: remove only the matched span (including its inner spaces/punctuation). tail: remove from the match start to the end of that reasoning block. paragraph: remove each whole line that equals a phrase, plus the newline that separated it, and do not add the blank lines on either side.'),
  maxHitsPerBlock: Schema.natural().min(1).default(1)
    .description('Maximum non-overlapping hits per reasoning block, collected from the end backward after hits that start before the tailFraction cutoff are dropped. Those dropped hits do not consume a slot. Ignored when remove is paragraph, which deletes every eligible matching line.'),
  tailFraction: Schema.number().min(0).max(1).default(0.25)
    .description('Editable suffix of each reasoning block. The accepted range is (0, 1]. 1 edits the whole block. Schema min 0 and max 1 are inclusive, so validation rejects negatives and values above 1. 0 is inside that minimum, and NaN is not ordered by it; both still throw from resolveTailFraction when the plugin starts, and the listener is not installed. The cutoff is Math.floor(text.length * (1 - tailFraction)) on the original block text, where length is JavaScript string length (UTF-16 code units). A paragraph line or a match/tail hit is eligible only when its start offset is >= cutoff; a line that starts earlier is kept even if it extends past the cutoff. Omitting the field here uses 0.25. The pure rewrite helper treats an omitted tailFraction as 1.'),
  excerptChars: Schema.natural().default(160)
    .description('Raw reasoning characters before each hit attached to the hit record (0 disables).'),
  logFile: Schema.string()
    .description('Optional JSONL file that receives one record per rewritten request and one record per block left unchanged because deletion would leave it blank.'),
}) as Schema<Config>

/** One redacted block observed on a loop request about to hit the wire. */
export interface ReasoningMatchHit {
  readonly sessionId: string
  readonly messageIndex: number
  readonly blockIndex: number
  readonly remove: RemoveMode
  readonly reasoningLength: number
  readonly ranges: readonly (readonly [number, number])[]
  readonly hits: readonly { phrase: string; rawRange: readonly [number, number]; offsetFromEnd: number }[]
  readonly removed: readonly string[]
  readonly excerpt: string
  readonly time: number
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /** A reasoning block was removed from the outgoing wire request (not from the log). */
    'reasoning-reverse-match/hit'(hit: ReasoningMatchHit): void
  }
}

function excerptFor(text: string, ranges: readonly (readonly [number, number])[], chars: number): string {
  if (chars <= 0 || ranges.length === 0) return ''
  const start = Math.min(...ranges.map(r => r[0]))
  return text.slice(Math.max(0, start - chars), start)
}

function recordHits(
  ctx: Context,
  config: Config,
  options: GenerateOptions,
  hits: readonly WireRedactHit[],
  originalMessages: GenerateOptions['messages'],
  rewrittenMessages: GenerateOptions['messages'],
): void {
  const sessionId = options.sessionId === undefined ? '' : String(options.sessionId)
  const time = Date.now()
  const records: ReasoningMatchHit[] = []
  for (const hit of hits) {
    const message = originalMessages[hit.messageIndex]
    const block = message && message.role === 'assistant' ? message.content[hit.blockIndex] : undefined
    const text = block && block.type === 'reasoning' ? block.text : ''
    const record: ReasoningMatchHit = {
      sessionId,
      messageIndex: hit.messageIndex,
      blockIndex: hit.blockIndex,
      remove: config.remove,
      reasoningLength: hit.reasoningLength,
      ranges: hit.ranges,
      hits: hit.hits.map(h => ({
        phrase: h.phrase,
        rawRange: h.rawRange,
        offsetFromEnd: h.offsetFromEnd,
      })),
      removed: hit.removed,
      excerpt: excerptFor(text, hit.ranges, config.excerptChars),
      time,
    }
    records.push(record)
    ctx.emit('reasoning-reverse-match/hit', record)
  }
  ctx.logger.info(
    'reasoning-reverse-match: removed %d span(s) across %d block(s) from wire request (session %s)',
    hits.reduce((n, h) => n + h.ranges.length, 0),
    hits.length,
    sessionId || '(none)',
  )
  if (config.logFile) {
    try {
      const after = hits.map((hit) => {
        const message = rewrittenMessages[hit.messageIndex]
        const block = message && message.role === 'assistant' ? message.content[hit.blockIndex] : undefined
        const signatureOf = (m: GenerateOptions['messages'][number] | undefined): unknown => {
          const replay = (m?.source as { replayState?: { blocks?: unknown[] } } | undefined)?.replayState
          const entry = replay?.blocks?.[hit.blockIndex] as { signature?: unknown } | undefined
          return entry?.signature
        }
        return {
          messageIndex: hit.messageIndex,
          blockIndex: hit.blockIndex,
          text: block && block.type === 'reasoning' ? block.text : '',
          signatureDropped: signatureOf(originalMessages[hit.messageIndex]) !== undefined
            && signatureOf(message) === undefined,
        }
      })
      appendFileSync(config.logFile, `${JSON.stringify({
        kind: 'wire-rewrite',
        sessionId,
        provider: options.provider,
        model: options.model,
        messageCount: options.messages.length,
        hits: records,
        after,
        time,
      })}\n`)
    } catch (error) {
      ctx.logger.warn('reasoning-reverse-match: failed to write logFile: %s', error)
    }
  }
}

/**
 * Global reentry mark. `Symbol.for` survives a second `apply` and a fresh
 * module evaluation; a `Symbol()` created per evaluation would not.
 */
const REENTRY = Symbol.for('dsh.reasoning-reverse-match.reentry')

/**
 * Whether `options` already carries this plugin's one-shot reentry mark.
 * @param options - an `llm/stream` request, including a clone this plugin built.
 * @returns `true` when the non-enumerable reentry mark is set to `true`.
 */
export function isReasoningReverseMatchReentry(options: GenerateOptions): boolean {
  const desc = Object.getOwnPropertyDescriptor(options, REENTRY)
  return desc !== undefined && 'value' in desc && desc.value === true
}

/**
 * Copy `options` by property descriptor, then install shortened `messages`
 * and the reentry mark.
 *
 * A frozen request stores `messages` as non-writable and non-configurable.
 * Copying that descriptor and then defining `messages` again throws TypeError,
 * so the loop skips `messages` and the replacement is defined on its own.
 * `enumerable` follows the original descriptor. `writable` and `configurable`
 * stay true until a final `Object.freeze`, which runs only when `options` is
 * already frozen. The copy is not agent-loop marked.
 * @param options - the request observed on this waterfall entry.
 * @param messages - assistant reasoning with matched spans removed.
 * @returns the request re-dispatched through `ctx.llm.stream`.
 */
function cloneRequest(options: GenerateOptions, messages: GenerateOptions['messages']): GenerateOptions {
  const copy: GenerateOptions = Object.create(Object.getPrototypeOf(options))
  for (const key of Reflect.ownKeys(options)) {
    if (key === 'messages') continue
    const desc = Object.getOwnPropertyDescriptor(options, key)
    if (desc !== undefined) Object.defineProperty(copy, key, desc)
  }
  const messagesDesc = Object.getOwnPropertyDescriptor(options, 'messages')
  Object.defineProperty(copy, 'messages', {
    value: messages,
    enumerable: messagesDesc?.enumerable ?? true,
    writable: true,
    configurable: true,
  })
  Object.defineProperty(copy, REENTRY, {
    value: true,
    enumerable: false,
    writable: false,
    configurable: false,
  })
  return Object.isFrozen(options) ? Object.freeze(copy) : copy
}

/**
 * Merge inline `phrases` with `phrasesFile`.
 * @param config - plugin config after schema defaults.
 * @returns the phrase list used for matching.
 * @throws when `phrasesFile` is set but empty, unreadable, or not a valid table.
 */
export function resolveConfiguredPhrases(config: Config): string[] {
  if (config.phrasesFile === undefined) return mergePhrases(config.phrases, [])
  if (config.phrasesFile.length === 0) {
    throw new Error('reasoning-reverse-match: phrasesFile is empty')
  }
  return mergePhrases(config.phrases, loadPhrasesFile(config.phrasesFile))
}

function recordSkips(
  ctx: Context,
  config: Config,
  options: GenerateOptions,
  skipped: readonly SkippedReasoningBlock[],
): void {
  const sessionId = options.sessionId === undefined ? '' : String(options.sessionId)
  const time = Date.now()
  for (const skip of skipped) {
    ctx.logger.warn(
      'reasoning-reverse-match: kept reasoning block %d of message %d unchanged; deleting matched lines would leave it empty or whitespace-only (session %s)',
      skip.blockIndex,
      skip.messageIndex,
      sessionId || '(none)',
    )
  }
  if (!config.logFile) return
  try {
    for (const skip of skipped) {
      appendFileSync(config.logFile, `${JSON.stringify({
        kind: 'skip-blank',
        sessionId,
        messageIndex: skip.messageIndex,
        blockIndex: skip.blockIndex,
        time,
      })}\n`)
    }
  } catch (error) {
    ctx.logger.warn('reasoning-reverse-match: failed to write logFile: %s', error)
  }
}

/**
 * Apply the plugin: register an `llm/stream` listener that rewrites request
 * bodies that replay assistant reasoning, without mutating the durable session log.
 * @param ctx - plugin context; `llm` is injected so re-entry can call `ctx.llm.stream`.
 * @param config - phrase table, hit limits, and `tailFraction`.
 * @throws when `tailFraction` is outside (0, 1] or `phrasesFile` cannot be read. The listener is not registered in that case.
 */
export function apply(ctx: Context, config: Config): void {
  const tailFraction = resolveTailFraction(config.tailFraction ?? 0.25)
  const rewriteConfig: RewriteConfig = {
    phrases: resolveConfiguredPhrases(config),
    remove: config.remove,
    maxHitsPerBlock: config.maxHitsPerBlock,
    tailFraction,
  }

  // Not prepended: checkpoint and reconstructability listeners, registered
  // earlier, observe the original request. This listener then either returns
  // `next()` (no hit, or already marked) or re-enters with a clone.
  // Agent-loop steps, subagents, and unmarked replays such as compaction all
  // pass through here. A request with no matching assistant reasoning keeps
  // the caller's object.
  ctx.on('llm/stream', (options: GenerateOptions, next: () => AsyncIterable<StreamChunk>): AsyncIterable<StreamChunk> => {
    if (isReasoningReverseMatchReentry(options)) return next()
    const rewritten = rewriteRequestMessages(options.messages, rewriteConfig)
    if (rewritten === undefined) return next()
    if (rewritten.skipped.length > 0) recordSkips(ctx, config, options, rewritten.skipped)
    if (rewritten.passthrough) return next()
    recordHits(ctx, config, options, rewritten.hits, options.messages, rewritten.messages)
    return ctx.llm.stream(cloneRequest(options, rewritten.messages))
  })
}
