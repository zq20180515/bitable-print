/**
 * 全量 Node 层测试套件的统一跑分器。
 *
 * 为什么单独写：bash 环境间歇性坏掉（dirname/tail 找不到、node 被 SIGTERM），
 * 而且并行跑多个套件时要能一次看清「哪一套退化了」。
 * 用 node 的 spawnSync 直接起进程，绕开 shell。
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const NODE = process.execPath
const ESBUILD = join(ROOT, 'node_modules', '.bin', 'esbuild.cmd')
const ESBUILD_JS = join(ROOT, 'node_modules', 'esbuild', 'bin', 'esbuild')

/**
 * 每套：名字 + 前置打包 + 运行命令。
 *
 * ⚠️ `bundle` 有**三种**取值，缺一不可（三种不同的东西不许长成一个样子）：
 *   · `[src, dst]`      —— 这套**需要**打包；打不出来 ⇒ 本套判失败（`bundle-FAIL`）
 *   · `null`            —— 这套**声明**不需要打包（纯 `.mts` 直接 strip-types 跑）
 *   · `undefined`（写漏）—— `bundle-MISSING`，**也判失败**
 *
 * 为什么要把"不需要打包"从**缺省**改成**声明**：在加 `null` 之前，第 2 种和第 3 种
 * 打印成同一个字符串 `no-bundle` —— 「合法地不需要」和「本该打包却写漏了」长得一模一样。
 * 那正是本项目一直在防的形状（`slice(0,2500)` / `prepared` 的同族）。
 * 现在的口径是：**能跑通一套本来就是配置写对了的证据**，所以"少了声明"必须能被看见。
 *
 * ⚠️ 判据不许写成"应该有 3 套打包"这种**计数** —— 加一套合法套件就会把它打红。
 * 期待由**声明**表达（`bundle` 字段本身），不由数字表达。
 */
const SUITES = [
  {
    name: 'selftest',
    bundle: ['test/selftest.ts', 'test/selftest.cjs'],
    run: ['test/selftest.cjs'],
  },
  {
    name: 'skeleton',
    bundle: ['test/skeleton-test.ts', 'test/skeleton-test.cjs'],
    run: ['test/skeleton-test.cjs'],
  },
  { name: 'lib', bundle: null, run: ['--experimental-strip-types', 'src/lib/__selftest.mts'] },
  { name: 'render', bundle: null, run: ['--experimental-strip-types', 'src/render/__selftest.mts'] },
  { name: 'import', bundle: null, run: ['--experimental-strip-types', 'src/import/__selftest.mts'] },
  // 表格动作层（纯函数，B 批引入）：与 lib/render/import 同一种跑法，显式声明不需要打包
  { name: 'table-actions', bundle: null, run: ['--experimental-strip-types', 'src/components/editor/__selftest.mts'] },
  /*
   * 格内子元素（复合 id 的解析/写回）与这次下沉出来的版式区原语 `doc-bands.ts`。
   * 放在这里而不是并进 `table-actions` 那套：它们守的是**另一条**契约
   * （选中模型 + 尺寸口径换算），混在一起以后改哪一块都得先读懂那一大坨。
   */
  { name: 'cell-child', bundle: null, run: ['--experimental-strip-types', 'src/components/editor/cell-child.selftest.mts'] },
  {
    name: 'code-elements',
    bundle: ['test/code-elements-test.ts', 'test/code-elements-test.cjs'],
    run: ['test/code-elements-test.cjs'],
  },
]

function run(args, label) {
  const r = spawnSync(NODE, args, { cwd: ROOT, encoding: 'utf8', timeout: 300_000 })
  if (r.error) return { ok: false, out: `spawn 失败: ${r.error.message}` }
  const out = `${r.stdout || ''}${r.stderr || ''}`
  return { ok: r.status === 0, status: r.status, out }
}

