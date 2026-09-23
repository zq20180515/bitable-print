/**
 * 二维码 / 条形码自测：编码正确性 + 渲染契约。
 *
 * 为什么单测要"反解 SVG"而不是只看字符串包含：
 *   码类元素是**唯一一种"渲染出来了但内容错了，屏幕上完全看不出来"**的元素。
 *   二维码少一个模块、条码校验位差 1，肉眼完全一样，但扫码器读出来的值是错的。
 *   所以这里的断言全部基于把 SVG 里的矩形**还原回模块位串**再逐位比对，
 *   等于在 Node 里当了一次扫码器。
 *
 * 运行：esbuild 打包成 cjs 后 node 执行（与 test/skeleton-test.ts 同法）
 */

import { barcodeSvg, isCode128Encodable, qrCodeSvg, QR_MAX_BYTES, utf8ByteLength } from '../src/render/code-elements'
import { renderDocument } from '../src/render/pipeline'
import { emptyRenderContext } from '../src/render/context'
import type { AnyElement, InlineNode, TemplateDoc } from '../src/lib/types'
import { DEFAULT_PAGE_SETUP, SCHEMA_VERSION, TIME_FORMAT_PRESETS } from '../src/lib/types'
import type { FieldMeta, RecordItem } from '../src/lib/data-source'

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
// QR：静默区（QR 规范要求四周各留 4 个模块）
// ============================================================
const QR_QUIET = 4
/** 版本 k 的模块数 = 21 + 4(k-1) */
const QR_VERSION_STEP = 4

/** 从 SVG 的 viewBox 反解模块总数（viewBox 边长 = 模块数 + 两侧静默区） */
function qrTotalFromSvg(svg: string): number {
  const m = svg.match(/viewBox="0 0 ([\d.]+) [\d.]+"/)
  return m ? Number(m[1]) - QR_QUIET * 2 : -1
}

/** 把 SVG 里的模块矩形还原成 n×n 矩阵 */
function qrMatrix(svg: string, n: number): boolean[][] {
  const grid: boolean[][] = Array.from({ length: n }, () => new Array<boolean>(n).fill(false))
  const group = svg.match(/<g[^>]*>([\s\S]*?)<\/g>/)
  const body = group ? group[1] : ''
  const re = /<rect x="(\d+)" y="(\d+)" width="(\d+)" height="(\d+)"\/>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(body)) !== null) {
    const x0 = Number(m[1])
    const y0 = Number(m[2])
    const w = Number(m[3])
    const h = Number(m[4])
    for (let dy = 0; dy < h; dy++) {
      for (let dx = 0; dx < w; dx++) {
        const r = y0 - QR_QUIET + dy
        const c = x0 - QR_QUIET + dx
        if (r >= 0 && r < n && c >= 0 && c < n) grid[r][c] = true
      }
    }
  }
  return grid
}

/** 把条形码 SVG 还原成模块位串（'1' = 条） */
function barcodeBits(svg: string, totalModules: number): string {
  const wm = Number((svg.match(/width="([\d.]+)mm"/) ?? [])[1])
  const moduleW = wm / totalModules
  const bits = new Array<string>(totalModules).fill('0')
  const group = svg.match(/<g[^>]*>([\s\S]*?)<\/g>/)
  const body = group ? group[1] : ''
  const re = /<rect x="([\d.\-]+)" y="[\d.\-]+" width="([\d.\-]+)" height="[\d.\-]+"\/>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(body)) !== null) {
    const start = Math.round(Number(m[1]) / moduleW)
    const len = Math.round(Number(m[2]) / moduleW)
    for (let k = 0; k < len; k++) {
      if (start + k < totalModules) bits[start + k] = '1'
    }
  }
  return bits.join('')
}

/** Code 128 的总模块数：START(11) + n×11 + 校验(11) + STOP(13) */
function c128Total(n: number): number {
  return 35 + 11 * n
}

/** 编码一段 ASCII 内容并还原出位串 */
function bitsOf(text: string): string {
  const svg = barcodeSvg(text, { widthMm: 40, heightMm: 15 })
  return barcodeBits(svg, c128Total(text.length))
}

