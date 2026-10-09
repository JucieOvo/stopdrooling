import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, {
  createAssistantMessage,
  isAgentLoopRequest,
  LlmAdapter,
  markAgentLoopRequest,
  ReasoningEffortId,
  type GenerateOptions,
  type LlmResolvedModelInfo,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { apply, Config, isReasoningReverseMatchReentry } from '../src/reasoning-reverse-match.ts'

const REENTRY = Symbol.for('dsh.reasoning-reverse-match.reentry')
const TWO_HITS = 'one LETSGO two LETSGO three'
/** Last of the two phrases removed; maxHitsPerBlock 1 must leave the earlier one. */
const ONE_CUT = 'one LETSGO two  three'

class CaptureAdapter extends LlmAdapter {
  requests: GenerateOptions[] = []
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      reasoning: { efforts: [{ id: ReasoningEffortId('high'), name: 'High' }] },
    })
  }
  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'ok' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'ok' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

class ThrowingAdapter extends CaptureAdapter {
  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    throw new Error('adapter boom')
  }
}

class AbortAdapter extends CaptureAdapter {
  sawAborted = false
  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    yield { type: 'text-delta', index: 0, text: 'partial' }
    const signal = options.signal
    if (signal !== undefined && !signal.aborted) {
      await new Promise<void>((resolve) => {
        signal.addEventListener('abort', () => resolve(), { once: true })
      })
    }
    this.sawAborted = signal?.aborted === true
    throw new Error('aborted by caller')
  }
}

class PrepareCountingAdapter extends CaptureAdapter {
  prepareCalls = 0
  override async prepareCall(provider: string, model: string, signal?: AbortSignal) {
    this.prepareCalls += 1
    return super.prepareCall(provider, model, signal)
  }
}

async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const out: StreamChunk[] = []
  for await (const chunk of stream) out.push(chunk)
  return out
}

async function setup(adapter: LlmAdapter = new CaptureAdapter()): Promise<{
  ctx: Context
  adapter: LlmAdapter
  hits: unknown[]
}> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  ctx.llm.registerAdapter(['mock'], adapter)
  const hits: unknown[] = []
  ctx.on('reasoning-reverse-match/hit', (hit) => { hits.push(hit) })
  return { ctx, adapter, hits }
}

function installStreamCounter(llm: LlmRuntime): GenerateOptions[] {
  const calls: GenerateOptions[] = []
  const host = llm as LlmRuntime & {
    stream: (options: GenerateOptions) => AsyncIterable<StreamChunk>
  }
  const original = host.stream.bind(host)
  host.stream = (options) => {
    calls.push(options)
    return original(options)
  }
  return calls
}

function reasoningText(options: GenerateOptions): string {
  const block = options.messages[0]?.content[0]
  return block !== undefined && block.type === 'reasoning' ? block.text : ''
}

function pluginConfig(partial: {
  phrases: string[]
  remove?: Config['remove']
  maxHitsPerBlock?: number
  tailFraction?: number
}): Config {
  return Config({
    phrases: partial.phrases,
    remove: partial.remove ?? 'match',
    maxHitsPerBlock: partial.maxHitsPerBlock ?? 1,
    excerptChars: 160,
    ...partial.tailFraction === undefined ? {} : { tailFraction: partial.tailFraction },
  })
}

function twoHitRequest(signal?: AbortSignal): GenerateOptions {
  return markAgentLoopRequest(Object.freeze({
    provider: 'mock',
    model: 'mock',
    ...signal === undefined ? {} : { signal },
    messages: Object.freeze([
      createAssistantMessage({
        content: [{ type: 'reasoning', text: TWO_HITS }],
        source: { provider: 'mock', model: 'mock' },
      }),
    ]),
  }) as GenerateOptions)
}

