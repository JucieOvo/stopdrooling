/**
 * Load the first column of a phrase table and merge it with inline phrases.
 * The header row is always skipped. Empty rows are ignored.
 */

import { readFileSync } from 'node:fs'

/** Which splitter `parsePhrasesTable` should use. */
export type PhrasesFormat = 'tsv' | 'csv'

/**
 * `.csv` selects comma splitting. `.tsv` selects tabs. Any other suffix uses
 * tabs when the first line contains a tab, and commas otherwise.
 * @param filePath - path as configured, used only for its suffix and a first-line sniff when the suffix is neither.
 * @param firstLine - the first line of the file, without its terminator. Used only when the suffix is neither `.csv` nor `.tsv`.
 */
export function phrasesFormat(filePath: string, firstLine = ''): PhrasesFormat {
  const lower = filePath.toLowerCase()
  if (lower.endsWith('.csv')) return 'csv'
  if (lower.endsWith('.tsv')) return 'tsv'
  return firstLine.includes('\t') ? 'tsv' : 'csv'
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

function emptyCell(cell: string): boolean {
  let start = 0
  let end = cell.length
  while (start < end && (cell.charCodeAt(start) === 32 || cell.charCodeAt(start) === 9)) start++
  while (end > start && (cell.charCodeAt(end - 1) === 32 || cell.charCodeAt(end - 1) === 9)) end--
  return start === end
}

function parseTsv(text: string): string[][] {
  const rows: string[][] = []
  let start = 0
  for (let i = 0; i <= text.length; i++) {
    if (i !== text.length && text.charCodeAt(i) !== 10) continue
    let end = i
    if (end > start && text.charCodeAt(end - 1) === 13) end--
    const line = text.slice(start, end)
    if (line.length > 0) rows.push(line.split('\t'))
    start = i + 1
  }
  return rows
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false
  let sawComma = false
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (inQuotes) {
      if (code === 34) {
        if (text.charCodeAt(i + 1) === 34) {
          field += '"'
          i++
          continue
        }
        inQuotes = false
        continue
      }
      field += text[i]
      continue
    }
    if (code === 34) {
      inQuotes = true
      continue
    }
    if (code === 44) {
      row.push(field)
      field = ''
      sawComma = true
      continue
    }
    if (code === 13) continue
    if (code === 10) {
      if (field.length > 0 || sawComma || row.length > 0) {
        row.push(field)
        rows.push(row)
      }
      row = []
      field = ''
      sawComma = false
      continue
    }
    field += text[i]
  }
  if (inQuotes) throw new Error('reasoning-reverse-match: unclosed quote in phrases CSV')
  if (field.length > 0 || sawComma || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  return rows
}

/**
 * Take the first column, skip the header row, and drop empty cells.
 * @param text - full file contents.
 * @param format - `tsv` splits on tabs; `csv` splits on commas and honors double quotes.
 * @returns data cells in file order. The header is not included.
 */
export function parsePhrasesTable(text: string, format: PhrasesFormat): string[] {
  const rows = format === 'csv' ? parseCsv(stripBom(text)) : parseTsv(stripBom(text))
  const phrases: string[] = []
  for (let i = 1; i < rows.length; i++) {
    const cell = rows[i]![0] ?? ''
    if (emptyCell(cell)) continue
    phrases.push(cell)
  }
  return phrases
}

/**
 * Read a phrase table from disk.
 * @param filePath - TSV or CSV path passed to `readFileSync` unchanged.
 * @returns the first-column phrases, header skipped.
 * @throws when the file cannot be read or a CSV quote is unclosed. The message names `filePath`.
 */
export function loadPhrasesFile(filePath: string): string[] {
  let text: string
  try {
    text = readFileSync(filePath, 'utf8')
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`reasoning-reverse-match: cannot read phrasesFile ${JSON.stringify(filePath)}: ${detail}`)
  }
  const firstBreak = text.indexOf('\n')
  const firstLine = firstBreak < 0 ? text : text.slice(0, firstBreak)
  try {
    return parsePhrasesTable(text, phrasesFormat(filePath, firstLine))
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`reasoning-reverse-match: cannot parse phrasesFile ${JSON.stringify(filePath)}: ${detail}`)
  }
}

/**
 * Inline phrases first, then file phrases. Exact string duplicates are dropped.
 * Empty strings are dropped.
 * @param inline - `phrases` from config, already defaulted by the schema.
 * @param fromFile - first-column cells from `phrasesFile`.
 */
export function mergePhrases(inline: readonly string[], fromFile: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const phrase of [...inline, ...fromFile]) {
    if (phrase.length === 0 || seen.has(phrase)) continue
    seen.add(phrase)
    out.push(phrase)
  }
  return out
}
