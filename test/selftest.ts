/**
 * 核心纯逻辑自测（Node 环境，不依赖 DOM）。
 *
 * 运行方式（esbuild 打包后再跑，因为源码用的是免扩展名 import，Node 无法直接解析）：
 *   node node_modules/esbuild/bin/esbuild test/selftest.ts --bundle --platform=node \
 *        --format=cjs --target=node20 --outfile=test/selftest.cjs && node test/selftest.cjs
 *
 * 为什么必须 --format=cjs：ESM 下 node 内置模块的 require 会报
 * "Dynamic require of stream is not supported"。
 */

import { renderCellValue, formatDateTime, isImageAttachment, extOf, fieldMeta, FT } from '../src/lib/field-types'
import { parseImageHeader, parseSvgSize, printedSizeMm, effectiveDpi } from '../src/lib/attachment'
import { drainPages } from '../src/lib/data-source'
import type { RecordItem } from '../src/lib/data-source'
import { DEFAULT_ATTACH_CONFIG } from '../src/lib/types'
import { createPool, isAbortError } from '../src/lib/pool'
import { MockDataSource } from '../src/lib/mock-source'

// ============================================================
// 极简断言
// ============================================================

let pass = 0
let fail = 0
const failures: string[] = []

function ok(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    pass++
  } else {
    fail++
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`)
  }
}

function eq<T>(name: string, actual: T, expected: T): void {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  ok(name, a === e, `期望 ${e}，实际 ${a}`)
}

function section(title: string): void {
  console.log(`\n— ${title}`)
}

// ============================================================
// 1. 字段值渲染矩阵
// ============================================================

// 全部测试体放进 main()：esbuild 打包成 cjs 时不支持顶层 await
async function main(): Promise<void> {

section('字段值渲染')

eq('文本', renderCellValue('薇诺娜', FT.Text), '薇诺娜')
eq('文本-数字', renderCellValue(123, FT.Text), '123')
eq('文本-空', renderCellValue(null, FT.Text), '')
eq('文本-空串', renderCellValue('', FT.Text), '')
eq('数字', renderCellValue(42.5, FT.Number), '42.5')
eq('复选框-真', renderCellValue(true, FT.Checkbox), '是')
eq('复选框-假', renderCellValue(false, FT.Checkbox), '否')
eq('单选', renderCellValue({ id: 'o1', text: '生产中' }, FT.SingleSelect), '生产中')
eq('多选', renderCellValue([{ id: 'o1', text: '灌装' }, { id: 'o2', text: '包装' }], FT.MultiSelect), '灌装、包装')
eq('人员-单人', renderCellValue({ id: 'u1', name: '张大帅' }, FT.User), '张大帅')
eq('人员-多人', renderCellValue([{ id: 'u1', name: '张三' }, { id: 'u2', name: '李四' }], FT.User), '张三、李四')
eq('人员-英文名兜底', renderCellValue({ id: 'u1', enName: 'Zhang' }, FT.User), 'Zhang')
eq('网址', renderCellValue({ text: '规格书', link: 'https://x.com' }, FT.Url), '规格书')
eq('进度-小数', renderCellValue(0.35, FT.Progress), '35%')
eq('进度-百分数', renderCellValue(80, FT.Progress), '80%')
eq('评分', renderCellValue(4, FT.Rating), '4')
eq('邮箱', renderCellValue('a@b.com', FT.Email), 'a@b.com')
eq('关联字段只出标题', renderCellValue({ text: 'SO-001' }, FT.SingleLink), 'SO-001')
eq('未知类型不崩', renderCellValue('x', 99999), 'x')

{
  const amount = renderCellValue(1234.5, FT.Currency)
  ok('货币带符号与千分位', amount.startsWith('¥1,234.50'), `实际 ${amount}`)
}

{
  // 用**本地时间**构造：formatDateTime 走本地时区（打印场景下用户要的是本地时间），
  // 用 Date.UTC 构造会让断言随机器时区变化而失败
  const ms = new Date(2026, 8, 14, 10, 30, 0).getTime()
  eq('日期默认格式', formatDateTime(ms, 'YYYY-MM-DD'), '2026-09-14')
  eq('日期带时间', formatDateTime(ms, 'YYYY-MM-DD HH:mm'), '2026-09-14 10:30')
  eq('日期带秒、补零', formatDateTime(new Date(2026, 0, 5, 9, 7, 3).getTime(), 'YYYY-MM-DD HH:mm:ss'), '2026-01-05 09:07:03')
  // 关键：日期字段在多维表格里就是毫秒时间戳，必须能直接渲染
  ok('日期字段走 number 毫秒', renderCellValue(ms, FT.DateTime).startsWith('2026-09-14'), renderCellValue(ms, FT.DateTime))
  eq('非法时间戳不产生垃圾文本', formatDateTime(NaN), '')
}

// ============================================================
// 2. 字段类型注册表
// ============================================================

section('字段类型注册表')

eq('文本可筛选', fieldMeta(FT.Text).filterable, true)
eq('关联字段不可筛选', fieldMeta(FT.SingleLink).filterable, false)
eq('关联字段只到标题级', fieldMeta(FT.SingleLink).capability, 'titleOnly')
eq('公式字段只读', fieldMeta(FT.Formula).writable, false)
eq('附件渲染类型', fieldMeta(FT.Attachment).renderKind, 'attachment')
eq('位置字段不可筛选', fieldMeta(FT.Location).filterable, false)
ok('未知类型退化为不可用而非崩溃', fieldMeta(12345).capability === 'none')

// ============================================================
// 3. 附件判定
// ============================================================

section('附件类型判定')

ok('png 是图片', isImageAttachment('a.png'))
ok('JPG 大写也算', isImageAttachment('a.JPG'))
ok('按 MIME 判定', isImageAttachment('noext', 'image/webp'))
ok('pdf 不是图片', !isImageAttachment('a.pdf', 'application/pdf'))
eq('取扩展名', extOf('产品照片.最终版.png'), 'png')
eq('无扩展名', extOf('README'), '')

// ============================================================
// 4. 图片文件头解析（不依赖浏览器解码，Node 可测）
// ============================================================

section('图片文件头解析')

{
  // PNG: 签名 + 长度 + "IHDR" + 宽(4,大端) + 高(4,大端)
  const png = new Uint8Array(24)
  png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
  png.set([0, 0, 0, 13], 8)
  png.set([0x49, 0x48, 0x44, 0x52], 12) // IHDR
  writeBE32(png, 16, 1920)
  writeBE32(png, 20, 1080)
  eq('PNG 宽高', parseImageHeader(png), { widthPx: 1920, heightPx: 1080 })
}

{
  // GIF: "GIF89a" + 宽(2,小端) + 高(2,小端)
  const gif = new Uint8Array(12)
  gif.set([0x47, 0x49, 0x46, 0x38, 0x39, 0x61], 0)
  writeLE16(gif, 6, 640)
  writeLE16(gif, 8, 480)
  eq('GIF 宽高', parseImageHeader(gif), { widthPx: 640, heightPx: 480 })
}

{
  // BMP: "BM" + 偏移 18/22 的小端 32 位宽高
  const bmp = new Uint8Array(30)
  bmp.set([0x42, 0x4d], 0)
  writeLE32(bmp, 18, 800)
  writeLE32(bmp, 22, 600)
  eq('BMP 宽高', parseImageHeader(bmp), { widthPx: 800, heightPx: 600 })
}

{
  // JPEG: FFD8 + FFC0 + 段长 + 精度 + 高(2,大端) + 宽(2,大端)
  const jpg = new Uint8Array(16)
  jpg.set([0xff, 0xd8], 0)
  jpg.set([0xff, 0xc0], 2)
  jpg.set([0x00, 0x11], 4) // 段长
  jpg[6] = 8 // 精度
  jpg[7] = 0x06
  jpg[8] = 0x40 // 高 = 1600
  jpg[9] = 0x0c
  jpg[10] = 0x80 // 宽 = 3200
  eq('JPEG 宽高', parseImageHeader(jpg), { widthPx: 3200, heightPx: 1600 })
}

{
  // WebP VP8X: "RIFF" + size + "WEBP" + "VP8X" + chunkSize + flags + reserved + (宽-1)(3LE) + (高-1)(3LE)
  const webp = new Uint8Array(32)
  webp.set([0x52, 0x49, 0x46, 0x46], 0) // RIFF
  webp.set([0x57, 0x45, 0x42, 0x50], 8) // WEBP
  webp.set([0x56, 0x50, 0x38, 0x58], 12) // VP8X
  writeLE24(webp, 24, 1023) // 宽 - 1
  writeLE24(webp, 27, 767) // 高 - 1
  eq('WebP(VP8X) 宽高', parseImageHeader(webp), { widthPx: 1024, heightPx: 768 })
}

{
  const junk = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
  eq('无法识别的格式返回 null', parseImageHeader(junk), null)
  eq('空数据不崩', parseImageHeader(new Uint8Array(0)), null)
}

{
  eq('SVG width/height', parseSvgSize('<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80"></svg>'), {
    widthPx: 120,
    heightPx: 80,
  })
  eq('SVG 回退 viewBox', parseSvgSize('<svg viewBox="0 0 300 200"></svg>'), { widthPx: 300, heightPx: 200 })
  eq('SVG 都没有返回 null', parseSvgSize('<svg></svg>'), null)
}

// ============================================================
// 5. 打印尺寸与 DPI
// ============================================================

section('打印尺寸与清晰度')

{
  const cfg = { ...DEFAULT_ATTACH_CONFIG, sizeMode: 'fixedHeight' as const, fixedHeightMm: 50 }
  const size = printedSizeMm(1000, 500, cfg)
  eq('固定高度：高度锁定', Math.round(size.h), 50)
  eq('固定高度：宽度按比例', Math.round(size.w), 100)
}

{
  // 等比是硬约束：任何模式下宽高比都必须守恒
  const cfg = { ...DEFAULT_ATTACH_CONFIG, sizeMode: 'fixedHeight' as const, fixedHeightMm: 30 }
  const ratios = [
    printedSizeMm(1200, 800, cfg),
    printedSizeMm(800, 1200, cfg),
    printedSizeMm(1000, 1000, cfg),
  ].map((s) => s.w / s.h)
  ok('不同宽高比都守恒', Math.abs(ratios[0] - 1.5) < 1e-6 && Math.abs(ratios[1] - 2 / 3) < 1e-6 && Math.abs(ratios[2] - 1) < 1e-6, JSON.stringify(ratios))
}

{
  // A4 大概 210x297mm；300dpi 的图按 50mm 高打印，有效 DPI 应该很高
  const dpi = effectiveDpi(3000, 3000, 50, 50)
  ok('有效 DPI 计算合理', dpi > 1000, `实际 ${dpi}`)
  eq('尺寸为 0 时 DPI 返回 0（不产生 Infinity）', effectiveDpi(100, 100, 0, 0), 0)
  eq('像素为 0 时 DPI 返回 0', effectiveDpi(0, 200, 50, 50), 0)
}

// ============================================================
// 6. 分页拉取骨架（含取消与失败保留）
// ============================================================

section('分页拉取 drainPages')

await (async () => {
  const total = 500
  const all: RecordItem[] = Array.from({ length: total }, (_, i) => ({
    recordId: `r${i}`,
    fields: { f: i },
  }))

  const res = await drainPages(async (token, pageSize) => {
    const start = token ? Number(token) : 0
    const slice = all.slice(start, start + pageSize)
    const next = start + pageSize
    return { records: slice, hasMore: next < total, pageToken: String(next), total }
  }, { tableId: 't', pageSize: 200 })

  eq('全部记录都拿到了', res.records.length, total)
  eq('total 被透传', res.total, total)
  eq('未被截断', res.truncated, false)

  // 进度回调必须至少被调用一次（否则用户看到的就是"点了没反应"）
  let progressCalls = 0
  await drainPages(async (token, pageSize) => {
    const start = token ? Number(token) : 0
    return { records: all.slice(start, start + pageSize), hasMore: start + pageSize < 50, pageToken: String(start + pageSize) }
  }, { tableId: 't', pageSize: 20, onProgress: () => progressCalls++ })
  ok('进度回调被调用', progressCalls > 0, `实际 ${progressCalls} 次`)
})()

await (async () => {
  // 中途失败：已加载的部分必须保留（对应 E-08，不整体回滚）
  let calls = 0
  const res = await drainPages(async (token, pageSize) => {
    calls++
    if (calls === 3) throw new Error('模拟第 3 页失败')
    const start = token ? Number(token) : 0
    return {
      records: Array.from({ length: pageSize }, (_, i) => ({ recordId: `x${start + i}`, fields: {} })),
      hasMore: true,
      pageToken: String(start + pageSize),
    }
  }, { tableId: 't', pageSize: 10 })

  eq('失败前加载的两页被保留', res.records.length, 20)
  ok('错误信息被带出', Boolean(res.error && res.error.includes('模拟第 3 页失败')), String(res.error))
})()

await (async () => {
  // 取消：aborted 后必须立刻停
  const ac = new AbortController()
  let calls = 0
  const p = drainPages(async (token, pageSize) => {
    calls++
    if (calls === 2) ac.abort()
    const start = token ? Number(token) : 0
    return { records: [{ recordId: `y${start}`, fields: {} }], hasMore: true, pageToken: String(start + 1) }
  }, { tableId: 't', pageSize: 1, signal: ac.signal })

  const res = await p
  ok('取消被识别为截断', res.truncated, JSON.stringify(res.truncated))
  ok('取消后没有继续无限拉取', calls <= 3, `实际调用了 ${calls} 次`)
})()

// ============================================================
// 7. 并发池
// ============================================================

section('并发池')

await (async () => {
  const pool = createPool(4)
  let active = 0
  let peak = 0
  const tasks = Array.from({ length: 20 }, () =>
    pool.run(async () => {
      active++
      peak = Math.max(peak, active)
      await sleep(5)
      active--
    }),
  )
  await Promise.all(tasks)
  await pool.onIdle()
  ok('峰值并发不超过上限 4', peak <= 4, `峰值 ${peak}`)
  eq('全部任务完成', active, 0)
})()

await (async () => {
  // 非法上限必须退化为 1，绝不能变成"无限制"
  eq('limit=0 退化为 1', createPool(0).limit, 1)
  eq('limit=NaN 退化为 1', createPool(NaN).limit, 1)
  eq('limit=-5 退化为 1', createPool(-5).limit, 1)
})()

await (async () => {
  const pool = createPool(1)
  const ac = new AbortController()
  let started = 0
  const p1 = pool.run(async () => {
    started++
    await sleep(30)
  })
  const p2 = pool.run(async () => {
    started++
  }, ac.signal)
  ac.abort()
  const r2 = await p2.then(() => 'resolved').catch((e) => (isAbortError(e) ? 'aborted' : 'other'))
  await p1
  eq('排队中被取消 → 以 AbortError 拒绝', r2, 'aborted')
  eq('排队中被取消的任务不会启动', started, 1)
})()

// ============================================================
// 8. Mock 数据源端到端
// ============================================================

section('Mock 数据源')

await (async () => {
  const ds = new MockDataSource(40)
  await ds.init()

  const ctx = await ds.getContext()
  ok('能拿到表上下文', Boolean(ctx.tableId && ctx.tableName))

  const fields = await ds.listFields(ctx.tableId, ctx.viewId)
  ok('字段数 > 15', fields.length > 15, `实际 ${fields.length}`)

  const attField = fields.find((f) => f.type === FT.Attachment)
  ok('mock 数据里包含附件字段（用于验证图片链路）', Boolean(attField))

  const res = await ds.fetchRecords({ tableId: ctx.tableId, pageSize: 25 })
  eq('记录数', res.records.length, 40)

  const tplTable = await ds.ensureTemplateTable()
  ok('能拿到模板表 id', Boolean(tplTable))
  const created = await ds.createTemplateRow(tplTable, {
    name: '测试模板',
    kind: 'view',
    targetTableName: '产品清单',
    targetTableId: ctx.tableId,
    docJson: '{"schemaVersion":1}',
    paper: 'A4 纵向',
  })
  const rows = await ds.listTemplateRows(tplTable)
  eq('模板写入后可读回', rows.length, 1)
  eq('模板名正确', rows[0].name, '测试模板')
  eq('模板类型正确', rows[0].kind, 'view')
  await ds.deleteTemplateRows(tplTable, [created])
  eq('模板删除生效', (await ds.listTemplateRows(tplTable)).length, 0)

  const rec0 = res.records[0]
  const atts = rec0.fields[attField!.id] as Array<{ token: string }>
  const urls = await ds.getAttachmentUrls(ctx.tableId, rec0.recordId, attField!.id, atts.map((a) => a.token))
  eq('附件链接数量与 token 一致', urls.length, atts.length)
  ok('mock 附件链接是可直接渲染的 dataURL', urls[0].startsWith('data:image/svg+xml'), urls[0].slice(0, 30))
})()

}

// ============================================================

function writeBE32(a: Uint8Array, o: number, v: number): void {
  a[o] = (v >>> 24) & 0xff
  a[o + 1] = (v >>> 16) & 0xff
  a[o + 2] = (v >>> 8) & 0xff
  a[o + 3] = v & 0xff
}
function writeLE16(a: Uint8Array, o: number, v: number): void {
  a[o] = v & 0xff
  a[o + 1] = (v >>> 8) & 0xff
}
function writeLE24(a: Uint8Array, o: number, v: number): void {
  a[o] = v & 0xff
  a[o + 1] = (v >>> 8) & 0xff
  a[o + 2] = (v >>> 16) & 0xff
}
function writeLE32(a: Uint8Array, o: number, v: number): void {
  a[o] = v & 0xff
  a[o + 1] = (v >>> 8) & 0xff
  a[o + 2] = (v >>> 16) & 0xff
  a[o + 3] = (v >>> 24) & 0xff
}
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

// ============================================================

main()
  .then(summarize)
  .catch((e) => {
    console.error('自测运行崩溃：', e)
    process.exit(1)
  })

function summarize(): void {
  console.log(`\n${'='.repeat(48)}`)
  if (fail === 0) {
    console.log(`✅ 全部通过：${pass} 项`)
  } else {
    console.log(`❌ ${fail} 项失败 / 共 ${pass + fail} 项`)
    for (const f of failures) console.log(`   · ${f}`)
  }
  console.log('='.repeat(48))
  process.exit(fail === 0 ? 0 : 1)
}
