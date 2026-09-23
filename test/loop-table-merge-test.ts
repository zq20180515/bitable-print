/**
 * 「视图模板一张连续大表」（TableElement.rowsFromRecords）证据脚本。
 *
 * 它不替代断言自测（那部分在 src/render/__selftest.mts 里，会计入总数），
 * 目的是把**改动前后**的产物原样打出来给人看：
 *   1. 3 条记录 + 表头 1 行/数据 1 行的表格：改前 3 张小表 → 改后 1 张大表；
 *   2. 40 条记录撑过一页：仍然是"跨页的同一张表"，每页都带表头，行号连续不重不漏；
 *   3. 反向对照：开关缺省 → 仍必须是 3 张小表（默认行为没被改坏）；
 *   4. 反向对照：开关打开但循环区有两个元素 → 必须出 loop-table-conflict 警告，并退回 3 张小表。
 *
 * 第 3、4 条不是补充，是**防"断言根本没生效"**的对照组：
 * 这个项目里出现过"断言写成永不成立的形态，于是 85 项全过、问题照旧"的事故。
 *
 * 运行：
 *   ./node_modules/.bin/esbuild test/loop-table-merge-test.ts --bundle --platform=node \
 *     --format=cjs --target=node20 --outfile=test/.loop-table-merge-test.cjs --log-level=warning \
 *     && node test/.loop-table-merge-test.cjs
 */

import { renderDocument } from '../src/render/pipeline'
import { DEFAULT_PAGE_SETUP, emptyTemplate, newId } from '../src/lib/types'
import type { AnyElement, TableElement, TemplateDoc } from '../src/lib/types'
import type { FieldMeta, RecordItem } from '../src/lib/data-source'
import { emptyRenderContext } from '../src/render/context'

// ============================================================
// 极简断言
// ============================================================

let checks = 0
let failures = 0
const log: string[] = []

function note(s: string): void {
  log.push(s)
}

function ok(cond: boolean, msg: string): void {
  checks++
  if (!cond) failures++
  log.push(`  ${cond ? 'PASS' : 'FAIL'}  ${msg}`)
}

function eq(actual: unknown, expected: unknown, msg: string): void {
  const same = actual === expected
  ok(same, `${msg}${same ? '' : `  ← 期望 ${String(expected)}，实际 ${String(actual)}`}`)
}

// ============================================================
// 造数据 / 造模板
// ============================================================

const fields: FieldMeta[] = [
  { id: 'f_name', name: '产品名称', type: 1, isPrimary: true },
  { id: 'f_qty', name: '数量', type: 2 },
]

function makeRecords(n: number): RecordItem[] {
  return Array.from({ length: n }, (_, i) => ({
    recordId: `r${i}`,
    fields: { f_name: `${String.fromCharCode(65 + (i % 26))} 产品-${i + 1}`, f_qty: (i + 1) * 10 },
  }))
}

function cell(nodes: unknown[]): any {
  return { id: newId('c'), colspan: 1, rowspan: 1, nodes }
}
function row(cells: unknown[], isHeader = false): any {
  return { id: newId('r'), cells, isHeader }
}

/** 循环区里的表格：表头 1 行 + 数据 1 行；`rowsFromRecords` 由调用方决定开不开 */
function loopTable(rowsFromRecords: boolean): TableElement {
  return {
    id: 'tbl_loop',
    kind: 'table',
    x: 0,
    y: 0,
    w: 170,
    h: 'auto',
    colWidthsMm: [16, 110, 44],
    border: { mode: 'all', widthPt: 0.75, color: '#000000' },
    repeatHeader: true,
    ...(rowsFromRecords ? { rowsFromRecords: true } : {}),
    rows: [
      row(
        [
          cell([{ type: 'text', text: '序号' }]),
          cell([{ type: 'text', text: '产品名称' }]),
          cell([{ type: 'text', text: '数量' }]),
        ],
        true,
      ),
      row([
        cell([{ type: 'sysvar', key: 'rowNo' }]),
        cell([{ type: 'field', fieldId: 'f_name', fieldName: '产品名称' }]),
        cell([{ type: 'field', fieldId: 'f_qty', fieldName: '数量' }]),
      ]),
    ],
  }
}

