import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { removeRanges } from '../src/matcher.ts'
import { planParagraph, reasoningCutoff, resolveTailFraction } from '../src/paragraph.ts'
import { apply, Config } from '../src/reasoning-reverse-match.ts'
import { rewriteRequestMessages, type RewriteConfig } from '../src/rewrite.ts'

const PHRASES = ['ok.', 'writing.', 'let me write.', 'ok — emitting now.', '好。', '（写）', '写。']

function paragraphText(text: string, tailFraction?: number): string | undefined {
  const plan = planParagraph(text, PHRASES, tailFraction)
  if (plan === undefined || plan.skip) return undefined
  return removeRanges(text, plan.ranges)
}

function assistant(text: string) {
  return createAssistantMessage({
    content: [{ type: 'reasoning', text }],
    source: { provider: 'p', model: 'm' },
  })
}

function cut(
  text: string,
  config: RewriteConfig,
): string | undefined {
  const result = rewriteRequestMessages([assistant(text)], config)
  if (result === undefined || result.passthrough) return undefined
  return (result.messages[0]!.content[0] as { text: string }).text
}

describe('tailFraction cutoff', () => {
  it('uses UTF-16 length and deletes a line that starts at the cutoff', () => {
    const text = 'aaaaa\nok.'
    expect(text.length).toBe(9)
    expect(reasoningCutoff(text.length, 0.25)).toBe(6)
    expect(text.indexOf('ok.')).toBe(6)
    expect(paragraphText(text, 0.25)).toBe('aaaaa')
  })

  it('keeps a line that starts one code unit before the cutoff, including when it extends past it', () => {
    const text = 'aaaa\nok.'
    expect(text.length).toBe(8)
    expect(reasoningCutoff(text.length, 0.25)).toBe(6)
    expect(text.indexOf('ok.')).toBe(5)
    expect(text.indexOf('ok.') + 'ok.'.length).toBeGreaterThan(6)
    expect(paragraphText(text, 0.25)).toBeUndefined()
    expect(text).toBe('aaaa\nok.')
  })

  it('keeps the line before the cutoff and deletes the line that starts on it', () => {
    const text = 'aaaa\nok.\nok.'
    expect(reasoningCutoff(text.length, 0.25)).toBe(9)
    expect(paragraphText(text, 0.25)).toBe('aaaa\nok.')
  })

  it('counts an ineligible hit as a kept line when measuring blank runs', () => {
    const text = `A\n\nok.\n\n${'z'.repeat(30)}\nok.\nC`
    const cutoff = reasoningCutoff(text.length, 0.25)
    const first = text.indexOf('ok.')
    const second = text.indexOf('ok.', first + 1)
    expect(first).toBeLessThan(cutoff)
    expect(second).toBeGreaterThanOrEqual(cutoff)
    expect(paragraphText(text, 0.25)).toBe(`A\n\nok.\n\n${'z'.repeat(30)}\nC`)
  })

  it('skips a block only when the eligible hits would leave it blank', () => {
    const both = 'ok.\nok.'
    expect(planParagraph(both, PHRASES, 1)?.skip).toBe(true)

    const partial = 'ok.\n\n\nok.'
    expect(partial.indexOf('ok.')).toBe(0)
    expect(partial.lastIndexOf('ok.')).toBe(reasoningCutoff(partial.length, 0.25))
    expect(paragraphText(partial, 0.25)).toBe('ok.')
    expect(planParagraph(partial, PHRASES, 0.25)?.skip).toBe(false)

    const tailOnly = `${'\n'.repeat(10)}ok.`
    expect(reasoningCutoff(tailOnly.length, 0.25)).toBeLessThanOrEqual(tailOnly.indexOf('ok.'))
    expect(planParagraph(tailOnly, PHRASES, 0.25)?.skip).toBe(true)
    expect(paragraphText(tailOnly, 0.25)).toBeUndefined()
  })

  it('matches tailFraction 1 to the previous whole-block samples', () => {
    const expected: [string, string | undefined][] = [
      ['ok.\nrest', 'rest'],
      ['rest\nok.', 'rest'],
      ['keep\n  \tok. \t\nmore', 'keep\nmore'],
      ['OK.\nrest', 'rest'],
      ['ok  —  emitting   now.\nrest', 'rest'],
      ['ok -- emitting now.\nrest', 'rest'],
      ['before\nok.\nok.\nok.\nafter', 'before\nafter'],
      ['好。\n继续', '继续'],
      ['（写）\n继续', '继续'],
      ['写。\n继续', '继续'],
      ['我来写。\n继续', undefined],
      ['A\nok.\nB', 'A\nB'],
      ['A\n\nok.\n\nB', 'A\n\nB'],
      ['A\n\n\nok.\n\nB', 'A\n\n\nB'],
      ['A\n\nok.\n\n\nB', 'A\n\n\nB'],
      ['A\n\nB\nok.', 'A\n\nB'],
      ['ok.\nA', 'A'],
      ['A\n\n\nB\nok.\n\nC', 'A\n\n\nB\n\nC'],
      ['A\n\nok.\nok.\n\nB', 'A\n\nB'],
      ['\n\nok.\ntext', 'text'],
      ['\n\ntext\nok.', '\n\ntext'],
      ['ok.\n\nA', 'A'],
      ['A\n\nok.', 'A'],
      ['ok.\nwriting.\n\nA\n\nB', 'A\n\nB'],
      ['A\n\nok.\n', 'A\n'],
      ['A\r\nok.\r\nB', 'A\r\nB'],
      ['A\r\n\r\nok.\r\n\r\nB', 'A\r\n\r\nB'],
      ['  A \t\n\nok.\n\t B  ', '  A \t\n\n\t B  '],
      ['look.', undefined],
      ['ok. writing the tests now', undefined],
    ]
    for (const [text, want] of expected) {
      expect(paragraphText(text, 1), text).toBe(want)
      expect(paragraphText(text), text).toBe(want)
      const message = [assistant(text)]
      const omitted = rewriteRequestMessages(message, { phrases: PHRASES, remove: 'paragraph', maxHitsPerBlock: 1 })
      const explicit = rewriteRequestMessages(message, { phrases: PHRASES, remove: 'paragraph', maxHitsPerBlock: 1, tailFraction: 1 })
      expect(explicit?.passthrough).toBe(omitted?.passthrough)
      expect(explicit?.skipped).toEqual(omitted?.skipped)
      const read = (result: typeof omitted): string => {
        if (result === undefined || result.passthrough) return text
        return (result.messages[0]!.content[0] as { text: string }).text
      }
      expect(read(explicit), text).toBe(read(omitted))
    }
  })
})

