/**
 * 打印保真度自测（两条"所见非所得"缺陷的回归护栏）。
 *
 * 缺陷 A —— 取值 dump 成 JSON：
 *   飞书文本字段的值可能是**富文本片段数组** `[{type:'text',text:'张三'}]`，
 *   旧实现走 default 分支 `JSON.stringify(value)`，于是纸面上印出 `[{"type":"text"...}]`。
 *   这里的断言逻辑是"**全类型矩阵**遍历 + 结果里不许出现 JSON 特征字符"，
 *   而不是逐个 case 比对字符串 —— 这样才能挡住"以后新增字段类型又走了 default"。
 *
 * 缺陷 B —— 画布不重叠、打印出来叠压：
 *   块的 y 是作者摆的**绝对**位置，但高度由内容决定（文本一换行就比盒子高）。
 *   内容顶出盒子后，下面那个元素仍被摆在盒子底边之上 → 叠字。
 *   这里先在 Node 里复刻**改前的放置规则**并断言它确实会叠压（= 改前失败的对照），
 *   再断言 `paginate()` 的输出不叠压、且换页判断用的是"放置后的真实高度"。
 *
 * 浏览器侧的实测（真实 DOM 高度、`h:'auto'` 的测量）不在这里，见
 * `test/print-fidelity-probe.ts` + `test/print-fidelity-run.mjs`（CDP 截图）。
 *
 * 运行：esbuild 打包成 cjs 后 node 执行（与 test/code-elements-test.ts 同法）
 */

import { renderCellValue } from '../src/lib/field-types'
import { FT } from '../src/lib/field-types'
import { paginate, type MeasuredBlock } from '../src/render/layout'
import type { PageModel } from '../src/render/context'
import { buildDocumentHtml } from '../src/render/html'
import { emptyRenderContext } from '../src/render/context'
import { DEFAULT_PAGE_SETUP, mmToPx } from '../src/lib/types'

let pass = 0
const failures: string[] = []

function ok(name: string, cond: boolean, detail = ''): void {
  if (cond) pass++
  else failures.push(`${name}${detail ? ` — ${detail}` : ''}`)
}

function eq<T>(name: string, got: T, want: T): void {
  ok(name, got === want, `期望 ${String(want)}，实际 ${String(got)}`)
}

function section(t: string): void {
  console.log(`\n【${t}】`)
}

// ============================================================
// 缺陷 A：renderCellValue 取值
// ============================================================

/** JSON / 对象漏出的特征：出现任何一个都说明"值没被翻成人话" */
const JSON_LEAK = ['{', '}', '[object', '"type"', 'undefined', 'null']

function noLeak(name: string, got: string): void {
  const bad = JSON_LEAK.filter((t) => got.includes(t))
  ok(name, bad.length === 0, `实际 ${JSON.stringify(got)} 里含 ${bad.join('/')}`)
}