// ============================================================
// 1. 二维码
// ============================================================
section('二维码 / 结构与版本')
{
  const svg = qrCodeSvg('HELLO', { sizeMm: 30 })
  ok('能出码（非空 SVG）', svg.startsWith('<svg') && svg.endsWith('</svg>'))
  console.log(`   HELLO(EC=M) → 模块数 ${qrTotalFromSvg(svg)}，viewBox 边长 ${qrTotalFromSvg(svg) + QR_QUIET * 2}（含两侧静默区）`)
  eq('HELLO + EC=M 落在版本 1（21 个模块）', qrTotalFromSvg(svg), 21)
  ok('带 shape-rendering="crispEdges"（不加会糊到扫不出来）', svg.includes('shape-rendering="crispEdges"'))
  eq('静默区 4 模块：viewBox 比模块数大 8', qrTotalFromSvg(svg) + QR_QUIET * 2, 29)
  ok('尺寸用 mm（打印 1:1，而不是按 px 缩放）', svg.includes('width="30mm"') && svg.includes('height="30mm"'))

  // 找像图案（左上角）：这是个"真的是二维码"而不是随便一堆方块的结构性证明
  const g = qrMatrix(svg, 21)
  let ringOk = true
  for (let i = 0; i < 7; i++) {
    if (!g[0][i] || !g[6][i] || !g[i][0] || !g[i][6]) ringOk = false
  }
  let innerOk = true
  for (let r = 2; r <= 4; r++) for (let c = 2; c <= 4; c++) if (!g[r][c]) innerOk = false
  let gapOk = true
  for (let i = 1; i <= 5; i++) if (g[1][i] || g[i][1]) gapOk = false
  ok('左上角是标准 7×7 定位图案（外框 + 3×3 实心 + 一圈空白）', ringOk && innerOk && gapOk)
  ok('矩阵有内容且不是全黑', g.some((row) => row.some(Boolean)) && g.some((row) => row.some((v) => !v)))
  ok('二维码 SVG 不含 NaN', !svg.includes('NaN'))
}
{
  const long = qrCodeSvg('A'.repeat(200), { sizeMm: 40 })
  const n = qrTotalFromSvg(long)
  ok('长内容自动升版本', n > 21, `模块数 ${n}`)
  eq('模块数符合 21 + 4k', (n - 21) % QR_VERSION_STEP, 0)
  ok('长内容仍在版本 40 以内', n <= 177)

  const cn = qrCodeSvg('追溯码：昆明仓-2026-0001，中文也要能出码', { sizeMm: 30 })
  ok('含中文能出码（UTF-8 字节模式）', cn.startsWith('<svg') && qrTotalFromSvg(cn) >= 21)
  const cnSoft = qrCodeSvg('中文', { sizeMm: 30, ecLevel: 'H' })
  ok('纠错等级 H 可用', cnSoft.startsWith('<svg') && qrTotalFromSvg(cnSoft) >= 21)
  ok('utf8ByteLength 按字节算（中文 3 字节）', utf8ByteLength('中') === 3)
}
section('二维码 / 颜色与非法入参')
{
  const custom = qrCodeSvg('HELLO', { sizeMm: 20, foreground: '#1f2329', background: '#eeeeee' })
  ok('前景色穿透到 SVG', custom.includes('fill="#1f2329"'))
  ok('背景色穿透到 SVG', custom.includes('fill="#eeeeee"'))
  const def = qrCodeSvg('HELLO', { sizeMm: 20 })
  ok('默认前景黑 / 背景白', def.includes('fill="#000000"') && def.includes('fill="#ffffff"'))

  // 非法入参一律返回空串而不抛错：调用方会走"占位框 + 警告"分支
  let threw = false
  const empty: string[] = []
  try {
    empty.push(qrCodeSvg('', { sizeMm: 30 }))
    empty.push(qrCodeSvg('A', { sizeMm: 0 }))
    empty.push(qrCodeSvg('A', { sizeMm: -5 }))
    empty.push(qrCodeSvg('A', { sizeMm: Number.NaN }))
    empty.push(qrCodeSvg('A', undefined as unknown as { sizeMm: number }))
    empty.push(qrCodeSvg('A', { sizeMm: 30, foreground: '', background: '   ' }))
  } catch {
    threw = true
  }
  ok('空内容 / 尺寸 ≤0 / NaN / 缺参 都不抛错', !threw)
  ok('空内容与非法尺寸返回空串', empty[0] === '' && empty[1] === '' && empty[2] === '' && empty[3] === '')
  ok('空颜色回落成默认黑白色', empty[5].includes('fill="#000000"') && empty[5].includes('fill="#ffffff"'))

  let overflowThrew = false
  let huge = ''
  try {
    huge = qrCodeSvg('A'.repeat(5000), { sizeMm: 40 })
  } catch {
    overflowThrew = true
  }
  ok('超容量内容（5000 字节）不抛错、返回空串', !overflowThrew && huge === '')
  ok('容量上限常量合理（EC=M 版本 40 约 2331 字节）', QR_MAX_BYTES > 0 && QR_MAX_BYTES < 2331)
}

