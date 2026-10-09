/**
 * Browser half of stopdrooling.
 *
 * No durable redact event: Conversation Definition watches assistant/message
 * only and paints the spans the host deletes. The host does not publish plugin
 * config to the page, so this file embeds the loop phrase table, tailFraction
 * 0.25, and the paragraph matcher from src/paragraph.ts. The cutoff is
 * Math.floor(text.length * (1 - tailFraction)) on the original block.
 * text.length counts UTF-16 code units. A host tailFraction other than 0.25
 * will not match these red spans. Sessions always reload because the log
 * never gains an unknown event type.
 */
window.__ModuleLoader__.load({
  id: 'stopdrooling',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState } = React

    const KIND = 'reasoning-redact'
    const NS = 'reasoning-reverse-match'
    const STYLE_ID = 'stopdrooling-style'
    const CONTEXT_CHARS = 80
    const ANCHOR_OFFSET = 0.06

    /*__PARAGRAPH_EXPORTS__*/
    const STRIP = /[^\p{L}\p{N}]+/gu
    // Same 35 phrases as tests/fixtures/loop-phrases.tsv and cordis.patch.yml.
    // paragraph mode does not apply NFKC: （写） is not (写).
    const LOOP_PHRASES = ["ok.","writing.","let me write.","go.","let me output.","emitting.","ok — emitting.","now.","好。","（写）","ok — emitting now.","写。","let me emit.","ok, writing.","ok. writing.","done.","ok — producing.","ok — writing.","producing.","ok. emitting.","i'll write the tool call now.","emitting the tool call.","ok — producing the tool call.","ok — producing now.","ok, emitting.","ok, emitting the tool call.","let me write the file.","let me output it.","ok, producing the tool call.","ok. writing the tool call.","let me output the tool call now.","writing the tool call.","ok. emitting the tool call.","writing the tool call now.","let me output the tool call."]
    // Hardcoded. The page cannot read the host's tailFraction. 0.25 matches the plugin schema default.
    const DEFAULT_TAIL_FRACTION = 0.25

    function reasoningCutoff(textLength, tailFraction) {
      const fraction = tailFraction === undefined ? DEFAULT_TAIL_FRACTION : tailFraction
      return Math.floor(textLength * (1 - fraction))
    }
    const EM = '\u2014'
    const EN_CODE = 0x2013
    const EM_CODE = 0x2014

    function trimSpaceTab(text) {
      let start = 0
      let end = text.length
      while (start < end) {
        const code = text.charCodeAt(start)
        if (code !== 32 && code !== 9) break
        start++
      }
      while (end > start) {
        const code = text.charCodeAt(end - 1)
        if (code !== 32 && code !== 9) break
        end--
      }
      return text.slice(start, end)
    }

    function isSpaceTab(code) {
      return code === 32 || code === 9
    }

    function canonicalizeParagraph(text) {
      let result = ''
      let pendingSpace = false
      const len = text.length
      let i = 0
      while (i < len) {
        const code = text.charCodeAt(i)
        if (isSpaceTab(code)) {
          if (result.length > 0) pendingSpace = true
          i++
          continue
        }
        if (code === EN_CODE || code === EM_CODE) {
          if (result.length > 0 && !result.endsWith(' ')) result += ' '
          result += EM
          pendingSpace = true
          i++
          continue
        }
        if (code === 0x2d && i + 1 < len && text.charCodeAt(i + 1) === 0x2d) {
          if (result.length > 0 && !result.endsWith(' ')) result += ' '
          result += EM
          pendingSpace = true
          i += 2
          continue
        }
        if (code === 0x2d && pendingSpace && i + 1 < len && isSpaceTab(text.charCodeAt(i + 1))) {
          if (result.length > 0 && !result.endsWith(' ')) result += ' '
          result += EM
          pendingSpace = true
          i++
          while (i < len && isSpaceTab(text.charCodeAt(i))) i++
          continue
        }
        if (pendingSpace && result.length > 0 && !result.endsWith(' ')) result += ' '
        pendingSpace = false
        result += code >= 65 && code <= 90 ? String.fromCharCode(code + 32) : text[i]
        i++
      }
      return result
    }

    function compileParagraphPhrases(phrases) {
      const table = new Map()
      for (const phrase of phrases) {
        const trimmed = trimSpaceTab(phrase)
        if (trimmed.length === 0) continue
        const key = canonicalizeParagraph(trimmed)
        if (key.length === 0 || table.has(key)) continue
        table.set(key, phrase)
      }
      return table
    }

    function stripTrailingCr(text, start, end) {
      if (end > start && text.charCodeAt(end - 1) === 13) end--
      return text.slice(start, end)
    }

    function parseLines(text) {
      const lines = []
      let start = 0
      for (let i = 0; i < text.length; i++) {
        if (text.charCodeAt(i) !== 10) continue
        lines.push({ start, end: i, nl: i })
        start = i + 1
      }
      if (start < text.length || lines.length === 0) lines.push({ start, end: text.length, nl: -1 })
      return lines
    }

    function classify(text, table) {
      return parseLines(text).map((line) => {
        const body = trimSpaceTab(stripTrailingCr(text, line.start, line.end))
        if (body.length === 0) return { ...line, kind: 'blank', phrase: '', folded: '' }
        const folded = canonicalizeParagraph(body)
        const phrase = table.get(folded)
        if (phrase === undefined) return { ...line, kind: 'keep', phrase: '', folded }
        return { ...line, kind: 'hit', phrase, folded }
      })
    }

    function demoteIneligibleHits(lines, cutoff) {
      if (cutoff <= 0) return lines
      return lines.map((line) => {
        if (line.kind !== 'hit' || line.start >= cutoff) return line
        return { ...line, kind: 'keep', phrase: '', folded: '' }
      })
    }

    function mergeRanges(ranges) {
      if (ranges.length === 0) return []
      const sorted = ranges.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1])
      const out = []
      let start = sorted[0][0]
      let end = sorted[0][1]
      for (let i = 1; i < sorted.length; i++) {
        const next = sorted[i]
        if (next[0] <= end) end = Math.max(end, next[1])
        else {
          out.push([start, end])
          start = next[0]
          end = next[1]
        }
      }
      out.push([start, end])
      return out
    }

    function deletionRanges(lines, text) {
      const keepAt = []
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].kind === 'keep') keepAt.push(i)
      }
      const gaps = []
      if (keepAt.length === 0) gaps.push([0, lines.length])
      else {
        if (keepAt[0] > 0) gaps.push([0, keepAt[0]])
        for (let k = 0; k < keepAt.length - 1; k++) {
          const from = keepAt[k] + 1
          const to = keepAt[k + 1]
          if (from < to) gaps.push([from, to])
        }
        const last = keepAt[keepAt.length - 1]
        if (last < lines.length - 1) gaps.push([last + 1, lines.length])
      }
      const ranges = []
      let stripLastKeptNewline = false
      for (const gap of gaps) {
        const from = gap[0]
        const to = gap[1]
        let hasHit = false
        for (let i = from; i < to; i++) {
          if (lines[i].kind === 'hit') hasHit = true
        }
        if (!hasHit) continue
        const runs = []
        let i = from
        while (i < to) {
          if (lines[i].kind !== 'blank') {
            i++
            continue
          }
          const at = i
          while (i < to && lines[i].kind === 'blank') i++
          runs.push({ at, len: i - at })
        }
        const edge = keepAt.length > 0 && (from === 0 || to === lines.length)
        let desired = 0
        if (!edge) {
          for (const run of runs) desired = Math.max(desired, run.len)
        }
        if (edge && to === lines.length && !text.endsWith('\n')) stripLastKeptNewline = true
        let kept = -1
        if (desired > 0) {
          for (let r = 0; r < runs.length; r++) {
            if (runs[r].len === desired) {
              kept = r
              break
            }
          }
        }
        for (let index = from; index < to; index++) {
          const line = lines[index]
          if (line.kind === 'blank') {
            const runIndex = runs.findIndex(run => index >= run.at && index < run.at + run.len)
            if (runIndex === kept) continue
          }
          if (line.nl >= 0) ranges.push([line.start, line.nl + 1])
          else if (index > 0 && lines[index - 1].nl >= 0) ranges.push([lines[index - 1].nl, line.end])
          else ranges.push([line.start, line.end])
        }
      }
      if (stripLastKeptNewline) {
        const nl = lines[keepAt[keepAt.length - 1]].nl
        if (nl >= 0) ranges.push([nl, nl + 1])
      }
      return mergeRanges(ranges)
    }

    function removeRangesClient(text, ranges) {
      if (ranges.length === 0) return text
      const ordered = ranges.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1])
      let out = ''
      let cursor = 0
      for (const range of ordered) {
        const from = Math.max(cursor, Math.min(range[0], text.length))
        const to = Math.max(from, Math.min(range[1], text.length))
        if (from > cursor) out += text.slice(cursor, from)
        cursor = Math.max(cursor, to)
      }
      if (cursor < text.length) out += text.slice(cursor)
      return out
    }

    function paragraphRemovalRanges(text, phrases, tailFraction) {
      const table = compileParagraphPhrases(phrases)
      if (table.size === 0) return null
      const lines = demoteIneligibleHits(classify(text, table), reasoningCutoff(text.length, tailFraction))
      const matched = []
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].kind === 'hit') matched.push(lines[i])
      }
      if (matched.length === 0) return null
      const ranges = deletionRanges(lines, text)
      if (removeRangesClient(text, ranges).trim().length === 0) return null
      return { ranges, phrases: matched.map(line => line.phrase) }
    }

    const zh = {
      title: '思考链 · 回传模型时从请求体删除 {count} 处（红色部分仅对模型隐藏，历史保留原文）',
      expand: '展开全文',
      collapse: '收起',
      phrase: '命中：{phrases}',
    }
    const en = {
      title: 'Reasoning · {count} span(s) stripped from the request body when replayed to the model (red = hidden from the model only; history keeps the original)',
      expand: 'Show full reasoning',
      collapse: 'Collapse',
      phrase: 'Matched: {phrases}',
    }

    const CSS = [
      '.rrm-root{margin:2px 0 6px;padding:6px 10px;border-left:2px solid var(--dsw-alias-label-error);',
      'border-radius:4px;background:var(--dsw-alias-bg-layer-1);font-size:12px;line-height:1.6;',
      'color:var(--dsw-alias-label-secondary)}',
      '.rrm-head{display:flex;align-items:center;gap:8px;justify-content:space-between;color:var(--dsw-alias-label-tertiary)}',
      '.rrm-toggle{border:0;background:none;padding:0;cursor:pointer;color:var(--dsw-alias-link);font:inherit}',
      '.rrm-body{white-space:pre-wrap;word-break:break-word;margin-top:4px}',
      '.rrm-snippet{white-space:pre-wrap;word-break:break-word;margin-top:4px}',
      '.rrm-ellipsis{color:var(--dsw-alias-label-tertiary)}',
      '.rrm-red{color:var(--dsw-alias-label-error);',
      'background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 14%,transparent);',
      'border-radius:2px;padding:0 1px}',
      '.rrm-phrases{margin-top:4px;color:var(--dsw-alias-label-tertiary)}',
    ].join('')

    function format(template, vars) {
      return String(template).replace(/\{(\w+)\}/g, (_, key) => (key in vars ? String(vars[key]) : '{' + key + '}'))
    }

    function foldWithMap(text) {
      let folded = ''
      const starts = []
      const ends = []
      for (let i = 0; i < text.length;) {
        const cp = text.codePointAt(i)
        const len = cp > 0xffff ? 2 : 1
        const kept = text.slice(i, i + len).normalize('NFKC').toLowerCase().replace(STRIP, '')
        for (const ch of kept) {
          folded += ch
          starts.push(i)
          ends.push(i + len)
        }
        i += len
      }
      return { folded, starts, ends }
    }

    function fold(text) {
      return foldWithMap(text).folded
    }

    function compileNeedles(phrases) {
      const seen = new Set()
      const needles = []
      for (const phrase of phrases) {
        const folded = fold(phrase)
        if (!folded || seen.has(folded)) continue
        seen.add(folded)
        needles.push({ phrase, folded })
      }
      return needles
    }

    function reverseFind(folded, needles, minEnd) {
      let best
      let bestEnd = -1
      const floor = minEnd || 0
      for (const needle of needles) {
        const index = folded.lastIndexOf(needle.folded)
        if (index < 0) continue
        const end = index + needle.folded.length
        if (end < floor) continue
        if (end > bestEnd || (end === bestEnd && best && needle.folded.length > best.folded.length)) {
          bestEnd = end
          best = { phrase: needle.phrase, folded: needle.folded, index, offsetFromEnd: folded.length - end }
        }
      }
      return best
    }

    function reverseFindAll(folded, needles, maxHits) {
      if (maxHits < 1 || !needles.length) return []
      const hits = []
      let limit = folded.length
      while (hits.length < maxHits && limit > 0) {
        const hit = reverseFind(folded.slice(0, limit), needles)
        if (!hit) break
        hits.push({ ...hit, offsetFromEnd: folded.length - (hit.index + hit.folded.length) })
        limit = hit.index
      }
      return hits
    }

    function reverseMatchRaw(text, needles, maxHits) {
      const { folded, starts, ends } = foldWithMap(text)
      return reverseFindAll(folded, needles, maxHits).map((hit) => ({
        ...hit,
        rawRange: [starts[hit.index], ends[hit.index + hit.folded.length - 1]],
      }))
    }

    function removalRanges(textLength, hits, mode) {
      if (mode === 'tail') {
        if (hits.length === 0) return []
        let start = textLength
        for (const hit of hits) start = Math.min(start, hit.rawRange[0])
        return start < textLength ? [[start, textLength]] : []
      }
      return hits.map(hit => [hit.rawRange[0], hit.rawRange[1]]).sort((a, b) => a[0] - b[0])
    }

    function scanReasoning(text, phrases, remove, maxHits, tailFraction) {
      const fraction = tailFraction === undefined ? DEFAULT_TAIL_FRACTION : tailFraction
      if (remove === 'paragraph') return paragraphRemovalRanges(text, phrases, fraction)
      const cutoff = reasoningCutoff(text.length, fraction)
      const needles = compileNeedles(phrases)
      const matched = reverseMatchRaw(text, needles, Number.POSITIVE_INFINITY)
        .filter((hit) => hit.rawRange[0] >= cutoff)
        .slice(0, maxHits)
      if (matched.length === 0) return null
      const ranges = removalRanges(text.length, matched, remove)
      if (ranges.length === 0) return null
      return { ranges, phrases: matched.map(h => h.phrase) }
    }
    /*__PARAGRAPH_EXPORTS_END__*/

    function highlight(text, ranges, from, to, keyPrefix) {
      const parts = []
      let cursor = from
      ranges.forEach((range, i) => {
        const start = Math.max(cursor, Math.min(range[0], to))
        const end = Math.max(start, Math.min(range[1], to))
        if (start > cursor) parts.push(text.slice(cursor, start))
        if (end > start) {
          parts.push(h('span', { key: keyPrefix + i, className: 'rrm-red', 'data-rrm-removed': '' }, text.slice(start, end)))
        }
        cursor = Math.max(cursor, end)
      })
      if (cursor < to) parts.push(text.slice(cursor, to))
      return parts
    }

    function Snippets({ block }) {
      const { text, ranges } = block
      return ranges.map((range, i) => {
        const from = Math.max(0, range[0] - CONTEXT_CHARS)
        const to = Math.min(text.length, range[1] + CONTEXT_CHARS)
        return h('div', { key: 's' + i, className: 'rrm-snippet' },
          from > 0 ? h('span', { className: 'rrm-ellipsis' }, '…') : null,
          highlight(text, [range], from, to, 'h' + i + '-'),
          to < text.length ? h('span', { className: 'rrm-ellipsis' }, '…') : null)
      })
    }

    function makeView(t) {
      return function ReasoningRedactNodeView(props) {
        const [open, setOpen] = useState(false)
        const blocks = (props.node && props.node.data && props.node.data.blocks) || []
        if (blocks.length === 0) return null
        const count = blocks.reduce((sum, block) => sum + block.ranges.length, 0)
        const phrases = [...new Set(blocks.flatMap(block => block.phrases))]
        return h('div', { className: 'rrm-root', 'data-rrm': '' },
          h('style', { id: STYLE_ID }, CSS),
          h('div', { className: 'rrm-head' },
            h('span', null, t('title', { count })),
            h('button', { type: 'button', className: 'rrm-toggle', onClick: () => setOpen(!open), 'aria-expanded': open },
              open ? t('collapse') : t('expand'))),
          blocks.map(block => open
            ? h('div', { key: 'b' + block.blockIndex, className: 'rrm-body' },
              highlight(block.text, block.ranges, 0, block.text.length, 'f' + block.blockIndex + '-'))
            : h(Snippets, { key: 'b' + block.blockIndex, block })),
          phrases.length > 0 ? h('div', { className: 'rrm-phrases' }, t('phrase', { phrases: phrases.join(', ') })) : null)
      }
    }

    function reasoningBlocks(message) {
      const out = {}
      const content = (message && message.content) || []
      content.forEach((block, index) => {
        if (block && block.type === 'reasoning' && typeof block.text === 'string') out[index] = block.text
      })
      return out
    }

    const definition = {
      kind: KIND,
      target: 'chat',
      match(event) {
        if (event.type === 'assistant/message' && event.surfaceOp === 'append') {
          return { id: String(event.seq), role: 'start' }
        }
        return null
      },
      start(_context, match) {
        return { seq: match.event.seq, reasoning: reasoningBlocks(match.event.data.message) }
      },
      buildViewNode(context) {
        const current = context.current.get('chat')
        const state = context.state
        if (!state || !state.reasoning || Object.keys(state.reasoning).length === 0) {
          return current == null ? null : { ...current, visibility: 'hidden' }
        }
        const blocks = []
        for (const key of Object.keys(state.reasoning).sort((a, b) => Number(a) - Number(b))) {
          const text = state.reasoning[key]
          if (typeof text !== 'string') continue
          const hit = scanReasoning(text, LOOP_PHRASES, 'paragraph', 1)
          if (!hit) continue
          blocks.push({ blockIndex: Number(key), text, ranges: hit.ranges, phrases: hit.phrases })
        }
        if (blocks.length === 0) return current == null ? null : { ...current, visibility: 'hidden' }
        const location = (context.start && context.start.location) || (context.matches[0] && context.matches[0].location) || { kind: 'unresolved' }
        return {
          key: context.key,
          kind: KIND,
          id: context.id,
          target: 'chat',
          anchorSeq: state.seq + ANCHOR_OFFSET,
          location,
          visibility: 'visible',
          data: { seq: state.seq, blocks },
        }
      },
    }

    return {
      inject: ['slots', 'uiConversation', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'reasoning-reverse-match: dictionaries')
        const bound = ctx.locale.bind(NS)
        const t = (key, vars) => format(bound(key), vars || {})
        ctx.effect(() => ctx.uiConversation.events.register(definition), 'reasoning-reverse-match: definition')
        const View = makeView(t)
        ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
          name: 'conversation.chat.node',
          key: KIND,
        }, View))
      },
    }
  },
})