function defectA(): void {
  section('缺陷 A：富文本片段数组必须拼成人话，不能 dump JSON')

  // ---- 用户实际踩到的那一类：文本字段返回富文本片段数组 ----
  const seg = renderCellValue([{ type: 'text', text: '张三' }], FT.Text)
  eq('文本字段：单段富文本数组 → 取出 text', seg, '张三')
  noLeak('文本字段：单段富文本数组不含 JSON 特征', seg)

  const mixed = renderCellValue(
    [{ type: 'text', text: '张三 ' }, { type: 'mention', text: '@李四' }, { type: 'text', text: ' 提了' }],
    FT.Text,
  )
  eq('文本字段：text + mention 混合段 → 逐段相接（不是用、连接）', mixed, '张三 @李四 提了')
  noLeak('文本字段：混合段不含 JSON 特征', mixed)

  eq('文本字段：普通字符串原样返回', renderCellValue('纯文本', FT.Text), '纯文本')
  eq('文本字段：对象值取 text（不是 [object Object]）', renderCellValue({ text: '甲', name: '乙' }, FT.Text), '甲')
  eq('文本字段：对象只有 name 时取 name', renderCellValue({ name: '乙' }, FT.Text), '乙')

  const emptyObj = renderCellValue({ foo: 1, bar: [{ a: 1 }] }, FT.Text)
  eq('文本字段：取不到可读文本 → 空串（宁可空，不可印 JSON）', emptyObj, '')
  noLeak('文本字段：不可读对象不泄漏 JSON', emptyObj)

  // ---- 改前这一整组全是 `JSON.stringify` 的产物 ----
  eq('数字字段：数字原样', renderCellValue(12.5, FT.Number), '12.5')
  eq('数字字段：数字字符串转数字', renderCellValue('12.5', FT.Number), '12.5')
  const numObj = renderCellValue({ text: '8' }, FT.Number)
  eq('数字字段：非数字对象 → 取可读文本', numObj, '8')
  noLeak('数字字段：非数字对象不 dump', numObj)

  // ---- 查找引用 / 公式：类型上算"文本"，但值常常是数组或对象 ----
  eq('查找引用：对象值取 text', renderCellValue({ text: '引用值' }, FT.Lookup), '引用值')
  eq(
    '查找引用：数组值用「、」连接（与多选一致）',
    renderCellValue([{ text: 'A' }, { text: 'B' }], FT.Lookup),
    'A、B',
  )
  eq('公式：对象值取 text', renderCellValue({ text: '公式结果' }, FT.Formula), '公式结果')

  // ---- 未知字段类型（插件不认识）：必须按文本处理，不许漏 JSON ----
  const unknown = renderCellValue({ text: '未知类型取值' }, 99999)
  eq('未知字段类型：仍取可读文本', unknown, '未知类型取值')
  noLeak('未知字段类型：不 dump JSON', unknown)

  // ---- 既有分支不能被改坏 ----
  eq('多选：仍用「、」连接', renderCellValue([{ text: 'A' }, { text: 'B' }], FT.MultiSelect), 'A、B')
  eq('人员：取 name', renderCellValue([{ name: '张三' }, { name: '李四' }], FT.User), '张三、李四')
  eq('人员：只剩 open_id 时给空串（印一串 id 比印空更糟）', renderCellValue([{ id: 'ou_xxx' }], FT.User), '')
  eq(
    '附件：仍然用换行连接（不能跟着数组改成「、」）',
    renderCellValue([{ name: 'a.pdf' }, { name: 'b.pdf' }], FT.Attachment),
    'a.pdf\nb.pdf',
  )
  eq('复选框：true → 是', renderCellValue(true, FT.Checkbox), '是')
  eq('复选框：false → 否', renderCellValue(false, FT.Checkbox), '否')
  eq('网址：对象取 text', renderCellValue({ text: '飞书', link: 'https://feishu.cn' }, FT.Url), '飞书')
  eq('评分：数字原样', renderCellValue(4, FT.Rating), '4')
  eq('进度：0.5 → 50%', renderCellValue(0.5, FT.Progress), '50%')
  eq('空值：null → 空串', renderCellValue(null, FT.Text), '')
  eq('空值：undefined → 空串', renderCellValue(undefined, FT.Text), '')

  // ---- 全类型矩阵：任何字段类型 + 任何"对象状"取值，都不允许漏 JSON ----
  const TYPES: Array<[string, number]> = [
    ['文本', FT.Text],
    ['数字', FT.Number],
    ['单选', FT.SingleSelect],
    ['多选', FT.MultiSelect],
    ['日期', FT.DateTime],
    ['复选框', FT.Checkbox],
    ['人员', FT.User],
    ['电话', FT.Phone],
    ['网址', FT.Url],
    ['附件', FT.Attachment],
    ['关联', FT.SingleLink],
    ['查找引用', FT.Lookup],
    ['公式', FT.Formula],
    ['双向关联', FT.DuplexLink],
    ['未知', 99999],
  ]
  const VALUES: Array<[string, unknown]> = [
    ['富文本段', [{ type: 'text', text: '值' }]],
    ['对象', { text: '值', extra: { deep: true } }],
    ['对象数组', [{ name: '值' }, { id: 'x' }]],
    ['嵌套数组', [[{ text: '值' }]]],
  ]
  let leaks = 0
  for (const [, t] of TYPES) {
    for (const [vn, v] of VALUES) {
      const out = renderCellValue(v, t)
      if (JSON_LEAK.some((f) => out.includes(f))) {
        leaks++
        failures.push(`矩阵泄漏：类型 ${t} / 取值 ${vn} → ${JSON.stringify(out)}`)
      }
    }
  }
  ok(`全类型矩阵（${TYPES.length} 类型 × ${VALUES.length} 取值）无一处漏出 JSON`, leaks === 0)
}

// ============================================================
// 缺陷 B：块落位不得叠压
// ============================================================

function blk(id: string, yMm: number, hMm: number, xMm = 0, wMm = 60): MeasuredBlock {
  return { elementId: id, kind: 'text', xMm, yMm, wMm, hMm, html: `<div style="width:100%">${id}</div>` }
}

/** 同栏（x 区间重叠）判定 —— 与 layout 内部的判据保持一致 */
function sameColumn(a: { xMm: number; wMm: number }, b: { xMm: number; wMm: number }): boolean {
  return a.xMm < b.xMm + b.wMm - 0.05 && b.xMm < a.xMm + a.wMm - 0.05
}

