import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { createAssistantMessage } from '@deepseek-ai/dsh-llm'
import { removeRanges } from '../src/matcher.ts'
import { canonicalizeParagraph, planParagraph } from '../src/paragraph.ts'
import { parsePhrasesTable } from '../src/phrases.ts'
import { rewriteRequestMessages } from '../src/rewrite.ts'

function loadClient(): {
  canonicalizeParagraph: (text: string) => string
  paragraphRemovalRanges: (
    text: string,
    phrases: readonly string[],
    tailFraction?: number,
  ) => { ranges: [number, number][]; phrases: string[] } | null
  scanReasoning: (
    text: string,
    phrases: readonly string[],
    remove: 'match' | 'tail' | 'paragraph',
    maxHits: number,
    tailFraction?: number,
  ) => { ranges: [number, number][]; phrases: string[] } | null
  LOOP_PHRASES: string[]
  DEFAULT_TAIL_FRACTION: number
} {
  const src = readFileSync(fileURLToPath(new URL('../client/client.js', import.meta.url)), 'utf8')
  const startMark = '/*__PARAGRAPH_EXPORTS__*/'
  const endMark = '/*__PARAGRAPH_EXPORTS_END__*/'
  const start = src.indexOf(startMark)
  const end = src.indexOf(endMark)
  if (start < 0 || end < start) throw new Error('client paragraph exports not found')
  const body = src.slice(start + startMark.length, end)
  return new Function(`${body}; return { canonicalizeParagraph, paragraphRemovalRanges, scanReasoning, LOOP_PHRASES, DEFAULT_TAIL_FRACTION }`)() as {
    canonicalizeParagraph: (text: string) => string
    paragraphRemovalRanges: (
      text: string,
      phrases: readonly string[],
      tailFraction?: number,
    ) => { ranges: [number, number][]; phrases: string[] } | null
    scanReasoning: (
      text: string,
      phrases: readonly string[],
      remove: 'match' | 'tail' | 'paragraph',
      maxHits: number,
      tailFraction?: number,
    ) => { ranges: [number, number][]; phrases: string[] } | null
    LOOP_PHRASES: string[]
    DEFAULT_TAIL_FRACTION: number
  }
}

function serverView(
  text: string,
  phrases: readonly string[],
  tailFraction: number,
): { ranges: [number, number][]; phrases: string[] } | null {
  const plan = planParagraph(text, phrases, tailFraction)
  if (plan === undefined || plan.skip) return null
  return {
    ranges: plan.ranges.map(range => [range[0], range[1]]),
    phrases: plan.hits.map(hit => hit.phrase),
  }
}

const fixture = readFileSync(fileURLToPath(new URL('./fixtures/loop-phrases.tsv', import.meta.url)), 'utf8')
const phrases = parsePhrasesTable(fixture, 'tsv')
const client = loadClient()

const samples = [
  'look.',
  'token.',
  'book.',
  'ok. writing the tests now',
  'Fine, ok.',
  'I was going to stop, but ok. is only a word in this long paragraph.',
  'ok.\nrest',
  'rest\nok.',
  'keep\n  \tok. \t\nmore',
  'OK.\nrest',
  'ok  —  emitting   now.\nrest',
  'ok -- emitting now.\nrest',
  'ok - emitting now.\nrest',
  'before\nok.\nok.\nok.\nafter',
  '好。\n继续',
  '（写）\n继续',
  '写。\n继续',
  '我来写。\n继续',
  '(写)\n继续',
  'A\nok.\nB',
  'A\n\nok.\n\nB',
  'A\n\n\nok.\n\nB',
  'A\n\nok.\n\n\nB',
  'A\n\nB\nok.',
  'ok.\nA',
  'A\n\n\nB\nok.\n\nC',
  'A\n\nok.\nok.\n\nB',
  '\n\nok.\ntext',
  '\n\ntext\nok.',
  'ok.\n\nA',
  'A\n\nok.',
  'ok.\nwriting.\n\nA\n\nB',
  'A\n\nok.\n',
  'A\r\nok.\r\nB',
  'A\r\n\r\nok.\r\n\r\nB',
  '  A \t\n\nok.\n\t B  ',
  'ok.\nok.\nok.',
  'ok.\n   ',
  'go.',
  'look.\ngo.\nbook.',
]

/** Line starts sit on the cutoff, one code unit before it, or across it. */
const cutoffSamples = [
  'aaaaa\nok.',
  'aaaa\nok.',
  'aaaa\nok.\nok.',
  `A\n\nok.\n\n${'z'.repeat(30)}\nok.\nC`,
  `${'\n'.repeat(10)}ok.`,
  'ok.\nok.',
  `😀${'x'.repeat(13)}\nok.`,
  'before\nok.\nok.\nok.\nafter',
]