/**
 * 从输出里抓出汇总行。
 *
 * ⚠️ 顺序很重要（这条是照着另一个 worker 踩过的坑改的）：
 * 他那个报告生成器按**文件名**排序日志，而合并规则是"后读到的覆盖先读到的"，
 * 结果字母序靠后的旧日志盖掉了晚跑的新读数 —— **不报错，只静静把结论写反**。
 *
 * 这里同理：如果先按"疑似汇总行"去 grep（`/共 N 项/` 之类），
 * 一条失败行「❌ 3 项失败 / 共 45 项」也会被命中并当成结论展示。
 * 所以**优先取测试自己的判定行（带 ✅/❌）**，那才是它对自己的结论；
 * 启发式 grep 只作为兜底。
 */
function summaryOf(out) {
  const lines = out.split('\n').filter((l) => l.trim())
  const verdict = lines.filter((l) => /[✅❌]/.test(l))
  if (verdict.length) return verdict.join(' | ').trim().slice(0, 220)
  const cand = lines.filter((l) => /全部通过|全过|共\s*\d+\s*项|\d+\s*项/.test(l))
  return (cand.length ? cand : lines.slice(-3)).join(' | ').trim().slice(0, 220)
}

/**
 * ============================================================
 * 失败输出的**取证式摘录**（在这之前是 `r.out.slice(0, 2500)`）
 * ============================================================
 *
 * 踩过的坑（`canvas-geom` 实测）：render 自测**先打完全部 PASS 行（160 条）**，
 * 唯一的 FAIL 行落在第 2500 字符之外 —— 于是读数里只剩 `[render] exit=1` 和汇总行，
 * **没有 FAIL 行**。也就是说"某套件红了"这条读数里**最关键的那个字段（哪一条红）
 * 被工具吃掉了**，而报告看起来是完整的。这正是本项目一直在防的形状。
 *
 * 三条硬要求：
 *   ① **判定失败的行一定进输出** —— 按**行号**定位，不按字节偏移截断，
 *      所以它与"PASS 行有多长"无关；
 *   ② **总量仍有上限** —— 单套失败输出有字符硬顶，失败行也有条数上限，
 *      不会因为某套件疯狂刷屏就 dump 出几 MB；
 *   ③ **截断本身不许隐身** —— 省略了多少行、多少条失败行，都写在输出里。
 *      （①与②天然有张力：失败行多到超上限时，列出的会被截。
 *        处置方式是**明说"还剩多少条没列"**，而不是悄悄截掉。）
 *
 * 各类套件的失败行有三种形态，**都得认**（只认一种就会在新的套件上重新踩坑）：
 *   · `  FAIL  <msg>`  —— render 自测的**内联**形态（混在 PASS 行之间）
 *   · `   · <msg>`     —— lib / selftest / editor 的**末尾清单**形态（跟在 `❌` 后面）
 *   · 含 `❌` 的行      —— 汇总判定行本身也是证据
 * 一条都认不出来时（例如套件直接崩了、只有 stack），退回头 N + 尾 M 行，
 * 并**明说**"没识别到判定失败行"—— 不要让"识别失败"看起来像"没有失败行"。
 */
const EXCERPT_MAX_CHARS = 24_000 // 单套失败输出的字符硬顶
const EXCERPT_FAIL_MAX = 80 // 最多列多少条判定失败行
const EXCERPT_TAIL = 12 // 末尾上下文行数（收尾结论与抛出的 Error 都在末尾）
const EXCERPT_HEAD = 25 // 退路：头部上下文行数
const EXCERPT_LINE_MAX = 400 // 单行截断，防止一行几万字符把预算吃光

const isFailLine = (l) => /^\s*FAIL\b/.test(l) || /^\s*[·•]\s/.test(l) || l.includes('❌')