// ============================================================
// 2. 条形码（Code 128 / Code Set B）
// ============================================================
section('条形码 / Code128 编码与校验位')
{
  // 手算基准（Code 128 规范）：
  //   'A' → 值 = 65 - 32 = 33；码字 33 = 111323 → 位串 10100011000
  //   校验位 = (104 + 1×33) mod 103 = 137 mod 103 = 34；码字 34 = 131123 → 位串 10001011000
  //   START B = 104 → 211214 → 11010010000；STOP = 106 → 2331112 → 1100011101011
  const START_B = '11010010000'
  const STOP = '1100011101011'
  const DATA_A = '10100011000'
  const CHECK_A = '10001011000'

  eq('手算校验位：(104 + 1×33) mod 103 = 34', (104 + 1 * 33) % 103, 34)

  const svg = barcodeSvg('A', { widthMm: 40, heightMm: 15 })
  ok('能出码', svg.startsWith('<svg') && svg.includes('shape-rendering="crispEdges"'))
  const bits = barcodeBits(svg, c128Total(1))
  console.log(`   'A' 位串 = ${bits}`)
  console.log(`   分段：START[${bits.slice(0, 11)}] 数据[${bits.slice(11, 22)}] 校验[${bits.slice(22, 33)}] STOP[${bits.slice(33)}]`)
  eq('总模块数 = 11 + 11 + 11 + 13 = 46', bits.length, 46)
  eq('START B 模块序列正确', bits.slice(0, 11), START_B)
  eq('数据码字正确（A = 值 33）', bits.slice(11, 22), DATA_A)
  eq('校验位码字正确（值 34）', bits.slice(22, 33), CHECK_A)
  eq('STOP 模块序列正确', bits.slice(33), STOP)

  // 'AB'：A=33、B=34 → (104 + 1×33 + 2×34) mod 103 = 205 mod 103 = 102
  // 码字 102 = 411131 → 位串 11110101110（这一例专门覆盖"校验位 > 94"的高段）
  eq('手算校验位：(104 + 1×33 + 2×34) mod 103 = 102', (104 + 1 * 33 + 2 * 34) % 103, 102)
  const ab = barcodeBits(barcodeSvg('AB', { widthMm: 40, heightMm: 15 }), c128Total(2))
  eq('两个字符的总模块数 = 57', ab.length, 57)
  eq('AB 的数据码字正确（A、B 依次排布）', ab.slice(11, 33), DATA_A + '10001011000')
  eq('AB 的校验位码字正确（值 102）', ab.slice(33, 44), '11110101110')
  eq('AB 的 STOP 仍然对得上', ab.slice(44), STOP)
}
section('条形码 / 全码表自检（95 个可打印 ASCII）')
{
  // 用公开 API 反推 值 → 码字 对照表，再逐字符核对校验位。
  // 这样即便表里有一个数字敲错，也会在这里被抓出来（位串长度或校验位对不上）。
  const patOf = new Map<number, string>()
  const dataSet = new Set<string>()
  let shapeBad = ''
  let lenBad = ''
  for (let c = 32; c <= 126; c++) {
    const v = c - 32
    const b = bitsOf(String.fromCharCode(c))
    const data = b.slice(11, 22)
    patOf.set(v, data)
    dataSet.add(data)
    if (!/^1[01]{9}0$/.test(data)) shapeBad += `${String.fromCharCode(c)}=${data} `
    if (b.length !== c128Total(1) || b.slice(0, 11) !== '11010010000' || b.slice(33) !== '1100011101011') lenBad += String.fromCharCode(c)
  }
  eq('95 个数据码字互不相同（表里没有重复项）', dataSet.size, 95)
  ok('每个码字都是 11 模块、以条开头以空结尾', shapeBad === '', shapeBad)
  ok('每个字符都是 46 模块且首尾是 START B / STOP', lenBad === '', lenBad)

  let checkBad = ''
  for (let c = 32; c <= 126; c++) {
    const v = c - 32
    const want = (104 + 1 * v) % 103
    if (want <= 94 && patOf.get(want) !== bitsOf(String.fromCharCode(c)).slice(22, 33)) {
      checkBad += String.fromCharCode(c)
    }
  }
  ok('单字符校验位 = (104 + 值) mod 103 全部成立', checkBad === '', checkBad)

  // 多字符加权：'A1B' → A=33、1=17、B=34 → (104 + 1×33 + 2×17 + 3×34) mod 103 = 67
  const wantA1B = (104 + 1 * 33 + 2 * 17 + 3 * 34) % 103
  const a1b = bitsOf('A1B')
  eq('三个字符的总模块数 = 68', a1b.length, c128Total(3))
  ok(
    '多字符加权校验位正确（权重从 1 开始递增）',
    a1b.slice(44, 55) === patOf.get(wantA1B),
    `期望值 ${wantA1B}，实际 ${patOf.get(wantA1B)}`,
  )
}
section('条形码 / 原文行与非法内容')
{
  const withText = barcodeSvg('ABC-123', { widthMm: 50, heightMm: 15, showText: true })
  ok('showText=true 显示原文', withText.includes('<text') && withText.includes('>ABC-123<'))
  ok('尺寸用 mm', withText.includes('width="50mm"') && withText.includes('height="15mm"'))
  const noText = barcodeSvg('ABC-123', { widthMm: 50, heightMm: 15 })
  ok('showText 缺省不显示原文', !noText.includes('<text'))

  const colored = barcodeSvg('A1', { widthMm: 30, heightMm: 12, foreground: '#333333', background: '#fafafa' })
  ok('条形码颜色穿透到 SVG', colored.includes('fill="#333333"') && colored.includes('fill="#fafafa"'))

  ok('isCode128Encodable：ASCII 可见字符可编码', isCode128Encodable('ABC-123_/.*+%') && isCode128Encodable(' '))
  ok('isCode128Encodable：中文/换行/空串不可编码', !isCode128Encodable('追溯码') && !isCode128Encodable('A\nB') && !isCode128Encodable(''))

  let threw = false
  const outs: string[] = []
  try {
    outs.push(barcodeSvg('中文编号', { widthMm: 40, heightMm: 15 }))
    outs.push(barcodeSvg('', { widthMm: 40, heightMm: 15 }))
    outs.push(barcodeSvg('A', { widthMm: 0, heightMm: 15 }))
    outs.push(barcodeSvg('A', { widthMm: 40, heightMm: 0 }))
    outs.push(barcodeSvg('A\u00e9', { widthMm: 40, heightMm: 15 }))
  } catch {
    threw = true
  }
  ok('非 ASCII / 空内容 / 尺寸 ≤0 都不抛错', !threw)
  ok('非 ASCII 与非法尺寸返回空串（由调用方给警告）', outs.every((s) => s === ''))
  ok('超长内容仍然出码（可读性由调用方告警，不在这里拒绝）', barcodeSvg('X'.repeat(35), { widthMm: 60, heightMm: 15 }) !== '')

  // 用户可填的颜色值直接进了 XML 属性，必须转义（否则等于开了个 XSS 口子）
  const evil = barcodeSvg('A"B', { widthMm: 40, heightMm: 15, showText: true, foreground: '"><script>x</script>' })
  ok('内容里的引号被转义', evil.includes('&quot;'))
  ok('颜色里的注入被转义（不会产出可执行标签）', !evil.includes('<script') && !evil.includes('onload="'))
}

