import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, {
  createAssistantMessage,
  createUserMessage,
  isAgentLoopRequest,
  LlmAdapter,
  markAgentLoopRequest,
  type GenerateOptions,
  type LlmResolvedModelInfo,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { apply, Config } from '../src/reasoning-reverse-match.ts'

class CaptureAdapter extends LlmAdapter {
  requests: GenerateOptions[] = []
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }
  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'ok' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'ok' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const out: StreamChunk[] = []
  for await (const chunk of stream) out.push(chunk)
  return out
}

describe('llm/stream wire rewrite', () => {
  it('removes matched spans from the adapter-visible body and leaves the caller messages intact', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    const adapter = new CaptureAdapter()
    ctx.llm.registerAdapter(['mock'], adapter)
    const hits: unknown[] = []
    ctx.on('reasoning-reverse-match/hit', (hit) => hits.push(hit))
    apply(ctx, Config({ phrases: ['letsgo'], remove: 'match', maxHitsPerBlock: 1, tailFraction: 1 }))

    const reasoning = 'think LETSGO more'
    const messages = Object.freeze([
      createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }),
      createAssistantMessage({
        content: [{ type: 'reasoning', text: reasoning }, { type: 'text', text: 'done' }],
        source: { provider: 'mock', model: 'mock' },
      }),
      createUserMessage({ content: [{ type: 'text', text: 'again' }], source: { kind: 'user' } }),
    ])
    const request = markAgentLoopRequest(Object.freeze({
      provider: 'mock',
      model: 'mock',
      messages,
    }))

    await collect(ctx.llm.stream(request))

    expect(isAgentLoopRequest(request)).toBe(true)
    expect((request.messages[1]!.content[0] as { text: string }).text).toBe(reasoning)
    expect(adapter.requests).toHaveLength(1)
    expect(isAgentLoopRequest(adapter.requests[0]!)).toBe(false)
    expect((adapter.requests[0]!.messages[1]!.content[0] as { text: string }).text).toBe('think  more')
    expect(hits).toHaveLength(1)
    expect(hits[0]).toMatchObject({ messageIndex: 1, blockIndex: 0, removed: ['LETSGO'] })
  })

  it('also rewrites unmarked history replays (compaction) without freezing caller inputs', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    const adapter = new CaptureAdapter()
    ctx.llm.registerAdapter(['mock'], adapter)
    apply(ctx, Config({ phrases: ['letsgo'], tailFraction: 1 }))

    const user = createUserMessage({ content: [{ type: 'text', text: 'summarize' }], source: { kind: 'user' } })
    const options: GenerateOptions = {
      provider: 'mock',
      model: 'mock',
      purpose: 'compaction',
      messages: [
        createAssistantMessage({
          content: [{ type: 'reasoning', text: 'a LETSGO b' }],
          source: { provider: 'mock', model: 'mock' },
        }),
        user,
      ],
    }
    await collect(ctx.llm.stream(options))

    expect(adapter.requests).toHaveLength(1)
    expect((adapter.requests[0]!.messages[0]!.content[0] as { text: string }).text).toBe('a  b')
    expect((options.messages[0]!.content[0] as { text: string }).text).toBe('a LETSGO b')
    expect(Object.isFrozen(options)).toBe(false)
  })

  it('applies the same cut on every retry (fresh request object each time)', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    const adapter = new CaptureAdapter()
    ctx.llm.registerAdapter(['mock'], adapter)
    apply(ctx, Config({ phrases: ['letsgo'] }))
    // The loop re-derives the same durable messages for each retry attempt.
    const history = Object.freeze([
      createAssistantMessage({
        content: [{ type: 'reasoning', text: 'x LETSGO y' }],
        source: { provider: 'mock', model: 'mock' },
      }),
    ])
    const build = () => markAgentLoopRequest(Object.freeze({
      provider: 'mock',
      model: 'mock',
      messages: history,
    }))
    await collect(ctx.llm.stream(build()))
    await collect(ctx.llm.stream(build()))
    expect(adapter.requests).toHaveLength(2)
    expect(JSON.stringify(adapter.requests[0]!.messages)).toBe(JSON.stringify(adapter.requests[1]!.messages))
  })

  it('passes through unchanged when nothing matches', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    const adapter = new CaptureAdapter()
    ctx.llm.registerAdapter(['mock'], adapter)
    apply(ctx, Config({ phrases: ['letsgo'] }))

    const request = markAgentLoopRequest(Object.freeze({
      provider: 'mock',
      model: 'mock',
      messages: Object.freeze([
        createAssistantMessage({
          content: [{ type: 'reasoning', text: 'clean reasoning' }],
          source: { provider: 'mock', model: 'mock' },
        }),
      ]),
    }))
    await collect(ctx.llm.stream(request))
    expect(adapter.requests[0]).toBe(request)
  })
})
