/**
 * 一次性探针：确认"循环区内多个元素纵向堆叠"时 y / h 该怎么给。
 *
 * 为什么需要：`y` 有三重语义 —— 排序键、行内偏移（`placeBlock(x, topY + b.yMm)`）、
 * 以及同行判定（`b.yMm < lastBottom - eps` 则并入上一排）。给错会**元素重叠**或**成片空隙**。
 *
 * 导入路径的约定是"y 累加 + h 给数字估计值"，但按 `emitRow` 的算法推算会累积出空隙。
 * 推算靠不住，这里直接把两种取值方式都跑一遍看实际坐标。
 */

import { renderDocument } from '../src/render/pipeline'
import { emptyTemplate, newId } from '../src/lib/types'
import type { TemplateDoc, TextElement, AnyElement } from '../src/lib/types'
import type { RecordItem, FieldMeta } from '../src/lib/data-source'
import { emptyRenderContext } from '../src/render/context'

const fields: FieldMeta[] = [{ id: 'f_name', name: '产品名称', type: 1, isPrimary: true }]
const records: RecordItem[] = [{ recordId: 'r0', fields: { f_name: 'A 产品' } }]

function textEl(text: string, y: number, h: number | 'auto'): TextElement {
  return {
    id: newId('el'),
    kind: 'text',
    x: 0,
    y,
    w: 170,
    h,
    style: { fontFamily: 'system', fontSizePt: 10.5, color: '#000', align: 'left', lineHeight: 1.5 },
    nodes: [{ type: 'text', text }],
  }
}

async function run(label: string, els: AnyElement[]): Promise<void> {
  const doc: TemplateDoc = {
    ...emptyTemplate('record'),
    bands: { header: [], loop: { elements: els, offsetMm: 0 }, footer: [] },
  }
  const ctx = emptyRenderContext({
    fields,
    fieldMap: new Map(fields.map((f) => [f.id, f])),
    today: '2026-09-15',
    totalRows: 1,
  })
  const out = await renderDocument({ doc, records, ctx, skipMeasure: true, forPreview: false, title: 'x' })

  console.log(`\n===== ${label} =====`)
  console.log(`元素定义: ${els.map((e) => `y=${e.y},h=${String(e.h)}`).join(' | ')}`)
  for (const p of out.pages) {
    const placed = p.blocks.map((b) => `y=${b.yMm.toFixed(1)}~${(b.yMm + b.hMm).toFixed(1)}`).join('  ')
    console.log(`第 ${p.index + 1} 页: ${placed}`)
  }
}

async function main(): Promise<void> {
  // A. y 全为 0 + 显式 h（数字）—— 期望：会不会同行合并导致重叠？
  await run('A. y=0/0/0 + h=6/6/6', [textEl('标题', 0, 6), textEl('第二行', 0, 6), textEl('第三行', 0, 6)])

  // B. y 累加 + 显式 h —— 导入路径的约定
  await run('B. y=0/6/12 + h=6/6/6', [textEl('标题', 0, 6), textEl('第二行', 6, 6), textEl('第三行', 12, 6)])

  // C. y 累加且步长略小于 h（更接近"正好相接"的意图）
  await run('C. y=0/5.9/11.8 + h=6/6/6', [textEl('标题', 0, 6), textEl('第二行', 5.9, 6), textEl('第三行', 11.8, 6)])

  // D. y 全为 0 + auto 高度（无法测量时走估算）
  await run('D. y=0/0/0 + h=auto', [textEl('标题', 0, 'auto'), textEl('第二行', 0, 'auto'), textEl('第三行', 0, 'auto')])

  // E. y 递增小步长 + auto
  await run('E. y=0/8/16 + h=auto', [textEl('标题', 0, 'auto'), textEl('第二行', 8, 'auto'), textEl('第三行', 16, 'auto')])
}

main().catch((e) => {
  console.error('探针崩溃：', e)
  process.exit(1)
})