// ============================================================
// 3. 端到端：模板里有二维码 / 条形码
// ============================================================
const FIELDS: FieldMeta[] = [
  { id: 'f1', name: '编号', type: 1, isPrimary: true },
  { id: 'f2', name: '追溯码', type: 1 },
  { id: 'f3', name: '空字段', type: 1 },
]

const RECORDS: RecordItem[] = [
  { recordId: 'r0', fields: { f1: 'RK-0001', f2: 'TRACE-0001', f3: '' } },
  { recordId: 'r1', fields: { f1: 'RK-0002', f2: '追溯码中文', f3: 'x' } },
]

function makeDoc(): TemplateDoc {
  const qr: AnyElement = {
    id: 'el_qr',
    kind: 'qrcode',
    x: 0,
    y: 0,
    w: 30,
    h: 30,
    source: { kind: 'static', value: 'https://example.com/trace' },
    ecLevel: 'M',
  }
  const bar: AnyElement = {
    id: 'el_bar',
    kind: 'barcode',
    x: 0,
    y: 32,
    w: 60,
    h: 15,
    source: { kind: 'field', fieldId: 'f2', fieldName: '追溯码' },
    showText: true,
  }
  // 未绑定字段的二维码放在重复区：模板级问题，只应报一次
  const unbound: AnyElement = {
    id: 'el_qr_unbound',
    kind: 'qrcode',
    x: 120,
    y: 0,
    w: 24,
    h: 24,
    source: { kind: 'field', fieldId: null, fieldName: '二维码' },
  }
  const printTime: AnyElement = {
    id: 'el_pt',
    kind: 'text',
    x: 0,
    y: 0,
    w: 60,
    h: 6,
    nodes: [{ type: 'sysvar', key: 'printTime' }],
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    pageSetup: DEFAULT_PAGE_SETUP,
    bands: {
      header: [unbound],
      loop: { elements: [qr, bar], offsetMm: 0 },
      footer: [printTime],
    },
  }
}