function failureExcerpt(text, name = '') {
  const raw = String(text ?? '')
  const lines = raw.split(/\r?\n/)
  const clip = (s) =>
    s.length > EXCERPT_LINE_MAX ? `${s.slice(0, EXCERPT_LINE_MAX)}…[本行还有 ${s.length - EXCERPT_LINE_MAX} 字符]` : s
  const tag = (i) => `[L${i + 1}] ${clip(lines[i])}`

  const body = []
  const shown = new Set()
  let budget = EXCERPT_MAX_CHARS
  const take = (i) => {
    if (shown.has(i)) return false
    const l = tag(i)
    if (l.length > budget) return false
    budget -= l.length + 1
    shown.add(i)
    body.push(l)
    return true
  }

  const header = `  ---- 失败证据${name ? `（${name}）` : ''}：子进程输出共 ${lines.length} 行 / ${raw.length} 字符 ----`

  const failIdx = []
  for (let i = 0; i < lines.length; i++) if (isFailLine(lines[i])) failIdx.push(i)

  if (failIdx.length === 0) {
    body.push('  ⚠️ 没有识别到判定失败行（`FAIL …` / `· …` / 含 ❌ 的行都没有）—— 套件可能是崩的，看头尾：')
    for (let i = 0; i < Math.min(EXCERPT_HEAD, lines.length); i++) take(i)
    for (let i = Math.max(0, lines.length - EXCERPT_TAIL); i < lines.length; i++) take(i)
    return [header, ...body, throttleNote(lines.length, shown.size, 0)].join('\n')
  }

  let listed = 0
  let droppedFail = 0
  for (const i of failIdx) {
    if (listed >= EXCERPT_FAIL_MAX || !take(i)) {
      droppedFail++
      continue
    }
    listed++
  }
  body.unshift(`  判定失败行 ${failIdx.length} 条，已列 ${listed} 条：`)

  /**
   * 末尾上下文：收尾结论行与抛出的 Error 都在末尾。
   * ⚠️ 这里**不能用 `take()`** —— `take` 会把行直接推进 body，
   * 于是它既出现在失败行区、又出现在末尾区，同一行印两遍。
   */
  const tailIdx = []
  for (let i = Math.max(0, lines.length - EXCERPT_TAIL); i < lines.length; i++) {
    if (shown.has(i)) continue
    const l = tag(i)
    if (l.length > budget) break
    budget -= l.length + 1
    shown.add(i)
    tailIdx.push(i)
  }
  if (tailIdx.length) body.push(`  末尾上下文 ${tailIdx.length} 行：`, ...tailIdx.map(tag))

  return [header, ...body, throttleNote(lines.length, shown.size, droppedFail)].join('\n')
}

/**
 * 省略说明：**必须**每次都写。截断这件事本身不许隐身。
 * `droppedFail === 0` 时也要把"失败行一条没省"写出来 —— 那是一句正面的保证，
 * 与"什么都没说"是两回事。
 */
function throttleNote(totalLines, shownLines, droppedFail) {
  const omitted = Math.max(0, totalLines - shownLines)
  const failPart = droppedFail > 0 ? `；**判定失败行还省略了 ${droppedFail} 条**（见上，上限 ${EXCERPT_FAIL_MAX} 条 / ${EXCERPT_MAX_CHARS} 字符）` : '；**判定失败行一条没省**'
  return `  ---- 省略说明：共 ${totalLines} 行，未列出 ${omitted} 行${omitted === 0 ? '（全部列出）' : ''}${failPart} ----`
}

/**
 * ⚠️ `prepared` 必须进裁决 —— 这是本文件第二次"关键字段被工具吃掉"。
 *
 * 现象（独立验证者顺着"豁免前提"挖出来、lead 静态复核过）：
 * 某个 `.ts` 源**打不出包** ⇒ esbuild 非零退出 ⇒ 本脚本**照样跑那份陈旧的 `.cjs`**
 * ⇒ 若旧产物恰好能过 ⇒ 总表 ✅、`SUITES_FAILED=0`、`exit=0`。
 * 唯一的痕迹是那一套标题行里的 `bundle-FAIL` 字符串 —— 它**不在总表里、不在退出码里、
 * 不在任何判据里**。和上一轮修掉的 `slice(0, 2500)` 是同一个形状：
 * **报告看起来是完整的，而关键字段已经没了。**
 *
 * 两处修：
 *   ① `bundle-FAIL` 进 `ok` ⇒ 于是进总表、进 `bad`、进 `SUITES_PASSED/FAILED`、进 `process.exit`；
 *   ② 打包器自己的输出不再丢弃 —— 真出问题时，**最该看的那段报错以前从来没进过读数**。
 *
 * ⚠️ 非 bundle 套件不许误判：`bundle: null`（显式声明不需要打包）时 `bundleOk` 保持 `null`，
 * 所以判据写 `bundleOk !== false` 而**不是** `bundleOk` —— 后者会把 `null` 当成失败。
 * 而 `bundle` 写漏（`undefined`）是**第三种**情况，见下面 `bundleState` 的三态。
 */
