import { describe, expect, it } from 'vitest'
import { createAssistantMessage, createUserMessage, type GenerateOptions } from '@deepseek-ai/dsh-llm'
import { serialize } from '@deepseek-ai/dsh-llm-deepseek/src/serialize.ts'
import { rewriteRequestMessages } from '../src/rewrite.ts'

const connection = { models: [], defaults: {}, maxTokens: 1024 } as never

function history(reasoning: string) {
  return [
    createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }),
    createAssistantMessage({
      content: [{ type: 'reasoning', text: reasoning }, { type: 'text', text: 'ok' }],
      source: {
        provider: 'deepseek-official', model: 'deepseek-flash',
        replayState: {
          response: { kind: 'deepseek-messages', version: 1, model: 'deepseek-flash' },
          blocks: [{ type: 'reasoning', signature: 'sig-live' }, { type: 'text' }],
        },
      },
    }),
    createUserMessage({ content: [{ type: 'text', text: 'again' }], source: { kind: 'user' } }),
  ]
}

function wire(messages: GenerateOptions['messages']) {
  const options = { provider: 'deepseek-official', model: 'deepseek-flash', messages } as GenerateOptions
  return serialize(options, connection, messages, new Map(), () => undefined as never)
}

describe('DeepSeek wire body after rewrite', () => {
  it('original body carries the phrase and the signature; rewritten body carries neither', () => {
    const original = history('My thinking must contain LETSGO on its own.')
    const before = wire(original)
    const beforeThinking = before.messages[1]!.content[0] as { type: string; thinking: string; signature?: string }
    expect(beforeThinking).toMatchObject({ type: 'thinking', signature: 'sig-live' })
    expect(beforeThinking.thinking).toContain('LETSGO')

    const rewritten = rewriteRequestMessages(original, { phrases: ['letsgo'], remove: 'match', maxHitsPerBlock: 1 })!
    const after = wire(rewritten.messages)
    const afterThinking = after.messages[1]!.content[0] as { type: string; thinking: string; signature?: string }
    expect(afterThinking.type).toBe('thinking')
    expect(afterThinking.thinking).toBe('My thinking must contain  on its own.')
    expect(afterThinking).not.toHaveProperty('signature')
    // Everything else on the wire is byte-identical.
    expect({ ...after, messages: undefined }).toEqual({ ...before, messages: undefined })
    expect(after.messages[0]).toEqual(before.messages[0])
    expect(after.messages[2]).toEqual(before.messages[2])
  })

  it('is deterministic: the same history yields the same wire bytes', () => {
    const a = rewriteRequestMessages(history('x LETSGO y'), { phrases: ['letsgo'], remove: 'match', maxHitsPerBlock: 1 })!
    const b = rewriteRequestMessages(history('x LETSGO y'), { phrases: ['letsgo'], remove: 'match', maxHitsPerBlock: 1 })!
    expect(JSON.stringify(wire(a.messages))).toBe(JSON.stringify(wire(b.messages)))
  })
})