async function e2e(): Promise<void> {
  section('端到端 / renderDocument')
  const ctx = emptyRenderContext({
    fields: FIELDS,
    fieldMap: new Map(FIELDS.map((f) => [f.id, f])),
    today: '2026-09-15',
    printTime: '2026-09-15 14:03',
    totalRows: RECORDS.length,
  })
  const out = await renderDocument({
    doc: makeDoc(),
    records: RECORDS,
    ctx,
    skipMeasure: true,
    title: '码元素测试',
  })

  ok('渲染出页', out.pages.length >= 1, String(out.pages.length))
  ok('HTML 不含 NaN', !out.html.includes('NaN'))
  // 循环区两条记录各一个二维码（2）+ r0 的条形码（1）；r1 的条形码内容含中文 → 占位框
  eq('HTML 里出现 3 个 <svg>', (out.html.match(/<svg/g) ?? []).length, 3)
  ok('二维码进了 HTML', out.html.includes('shape-rendering="crispEdges"'))
  ok('条形码原文行进了 HTML', out.html.includes('>TRACE-0001<'))
  eq('打印时间系统变量按 ctx 取值', out.html.includes('2026-09-15 14:03'), true)

  const kinds = out.warnings.map((w) => w.kind)
  ok('未绑定字段给出 field-unbound 警告', kinds.includes('field-unbound'))
  ok(
    '未绑定字段渲染成占位框（绝不静默留白）',
    out.html.includes('data-code-ph="1"') && out.html.includes('二维码：未绑定字段'),
  )
  ok('中文条形码给出 code-invalid 警告', kinds.includes('code-invalid'))
  ok('中文条形码渲染成占位框并说明原因', out.html.includes('条形码：内容含非 ASCII 字符'))
  ok(
    '未绑定是模板级问题（两条记录也只报一次）',
    out.warnings.filter((w) => w.kind === 'field-unbound').length === 1,
    String(out.warnings.filter((w) => w.kind === 'field-unbound').length),
  )
}

async function e2eEmptyFieldAndPrintTime(): Promise<void> {
  section('端到端 / 空字段值与打印时间兜底')
  const ctx = emptyRenderContext({
    fields: FIELDS,
    fieldMap: new Map(FIELDS.map((f) => [f.id, f])),
    today: '2026-09-15',
    totalRows: 1,
  })
  const doc = makeDoc()
  // 去掉重复区里那个"未绑定"的二维码：它会产出 field-unbound，
  // 干扰本用例要证明的"空值不产生阻断项"判定
  doc.bands.header = []
  // 把条形码换绑到"空字段"：绑定是对的、值却是空的 —— 最容易变成静默空白的一种情况
  doc.bands.loop.elements = [
    {
      id: 'el_bar_empty',
      kind: 'barcode',
      x: 0,
      y: 0,
      w: 60,
      h: 15,
      source: { kind: 'field', fieldId: 'f3', fieldName: '空字段' },
    },
  ]
  delete ctx.printTime
  const out = await renderDocument({ doc, records: [RECORDS[0]], ctx, skipMeasure: true })
  // 分级约定：值恰好为空是**记录级**问题（code-invalid），不是模板级阻断项
  ok('字段值为空时给出 code-invalid 警告', out.warnings.some((w) => w.kind === 'code-invalid'))
  ok(
    '空值不应被当成阻断项（不得报 field-missing / field-unbound）',
    !out.warnings.some((w) => w.kind === 'field-missing' || w.kind === 'field-unbound'),
  )
  ok('字段值为空时渲染占位框', out.html.includes('条形码：字段值为空'))
  ok(
    'pipeline 兜底填充打印时间（YYYY-MM-DD HH:mm，本地时区）',
    /2026-09-15 \d{2}:\d{2}/.test(out.html) || /\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(out.html),
    out.html.match(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}/)?.[0] ?? '（没找到）',
  )

  // 对照组（方向相反）：字段**已被删除**必须仍然是阻断级的 field-missing。
  // 与上一条一起，防止以后有人图省事把"值空"和"字段没了"两类合并回一种。
  const doc2 = makeDoc()
  doc2.bands.header = []
  doc2.bands.loop.elements = [
    {
      id: 'el_bar_deleted',
      kind: 'barcode',
      x: 0,
      y: 0,
      w: 60,
      h: 15,
      source: { kind: 'field', fieldId: 'f_deleted', fieldName: '已删除字段' },
    },
  ]
  const out2 = await renderDocument({ doc: doc2, records: [RECORDS[0]], ctx, skipMeasure: true })
  ok(
    '字段已被删除 → 仍是阻断级 field-missing（分级改动没有误伤这一类）',
    out2.warnings.some((w) => w.kind === 'field-missing'),
  )
}

