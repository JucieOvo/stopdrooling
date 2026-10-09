import { describe, expect, it } from 'vitest'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import {
  dropSignatures,
  planMessageRedaction,
  redactReasoningBlocks,
  rewriteRequestMessages,
} from '../src/rewrite.ts'

describe('planMessageRedaction / redactReasoningBlocks', () => {
  it('removes the reverse-matched span and drops the block signature', () => {
    const text = 'Wist Wist LETSGO Wist'
    const message = createAssistantMessage({
      content: [{ type: 'reasoning', text }, { type: 'text', text: 'done' }],
      source: {
        provider: 'p', model: 'm',
        replayState: {
          response: { kind: 'deepseek-messages', version: 1 },
          blocks: [{ type: 'reasoning', signature: 'sig-1' }, { type: 'text' }],
        },
      },
    })
    const planned = planMessageRedaction(message, {
      phrases: ['letsgo'], remove: 'match', maxHitsPerBlock: 1,
    })
    expect(planned).toBeDefined()
    const [start, end] = planned!.edits.get(0)![0]!
    expect(text.slice(start, end)).toBe('LETSGO')
    const redacted = redactReasoningBlocks(message, planned!.edits)
    expect((redacted.content[0] as { text: string }).text).toBe('Wist Wist  Wist')
    expect((message.content[0] as { text: string }).text).toBe(text)
    const blocks = (redacted.source as { replayState: { blocks: { signature?: string }[] } }).replayState.blocks
    expect(blocks[0]).toEqual({ type: 'reasoning' })
    expect(blocks[0]).not.toHaveProperty('signature')
  })

  it('tail mode cuts from the earliest hit start through the end', () => {
    const text = 'keep LETSGO drop this'
    const message = createAssistantMessage({
      content: [{ type: 'reasoning', text }],
      source: { provider: 'p', model: 'm' },
    })
    const planned = planMessageRedaction(message, {
      phrases: ['letsgo'], remove: 'tail', maxHitsPerBlock: 1,
    })!
    const redacted = redactReasoningBlocks(message, planned.edits)
    expect((redacted.content[0] as { text: string }).text).toBe('keep ')
  })
})

describe('dropSignatures', () => {
  it('is a no-op when there is no replayState', () => {
    const source = { provider: 'p', model: 'm' } as const
    expect(dropSignatures(source as never, new Set([0]))).toBe(source)
  })
})

describe('rewriteRequestMessages', () => {
  it('returns undefined when nothing matches (stable identity for the stream hook)', () => {
    const messages = [
      createUserMessage({ content: [{ type: 'text', text: 'q' }], source: { kind: 'user' } }),
      createAssistantMessage({
        content: [{ type: 'reasoning', text: 'only Wist here' }, { type: 'text', text: 'a' }],
        source: { provider: 'p', model: 'm' },
      }),
    ]
    expect(rewriteRequestMessages(messages, {
      phrases: ['letsgo'], remove: 'match', maxHitsPerBlock: 1,
    })).toBeUndefined()
  })

  it('rewrites only assistant reasoning and leaves user messages alone', () => {
    const reasoning = 'prefix LETSGO suffix'
    const messages = [
      createUserMessage({ content: [{ type: 'text', text: 'LETSGO in user' }], source: { kind: 'user' } }),
      createAssistantMessage({
        content: [{ type: 'reasoning', text: reasoning }, { type: 'text', text: 'ok' }],
        source: { provider: 'p', model: 'm' },
      }),
    ]
    const result = rewriteRequestMessages(messages, {
      phrases: ['letsgo'], remove: 'match', maxHitsPerBlock: 1,
    })!
    expect(result.messages[0]).toBe(messages[0])
    expect((result.messages[1]!.content[0] as { text: string }).text).toBe('prefix  suffix')
    expect((messages[1]!.content[0] as { text: string }).text).toBe(reasoning)
    expect(result.hits).toHaveLength(1)
    expect(result.hits[0]!.messageIndex).toBe(1)
    expect(result.hits[0]!.removed[0]).toBe('LETSGO')
  })
})