/**
 * ⚠️ 这里**没有** `bundleFailures` / `bundleMissing` 这两个计数器数组了 —— 故意的。
 *
 * 以前一处事件在**三处各算一遍**：`bad`（按 `!ok`）、`bundleFailures`（按 `!b.ok`）、
 * `bundleMissing`（按 `bundleState`）。三个数组**各自累加、互不看对方** ⇒
 * "有几套有打包问题"这句话有三个来源，读者还得自己在脑子里把它们拼起来。
 *
 * 现在只有**一个**来源：每套跑完记一个 `kinds`（数组、可多项），四个数全从它长出来：
 *   `OWN`  = 含 `'own'`            的套数（套件自己红）
 *   `FAIL` = 含 `'bundle-fail'`    的套数（**"有"打包问题，不是"只有"** —— 与历次冻结台账口径一致）
 *   `MISS` = 含 `'bundle-missing'` 的套数
 *   `U`    = `kinds` 非空的套数 = **并集**，按构造成立
 *
 * ⇒ 三个子计数**可以同时命中同一套**（既自身红、又打包挂），**它们不是互斥的**。
 *    这正是"用单值装多值事实"会踩的坑：单值会把一套从某个计数里**挪走**，
 *    于是新数 ≠ 旧数、历史读数不可比。所以是**多标签数组**，不是单值的 `failKind`。
 */