// ============================================================
// 4. 系统变量增强：pageOfTotal / 时间 format / 星期记号
// ============================================================

/**
 * 建一个"循环区里只有一段文本、内容由 nodes 给出"的模板。
 *
 * 为什么要把系统变量夹在 `[` `]` 之间：断言要看的是**用户最终看到的那串文本**，
 * 而渲染产物是「`<span style="…">值</span>`」。夹上标记后就可以剥掉所有标签、
 * 直接抠出两个标记之间的可见文本，不用去猜 span 的样式串长什么样。
 */
function sysVarDoc(nodes: InlineNode[]): TemplateDoc {
  const el: AnyElement = {
    id: 'el_sys',
    kind: 'text',
    x: 0,
    y: 0,
    w: 60,
    h: 'auto',
    nodes: [{ type: 'text', text: '[' }, ...nodes, { type: 'text', text: ']' }],
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    pageSetup: DEFAULT_PAGE_SETUP,
    bands: { header: [], loop: { elements: [el], offsetMm: 0 }, footer: [] },
  }
}

/** 剥掉标签后的可见文本（只看 <body> 之后，免得 <style> 里的 CSS 混进来） */
function plainText(html: string): string {
  const i = html.indexOf('<body>')
  return (i >= 0 ? html.slice(i) : html).replace(/<[^>]*>/g, '')
}

/** 抠出 HTML 里所有 `[ … ]` 片段（每页一个，顺序 = 页序） */
function markedAll(html: string): string[] {
  const out: string[] = []
  const re = /\[([^\]]*)\]/g
  let m: RegExpExecArray | null
  while ((m = re.exec(plainText(html))) !== null) out.push(m[1])
  return out
}

/** 只要第一个标记片段 */
function marked(html: string): string {
  const all = markedAll(html)
  return all.length > 0 ? all[0] : ''
}

/** 切出每一页的 HTML（页码是在**逐页替换**阶段填进去的，必须按页看） */
function splitPages(html: string): string[] {
  return html.split('<section class="bp-page"').slice(1)
}

const SYS_RECORDS: RecordItem[] = [
  { recordId: 'r0', fields: {} },
  { recordId: 'r1', fields: {} },
  { recordId: 'r2', fields: {} },
]

async function renderSys(nodes: InlineNode[], perPageN = 1): Promise<string> {
  const ctx = emptyRenderContext({
    fields: FIELDS,
    fieldMap: new Map(FIELDS.map((f) => [f.id, f])),
    today: '2026-09-15',
    printTime: '2026-09-15 14:03',
    totalRows: SYS_RECORDS.length,
    // 每页一条记录 → 固定 3 页，页码/总页数才有意义
    perPageN,
  })
  const out = await renderDocument({
    doc: sysVarDoc(nodes),
    records: SYS_RECORDS,
    ctx,
    skipMeasure: true,
    title: '系统变量增强',
  })
  return out.html
}