describe('reentry mark and descriptor clone', () => {
  it('cuts one object only once when a block has two hits', async () => {
    const adapter = new CaptureAdapter()
    const { ctx, hits } = await setup(adapter)
    apply(ctx, pluginConfig({ phrases: ['letsgo'], remove: 'match', maxHitsPerBlock: 1, tailFraction: 1 }))
    const calls = installStreamCounter(ctx.llm)
    const request = twoHitRequest()

    await collect(ctx.llm.stream(request))

    expect(calls).toHaveLength(2)
    expect(calls[0]).toBe(request)
    expect(adapter.requests).toHaveLength(1)
    expect(reasoningText(adapter.requests[0]!)).toBe(ONE_CUT)
    expect(hits).toHaveLength(1)
    const clone = adapter.requests[0]!
    expect(isReasoningReverseMatchReentry(clone)).toBe(true)
    expect(isReasoningReverseMatchReentry(request)).toBe(false)

    await collect(ctx.llm.stream(clone))
    expect(adapter.requests).toHaveLength(2)
    expect(adapter.requests[1]).toBe(clone)
    expect(reasoningText(adapter.requests[1]!)).toBe(ONE_CUT)
    expect(hits).toHaveLength(1)
  })

  it('shares the reentry symbol across two apply() listeners', async () => {
    const adapter = new CaptureAdapter()
    const { ctx, hits } = await setup(adapter)
    const config = pluginConfig({ phrases: ['letsgo'], remove: 'match', maxHitsPerBlock: 1, tailFraction: 1 })
    apply(ctx, config)
    apply(ctx, config)
    const calls = installStreamCounter(ctx.llm)

    await collect(ctx.llm.stream(twoHitRequest()))

    expect(calls).toHaveLength(2)
    expect(adapter.requests).toHaveLength(1)
    expect(reasoningText(adapter.requests[0]!)).toBe(ONE_CUT)
    expect(hits).toHaveLength(1)
    expect(isReasoningReverseMatchReentry(adapter.requests[0]!)).toBe(true)
  })

  it('shows the original request to an outer listener and only the clone to an inner one', async () => {
    const adapter = new CaptureAdapter()
    const { ctx } = await setup(adapter)
    const outer: GenerateOptions[] = []
    const inner: GenerateOptions[] = []
    ctx.on('llm/stream', (options: GenerateOptions, next: () => AsyncIterable<StreamChunk>) => {
      outer.push(options)
      return next()
    })
    apply(ctx, pluginConfig({ phrases: ['letsgo'], maxHitsPerBlock: 1, tailFraction: 1 }))
    ctx.on('llm/stream', (options: GenerateOptions, next: () => AsyncIterable<StreamChunk>) => {
      inner.push(options)
      return next()
    })
    const request = twoHitRequest()

    await collect(ctx.llm.stream(request))

    expect(outer).toHaveLength(2)
    expect(outer[0]).toBe(request)
    expect(isAgentLoopRequest(outer[0]!)).toBe(true)
    expect(isAgentLoopRequest(outer[1]!)).toBe(false)
    expect(isReasoningReverseMatchReentry(outer[1]!)).toBe(true)
    expect(inner).toHaveLength(1)
    expect(inner[0]).toBe(outer[1])
    expect(adapter.requests).toHaveLength(1)
    expect(adapter.requests[0]).toBe(inner[0])
    expect(adapter.requests[0]).not.toBe(request)
  })

  it('does not fail a prepended message comparison on the shortened clone', async () => {
    const adapter = new CaptureAdapter()
    const { ctx } = await setup(adapter)
    const request = twoHitRequest()
    const original = JSON.stringify(request.messages)
    let mismatches = 0
    ctx.on('llm/stream', (options: GenerateOptions, next: () => AsyncIterable<StreamChunk>) => {
      if (isAgentLoopRequest(options) && JSON.stringify(options.messages) !== original) {
        mismatches += 1
        throw new Error('invariant messages diverged')
      }
      return next()
    }, true)
    apply(ctx, pluginConfig({ phrases: ['letsgo'], maxHitsPerBlock: 1, tailFraction: 1 }))

    const chunks = await collect(ctx.llm.stream(request))

    expect(mismatches).toBe(0)
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
    expect(reasoningText(adapter.requests[0]!)).toBe(ONE_CUT)
  })

  it('passes the caller request through when nothing matches', async () => {
    for (const config of [pluginConfig({ phrases: ['letsgo'] }), pluginConfig({ phrases: [] })]) {
      const adapter = new CaptureAdapter()
      const { ctx, hits } = await setup(adapter)
      apply(ctx, config)
      const calls = installStreamCounter(ctx.llm)
      const request = markAgentLoopRequest(Object.freeze({
        provider: 'mock',
        model: 'mock',
        messages: Object.freeze([
          createAssistantMessage({
            content: [{ type: 'reasoning', text: 'clean reasoning' }],
            source: { provider: 'mock', model: 'mock' },
          }),
        ]),
      }) as GenerateOptions)

      await collect(ctx.llm.stream(request))

      expect(calls).toHaveLength(1)
      expect(calls[0]).toBe(request)
      expect(adapter.requests).toHaveLength(1)
      expect(adapter.requests[0]).toBe(request)
      expect(hits).toEqual([])
      expect(isReasoningReverseMatchReentry(request)).toBe(false)
    }
  })

  it('keeps descriptors, prototype, and signal, and omits the agent-loop mark', async () => {
    const adapter = new CaptureAdapter()
    const { ctx } = await setup(adapter)
    apply(ctx, pluginConfig({ phrases: ['letsgo'], maxHitsPerBlock: 1, tailFraction: 1 }))

    const proto = { fromProto: 'yes' }
    const hidden = Symbol('hidden-own')
    const signal = new AbortController().signal
    const tools = [{ name: 'echo', description: 'Echo', parameters: { type: 'object', properties: {} } }]
    const toolHistory = { tools: [], updates: [] }
    const stop = ['END']
    const sessionId = 'sess-1' as GenerateOptions['sessionId']
    const reasoningEffort = ReasoningEffortId('high')
    const messages = Object.freeze([
      createAssistantMessage({
        content: [{ type: 'reasoning', text: TWO_HITS }],
        source: { provider: 'mock', model: 'mock' },
      }),
    ])
    const raw: GenerateOptions = Object.create(proto)
    const enumerable: Record<string, unknown> = {
      provider: 'mock',
      model: 'mock',
      purpose: 'compaction',
      system: 'be brief',
      tools,
      toolHistory,
      stop,
      temperature: 0.3,
      maxTokens: 64,
      reasoningEffort,
      sessionId,
      signal,
    }
    for (const [key, value] of Object.entries(enumerable)) {
      Object.defineProperty(raw, key, { value, enumerable: true, writable: true, configurable: true })
    }
    Object.defineProperty(raw, 'messages', {
      value: messages,
      enumerable: true,
      writable: true,
      configurable: true,
    })
    Object.defineProperty(raw, 'hiddenOwn', { value: 'secret', enumerable: false, writable: true, configurable: true })
    Object.defineProperty(raw, hidden, { value: 7, enumerable: false, writable: false, configurable: false })
    const request = markAgentLoopRequest(Object.freeze(raw) as GenerateOptions)

    await collect(ctx.llm.stream(request))

    const seen = adapter.requests[0]!
    expect(seen.purpose).toBe('compaction')
    expect(seen.system).toBe('be brief')
    expect(seen.tools).toBe(tools)
    expect(seen.toolHistory).toBe(toolHistory)
    expect(seen.stop).toBe(stop)
    expect(seen.temperature).toBe(0.3)
    expect(seen.maxTokens).toBe(64)
    expect(seen.reasoningEffort).toBe(reasoningEffort)
    expect(seen.sessionId).toBe(sessionId)
    expect(seen.signal).toBe(signal)
    expect(Object.getPrototypeOf(seen)).toBe(proto)
    expect((Object.getPrototypeOf(seen) as { fromProto: string }).fromProto).toBe('yes')
    expect(Object.getOwnPropertyDescriptor(seen, 'hiddenOwn')).toMatchObject({
      value: 'secret',
      enumerable: false,
    })
    expect(Object.getOwnPropertyDescriptor(seen, hidden)?.value).toBe(7)
    expect(isAgentLoopRequest(seen)).toBe(false)
    expect(isAgentLoopRequest(request)).toBe(true)
    expect(isReasoningReverseMatchReentry(seen)).toBe(true)
    expect(isReasoningReverseMatchReentry({ ...seen })).toBe(false)
    expect(Object.isFrozen(seen)).toBe(true)
    expect(Object.getOwnPropertyDescriptor(seen, 'messages')).toMatchObject({
      enumerable: true,
      writable: false,
      configurable: false,
    })
    expect(Object.getOwnPropertyDescriptor(seen, REENTRY)).toEqual({
      value: true,
      enumerable: false,
      writable: false,
      configurable: false,
    })
    expect(reasoningText(seen)).toBe(ONE_CUT)

    const hiddenMessages = {
      provider: 'mock',
      model: 'mock',
    }
    Object.defineProperty(hiddenMessages, 'messages', {
      value: messages,
      enumerable: false,
      writable: true,
      configurable: true,
    })
    await collect(ctx.llm.stream(markAgentLoopRequest(Object.freeze(hiddenMessages) as GenerateOptions)))
    const second = adapter.requests[1]!
    expect(Object.getOwnPropertyDescriptor(second, 'messages')?.enumerable).toBe(false)
    expect(reasoningText(second)).toBe(ONE_CUT)
    expect(Object.isFrozen(second)).toBe(true)
  })

  it('does not freeze an unfrozen caller or its untouched messages', async () => {
    const adapter = new CaptureAdapter()
    const { ctx } = await setup(adapter)
    apply(ctx, pluginConfig({ phrases: ['letsgo'], tailFraction: 1 }))
    const user = { role: 'user' as const, content: [{ type: 'text' as const, text: 'summarize' }] }
    const assistant = createAssistantMessage({
      content: [{ type: 'reasoning', text: 'a LETSGO b' }],
      source: { provider: 'mock', model: 'mock' },
    })
    const options: GenerateOptions = {
      provider: 'mock',
      model: 'mock',
      purpose: 'compaction',
      messages: [assistant, user],
    }

    await collect(ctx.llm.stream(options))

    const seen = adapter.requests[0]!
    expect(Object.isFrozen(options)).toBe(false)
    expect(Object.isFrozen(user)).toBe(false)
    expect(Object.isFrozen(options.messages)).toBe(false)
    expect(Object.isFrozen(seen)).toBe(false)
    expect(seen.purpose).toBe('compaction')
    expect(seen.messages[1]).toBe(user)
    expect(Object.isFrozen(seen.messages[1])).toBe(false)
    expect((options.messages[0]!.content[0] as { text: string }).text).toBe('a LETSGO b')
    expect((seen.messages[0]!.content[0] as { text: string }).text).toBe('a  b')
  })

  it('forwards the caller signal and surfaces abort on the consumer stream', async () => {
    const adapter = new AbortAdapter()
    const { ctx } = await setup(adapter)
    apply(ctx, pluginConfig({ phrases: ['letsgo'], maxHitsPerBlock: 1 }))
    const controller = new AbortController()
    const request = twoHitRequest(controller.signal)
    const iter = ctx.llm.stream(request)[Symbol.asyncIterator]()
    const first = await iter.next()
    expect(first.value).toMatchObject({ type: 'text-delta', text: 'partial' })
    controller.abort()

    const chunks: StreamChunk[] = []
    let thrown: unknown
    try {
      while (true) {
        const next = await iter.next()
        if (next.done) break
        chunks.push(next.value)
      }
    } catch (error) {
      thrown = error
    }

    expect(adapter.requests).toHaveLength(1)
    expect(adapter.requests[0]!.signal).toBe(controller.signal)
    expect(adapter.sawAborted).toBe(true)
    if (thrown !== undefined) {
      expect(thrown).toBeInstanceOf(Error)
      return
    }
    expect(chunks.some((chunk) => chunk.type === 'finish' && chunk.reason.kind === 'aborted')).toBe(true)
  })

  it('turns an adapter throw into an error finish chunk', async () => {
    const adapter = new ThrowingAdapter()
    const { ctx } = await setup(adapter)
    apply(ctx, pluginConfig({ phrases: ['letsgo'], maxHitsPerBlock: 1 }))

    const chunks = await collect(ctx.llm.stream(twoHitRequest()))

    expect(adapter.requests).toHaveLength(1)
    expect(chunks).toContainEqual(expect.objectContaining({
      type: 'finish',
      reason: expect.objectContaining({
        kind: 'error',
        failure: expect.objectContaining({ message: 'adapter boom' }),
      }),
    }))
  })

  it('propagates a synchronous rewrite failure to the consumer', async () => {
    const adapter = new CaptureAdapter()
    const { ctx } = await setup(adapter)
    apply(ctx, pluginConfig({ phrases: ['letsgo'] }))
    const messages = new Proxy([] as GenerateOptions['messages'], {
      get(target, prop, receiver) {
        if (prop === 'map') return () => { throw new Error('rewrite exploded') }
        return Reflect.get(target, prop, receiver)
      },
    })
    const request = markAgentLoopRequest(Object.freeze({
      provider: 'mock',
      model: 'mock',
      messages,
    }) as GenerateOptions)
    const chunks: StreamChunk[] = []

    await expect((async () => {
      for await (const chunk of ctx.llm.stream(request)) chunks.push(chunk)
    })()).rejects.toThrow('rewrite exploded')

    expect(chunks).toEqual([])
    expect(adapter.requests).toEqual([])
  })

  it('runs an outer checkpoint twice and skips the adapter when the second flush fails', async () => {
    const adapter = new CaptureAdapter()
    const { ctx } = await setup(adapter)
    let flushes = 0
    ctx.on('llm/stream', (_options: GenerateOptions, next: () => AsyncIterable<StreamChunk>) => {
      return (async function* () {
        flushes += 1
        await Promise.resolve()
        yield* next()
      })()
    })
    apply(ctx, pluginConfig({ phrases: ['letsgo'], maxHitsPerBlock: 1, tailFraction: 1 }))

    await collect(ctx.llm.stream(twoHitRequest()))
    expect(flushes).toBe(2)
    expect(adapter.requests).toHaveLength(1)

    const failing = new CaptureAdapter()
    const second = await setup(failing)
    let failingFlushes = 0
    second.ctx.on('llm/stream', (_options: GenerateOptions, next: () => AsyncIterable<StreamChunk>) => {
      return (async function* () {
        failingFlushes += 1
        await Promise.resolve()
        if (failingFlushes >= 2) throw new Error('second flush failed')
        yield* next()
      })()
    })
    apply(second.ctx, pluginConfig({ phrases: ['letsgo'], maxHitsPerBlock: 1, tailFraction: 1 }))

    await expect(collect(second.ctx.llm.stream(twoHitRequest()))).rejects.toThrow('second flush failed')
    expect(failingFlushes).toBe(2)
    expect(failing.requests).toHaveLength(0)
  })

  it('prepares the adapter again when a prepared call is rewritten', async () => {
    const adapter = new PrepareCountingAdapter()
    const { ctx } = await setup(adapter)
    apply(ctx, pluginConfig({ phrases: ['letsgo'], maxHitsPerBlock: 1, tailFraction: 1 }))
    const request = twoHitRequest()
    const prepared = await ctx.llm.prepareCall({ provider: 'mock', model: 'mock' })
    expect(adapter.prepareCalls).toBe(1)

    const chunks = await collect(prepared.stream(request))

    expect(adapter.prepareCalls).toBe(2)
    expect(adapter.requests).toHaveLength(1)
    expect(reasoningText(adapter.requests[0]!)).toBe(ONE_CUT)
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
    expect(JSON.stringify(chunks)).not.toContain('INVALID_PREPARED_CALL')
  })

  it('drops only the edited reasoning signature on the adapter-visible message', async () => {
    const adapter = new CaptureAdapter()
    const { ctx } = await setup(adapter)
    apply(ctx, pluginConfig({ phrases: ['letsgo'], remove: 'match', maxHitsPerBlock: 1, tailFraction: 1 }))
    const assistant = createAssistantMessage({
      content: [
        { type: 'reasoning', text: 'keep LETSGO tail' },
        { type: 'text', text: 'done' },
      ],
      source: {
        provider: 'mock',
        model: 'mock',
        replayState: {
          response: { kind: 'deepseek-messages', version: 1 },
          blocks: [
            { type: 'reasoning', signature: 'reason-sig' },
            { type: 'text', signature: 'text-sig' },
          ],
        },
      },
    })
    const request = markAgentLoopRequest(Object.freeze({
      provider: 'mock',
      model: 'mock',
      messages: Object.freeze([assistant]),
    }) as GenerateOptions)

    await collect(ctx.llm.stream(request))

    const seen = adapter.requests[0]!.messages[0]!
    expect(seen.role).toBe('assistant')
    if (seen.role !== 'assistant') return
    expect(seen.id).toBe(assistant.id)
    expect((seen.content[0] as { text: string }).text).toBe('keep  tail')
    expect(seen.content[1]).toBe(assistant.content[1])
    const blocks = (seen.source as {
      replayState: { blocks: { type?: string; signature?: string }[] }
    }).replayState.blocks
    expect(blocks[0]).toEqual({ type: 'reasoning' })
    expect(blocks[0]).not.toHaveProperty('signature')
    expect(blocks[1]).toEqual({ type: 'text', signature: 'text-sig' })
    const originalBlocks = (assistant.source as {
      replayState: { blocks: { signature?: string }[] }
    }).replayState.blocks
    expect(originalBlocks[0]?.signature).toBe('reason-sig')
  })
})