describe('client paragraph matcher', () => {
  it('embeds the same 35 phrases as the TSV fixture', () => {
    expect(client.LOOP_PHRASES).toEqual(phrases)
    const patch = readFileSync(fileURLToPath(new URL('../cordis.patch.yml', import.meta.url)), 'utf8')
    expect(patch).toContain('remove: paragraph')
    const listed = [...patch.matchAll(/^\s+-\s+(?:'([^']*)'|"([^"]*)")\s*$/gm)].map(match => match[1] ?? match[2])
    expect(listed).toEqual(phrases)
  })

  it('matches the server on canonical keys and removal ranges', () => {
    const keys = ['OK.', 'ok  —  emitting   now.', 'ok -- emitting now.', 'ok - emitting now.', '（写）', '(写)', "I'll write."]
    for (const key of keys) {
      expect(client.canonicalizeParagraph(key), key).toBe(canonicalizeParagraph(key))
    }
    for (const tailFraction of [0.25, 1]) {
      for (const text of samples) {
        const fromClient = client.paragraphRemovalRanges(text, phrases, tailFraction)
        const fromServer = serverView(text, phrases, tailFraction)
        expect(fromClient, `${tailFraction} ${text}`).toEqual(fromServer)
        if (fromServer) {
          expect(removeRanges(text, fromClient!.ranges)).toBe(removeRanges(text, fromServer.ranges))
        }
      }
    }
    for (const phrase of phrases) {
      const alone = `${phrase}\nkeep`
      const padded = `note ${phrase}`
      for (const tailFraction of [0.25, 1]) {
        expect(client.paragraphRemovalRanges(alone, phrases, tailFraction), `${tailFraction} ${alone}`).toEqual(serverView(alone, phrases, tailFraction))
        expect(client.paragraphRemovalRanges(padded, phrases, tailFraction), `${tailFraction} ${padded}`).toBeNull()
        expect(serverView(padded, phrases, tailFraction), `${tailFraction} ${padded}`).toBeNull()
      }
    }
  })

  it('matches the server on cutoff boundaries for 0.25 and 1, and hardcodes 0.25', () => {
    expect(client.DEFAULT_TAIL_FRACTION).toBe(0.25)
    const onCutoff = 'aaaaa\nok.'
    const beforeCutoff = 'aaaa\nok.'
    expect(client.paragraphRemovalRanges(onCutoff, phrases)).toEqual(client.paragraphRemovalRanges(onCutoff, phrases, 0.25))
    expect(client.paragraphRemovalRanges(beforeCutoff, phrases)).toBeNull()
    expect(serverView(beforeCutoff, phrases, 1)).not.toBeNull()
    for (const tailFraction of [0.25, 1]) {
      for (const text of cutoffSamples) {
        const fromClient = client.paragraphRemovalRanges(text, phrases, tailFraction)
        const fromServer = serverView(text, phrases, tailFraction)
        expect(fromClient, `${tailFraction} ${JSON.stringify(text)}`).toEqual(fromServer)
        const clientText = fromClient ? removeRanges(text, fromClient.ranges) : text
        const serverText = fromServer ? removeRanges(text, fromServer.ranges) : text
        expect(clientText, `${tailFraction} ${JSON.stringify(text)}`).toBe(serverText)
      }
    }
  })

  it('matches the server match and tail cuts on cutoff samples', () => {
    const head = `LETSGO ${'y'.repeat(80)}`
    const texts = [
      `${'x'.repeat(15)}LETSGO`,
      `${'x'.repeat(14)}LETSGO`,
      `${head}LETSGO xx LETSGO`,
      `😀${'x'.repeat(13)}LETSGO`,
    ]
    function serverCut(text: string, remove: 'match' | 'tail', maxHits: number, tailFraction: number): string {
      const result = rewriteRequestMessages([
        createAssistantMessage({
          content: [{ type: 'reasoning', text }],
          source: { provider: 'p', model: 'm' },
        }),
      ], { phrases: ['letsgo'], remove, maxHitsPerBlock: maxHits, tailFraction })
      if (result === undefined || result.passthrough) return text
      return (result.messages[0]!.content[0] as { text: string }).text
    }
    for (const tailFraction of [0.25, 1]) {
      for (const maxHits of [1, 2]) {
        for (const remove of ['match', 'tail'] as const) {
          for (const text of texts) {
            const hit = client.scanReasoning(text, ['letsgo'], remove, maxHits, tailFraction)
            const fromClient = hit ? removeRanges(text, hit.ranges) : text
            expect(fromClient, `${remove} ${maxHits} ${tailFraction} ${text}`).toBe(serverCut(text, remove, maxHits, tailFraction))
          }
        }
      }
    }
  })
})
