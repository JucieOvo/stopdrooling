import { describe, expect, it } from 'vitest'
import {
  compileNeedles, fold, foldWithMap, rawRangeFor, removalRanges, removeRanges,
  reverseFind, reverseFindAll, reverseMatchRaw,
} from '../src/matcher.ts'

describe('fold', () => {
  it('drops case, spaces and punctuation char-locally', () => {
    expect(fold("OK, I'll do it")).toBe('okilldoit')
    expect(fold('Let\'s-Go!!')).toBe('letsgo')
    expect(foldWithMap("OK, I'll do it").folded).toBe(fold("OK, I'll do it"))
  })
})

describe('rawRangeFor / reverseMatchRaw', () => {
  it('maps a folded hit onto the original phrase span including punctuation', () => {
    const text = 'hello Let\'s go world'
    const needles = compileNeedles(['letsgo'])
    const hits = reverseMatchRaw(text, needles, 1)
    expect(hits).toHaveLength(1)
    expect(hits[0]!.phrase).toBe('letsgo')
    expect(text.slice(...hits[0]!.rawRange)).toBe('Let\'s go')
  })

  it('maps ok i\'ll do it across punctuation', () => {
    const text = 'Plan. OK, I\'ll do it! Then more.'
    const hits = reverseMatchRaw(text, compileNeedles(["ok i'll do it"]), 1)
    expect(text.slice(...hits[0]!.rawRange)).toBe('OK, I\'ll do it')
  })

  it('rejects out-of-bounds folded ranges', () => {
    const { starts, ends } = foldWithMap('abc')
    expect(() => rawRangeFor(starts, ends, 0, 0)).toThrow(/out of bounds/)
  })
})

describe('reverseFindAll / removalRanges', () => {
  it('collects hits from the end backward without overlap', () => {
    const folded = fold('letsgo xx letsgo yy letsgo')
    const hits = reverseFindAll(folded, compileNeedles(['letsgo']), 2)
    expect(hits.map(h => h.index)).toEqual([fold('letsgo xx ').length + fold('letsgo yy ').length, fold('letsgo xx ').length])
  })

  it('tail mode removes from the earliest match start to the end', () => {
    const text = 'aaa LETSGO bbb LETSGO ccc'
    const hits = reverseMatchRaw(text, compileNeedles(['letsgo']), 2)
    const ranges = removalRanges(text.length, hits, 'tail')
    expect(ranges).toEqual([[hits[hits.length - 1]!.rawRange[0], text.length]])
    expect(removeRanges(text, ranges)).toBe('aaa ')
  })

  it('match mode removes only the phrase spans', () => {
    const text = 'aaa LETSGO bbb'
    const hits = reverseMatchRaw(text, compileNeedles(['letsgo']), 1)
    const ranges = removalRanges(text.length, hits, 'match')
    expect(removeRanges(text, ranges)).toBe('aaa  bbb')
  })
})

describe('reverseFind ties', () => {
  it('prefers the longer phrase when ends coincide', () => {
    const hit = reverseFind(fold('okilldoit'), compileNeedles(['ok', "ok i'll do it"]))
    expect(hit?.phrase).toBe("ok i'll do it")
  })
})
