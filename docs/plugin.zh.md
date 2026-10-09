# stopdrooling

DeepSeek Harness 插件：在助手**思考链**上倒序匹配短语。

## 行为

1. 正常接受模型回复，不打断流式输出。
2. **不改写**会话历史（不再写入 `reasoning/redact` 等持久事件）。
3. 在每次回放助手思考的 `llm/stream` 派发时（agent-loop、子代理、压缩摘要），按属性描述符复制请求（保留原型、不可枚举属性和 symbol 键），换成删减后的 `messages`，再以该副本重新进入 `ctx.llm.stream`。监听器不 `prepend`，因此检查点与重构性不变量先看到原始请求。未命中则 `next()` 原引用透传：不克隆、不发 hit。仅当调用方请求已冻结时才冻结副本。
4. 只做整段匹配，不做语义判断。同一段原文和同一份配置，每次裁剪结果相同。动作只在思考链末尾，所以缓存破坏较少；末尾仍会被改动。最恶劣时破坏区域在 100k 以内。这要求上下文长度达到 384k 及以上，且整个上下文只有单轮一段思考链，并接近输出上限。
5. Web 客户端在 `assistant/message` 上用整段匹配器标红。短语表内嵌在客户端里，不读取宿主机的实时配置。

## 安装

用户安装的是已经构建好的 `stopdrooling-0.3.0.tgz`。从该版本的 GitHub Release 下载这个文件，在它所在的目录执行：

```sh
dsh plugin --profile web add ./stopdrooling-0.3.0.tgz
dsh --profile web --dump-config
dsh web
```

`--dump-config` 里应出现包名 `stopdrooling`。安装这个 tarball 不会执行 `prepare`，也不需要 `allowBuilds`。不要用 `dsh plugin add github:...` 从源码仓库安装。

要留着原来的 `web` 作对照：

```sh
dsh --profile web-compare --from-default-profile web --dump-config
dsh plugin --profile web-compare add ./stopdrooling-0.3.0.tgz
dsh --profile web-compare
```

第一条只在 `web-compare` 还不存在时执行。卸载：`dsh plugin --profile web remove stopdrooling`。安装或卸载后需要重启该 profile；已经在跑的进程仍使用启动时的 bundle 集合。`--dump-config-schema` 可以为同一组层打印 JSON Schema。两种 dump 都会在 profile 文件缺失时创建它们。

## 配置

| 键 | 默认 | 含义 |
|---|---|---|
| `phrases` | `['letsgo', "ok i'll do it"]` | 内联短语。与 `phrasesFile` 合并，完全相同的字符串只留第一次。若只要文件里的短语，设为 `[]`。 |
| `phrasesFile` | — | 可选 TSV 或 CSV 路径，启动时读一次。只取第一列，跳过表头，忽略空行。`.csv` 按逗号分隔并识别双引号（`""` 为转义引号）；`.tsv` 按制表符分隔；其他后缀在首行含制表符时按 TSV，否则按 CSV。路径原样交给 `readFileSync`。文件缺失、读失败或 CSV 引号不闭合时抛错，监听器不会装上。 |
| `remove` | `match` | `match` 只删折叠后的命中段。`tail` 从最早的命中起点删到该思考块末尾。`paragraph` 删除与短语等价的整行。 |
| `maxHitsPerBlock` | `1` | 每个思考块最多命中数，从末尾起，且先丢掉起点在 `tailFraction` 截断点之前的命中。被丢掉的命中不占名额。`paragraph` 忽略此项，合格的命中行全部删除。 |
| `tailFraction` | `0.25` | 每个思考块末尾可编辑的比例，范围是 (0, 1]。未写这个键时用 0.25。`1` 表示整块可编辑。`0`、负数、大于 1 和 `NaN` 会在启动时拒绝。 |
| `excerptChars` | `160` | 命中记录中保留的前文长度。 |
| `logFile` | — | 可选 JSONL：每次改写一条 `wire-rewrite`，每个因会变空白而保留的块一条 `skip-blank`。目录不存在或写入失败时只打警告，不拆掉监听器。 |

`paragraph` 按 `\n` 分行（紧挨在 `\n` 前的 `\r` 不算行内容）。一行去掉首尾空格和制表符后，只有整行与某条短语等价才命中：ASCII 字母不区分大小写，连续空格/制表符视为一个空格，`—`、`–`、`--` 和 ` - ` 视为同一种破折号。其余字符（包括 `。`、`（`、`）`、`.`、`'`）逐字比较。不做 NFKC，因此 `（写）` 不等于 `(写)`。`ok. writing the tests now`、`look.` 这种更长的行不会命中 `ok.`。大量样本里这些短句经常自己占一段，所以只处理单独成段的行。段落内部的同样字样不处理，因为它们邻接着有意义的内容。匹配不做语义判断。

删除命中行时连同它的一个换行符：优先删行尾的 `\n`；该行是块的最后一行且没有 `\n` 时，改删它前面的 `\n`。两个保留行之间，由空行和被删行组成的一段里留下来的空行是其中第一条最长的空行串，两侧空行数不相加。第一个保留行之前或最后一个保留行之后的同样一段，其中的空行一并删除。这段落在块尾且含有命中、而块本身不以 `\n` 结尾时，最后一个保留行的 `\n` 也删掉；块以 `\n` 结尾时保留这一个结尾换行。不含命中的开头空行保留。其他字符不改。若删完后该块会变成空串或只剩空白，则保留原块和原 signature，打一条警告，并在设置了 `logFile` 时追加 `skip-blank`。请求不因此失败。

每个块的截断点是 `Math.floor(text.length * (1 - tailFraction))`，用的是该块编辑前的原文。`text.length` 是 JavaScript 字符串长度（UTF-16 code unit）。`tailFraction` 为 1 时截断点是 0。`paragraph` 里一行只有起始偏移大于或等于截断点才可删除。起始更早的行保持不动，即使该行延伸跨过截断点；空行规则把它当作普通保留行。`match` 和 `tail` 的命中也只有起始偏移大于或等于截断点才可删除。同一段原文加上同一份配置，每次重放的编辑结果相同。`rewriteRequestMessages` 在未传 `tailFraction` 时按 1 处理。本插件的 schema 默认值是 0.25，`apply` 把解析后的这个数传给改写函数。

随包的 `cordis.patch.yml` 把 `remove` 设为 `paragraph`，并写入 35 条循环短语。它没有设置 `tailFraction`，因此使用 schema 默认值 0.25。

后一层补丁会整份替换一行的 `config`。要覆盖本插件，在 profile 的 `cordis.patch.yml` 里写 id 为 `stopdrooling` 的一行，并把这一行需要保留的键全部写上。省略的键回到 schema 默认：`remove: match` 和 `phrases: ['letsgo', "ok i'll do it"]`，不是随包的 35 条 `paragraph` 表。只写 `tailFraction` 的补丁会丢掉循环短语和 `paragraph` 模式。

## 代价

- 会话日志保留原文，发出去的请求体是删过的。签名只在实际删短的块上丢弃。
- 网页标红内嵌 35 条循环短语、`tailFraction` 0.25 和整段匹配器。只有宿主使用同一张表、`remove: paragraph` 且 `tailFraction` 为 0.25 时，标红才与实际删除相同。改了 `phrases`、`phrasesFile`、`remove` 或 `tailFraction` 之后，请求体会变，红标不会变。页面读不到宿主的 `tailFraction`。会变成空白而保留的块不标红。