function viewDoc(loopElements: AnyElement[]): TemplateDoc {
  return {
    ...emptyTemplate('view'),
    pageSetup: { ...DEFAULT_PAGE_SETUP, margin: { ...DEFAULT_PAGE_SETUP.margin } },
    bands: { header: [], loop: { elements: loopElements, offsetMm: 0 }, footer: [] },
  }
}

const ctxOf = (n: number) =>
  emptyRenderContext({ fields, fieldMap: new Map(fields.map((f) => [f.id, f])), today: '2026-09-15', totalRows: n })

// ============================================================
// 产物统计小工具
// ============================================================

const count = (s: string, re: RegExp): number => (s.match(re) ?? []).length

/** 按 <section class="bp-page"> 切页（与 buildDocumentHtml 的分页结构一致） */
function pagesHtml(html: string): string[] {
  return html
    .split('<section class="bp-page"')
    .slice(1)
    .map((s) => s.slice(0, s.indexOf('</section>')))
}

/**
 * 按 `<table>` 逐张解析一页的产物。
 *
 * 注意单元格内容是被 `<span style>` 包起来的（renderInline 的既有行为），
 * 所以判断"这一格是不是序号"必须**先去标签**再判数字 —— 直接 `<td>(\d+)</td>` 永远匹配不到，
 * 会得到"序号列 = 空"这种看着像功能坏了的假象。
 */
function inspectPage(ph: string): {
  tables: number
  trs: number
  headRows: number
  bodyRows: number
  rowNos: number[]
  bodyTexts: string[]
} {
  const tables = ph.split(/<table[\s>]/).slice(1)
  let trs = 0
  let headRows = 0
  let bodyRows = 0
  const rowNos: number[] = []
  const bodyTexts: string[] = []
  for (const t of tables) {
    const thead = (t.match(/<thead[^>]*>([\s\S]*?)<\/thead>/) ?? ['', ''])[1]
    const tbody = (t.match(/<tbody>([\s\S]*?)<\/tbody>/) ?? ['', ''])[1]
    headRows += count(thead, /<tr/g)
    for (const rowMatch of tbody.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
      bodyRows++
      const cells = [...rowMatch[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) =>
        m[1].replace(/<[^>]*>/g, '').trim(),
      )
      bodyTexts.push(cells.join(' | '))
      if (/^\d+$/.test(cells[0] ?? '')) rowNos.push(Number(cells[0]))
    }
    trs += count(t, /<tr/g)
  }
  return { tables: tables.length, trs, headRows, bodyRows, rowNos, bodyTexts }
}

async function render(doc: TemplateDoc, records: RecordItem[], n: number) {
  return renderDocument({
    doc,
    records,
    ctx: ctxOf(n),
    skipMeasure: true, // Node 里没有 DOM；表格高度走"按行均分"兜底估算
    forPreview: false,
    title: 'loop-table',
  })
}

// ============================================================
// 1 / 3. 开与不开：3 条记录
// ============================================================