const results = []
for (const s of SUITES) {
  /**
   * 三态：**声明**决定形态，不由"缺省"兜底。
   *   `[src, dst]` → 'bundle'        需要打包
   *   `null`       → 'no-bundle'     显式声明不需要打包
   *   其余(undefined) → 'missing'     写漏了 ⇒ `bundle-MISSING`，**计入失败**
   * 第三种以前和第 2 种打印成同一个字符串（都是 `prepared || 'no-bundle'`），
   * 于是「合法地不需要」和「本该打包却写漏了」长得一模一样 —— 现在它们分开了。
   */
  const bundleState = Array.isArray(s.bundle) ? 'bundle' : s.bundle === null ? 'no-bundle' : 'missing'
  let prepared = bundleState === 'bundle' ? '' : bundleState === 'no-bundle' ? 'no-bundle' : 'bundle-MISSING'
  let bundleOk = null // null = 本套不需要打包；true/false = 打过包
  let bundleOut = ''
  if (bundleState === 'bundle') {
    const [src, dst] = s.bundle
    const args = existsSync(ESBUILD_JS)
      ? [ESBUILD_JS, src, '--bundle', '--platform=node', '--format=cjs', '--target=node20', `--outfile=${dst}`, '--log-level=warning']
      : [ESBUILD, src, '--bundle', '--platform=node', '--format=cjs', '--target=node20', `--outfile=${dst}`, '--log-level=warning']
    const b = run(args)
    bundleOk = b.ok
    bundleOut = b.out
    prepared = b.ok ? 'bundle-ok' : 'bundle-FAIL'
  }
  const r = run(s.run)
  /**
   * 打包失败 ⇒ 这一套跑的是**上一次留下的旧产物**，它的"绿"**不构成证据** ⇒ 本套判失败。
   * 仍然跑它：跑完的输出是有用的线索，只是**不计为通过**。也正因如此下面要明说这一点，
   * 否则读数里会出现「❌ 这一套」和「✅ 全部通过：80 项」并排的怪相而没人解释。
   */
  const ok = r.ok && bundleOk !== false && bundleState !== 'missing'
  /**
   * `kinds`：本文件**唯一**的失败计数来源。可多项 —— 一套可以同时有两件事。
   *
   * 下面三条与 `ok` 的判据**逐字对应**（同一件事的两种写法）：
   *   `!r.ok` ⇒ `'own'`、`bundleOk === false` ⇒ `'bundle-fail'`、`bundleState === 'missing'` ⇒ `'bundle-missing'`
   *
   * ⚠️ 为什么**不**把 `ok` 直接改成 `kinds.length === 0`（那样更"同源"）：为了留住一道**交叉自证**。
   *    两处独立地写、结论必须一致；将来若有人加了第四种失败却只改了一处，下面这道守卫会当场喊出来。
   *    （这个项目和这条纪律是一致的：**两套独立实现、同一结论，才算证据**。）
   */
  const kinds = []
  if (!r.ok) kinds.push('own')
  if (bundleOk === false) kinds.push('bundle-fail')
  if (bundleState === 'missing') kinds.push('bundle-missing')
  if (ok !== (kinds.length === 0)) {
    console.log(`  ⚠️ 口径漂移：本套 ok=${ok}，但 kinds=${JSON.stringify(kinds)} —— 两处判据已经不一致，请修。`)
  }
  results.push({ name: s.name, ...r, ok, prepared, bundleOk, bundleState, kinds })
  console.log(`\n${'='.repeat(70)}`)
  console.log(`[${s.name}] ${prepared} exit=${r.status} ${ok ? '✅' : '❌'}`)
  console.log(`  汇总: ${summaryOf(r.out)}`)
  if (bundleState === 'missing') {
    console.log('  ⚠️ 本套既没给 `bundle: [src, dst]`、也没声明 `bundle: null` —— 配置写漏了，本轮按失败计。')
    console.log('     （"不需要打包"必须**显式声明**；缺省不等于声明。）')
  }
  if (bundleOk === false) {
    console.log('  ⚠️ 打包失败 ⇒ 这一套跑的是旧产物，它的"绿"不构成证据，本轮按失败计。')
    console.log('  ---- 打包器输出（esbuild）----')
    /**
     * ⚠️ 这里**故意不设字符上限**（与上面的 `failureExcerpt` 的 24000 硬顶不一样），
     * 依据不是"我觉得它短"，而是**它凭什么短**：这一段只有两个来源 ——
     * esbuild 自己的报错（`--log-level=warning`，通常 3~10 行）+ node spawnSync 失败时的调用栈。
     * 它**不是**被测套件的输出，没有任何东西能让它按输入规模膨胀。
     * 反过来，一旦这里被截，"打包为什么挂了"就又要靠猜 —— 而那正是本文件已经栽过两次的坑。
     */
    console.log(bundleOut.trim() ? bundleOut.trim().split('\n').map((l) => `  ${l}`).join('\n') : '  (打包器无输出)')
  }
  if (!r.ok) console.log(failureExcerpt(r.out, s.name))
}

console.log(`\n${'='.repeat(70)}`)
console.log('总表：')
for (const r of results) {
  // 打包侧的问题在总表里也要能一眼看出是**哪种**：套件自己红了 / 打包挂了 / 配置写漏了
  const mark = r.bundleOk === false ? 'bundle-FAIL ' : r.bundleState === 'missing' ? 'bundle-MISSING ' : ''
  console.log(`  ${r.ok ? '✅' : '❌'}  ${r.name.padEnd(15)} exit=${String(r.status).padStart(3)}  ${mark}${summaryOf(r.out).slice(0, 110)}`)
}
/**
 * 四个数**同一个来源**（`records[].kinds`）—— 这是本文件"一处事件只在一处记"的兑现。
 *   `OWN` / `FAIL` / `MISS` 都是"**含**该问题的套数"，**可重复计数**；
 *   `U` 是并集（`kinds` 非空的套数）。
 * ⇒ `OWN + FAIL + MISS` **可以大于** `U`，那不是错，也**不要**拿它当 `U` 的分解式去核对。
 *    所以下面那行结论里带着 `(union)` 与 `NOTE=` —— 就是为了拦住这个错觉。
 */
const OWN = results.filter((r) => r.kinds.includes('own')).length
const FAIL = results.filter((r) => r.kinds.includes('bundle-fail')).length
const MISS = results.filter((r) => r.kinds.includes('bundle-missing')).length
const bad = results.filter((r) => r.kinds.length > 0)
const U = bad.length
console.log(bad.length === 0 ? '\n全部套件通过' : `\n${bad.length} 套失败: ${bad.map((b) => b.name).join(', ')}`)