/** 逐页检查：同栏内两块的纵向区间不许重叠 */
function overlapsOf(page: PageModel): string[] {
  const out: string[] = []
  const bs = page.blocks
  for (let i = 0; i < bs.length; i++) {
    for (let j = i + 1; j < bs.length; j++) {
      const a = bs[i]
      const b = bs[j]
      if (!sameColumn(a, b)) continue
      const lo = a.yMm < b.yMm ? a : b
      const hi = a.yMm < b.yMm ? b : a
      if (lo.yMm + lo.hMm > hi.yMm + 0.05) {
        out.push(`${lo.elementId}(${lo.yMm}~${round2(lo.yMm + lo.hMm)}) 压住 ${hi.elementId}(顶 ${hi.yMm})`)
      }
    }
  }
  return out
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

function placedOf(pages: PageModel[], id: string): { y: number; h: number; page: number } | null {
  for (let i = 0; i < pages.length; i++) {
    const b = pages[i].blocks.find((x) => x.elementId === id)
    if (b) return { y: b.yMm, h: b.hMm, page: i }
  }
  return null
}

/**
 * 改前的放置规则 —— **逐字复刻旧实现**：每个块按"作者给的相对 y"落位，
 * 完全不看上一块的内容是否已经顶出了它的盒子。
 * 它在这里唯一的作用是当"改前失败"的对照：断言它确实会产出叠压。
 */
function legacyPlace(blocks: MeasuredBlock[], topY: number, rowMinYm: number): Array<{ id: string; y: number }> {
  return blocks.map((b) => ({ id: b.elementId, y: topY + (b.yMm - rowMinYm) }))
}

function defectB(): void {
  section('缺陷 B：内容顶出盒子后，同栏下方的块必须顺移（不许叠压）')

  // 用户场景的几何（数值取自浏览器实测）：
  //   产品名称：窄元素（30mm 宽），"薇诺娜舒敏保湿特护霜"折成 2 行 → 真实内容高 11.11mm
  //   规格型号：作者摆在 y=8mm
  // 旧实现里名称的占位高 = 作者给的 6mm，于是规格型号留在 y=8 → 名称第 2 行被压住。
  const name = blk('el_name', 0, 11.11, 0, 30)
  const spec = blk('el_spec', 8, 6, 0, 60)

  // ---- 改前失败的对照：旧规则确实叠压 ----
  const legacy = legacyPlace([name, spec], 0, 0)
  const legacyName = legacy[0]
  const legacySpec = legacy[1]
  ok(
    '改前对照：旧规则把 el_spec 留在 y=8，名称内容到 11.11 → 真的叠压（这条断言在修复前成立，等于复现了用户看到的画面）',
    legacyName.y + name.hMm > legacySpec.y + 0.05,
    `名称底 ${round2(legacyName.y + name.hMm)} / 规格顶部 ${legacySpec.y}`,
  )

  // ---- 改后：paginate 必须不叠压，且把下方元素顺移到内容底边之下 ----
  const out = paginate({
    records: [{ recordIndex: 0, blocks: [name, spec] }],
    contentHeightMm: 260,
  })
  const ov = overlapsOf(out.pages[0])
  ok('修复后：同名场景不再叠压', ov.length === 0, ov.join('；'))

  const placedSpec = placedOf(out.pages, 'el_spec')
  ok(
    '修复后：el_spec 被顺移到名称内容底边之下（≥11.11mm）',
    !!placedSpec && placedSpec.y >= 11.11 - 0.05,
    `实际 y=${placedSpec ? placedSpec.y : '缺块'}`,
  )

  // ---- h:'auto' 场景：模型高度本来就对（11.11），旧实现照样叠压（同排归组后按作者 y 落位）----
  const autoOut = paginate({
    records: [{ recordIndex: 0, blocks: [blk('el_name_auto', 0, 11.11, 0, 30), blk('el_spec_auto', 8, 6, 0, 60)] }],
    contentHeightMm: 260,
  })
  const autoSpec = placedOf(autoOut.pages, 'el_spec_auto')
  ok(
    "h:'auto' 场景：规格型号同样被顺移（模型高度对了还不够，落位也得让路）",
    !!autoSpec && autoSpec.y >= 11.11 - 0.05 && overlapsOf(autoOut.pages[0]).length === 0,
    `实际 y=${autoSpec ? autoSpec.y : '缺块'}`,
  )

  // ---- 对照：横向并排（标签 + 值）不能被这条约束改坏 ----
  const sideOut = paginate({
    records: [{ recordIndex: 0, blocks: [blk('label', 0, 6, 0, 20), blk('value', 0, 6, 25, 40)] }],
    contentHeightMm: 260,
  })
  const label = placedOf(sideOut.pages, 'label')
  const value = placedOf(sideOut.pages, 'value')
  ok(
    '对照：x 不重叠的并排块仍严格按作者 y 落位（标签左、值右，都在 y=0）',
    !!label && !!value && label.y === 0 && value.y === 0,
    `label.y=${label?.y} value.y=${value?.y}`,
  )

  // ---- 对照：作者显式留白（盒子比内容高）时，块仍然占满盒子高 ----
  const tallOut = paginate({
    records: [{ recordIndex: 0, blocks: [blk('el_name_tall', 0, 12, 0, 30), blk('el_spec_tall', 14, 6, 0, 60)] }],
    contentHeightMm: 260,
  })
  const tallSpec = placedOf(tallOut.pages, 'el_spec_tall')
  ok(
    '对照：作者把盒子设成 12mm（内容 11.11）时，下方元素仍留在作者摆的 y=14',
    !!tallSpec && tallSpec.y === 14,
    `实际 y=${tallSpec ? tallSpec.y : '缺块'}`,
  )

  // ---- 换页判断必须用"放置后的真实高度"：夹紧会把本排撑高 ----
  // 页高 30：先放一个 15mm 的填充块，接着一整排"夹紧后高 16mm"的块。
  // 旧实现只按作者跨度（10mm）判断 → 15+10=25 ≤ 30 留在本页，然后块被夹紧到 8~16 溢出页底；
  // 新实现按放置后高度（16mm）判断 → 15+16=31 > 30 → 整排换到下一页。
  const pageOut = paginate({
    records: [
      { recordIndex: 0, blocks: [blk('filler', 0, 15)] },
      { recordIndex: 1, blocks: [blk('a', 0, 8), blk('b', 2, 8)] },
    ],
    contentHeightMm: 30,
  })
  const bPlace = placedOf(pageOut.pages, 'b')
  ok(
    '换页判断用的是"夹紧后"的排高：整排被移到第 2 页（而不是溢出页底）',
    !!bPlace && bPlace.page === 1,
    `实际落在第 ${bPlace ? bPlace.page + 1 : '?'} 页；页数 ${pageOut.pages.length}`,
  )
  ok(
    '跨页后同栏依然不叠压',
    pageOut.pages.every((p) => overlapsOf(p).length === 0),
    pageOut.pages.map((p, i) => `P${i + 1}:${overlapsOf(p).join('；')}`).join(' | '),
  )
  const bOnPage2 = pageOut.pages[1]?.blocks.find((x) => x.elementId === 'b') ?? null
  ok(
    '第 2 页里 b 落在 a 的内容底边之下（y ≥ 8）',
    !!bOnPage2 && bOnPage2.yMm >= 8 - 0.05,
    `实际 y=${bOnPage2 ? bOnPage2.yMm : '缺块'}`,
  )
}

// ============================================================
// 输出层：块容器用 min-height 兜底（内容仍比模型高时不溢出去压别人）
// ============================================================

function outputLayer(): void {
  section('输出层：.bp-el 用 min-height，内容超了由浏览器撑开而不是溢出压字')

  const pages: PageModel[] = [
    {
      index: 0,
      recordRange: [0, 1],
      blocks: [
        { elementId: 'a', kind: 'text', xMm: 0, yMm: 0, wMm: 50, hMm: 10, html: '<div>x</div>' },
        { elementId: 't', kind: 'table', xMm: 0, yMm: 20, wMm: 50, hMm: 5, html: '<table></table>' },
      ],
    },
  ]
  const html = buildDocumentHtml(pages, DEFAULT_PAGE_SETUP, emptyRenderContext(), { title: '测试' })

  const textEl = (html.match(/<div class="bp-el bp-el-text"[^>]*>/) ?? [''])[0]
  ok('.bp-el 的样式里写了 min-height', /min-height:/.test(textEl), textEl)
  ok(
    '.bp-el 不再写死 height（写死会让换行文字溢出盒外、压住下一个元素）',
    !/(?:^|;)height:/.test(textEl.replace(/min-height:/g, 'miniheight:')),
    textEl,
  )
  ok('min-height 的值等于模型给的高度（10mm → 37.795px）', textEl.includes(`${round3(mmToPx(10))}px`), textEl)

  const tableEl = (html.match(/<div class="bp-el bp-el-table"[^>]*>/) ?? [''])[0]
  ok('表格块仍然不写高度（片段高度由行高决定）', !/min-height:/.test(tableEl), tableEl)

  ok('输出中不含 NaN（NaN 会让浏览器整条丢弃样式声明）', !html.includes('NaN'))
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000
}

// ============================================================

function main(): void {
  defectA()
  defectB()
  outputLayer()

  console.log('\n' + '='.repeat(52))
  if (failures.length === 0) console.log(`✅ 全部通过：${pass} 项`)
  else {
    console.log(`❌ ${failures.length} 项失败 / 共 ${pass + failures.length} 项`)
    for (const f of failures) console.log(`   · ${f}`)
  }
  console.log('='.repeat(52))
  process.exit(failures.length === 0 ? 0 : 1)
}

main()