async function main(): Promise<void> {
  const records3 = makeRecords(3)

  note('============================================================')
  note('【1】3 条记录 · 开关缺省（= 改动前的代码路径，逐记录重复构建块）')
  note('============================================================')
  const before = await render(viewDoc([loopTable(false)]), records3, 3)
  const beforeHtml = before.html
  note(`页数: ${before.pages.length}`)
  for (const p of before.pages) {
    note(`第 ${p.index + 1} 页  记录区间=[${p.recordRange[0]}, ${p.recordRange[1]})`)
    for (const b of p.blocks) {
      note(`  块 kind=${b.kind} el=${b.elementId} x=${b.xMm.toFixed(1)} y=${b.yMm.toFixed(1)} h=${b.hMm.toFixed(1)}`)
    }
  }
  note(`产物统计：<table> 出现次数 = ${count(beforeHtml, /<table/g)}，产物总长 ${beforeHtml.length} 字符`)
  ok(count(beforeHtml, /<table/g) === 3, '改前：3 条记录 → 3 张小表（现状复现）')
  ok(before.pages.length === 1, '改前：3 张小表都在第 1 页')
  eq(count(beforeHtml, /<thead/g), 3, '改前：每张小表各带一份表头 → 3 份表头')
  eq(
    before.pages[0].blocks.map((b) => b.yMm.toFixed(1)).join(','),
    '0.0,16.0,32.0',
    '改前：三张小表逐张堆叠（y=0/16/32，与改动前探针实测一致）',
  )
  eq(
    before.pages[0].blocks.map((b) => b.hMm.toFixed(1)).join(','),
    '16.0,16.0,16.0',
    '改前：每张小表 2 行（表头 + 1 数据行）× 8mm 估算高',
  )

  note('')
  note('============================================================')
  note('【2】3 条记录 · rowsFromRecords: true（改动后）')
  note('============================================================')
  const after = await render(viewDoc([loopTable(true)]), records3, 3)
  const afterHtml = after.html
  note(`页数: ${after.pages.length}`)
  for (const p of after.pages) {
    note(`第 ${p.index + 1} 页  记录区间=[${p.recordRange[0]}, ${p.recordRange[1]})`)
    for (const b of p.blocks) {
      note(`  块 kind=${b.kind} el=${b.elementId} x=${b.xMm.toFixed(1)} y=${b.yMm.toFixed(1)} h=${b.hMm.toFixed(1)}`)
    }
  }
  note(`产物统计：<table> 出现次数 = ${count(afterHtml, /<table/g)}，产物总长 ${afterHtml.length} 字符`)
  const a0 = inspectPage(pagesHtml(afterHtml)[0] ?? '')
  note(`第 1 页行结构：<table> ${a0.tables} 个，<tr> ${a0.trs} 个 = 表头 ${a0.headRows} + 数据 ${a0.bodyRows}；序号列 = [${a0.rowNos.join(', ')}]`)
  a0.bodyTexts.forEach((t, i) => note(`  第 ${i + 1} 个数据行文本：${t}`))

  ok(count(afterHtml, /<table/g) === 1, '改后：<table> 出现次数 = 1（一张连续大表）')
  eq(count(afterHtml, /<thead/g), 1, '改后：只有一份表头')
  eq(a0.headRows, 1, '改后：该表内有 1 个表头行')
  eq(a0.bodyRows, 3, '改后：该表内有 3 个数据行（每条记录一行）')
  eq(a0.rowNos.join(','), '1,2,3', '改后：${行号} 是各条记录的真实序号（1 起）')
  // 逐行核对"这一行取到的是自己那条记录的值"（不是全都渲染成第一条记录）
  ok(a0.bodyTexts[0]?.includes('A 产品-1') && a0.bodyTexts[0]?.includes('10'), '改后：第 1 行取第 1 条记录的值')
  ok(a0.bodyTexts[1]?.includes('B 产品-2') && a0.bodyTexts[1]?.includes('20'), '改后：第 2 行取第 2 条记录的值')
  ok(a0.bodyTexts[2]?.includes('C 产品-3') && a0.bodyTexts[2]?.includes('30'), '改后：第 3 行取第 3 条记录的值')

  note('')
  note('============================================================')
  note('【3】反向对照 · 开关缺省（不设 rowsFromRecords），3 条记录')
  note('============================================================')
  note('（同一个模板、同一批记录，只差一个开关 → 唯一变量就是它）')
  eq(beforeHtml.length !== afterHtml.length ? 1 : 0, 1, `缺省与开启的产物确实不同（${beforeHtml.length} ≠ ${afterHtml.length} 字符）`)
  eq(count(beforeHtml, /<table/g), 3, '缺省：仍然是 3 张小表')
  eq(count(afterHtml, /<table/g), 1, '开启：1 张大表（与上一行形成对照，说明断言不是空转）')
  eq(before.pages.length, 1, '缺省：仍然 1 页')

  // ============================================================
  // 4. 40 条记录：撑过一页，按行拆分 + 每页重复表头
  // ============================================================
  note('')
  note('============================================================')
  note('【4】40 条记录 · 撑过一页（分页交给 splitTable，不新写分页逻辑）')
  note('============================================================')
  const records40 = makeRecords(40)
  const big = await render(viewDoc([loopTable(true)]), records40, 40)
  const bigHtml = big.html
  const pgs = pagesHtml(bigHtml)
  note(`页数: ${big.pages.length}，<table> 出现次数 = ${count(bigHtml, /<table/g)}（= 每页一个续排片段）`)
  const allRowNos: number[] = []
  let pagesWithHeader = 0
  pgs.forEach((ph, i) => {
    const info = inspectPage(ph)
    if (info.headRows >= 1) pagesWithHeader++
    allRowNos.push(...info.rowNos)
    note(
      `第 ${i + 1} 页：<table> ${info.tables} 个，<tr> ${info.trs} = 表头 ${info.headRows} + 数据 ${info.bodyRows}，序号列 ${
        info.rowNos.length ? `${info.rowNos[0]}~${info.rowNos[info.rowNos.length - 1]}` : '（无）'
      }`,
    )
  })
  note(`合并后的数据行序号序列长度 = ${allRowNos.length}（应 = 40）`)
  ok(big.pages.length > 1, `40 条记录确实跨页（${big.pages.length} 页）`)
  eq(allRowNos.length, 40, '跨页后数据行总数仍是 40（一行不多、一行不少）')
  eq(allRowNos.join(','), records40.map((_, i) => i + 1).join(','), '跨页后序号连续且不重复（1..40）')
  eq(pagesWithHeader, big.pages.length, '每一页都有表头行（F2-29 在新块形状下依然生效）')
  eq(
    big.pages.every((p) => p.blocks.filter((b) => b.elementId === 'tbl_loop').length === 1) ? 1 : 0,
    1,
    '每页最多一块、且都是同一个 elementId → 是"同一张表的续排片段"，不是 N 张表',
  )
  eq(count(bigHtml, /<table/g), big.pages.length, '全篇 <table> 数 = 页数（每页一个片段）')

  // ============================================================
  // 5. 反向对照：开关打开 + 循环区两个元素
  // ============================================================
  note('')
  note('============================================================')
  note('【5】反向对照 · rowsFromRecords: true 但循环区有 2 个元素')
  note('============================================================')
  const txtElem: AnyElement = {
    id: 'txt_1',
    kind: 'text',
    x: 0,
    y: 20,
    w: 170,
    h: 6,
    nodes: [{ type: 'text', text: '备注行' }],
  }
  const conflict = await render(viewDoc([loopTable(true), txtElem]), records3, 3)
  const conflictHtml = conflict.html
  const conflicts = conflict.warnings.filter((w) => w.kind === 'loop-table-conflict')
  note(`页数: ${conflict.pages.length}，<table> 出现次数 = ${count(conflictHtml, /<table/g)}`)
  note(`警告：${conflicts.length ? conflicts.map((w) => `[${w.kind}] ${w.message}`).join(' / ') : '（无）'}`)
  const c0 = inspectPage(pagesHtml(conflictHtml)[0] ?? '')
  note(`第 1 页行结构：<tr> ${c0.trs} 个，序号列 = [${c0.rowNos.join(', ')}]`)
  eq(conflicts.length, 1, '出现且仅出现 1 条 loop-table-conflict 警告（模板级去重）')
  eq(conflicts[0]?.elementId, 'tbl_loop', '警告指向那张表格元素（用户能定位到改哪儿）')
  ok(!!conflicts[0]?.message.includes('退回'), '警告文案说明了已退回逐记录重复的行为')
  eq(count(conflictHtml, /<table/g), 3, '冲突时退回 3 张小表（不静默产出怪结果）')
  eq(count(conflictHtml, /<thead/g), 3, '冲突时每张小表各带一份自己的表头（= 原有行为）')
  eq(c0.rowNos.join(','), '1,2,3', '冲突时序号仍是 1/2/3（每条记录各一张小表，行号没错位）')
  ok(count(conflictHtml, /备注行/g) === 3, '冲突时循环区另一个元素照常逐记录渲染（3 次）')

  // ============================================================
  // 6. 边界：一条记录都没有（筛选后为空）时不能凭空冒出光表头
  // ============================================================
  note('')
  note('============================================================')
  note('【6】边界 · 0 条记录（筛选后为空）')
  note('============================================================')
  const empty = await render(viewDoc([loopTable(true)]), [], 0)
  note(`页数: ${empty.pages.length}，<table> 出现次数 = ${count(empty.html, /<table/g)}`)
  eq(count(empty.html, /<table/g), 0, '0 条记录：不产出只有表头的空表（与缺省行为一致）')
  eq(empty.pages.length, 1, '0 条记录：仍然产出一页（页眉/页脚区照常）')
  eq(
    empty.warnings.filter((w) => w.kind === 'loop-table-conflict').length,
    0,
    '0 条记录：这是"没有数据"而不是"模板结构冲突"，不出 conflict 警告',
  )

  // ============================================================
  // 7. 骨架库核对：只有清单/台账类视图骨架打开开关
  // ============================================================
  note('')
  note('============================================================')
  note('【7】骨架库核对（10 个骨架逐一检查开关）')
  note('============================================================')
  const skel = await import('../src/lib/skeletons')
  const skelFields: FieldMeta[] = [
    { id: 's1', name: '名称', type: 1, isPrimary: true },
    { id: 's2', name: '数量', type: 2 },
    { id: 's3', name: '备注', type: 1 },
    { id: 's4', name: '规格型号', type: 1 },
    { id: 's5', name: '单位', type: 1 },
    { id: 's6', name: '巡检区域', type: 1 },
    { id: 's7', name: '检查项目', type: 1 },
    { id: 's8', name: '结果', type: 1 },
    { id: 's9', name: '巡检人', type: 1 },
    { id: 's10', name: '单号', type: 1 },
    { id: 's11', name: '日期', type: 5 },
  ]
  const flagged: { key: string; kind: string; loopCount: number }[] = []
  const flaggedRecord: string[] = []
  const warned: string[] = []
  for (const s of skel.SKELETONS) {
    const doc = skel.buildSkeleton(s.key, skelFields)
    const loop = doc.bands.loop.elements
    const t = loop.find((e) => e.kind === 'table') as TableElement | undefined
    if (t?.rowsFromRecords === true) {
      flagged.push({ key: s.key, kind: s.kind, loopCount: loop.length })
      if (s.kind === 'record') flaggedRecord.push(s.key)
    }
    const recs = makeRecords(5)
    const out = await renderDocument({
      doc,
      records: recs,
      ctx: emptyRenderContext({
        fields: skelFields,
        fieldMap: new Map(skelFields.map((f) => [f.id, f])),
        today: '2026-09-15',
        totalRows: recs.length,
      }),
      skipMeasure: true,
      title: s.key,
    })
    if (out.warnings.some((w) => w.kind === 'loop-table-conflict')) warned.push(s.key)
  }
  note(`打开开关的骨架：${flagged.map((f) => `${f.key}(${f.kind}, 循环区 ${f.loopCount} 元素)`).join('、')}`)
  eq(flaggedRecord.length, 0, '单据类记录模板骨架一个都没打开开关（它们的语义就是一条记录一份）')
  eq(
    flagged.map((f) => f.key).sort().join(','),
    'list-general,list-inspection',
    '只有清单/台账两个视图骨架打开开关',
  )
  eq(
    flagged.every((f) => f.loopCount === 1) ? 1 : 0,
    1,
    '打开开关的骨架都满足"循环区只有这一个表格"（否则一渲染就触发 conflict 警告）',
  )
  eq(warned.length, 0, `10 个骨架渲染后都没有 loop-table-conflict 警告（实际：${warned.join(',') || '无'}）`)

  const listDoc = skel.buildSkeleton('list-general', skelFields)
  const listOut = await renderDocument({
    doc: listDoc,
    records: makeRecords(5),
    ctx: emptyRenderContext({
      fields: skelFields,
      fieldMap: new Map(skelFields.map((f) => [f.id, f])),
      today: '2026-09-15',
      totalRows: 5,
    }),
    skipMeasure: true,
    title: 'list-general',
  })
  const lp = inspectPage(pagesHtml(listOut.html)[0] ?? '')
  note(
    `「通用清单」5 条记录：页数 ${listOut.pages.length}，第 1 页 <table> ${lp.tables} 个（1 个每页重复的列头 + 1 张大表），` +
      `<tr> ${lp.trs} 个，数据行序号 = [${lp.rowNos.join(', ')}]`,
  )
  eq(listOut.pages.length, 1, '「通用清单」5 条记录：1 页')
  eq(lp.tables, 2, '「通用清单」：循环区只剩 1 张大表（另一张是每页重复的列头表）')
  eq(lp.rowNos.join(','), '1,2,3,4,5', '「通用清单」：5 条记录各占一行、序号连续（不再是 5 张单行表）')

  // ============================================================
  // 8. 真实行高（非均分估算）下按行拆分 + 每页重复表头
  // ============================================================
  //
  // 【4】走的是 Node 的"按行均分"兜底估算；浏览器里行高是 DOM 实测出来的、
  // 每行都不一样，分页边界落在哪儿取决于真实高度。这一节直接喂**不均匀行高**给分页器，
  // 并让片段 HTML 由真正的 renderLoopTableRows 生成，证明两者接得上：
  // 每页高度 = 表头 + 本页行高之和，续排片段自带克隆表头，序号跨页连续。
  note('')
  note('============================================================')
  note('【8】真实行高下的按行拆分（表头 12mm + 40 行 × 5mm，版心 100mm）')
  note('============================================================')
  const htmlMod = await import('../src/render/html')
  const layoutMod = await import('../src/render/layout')
  const tpl = loopTable(true)
  const plan = htmlMod.planLoopTable(tpl, 40)
  const scopeOf = (i: number): any => ({
    record: records40[i] ?? null,
    recordIndex: i,
    widthMm: 170,
    elementId: 'tbl_loop',
  })
  const fragCtx = ctxOf(40)
  const measuredRows = [
    { rowId: 'h', hMm: 12, isHeader: true },
    ...Array.from({ length: 40 }, (_, i) => ({ rowId: `r${i}`, hMm: 5, isHeader: false })),
  ]
  note(`展开计划：表头 ${plan.headerCount} 行 + 数据 ${plan.bodyCount} 行 × ${plan.recordCount} 条记录 = ${plan.totalRows} 个虚拟行`)
  const split = layoutMod.paginate({
    records: [
      {
        recordIndex: 0,
        blocks: [
          {
            elementId: 'tbl_loop',
            kind: 'table',
            xMm: 0,
            yMm: 0,
            wMm: 170,
            hMm: 12 + 40 * 5,
            html: '',
            tableRows: measuredRows,
            headerRowCount: 1,
            repeatHeader: true,
            tableFragmentHtml: (s: number, e: number): string =>
              htmlMod.renderLoopTableRows(tpl, plan, s, e, scopeOf, fragCtx).html,
          },
        ],
      },
    ],
    contentHeightMm: 100,
  })
  const splitInfos = split.pages.map((p: any) => inspectPage(`<section class="bp-page"${p.blocks.map((b: any) => `<div>${b.html}</div>`).join('')}`))
  split.pages.forEach((p: any, i: number) => {
    note(
      `第 ${i + 1} 页：块高 ${p.blocks[0].hMm.toFixed(1)}mm，表头 ${splitInfos[i].headRows} 行，` +
        `数据 ${splitInfos[i].bodyRows} 行，序号 ${splitInfos[i].rowNos[0]}~${splitInfos[i].rowNos[splitInfos[i].rowNos.length - 1]}`,
    )
  })
  const splitNos = splitInfos.flatMap((i: any) => i.rowNos)
  eq(split.pages.length, 3, '真实行高：拆成 3 页')
  eq(split.pages[0].blocks[0].hMm, 97, '第 1 页 = 表头 12 + 17 行 × 5')
  eq(split.pages[1].blocks[0].hMm, 97, '第 2 页 = 克隆表头 12 + 17 行 × 5')
  eq(split.pages[2].blocks[0].hMm, 42, '第 3 页 = 克隆表头 12 + 6 行 × 5')
  eq(
    splitInfos.filter((i: any) => i.headRows === 1).length,
    split.pages.length,
    '真实行高：每页片段都带 1 行表头（续排片段克隆表头）',
  )
  eq(splitNos.join(','), records40.map((_, i) => i + 1).join(','), '真实行高：序号跨页连续 1..40，无重复无遗漏')

  // ============================================================
  // 汇总
  // ============================================================
  note('')
  note('============================================================')
  note(`证据脚本断言：${checks - failures}/${checks} 通过${failures ? `，${failures} 项失败` : ''}`)
  note('============================================================')
  console.log(log.join('\n'))

  if (failures > 0) {
    console.error(`${failures} 项证据断言失败`)
    process.exit(1)
  }
}

main().catch((e) => {
  console.error('证据脚本崩溃：', e)
  process.exit(1)
})