/**
 * ASCII 结论行：上面那些中文摘要会被 **OEM 码页吞掉紧邻 `：` 的那个字符**（实测：
 * `：48 项` 读成 `?8 项`，于是被报成 38）。这一行不含中文，**任何控制台编码下都一样**。
 *
 * ⚠️ **`SUITES_TOTAL=` / `SUITES_PASSED=` / `SUITES_FAILED=` 这三个 token 必须保持
 *    连续、且一字不变形。** 已经有消费者把它们当**固定子串**匹配 ——
 *    `_r14-negctl.mjs`：`runOut.match(/SUITES_TOTAL=\d+ SUITES_PASSED=\d+ SUITES_FAILED=\d+/)`。
 *    新加的东西**只能往右边接**；插到中间会把那三个 token 断开，而后果是
 *    **不报错、静默降级成 `(没抓到)`** —— 又是一次"读数悄悄没了"。
 *    （这条是判据 59 的验收条件：改完必须复跑那条 grep，确认仍抓得到。）
 *
 * `(union)`：`SUITES_FAILED` 是**并集**（自身红 ∪ 打包挂 ∪ 配置写漏），不是三者求和。
 * `NOTE=`：三个子计数可重复计数、语义是"**含**该问题" —— 固定字面量，便于 grep 与逐次比对。
 */
console.log(
  `SUITES_TOTAL=${results.length} SUITES_PASSED=${results.length - U} SUITES_FAILED=${U}  (union) SUITES_FAILED_OWN=${OWN} BUNDLE_FAILURES=${FAIL} BUNDLE_MISSING=${MISS} NOTE=counts-are-inclusive-not-disjoint`,
)

/**
 * 打包失败单独一行 ASCII —— 与上面 `SUITES_TOTAL=` 同一个理由：
 * 中文摘要会被 OEM 码页吞掉紧邻 `：` 的字符，而这一行在任何控制台编码下都一样。
 * **任何一个 `bundle-FAIL` 都必须在这行里有计数**，否则"打包挂了"这件事在某些控制台里读不出来。
 * `= 0` 也要打：那是一句正面的保证，与"什么都没说"是两回事。
 * （值与上面那行的 `BUNDLE_FAILURES=` **同源同值**；重复打印是为了让"只认单独一行"的消费者不必改。）
 */
console.log(`BUNDLE_FAILURES=${FAIL}`)

/**
 * 「配置写漏」单独再一行 ASCII，**不并进 `BUNDLE_FAILURES`**。
 *
 * 理由就是我们这轮在修的东西：`bundle-FAIL`（打包器挂了）和 `bundle-MISSING`（人写漏了）
 * 是**两种不同的失败**，并成一个数就又把它们变成"长得一样"。
 *
 * ⚠️ 与 `SUITES_FAILED=` 的关系（这句话以前**写错了**，现在按行为重写）：
 * 上面那行已标 `(union)` —— 写漏的**这一套本身**确实会因 `kinds` 非空而计进 `SUITES_FAILED`；
 * 这句要说的是**不把这个计数再加进那行数里**（三个子计数可重复计数，不是求和）。
 * 旧写法"（那是套件自己的红）"**是假的**，反例就在自己的读数里 ——
 * `_r15-missingctrl.txt`：写漏时 `SUITES_TOTAL=7 SUITES_PASSED=6 SUITES_FAILED=1`。
 *
 * `= 0` 照样打：正面保证。
 */
console.log(`BUNDLE_MISSING=${MISS}`)

/**
 * ⚠️ 这里必须**真的设置退出码** —— 在加这一行之前，本脚本**从来不设置**，
 * 于是它永远 `exit=0`，哪怕里面红了好几套。那意味着"七套 exit=0"这种说法
 * 只反映"脚本跑完了"，**不反映"套件过了"** —— 一个看起来像证据、实际是空证据的读数。
 *
 * 正确的判据是两条独立的：①总表里每套的 ✅/❌（来自子进程真实退出码）
 * ②本进程自己的退出码（现在它才第一次真的会变）。
 */
process.exit(bad.length === 0 ? 0 : 1)
