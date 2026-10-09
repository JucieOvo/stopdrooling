import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, {
  createAssistantMessage,
  createUserMessage,
  LlmAdapter,
  markAgentLoopRequest,
  type GenerateOptions,
  type LlmResolvedModelInfo,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import { removeRanges } from '../src/matcher.ts'
import { canonicalizeParagraph, planParagraph } from '../src/paragraph.ts'
import { apply, Config } from '../src/reasoning-reverse-match.ts'
import { rewriteRequestMessages } from '../src/rewrite.ts'

const PHRASES = ['ok.', 'writing.', 'let me write.', 'ok — emitting now.', '好。', '（写）', '写。']

function edited(text: string, phrases: readonly string[] = PHRASES): string | undefined {
  const plan = planParagraph(text, phrases)
  if (plan === undefined || plan.skip) return undefined
  return removeRanges(text, plan.ranges)
}

describe('canonicalizeParagraph', () => {
  it('lowercases ASCII, collapses spaces, and equates dash spellings without NFKC', () => {
    expect(canonicalizeParagraph('OK.')).toBe('ok.')
    expect(canonicalizeParagraph('ok  —  emitting   now.')).toBe('ok — emitting now.')
    expect(canonicalizeParagraph('ok -- emitting now.')).toBe('ok — emitting now.')
    expect(canonicalizeParagraph('ok - emitting now.')).toBe('ok — emitting now.')
    expect(canonicalizeParagraph('ok–emitting now.')).toBe('ok — emitting now.')
    expect(canonicalizeParagraph('（写）')).toBe('（写）')
    expect(canonicalizeParagraph('(写)')).toBe('(写)')
    expect(canonicalizeParagraph('（写）')).not.toBe(canonicalizeParagraph('(写)'))
  })
})

describe('paragraph misses', () => {
  it('does not match a phrase inside a longer line or a different word', () => {
    for (const text of ['look.', 'token.', 'book.', 'ok. writing the tests now', 'Fine, ok.', '我来写。']) {
      expect(edited(text), text).toBeUndefined()
    }
    const middle = 'I was going to stop, but ok. is only a word in this long paragraph about the tests.'
    expect(edited(middle)).toBeUndefined()
    expect(planParagraph(middle, PHRASES)).toBeUndefined()
  })
})

describe('paragraph hits', () => {
  it('removes a matching line at the start, the end, and with surrounding spaces', () => {
    expect(edited('ok.\nrest')).toBe('rest')
    expect(edited('rest\nok.')).toBe('rest')
    expect(edited('keep\n  \tok. \t\nmore')).toBe('keep\nmore')
    expect(edited('OK.\nrest')).toBe('rest')
    expect(edited('ok  —  emitting   now.\nrest')).toBe('rest')
    expect(edited('ok -- emitting now.\nrest')).toBe('rest')
  })

  it('removes every repeated line and ignores maxHitsPerBlock', () => {
    const text = 'before\nok.\nok.\nok.\nafter'
    expect(edited(text)).toBe('before\nafter')
    const message = createAssistantMessage({
      content: [{ type: 'reasoning', text }],
      source: { provider: 'p', model: 'm' },
    })
    const planned = rewriteRequestMessages([message], {
      phrases: PHRASES, remove: 'paragraph', maxHitsPerBlock: 1,
    })
    expect(planned?.hits[0]?.hits).toHaveLength(3)
    expect(removeRanges(text, planned!.hits[0]!.ranges)).toBe('before\nafter')
    expect((planned!.messages![0]!.content[0] as { text: string }).text).toBe('before\nafter')
  })

  it('matches Chinese lines exactly and leaves a longer line', () => {
    expect(edited('好。\n继续')).toBe('继续')
    expect(edited('（写）\n继续')).toBe('继续')
    expect(edited('写。\n继续')).toBe('继续')
    expect(edited('我来写。\n继续')).toBeUndefined()
    expect(edited('(写)\n继续', ['（写）'])).toBeUndefined()
  })
})

describe('paragraph newlines', () => {
  it('drops one newline with the line and keeps the larger blank run', () => {
    expect(edited('A\nok.\nB')).toBe('A\nB')
    expect(edited('A\n\nok.\n\nB')).toBe('A\n\nB')
    expect(edited('A\n\n\nok.\n\nB')).toBe('A\n\n\nB')
    expect(edited('A\n\nok.\n\n\nB')).toBe('A\n\n\nB')
    expect(edited('A\n\nB\nok.')).toBe('A\n\nB')
    expect(edited('ok.\nA')).toBe('A')
    expect(edited('A\n\n\nB\nok.\n\nC')).toBe('A\n\n\nB\n\nC')
    expect(edited('A\n\nok.\nok.\n\nB')).toBe('A\n\nB')
    expect(edited('\n\nok.\ntext')).toBe('text')
    expect(edited('\n\ntext\nok.')).toBe('\n\ntext')
    expect(edited('ok.\n\nA')).toBe('A')
    expect(edited('A\n\nok.')).toBe('A')
    expect(edited('ok.\nwriting.\n\nA\n\nB')).toBe('A\n\nB')
    expect(edited('A\n\nok.\n')).toBe('A\n')
    expect(edited('A\r\nok.\r\nB')).toBe('A\r\nB')
    expect(edited('A\r\n\r\nok.\r\n\r\nB')).toBe('A\r\n\r\nB')
  })

  it('does not rewrite characters outside the removed line', () => {
    const text = '  A \t\n\nok.\n\t B  '
    expect(edited(text)).toBe('  A \t\n\n\t B  ')
  })
})

describe('paragraph block that would become blank', () => {
  it('leaves the block and its signature, and records a skip', () => {
    const text = 'ok.\nok.\nok.'
    const message = createAssistantMessage({
      content: [
        { type: 'reasoning', text },
        { type: 'text', text: 'ok.' },
        { type: 'tool-call', id: ToolCallId('call-1'), name: 'read', arguments: '{}' },
        { type: 'reasoning', text: 'keep\nok.\nmore' },
      ],
      source: {
        provider: 'p', model: 'm',
        replayState: {
          response: { kind: 'deepseek-messages', version: 1 },
          blocks: [
            { type: 'reasoning', signature: 'sig-all' },
            { type: 'text' },
            { type: 'tool-call', signature: 'sig-tool' },
            { type: 'reasoning', signature: 'sig-part' },
          ],
        },
      },
    })
    const result = rewriteRequestMessages([
      createUserMessage({ content: [{ type: 'text', text: 'q' }], source: { kind: 'user' } }),
      message,
    ], { phrases: PHRASES, remove: 'paragraph', maxHitsPerBlock: 1 })
    expect(result?.skipped).toEqual([{ messageIndex: 1, blockIndex: 0 }])
    const rewritten = result!.messages![1]!
    expect(rewritten.content[0]).toBe(message.content[0])
    expect(rewritten.content[1]).toBe(message.content[1])
    expect(rewritten.content[2]).toBe(message.content[2])
    expect((rewritten.content[3] as { text: string }).text).toBe('keep\nmore')
    const blocks = (rewritten.source as { replayState: { blocks: { signature?: string }[] } }).replayState.blocks
    expect(blocks[0]).toEqual({ type: 'reasoning', signature: 'sig-all' })
    expect(blocks[2]).toEqual({ type: 'tool-call', signature: 'sig-tool' })
    expect(blocks[3]).toEqual({ type: 'reasoning' })
    expect(blocks[3]).not.toHaveProperty('signature')
  })

  it('returns the input messages when every match would blank the block', () => {
    const messages = [
      createAssistantMessage({
        content: [{ type: 'reasoning', text: 'ok.\nok.' }],
        source: { provider: 'p', model: 'm' },
      }),
    ]
    const result = rewriteRequestMessages(messages, {
      phrases: PHRASES, remove: 'paragraph', maxHitsPerBlock: 1,
    })
    expect(result?.passthrough).toBe(true)
    expect(result?.messages).toBe(messages)
    expect(result?.skipped).toEqual([{ messageIndex: 0, blockIndex: 0 }])
    expect(result?.hits).toEqual([])
  })

  it('returns undefined and the same message reference when nothing matches', () => {
    const messages = [
      createAssistantMessage({
        content: [{ type: 'reasoning', text: 'look.\ntoken.\nbook.' }, { type: 'text', text: 'ok.' }],
        source: { provider: 'p', model: 'm' },
      }),
    ]
    expect(rewriteRequestMessages(messages, {
      phrases: PHRASES, remove: 'paragraph', maxHitsPerBlock: 1,
    })).toBeUndefined()
  })
})

class CaptureAdapter extends LlmAdapter {
  requests: GenerateOptions[] = []
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }
  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

describe('paragraph plugin logging', () => {
  it('warns, appends a skip record, and passes the original request through', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rrm-skip-'))
    const logFile = join(dir, 'hits.jsonl')
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    const adapter = new CaptureAdapter()
    ctx.llm.registerAdapter(['mock'], adapter)
    const warnings: unknown[][] = []
    ctx.logger.warn = (...args: unknown[]) => { warnings.push(args) }
    apply(ctx, Config({
      phrases: ['ok.'],
      remove: 'paragraph',
      logFile,
      tailFraction: 1,
    }))
    const request = markAgentLoopRequest(Object.freeze({
      provider: 'mock',
      model: 'mock',
      messages: Object.freeze([
        createAssistantMessage({
          content: [{ type: 'reasoning', text: 'ok.\nok.' }],
          source: { provider: 'mock', model: 'mock', replayState: {
            response: { kind: 'deepseek-messages', version: 1 },
            blocks: [{ type: 'reasoning', signature: 'keep-me' }],
          } },
        }),
      ]),
    }))
    const chunks: StreamChunk[] = []
    for await (const chunk of ctx.llm.stream(request)) chunks.push(chunk)
    expect(adapter.requests[0]).toBe(request)
    expect(warnings.some(args => String(args[0]).includes('empty or whitespace-only'))).toBe(true)
    const lines = readFileSync(logFile, 'utf8').trim().split('\n').map(line => JSON.parse(line) as { kind: string })
    expect(lines.map(line => line.kind)).toEqual(['skip-blank'])
    const blocks = (request.messages[0]!.source as { replayState: { blocks: { signature?: string }[] } }).replayState.blocks
    expect(blocks[0]?.signature).toBe('keep-me')
    expect(chunks.at(-1)).toMatchObject({ type: 'finish' })
  })

  it('does not throw when the log directory is missing', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    const adapter = new CaptureAdapter()
    ctx.llm.registerAdapter(['mock'], adapter)
    const warnings: unknown[][] = []
    ctx.logger.warn = (...args: unknown[]) => { warnings.push(args) }
    apply(ctx, Config({
      phrases: ['ok.'],
      remove: 'paragraph',
      logFile: join(tmpdir(), 'rrm-missing-dir', 'nope.jsonl'),
      tailFraction: 1,
    }))
    const request = {
      provider: 'mock',
      model: 'mock',
      messages: [
        createAssistantMessage({
          content: [{ type: 'reasoning', text: 'ok.' }],
          source: { provider: 'mock', model: 'mock' },
        }),
      ],
    }
    for await (const _chunk of ctx.llm.stream(request)) { /* drain */ }
    expect(adapter.requests[0]).toBe(request)
    expect(warnings.some(args => String(args[0]).includes('failed to write logFile'))).toBe(true)
  })

  it('passes a request with no paragraph hit through as the same object', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    const adapter = new CaptureAdapter()
    ctx.llm.registerAdapter(['mock'], adapter)
    apply(ctx, Config({ phrases: ['ok.'], remove: 'paragraph' }))
    const request = markAgentLoopRequest(Object.freeze({
      provider: 'mock',
      model: 'mock',
      messages: Object.freeze([
        createAssistantMessage({
          content: [{ type: 'reasoning', text: 'look.\nbook.' }],
          source: { provider: 'mock', model: 'mock' },
        }),
      ]),
    }))
    for await (const _chunk of ctx.llm.stream(request)) { /* drain */ }
    expect(adapter.requests[0]).toBe(request)
  })
})

describe('phrasesFile wiring', () => {
  it('throws a path-bearing error when the file is missing', () => {
    const missing = join(tmpdir(), 'rrm-no-such-phrases.tsv')
    expect(() => apply(new Context(), Config({
      phrases: [],
      phrasesFile: missing,
      remove: 'paragraph',
    }))).toThrow(missing)
  })
})