describe('match and tail cutoff', () => {
  const phrases = ['letsgo']

  it('deletes a hit that starts at the cutoff and keeps one that starts one unit earlier', () => {
    const onCutoff = `${'x'.repeat(15)}LETSGO`
    const before = `${'x'.repeat(14)}LETSGO`
    expect(onCutoff.indexOf('LETSGO')).toBe(reasoningCutoff(onCutoff.length, 0.25))
    expect(before.indexOf('LETSGO')).toBe(reasoningCutoff(before.length, 0.25) - 1)
    expect(before.indexOf('LETSGO') + 'LETSGO'.length).toBeGreaterThan(reasoningCutoff(before.length, 0.25))
    expect(cut(onCutoff, { phrases, remove: 'match', maxHitsPerBlock: 1, tailFraction: 0.25 })).toBe('x'.repeat(15))
    expect(cut(before, { phrases, remove: 'match', maxHitsPerBlock: 1, tailFraction: 0.25 })).toBeUndefined()
  })

  it('measures the cutoff in UTF-16 code units', () => {
    const text = `😀${'x'.repeat(13)}LETSGO`
    expect('😀'.length).toBe(2)
    expect(text.length).toBe(21)
    expect(text.indexOf('LETSGO')).toBe(15)
    expect(reasoningCutoff(text.length, 0.25)).toBe(15)
    expect(cut(text, { phrases, remove: 'match', maxHitsPerBlock: 1, tailFraction: 0.25 })).toBe(`😀${'x'.repeat(13)}`)
  })

  it('filters hits before the cap in match and tail mode', () => {
    const text = `LETSGO ${'y'.repeat(80)}LETSGO xx LETSGO`
    const cutoff = reasoningCutoff(text.length, 0.25)
    const starts = [...text.matchAll(/LETSGO/g)].map(match => match.index)
    expect(starts).toEqual([0, 87, 97])
    expect(starts[0]).toBeLessThan(cutoff)
    expect(starts[1]).toBeGreaterThanOrEqual(cutoff)
    expect(starts[2]).toBeGreaterThanOrEqual(cutoff)

    const matchOne = cut(text, { phrases, remove: 'match', maxHitsPerBlock: 1, tailFraction: 0.25 })
    expect(matchOne).toBe(`LETSGO ${'y'.repeat(80)}LETSGO xx `)
    const matchTwo = cut(text, { phrases, remove: 'match', maxHitsPerBlock: 2, tailFraction: 0.25 })
    expect(matchTwo).toBe(`LETSGO ${'y'.repeat(80)} xx `)
    const tailOne = cut(text, { phrases, remove: 'tail', maxHitsPerBlock: 1, tailFraction: 0.25 })
    expect(tailOne).toBe(text.slice(0, 97))
    const tailTwo = cut(text, { phrases, remove: 'tail', maxHitsPerBlock: 2, tailFraction: 0.25 })
    expect(tailTwo).toBe(`LETSGO ${'y'.repeat(80)}`)
  })

  it('matches tailFraction 1 to an uncapped whole-block match', () => {
    const text = 'aaa LETSGO bbb LETSGO ccc'
    const whole = { phrases, remove: 'match' as const, maxHitsPerBlock: 2 }
    expect(cut(text, whole)).toBe(cut(text, { ...whole, tailFraction: 1 }))
    expect(cut(text, { ...whole, remove: 'tail' })).toBe('aaa ')
    expect(cut(text, { ...whole, remove: 'tail', tailFraction: 1 })).toBe('aaa ')
  })
})

