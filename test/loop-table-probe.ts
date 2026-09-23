/**
 * 一次性探针：确认「视图模板 + 循环区放表格」到底产出什么结构。
 *
 * 背景：`RenderScope` 只携带单条记录（`record: RecordItem | null`），
 * 而 pipeline 是"逐记录构建块"。所以怀疑：**循环区里的表格会每条记录生成一张小表**，
 * 而不是"一张大表 N 行"。这会直接影响"清单/台账"类骨架能不能做。
 *
 * 这个脚本用渲染引擎自己的纯逻辑入口验证，不猜。
 *
 * 运行：esbuild 打包成 cjs 后 node 执行（见 package.json 的 test 脚本同款做法）
 */

import { renderDocument } from '../src/render/pipeline'
import { emptyTemplate, newId, DEFAULT_ATTACH_CONFIG } from '../src/lib/types'
import type { TableElement, TemplateDoc } from '../src/lib/types'
import type { RecordItem, FieldMeta } from '../src/lib/data-source'
import { emptyRenderContext } from '../src/render/context'

// 造 3 条记录 + 2 个字段
const fields: FieldMeta[] = [
  { id: 'f_name', name: '产品名称', type: 1, isPrimary: true },
  { id: 'f_qty', name: '数量', type: 2 },
]

const records: RecordItem[] = ['A 产品', 'B 产品', 'C 产品'].map((n, i) => ({
  recordId: `r${i}`,
  fields: { f_name: n, f_qty: (i + 1) * 10 },
}))

// 建一个视图模板：循环区里放「表头行 + 1 个数据行」的表格
function cell(nodes: any[]) {
  return { id: newId('c'), colspan: 1, rowspan: 1, nodes }
}
function row(cells: any[], isHeader = false) {
  return { id: newId('r'), cells, isHeader }
}

const table: TableElement = {
  id: newId('el'),
  kind: 'table',
  x: 0,
  y: 0,
  w: 170,
  h: 'auto',
  colWidthsMm: [110, 60],
  border: { mode: 'all', widthPt: 0.75, color: '#000000' },
  repeatHeader: true,
  rows: [
    row([cell([{ type: 'text', text: '产品名称' }]), cell([{ type: 'text', text: '数量' }])], true),
    row([
      cell([{ type: 'field', fieldId: 'f_name', fieldName: '产品名称' }]),
      cell([{ type: 'field', fieldId: 'f_qty', fieldName: '数量' }]),
    ]),
  ],
}

const doc: TemplateDoc = {
  ...emptyTemplate('view'),
  bands: {
    header: [],
    loop: { elements: [table], offsetMm: 0 },
    footer: [],
  },
}

const ctx = emptyRenderContext({
  fields,
  fieldMap: new Map(fields.map((f) => [f.id, f])),
  today: '2026-09-15',
  totalRows: records.length,
})

async function main(): Promise<void> {
  const out = await renderDocument({
    doc,
    records,
    ctx,
    skipMeasure: true, // Node 里没有 DOM，跳过测量（按显式高度/估算走）
    forPreview: false,
    title: 'probe',
  })

  console.log('页数:', out.pages.length)
  for (const p of out.pages) {
    console.log(`\n第 ${p.index + 1} 页  记录区间=[${p.recordRange[0]}, ${p.recordRange[1]})`)
    for (const b of p.blocks) {
      console.log(`  块 kind=${b.kind} x=${b.xMm.toFixed(1)} y=${b.yMm.toFixed(1)} h=${b.hMm.toFixed(1)}`)
    }
  }

  const html = out.html
  const tableCount = (html.match(/<table/g) ?? []).length
  const headerCellCount = (html.match(/产品名称<\/?(td|th)/g) ?? []).length
  console.log('\n===== 产物统计 =====')
  console.log('<table> 出现次数:', tableCount)
  console.log('含「产品名称」的单元格次数:', headerCellCount)
  console.log('产物总长:', html.length, '字符')
  console.log('\n===== 结论 =====')
  console.log(
    tableCount <= 1
      ? '✅ 只生成了 1 张表 → 循环区表格会跨记录合并成一张大表'
      : `⚠️ 生成了 ${tableCount} 张表 → 每条记录各一张小表（清单类骨架无法做成连续大表）`,
  )
}

main().catch((e) => {
  console.error('探针崩溃：', e)
  process.exit(1)
})
