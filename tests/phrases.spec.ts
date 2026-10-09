import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  loadPhrasesFile,
  mergePhrases,
  parsePhrasesTable,
  phrasesFormat,
} from '../src/phrases.ts'
import { createAssistantMessage } from '@deepseek-ai/dsh-llm'
import { rewriteRequestMessages } from '../src/rewrite.ts'

const fixturePath = fileURLToPath(new URL('./fixtures/loop-phrases.tsv', import.meta.url))
const fixtureText = readFileSync(fixturePath, 'utf8')

describe('parsePhrasesTable', () => {
  it('reads the 35 loop phrases from the TSV fixture', () => {
    const phrases = parsePhrasesTable(fixtureText, 'tsv')
    expect(phrases).toHaveLength(35)
    expect(phrases[0]).toBe('ok.')
    expect(phrases).toContain('好。')
    expect(phrases).toContain('（写）')
    expect(phrases).toContain('写。')
    expect(phrases).toContain('let me write.')
    expect(phrases).toContain('ok — emitting now.')
    expect(phrases.at(-1)).toBe('let me output the tool call.')
    expect(loadPhrasesFile(fixturePath)).toEqual(phrases)
  })

  it('skips the header, blank rows, and empty first cells', () => {
    expect(parsePhrasesTable('段落\n\nok.\n\tignored\nwriting.\n', 'tsv')).toEqual(['ok.', 'writing.'])
    expect(parsePhrasesTable('only-header\n', 'tsv')).toEqual([])
    expect(parsePhrasesTable('\uFEFF段落\nok.\n', 'tsv')).toEqual(['ok.'])
  })

  it('parses CSV quotes and doubled quotes', () => {
    const csv = '段落,次数\n"ok.","1"\n"say ""hi"".","2"\n\nwriting.,3\n'
    expect(parsePhrasesTable(csv, 'csv')).toEqual(['ok.', 'say "hi".', 'writing.'])
  })

  it('selects the splitter from the suffix, then the first line', () => {
    expect(phrasesFormat('a.csv')).toBe('csv')
    expect(phrasesFormat('a.tsv')).toBe('tsv')
    expect(phrasesFormat('a.txt', '段落\t覆盖')).toBe('tsv')
    expect(phrasesFormat('a.txt', '段落,覆盖')).toBe('csv')
  })

  it('throws when a CSV quote is unclosed', () => {
    expect(() => parsePhrasesTable('h\n"ok.\n', 'csv')).toThrow(/unclosed quote/)
  })
})

describe('loadPhrasesFile / mergePhrases', () => {
  it('names the path when the file cannot be read', () => {
    const missing = join(tmpdir(), 'rrm-missing-phrases.tsv')
    expect(() => loadPhrasesFile(missing)).toThrow(missing)
  })

  it('merges inline phrases ahead of the file and drops exact duplicates', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rrm-merge-'))
    const file = join(dir, 'loop.csv')
    writeFileSync(file, '段落,n\n"ok.",1\n"from file.",2\n')
    expect(loadPhrasesFile(file)).toEqual(['ok.', 'from file.'])
    expect(mergePhrases(['inline.', 'ok.', ''], ['ok.', 'from file.'])).toEqual([
      'inline.', 'ok.', 'from file.',
    ])
  })

  it('removes lines from the merged table', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rrm-merge-rewrite-'))
    const file = join(dir, 'p.tsv')
    writeFileSync(file, '段落\nextra.\n')
    const phrases = mergePhrases(['ok.'], loadPhrasesFile(file))
    const messages = [
      createAssistantMessage({
        content: [{ type: 'reasoning', text: 'ok.\nextra.\nstay' }],
        source: { provider: 'p', model: 'm' },
      }),
    ]
    const result = rewriteRequestMessages(messages, {
      phrases, remove: 'paragraph', maxHitsPerBlock: 1,
    })
    expect((result!.messages![0]!.content[0] as { text: string }).text).toBe('stay')
  })
})