describe('tailFraction determinism', () => {
  const config: RewriteConfig = { phrases: PHRASES, remove: 'paragraph', maxHitsPerBlock: 1, tailFraction: 0.25 }

  it('returns the same edit when the same block is planned twice', () => {
    const text = 'aaaaa\nok.'
    const view = (text: string) => {
      const result = rewriteRequestMessages([assistant(text)], config)!
      return {
        text: (result.messages[0]!.content[0] as { text: string }).text,
        ranges: result.hits.map(hit => hit.ranges),
        removed: result.hits.map(hit => hit.removed),
        skipped: result.skipped,
      }
    }
    const first = view(text)
    const second = view(text)
    expect(second).toEqual(first)
    expect(first.text).toBe('aaaaa')
  })

  it('replays earlier blocks unchanged across three growing requests', () => {
    const blocks = [
      'aaaaa\nok.',
      `${'b'.repeat(20)}\nwriting.`,
      `${'c'.repeat(20)}\nok.`,
    ]
    const rounds = [1, 2, 3].map(count => rewriteRequestMessages(blocks.slice(0, count).map(assistant), config)!)
    const edited = rounds.map(round => round.messages.map(message => (message.content[0] as { text: string }).text))
    expect(edited[0]![0]).toBe('aaaaa')
    expect(edited[1]![0]).toBe(edited[0]![0])
    expect(edited[1]![1]).toBe('b'.repeat(20))
    expect(edited[2]![0]).toBe(edited[0]![0])
    expect(edited[2]![1]).toBe(edited[1]![1])
    expect(edited[2]![2]).toBe('c'.repeat(20))
    const user = createUserMessage({ content: [{ type: 'text', text: 'next' }], source: { kind: 'user' } })
    const withUser = rewriteRequestMessages([assistant(blocks[0]!), user, assistant(blocks[1]!)], config)!
    expect((withUser.messages[0]!.content[0] as { text: string }).text).toBe(edited[0]![0])
    expect(withUser.messages[1]).toBe(user)
    expect((withUser.messages[2]!.content[0] as { text: string }).text).toBe(edited[1]![1])
  })
})

describe('tailFraction config', () => {
  it('defaults the plugin to 0.25 and the pure helper omission to 1', () => {
    expect(Config({ phrases: ['ok.'] }).tailFraction).toBe(0.25)
    expect(resolveTailFraction(undefined)).toBe(1)
    expect(resolveTailFraction(0.25)).toBe(0.25)
    expect(resolveTailFraction(1)).toBe(1)
  })

  it('throws at startup for values outside (0, 1]', () => {
    for (const tailFraction of [0, -0.1, 1.01, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => apply(new Context(), Config({ phrases: ['ok.'], tailFraction })), String(tailFraction)).toThrow(/tailFraction/)
    }
  })

  it('rejects negatives and values above 1 in the schema, and still accepts 0', () => {
    expect(() => Config({ phrases: ['ok.'], tailFraction: -0.1 })).toThrow(/tailFraction/)
    expect(() => Config({ phrases: ['ok.'], tailFraction: 1.01 })).toThrow(/tailFraction/)
    expect(() => Config({ phrases: ['ok.'], tailFraction: Number.POSITIVE_INFINITY })).toThrow(/tailFraction/)
    expect(Config({ phrases: ['ok.'], tailFraction: 0 }).tailFraction).toBe(0)
    expect(Config({ phrases: ['ok.'], tailFraction: 1 }).tailFraction).toBe(1)
  })
})
