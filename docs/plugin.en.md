# stopdrooling

DeepSeek Harness bundle: reverse (tail-first) phrase matching over **assistant reasoning**.

## Behavior

1. The model’s reply is accepted normally — streaming is never cancelled.
2. The session log is **never** rewritten (no durable redact / projection event).
3. On each `llm/stream` dispatch that replays assistant reasoning (agent-loop steps, subagents, compaction summaries), the plugin copies the request by property descriptor (prototype, non-enumerable properties, and symbol keys included), replaces `messages` with matched reasoning spans removed, and re-enters `ctx.llm.stream` with that copy. The listener is not prepended, so checkpoint and reconstructability listeners see the original request first. A miss returns `next()` with the caller's object: no copy, no hit event. The copy is frozen only when the caller request was frozen.
4. Matching is exact and has no semantic judgment. The same original text and config always cut the same way. Edits touch only the tail of a reasoning block, so cache disruption stays small, while that tail still changes. The worst affected region is within 100k. That case needs a context length of at least 384k, a single turn, one reasoning block, and that block near the output limit.
5. The web client paints those spans red by re-running the paragraph matcher over `assistant/message` events. It embeds the loop phrase table; it does not read the host's live config.

## Install

Users install the already built `stopdrooling-0.3.0.tgz`. Download it from this version's GitHub Release, then run these commands in the directory that contains the file:

```sh
dsh plugin --profile web add ./stopdrooling-0.3.0.tgz
dsh --profile web --dump-config
dsh web
```

`--dump-config` should show a layer named `stopdrooling`. Installing this tarball does not run `prepare` and does not need `allowBuilds`. Do not install this repository with `dsh plugin add github:...`.

To keep the existing `web` profile unchanged for comparison:

```sh
dsh --profile web-compare --from-default-profile web --dump-config
dsh plugin --profile web-compare add ./stopdrooling-0.3.0.tgz
dsh --profile web-compare
```

The first command applies only when `web-compare` does not exist yet. Uninstall with `dsh plugin --profile web remove stopdrooling`. Restart that profile after install or removal; a process that is already running keeps the bundle set from its start. `--dump-config-schema` prints JSON Schema for the same layers. Either dump creates missing profile files.

## Config

| Key | Default | Meaning |
|---|---|---|
| `phrases` | `['letsgo', "ok i'll do it"]` | Inline phrases. Merged with `phrasesFile`; exact duplicates are dropped. Set `[]` to use only the file. |
| `phrasesFile` | — | Optional TSV or CSV path, read once at startup. First column only; the header row is skipped; empty rows are ignored. `.csv` splits on commas and honors double quotes (`""` is an escaped quote). `.tsv` splits on tabs. Any other suffix uses tabs when the first line contains a tab, otherwise commas. The path is passed to `readFileSync` as given. A missing, unreadable, or unparsable file throws and the plugin does not install its listener. |
| `remove` | `match` | `match` removes only the folded phrase span. `tail` removes from the earliest match start through the end of that reasoning block. `paragraph` removes each whole line that equals a phrase. |
| `maxHitsPerBlock` | `1` | Max non-overlapping hits per reasoning block, end-first, after hits that start before the `tailFraction` cutoff are dropped. Those dropped hits do not consume a slot. Ignored for `paragraph`, which deletes every eligible matching line. |
| `tailFraction` | `0.25` | Editable suffix of each reasoning block, in the range (0, 1]. When the key is omitted the value is 0.25. `1` edits the whole block. `0`, negatives, values above 1, and `NaN` are rejected at startup. |
| `excerptChars` | `160` | Raw characters before the first removed range kept on hit records. |
| `logFile` | — | Optional JSONL log: one `wire-rewrite` record per edited request, and one `skip-blank` record per block left unchanged. A missing directory or a failed write logs a warning and does not stop the listener. |

`paragraph` splits the block on `\n` (`\r` immediately before `\n` is not part of the line). A line matches only when the whole line, after trimming spaces and tabs, equals a phrase: ASCII A–Z is case-insensitive, runs of spaces and tabs are one space, and `—`, `–`, `--`, and ` - ` are the same dash. Other characters, including `。`, `（`, `）`, `.`, and `'`, compare exactly. NFKC is not applied, so `（写）` does not match `(写)`. A longer line such as `ok. writing the tests now` or `look.` does not match `ok.`. Samples show these phrases usually occupy a paragraph by themselves, so only a standalone paragraph is removed. The same words inside a longer paragraph stay, because they sit next to meaningful text. Matching does not judge meaning.

Each matched line is removed together with one newline: its trailing `\n`, or the preceding `\n` when the line is last and has none. Between two kept lines, blank lines that remain in a stretch of blank lines and removed lines are the first longest run, so the two sides are not added together. The same kind of stretch before the first kept line or after the last one drops those blank lines as well. When that trailing stretch contains a match and the block does not end in `\n`, the last kept line's `\n` is removed too; a block that ends in `\n` keeps that one trailing newline. A leading blank run that contains no match stays. No other character changes. If deletion would leave the block empty or whitespace-only, the block and its signature stay, a warning is logged, and a `skip-blank` line is appended when `logFile` is set. The request is not failed.

The cutoff of a block is `Math.floor(text.length * (1 - tailFraction))` on that block's original text, before any edit. `text.length` is JavaScript string length (UTF-16 code units). `tailFraction` 1 yields cutoff 0. A paragraph line is eligible only when its start offset is greater than or equal to the cutoff. A line that starts earlier stays in place, including when the line extends past the cutoff, and the blank-line rules treat it as a kept line. A match or tail hit is eligible only when the hit's start offset is greater than or equal to the cutoff. The same original block text and config produce the same edit on every replay. `rewriteRequestMessages` treats a missing `tailFraction` as 1. This plugin's schema default is 0.25, and `apply` passes that resolved number into the rewrite helper.

Shipped `cordis.patch.yml` sets `remove: paragraph` and the 35 loop phrases. It does not set `tailFraction`, so the schema default 0.25 applies.

A later patch replaces a row's entire `config`. To override this plugin, put a row with id `stopdrooling` in the profile `cordis.patch.yml` and write every key that row should keep. Omitted keys fall back to the schema defaults, which are `remove: match` and `phrases: ['letsgo', "ok i'll do it"]`, not the shipped 35-phrase `paragraph` table. A patch that sets only `tailFraction` drops the loop phrases and `paragraph` mode.

## Trade-offs

- The session log keeps the original reasoning. The outbound request is the shortened one. A signature is dropped only on a block that was actually shortened.
- The web highlight embeds the 35 loop phrases, `tailFraction` 0.25, and the paragraph matcher. Highlighting matches deletion only when the host uses that same table, `remove: paragraph`, and `tailFraction` 0.25. Changing `phrases`, `phrasesFile`, `remove`, or `tailFraction` changes the request without moving the red marks. The page cannot read the host `tailFraction`. Blocks left unchanged because they would become blank are not highlighted.