async function sysVars(): Promise<void> {
  section('系统变量增强 / pageOfTotal（合并页码与总页数）')

  // ---- 1) 三种 hideTotal 形态的**精确文案** ----
  const withTotal = await renderSys([{ type: 'sysvar', key: 'pageOfTotal' }])
  const pagesWithTotal = splitPages(withTotal).map((p) => marked(p))
  console.log(`   pageOfTotal 默认        → 每页：${JSON.stringify(pagesWithTotal)}`)
  eq('pageOfTotal 默认（hideTotal 缺省）第 1 页文案', pagesWithTotal[0], '第 1 页 / 共 3 页')
  eq('pageOfTotal 默认第 3 页文案（逐页替换真的生效）', pagesWithTotal[2], '第 3 页 / 共 3 页')
  eq('pageOfTotal 共 3 页 = 实际页数', splitPages(withTotal).length, 3)

  const explicitFalse = await renderSys([{ type: 'sysvar', key: 'pageOfTotal', hideTotal: false }])
  console.log(`   hideTotal: false        → ${JSON.stringify(marked(explicitFalse))}`)
  eq('hideTotal 显式 false 仍要出「共 N 页」', marked(explicitFalse), '第 1 页 / 共 3 页')

  const hideTotal = await renderSys([{ type: 'sysvar', key: 'pageOfTotal', hideTotal: true }])
  const hiddenPages = splitPages(hideTotal).map((p) => marked(p))
  console.log(`   hideTotal: true         → 每页：${JSON.stringify(hiddenPages)}`)
  eq('hideTotal: true 只留「第 X 页」', hiddenPages[0], '第 1 页')
  eq('hideTotal: true 第 2 页文案', hiddenPages[1], '第 2 页')
  ok(
    'hideTotal: true 时全文不出现「共」字',
    !plainText(hideTotal).includes('共'),
    hiddenPages.join(' | '),
  )

  section('系统变量增强 / today 与 printTime 的 format')

  const todayDefault = await renderSys([{ type: 'sysvar', key: 'today' }])
  console.log(`   today 无 format         → ${JSON.stringify(marked(todayDefault))}`)
  eq('today 不指定 format：与改动前逐字节一致（YYYY-MM-DD）', marked(todayDefault), '2026-09-15')

  const todayCn = await renderSys([{ type: 'sysvar', key: 'today', format: 'YYYY年MM月DD日' }])
  console.log(`   today YYYY年MM月DD日     → ${JSON.stringify(marked(todayCn))}`)
  eq('today 指定中文格式', marked(todayCn), '2026年09月15日')

  const todayEmpty = await renderSys([{ type: 'sysvar', key: 'today', format: '' }])
  eq('today 的 format 是空串 → 退回默认格式', marked(todayEmpty), '2026-09-15')

  // 承重断言：`today` 是"本地今天"，换成时分后必须是 00:00。
  // 直接把 '2026-09-15' 丢给 Date.parse 会按 **UTC** 解析，在 UTC+8 会得到 08:00、在 UTC-4 会
  // 直接退到前一天（实测 TZ=America/New_York 裸解析 '2026-09-15' → 2026-09-14）。
  // 所以实现里补了 'T00:00' 强制本地零点，这条断言把那个补丁钉住。
  const todayTimeOnly = await renderSys([{ type: 'sysvar', key: 'today', format: 'HH:mm' }])
  console.log(`   today HH:mm             → ${JSON.stringify(marked(todayTimeOnly))}（日期源没有时分，应为本地零点）`)
  eq('today 换成 HH:mm 必须是本地 00:00（不是 08:00、也不是前一天）', marked(todayTimeOnly), '00:00')

  const ptDefault = await renderSys([{ type: 'sysvar', key: 'printTime' }])
  console.log(`   printTime 无 format     → ${JSON.stringify(marked(ptDefault))}`)
  eq('printTime 不指定 format：与改动前逐字节一致', marked(ptDefault), '2026-09-15 14:03')

  const ptTimeOnly = await renderSys([{ type: 'sysvar', key: 'printTime', format: 'HH:mm' }])
  console.log(`   printTime HH:mm         → ${JSON.stringify(marked(ptTimeOnly))}`)
  eq('printTime 只要时分', marked(ptTimeOnly), '14:03')

  const ptFull = await renderSys([{ type: 'sysvar', key: 'printTime', format: 'YYYY/MM/DD HH:mm:ss' }])
  console.log(`   printTime YYYY/MM/DD HH:mm:ss → ${JSON.stringify(marked(ptFull))}`)
  // 秒来自 ctx.printTime 里的 '14:03'（没有秒位）→ 应为 00，这里同时证明"缺位补 0"是可预期的
  eq('printTime 换斜杠格式 + 秒位补 00', marked(ptFull), '2026/09/15 14:03:00')

  section('系统变量增强 / 不该生效的字段必须被静默忽略')

  const rowNoWithFormat = await renderSys([
    { type: 'sysvar', key: 'rowNo', format: 'YYYY年MM月DD日' },
  ])
  console.log(`   rowNo + format          → ${JSON.stringify(marked(rowNoWithFormat))}`)
  eq('format 出现在 rowNo 上被忽略（仍是纯数字）', marked(rowNoWithFormat), '1')
  ok(
    'format 出现在 rowNo 上不会把格式串漏进正文',
    !plainText(rowNoWithFormat).includes('YYYY'),
    marked(rowNoWithFormat),
  )

  const pageNoWithHide = await renderSys([{ type: 'sysvar', key: 'pageNo', hideTotal: true }])
  console.log(`   pageNo + hideTotal      → ${JSON.stringify(marked(pageNoWithHide))}`)
  eq('hideTotal 出现在 pageNo 上被忽略（不变成「第 X 页」）', marked(pageNoWithHide), '1')

  const pageCountWithHide = await renderSys([
    { type: 'sysvar', key: 'pageCount', hideTotal: true },
  ])
  eq('hideTotal 出现在 pageCount 上被忽略（仍是纯数字 3）', marked(pageCountWithHide), '3')

  section('系统变量增强 / 星期记号（dddd 必须不被 ddd 吃掉）')

  const ddd = await renderSys([{ type: 'sysvar', key: 'today', format: 'YYYY-MM-DD ddd' }])
  console.log(`   'YYYY-MM-DD ddd'        → ${JSON.stringify(marked(ddd))}`)
  eq('ddd → 周X', marked(ddd), '2026-09-15 周二')

  const dddd = await renderSys([{ type: 'sysvar', key: 'today', format: 'YYYY-MM-DD dddd' }])
  const ddddGot = marked(dddd)
  console.log(`   'YYYY-MM-DD dddd'       → ${JSON.stringify(ddddGot)}`)
  // 这两条就是"顺序陷阱"的承重断言：把 dddd 排到 ddd 后面实测会得到「2026-09-15 周二d」
  //（/ddd/g 先吃掉 ddd 并留下最后一个 d），下面两条都会变红。
  eq('dddd → 星期X（没有被 ddd 吃掉前三个字符）', ddddGot, '2026-09-15 星期二')
  ok(
    '反向对照：渲染结果里不得残留任何未被消费的记号字母（错序时会残留一个 d）',
    !/d/.test(ddddGot),
    ddddGot,
  )

  const ddddMixed = await renderSys([
    { type: 'sysvar', key: 'printTime', format: 'YYYY年MM月DD日 dddd HH:mm' },
  ])
  console.log(`   混合格式 dddd + HH:mm    → ${JSON.stringify(marked(ddddMixed))}`)
  eq('星期记号与 mm/HH 等既有记号可以共存', marked(ddddMixed), '2026年09月15日 星期二 14:03')

  // 所有预设档位都要能跑通（UI 的下拉就是从 TIME_FORMAT_PRESETS 来的）
  const presetGot: string[] = []
  for (const p of TIME_FORMAT_PRESETS) {
    presetGot.push(`${p.value} → ${marked(await renderSys([{ type: 'sysvar', key: 'today', format: p.value }]))}`)
  }
  console.log(`   TIME_FORMAT_PRESETS 全档位：\n     ${presetGot.join('\n     ')}`)
  ok(
    `TIME_FORMAT_PRESETS 全部 ${TIME_FORMAT_PRESETS.length} 个档位都能渲染且不留记号`,
    presetGot.every((s) => !/YYYY|MM|DD|HH|mm|ss|dddd|ddd/.test(s.split(' → ')[1] ?? '')),
    presetGot.join(' | '),
  )
}

async function main(): Promise<void> {
  await e2e()
  await e2eEmptyFieldAndPrintTime()
  await sysVars()

  console.log('\n' + '='.repeat(52))
  if (failures.length === 0) console.log(`✅ 全部通过：${pass} 项`)
  else {
    console.log(`❌ ${failures.length} 项失败 / 共 ${pass + failures.length} 项`)
    for (const f of failures) console.log(`   · ${f}`)
  }
  console.log('='.repeat(52))
  process.exit(failures.length === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('自测崩溃：', e)
  process.exit(1)
})
