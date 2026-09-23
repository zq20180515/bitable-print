/**
 * 打印保真度探针（浏览器内运行，由 test/print-fidelity-run.mjs 用 CDP 驱动）。
 *
 * 为什么必须在真浏览器里量：`h:'auto'` 的高度来自 DOM 测量，纯 Node 里量不出来。
 * 这里的做法是"两条链路都走真的"：
 *   1) renderDocument 在**当前文档**里跑真实 measureBlocks（拿到模型给的高度）；
 *   2) 把渲染产物塞进同源 iframe，读**打印时真正会用的那些 DOM 节点**的高度；
 *   3) 逐块比对，并算出"内容实际结束位置"是否越过了下一个块的顶部 —— 那就是叠压。
 *
 * 场景 A 复现用户报的那张图：窄的产品名称元素 + 显式 h（一行高），
 * 名称换行成两行后溢出到下面的规格型号上。
 */

import { renderDocument } from '../src/render/pipeline'
import { emptyRenderContext } from '../src/render/context'
import type { AnyElement, TemplateDoc, TextElement } from '../src/lib/types'
import { emptyTemplate, mmToPx } from '../src/lib/types'
import type { FieldMeta, RecordItem } from '../src/lib/data-source'

const fields: FieldMeta[] = [
  { id: 'f_name', name: '产品名称', type: 1, isPrimary: true },
  { id: 'f_spec', name: '规格型号', type: 1 },
]

const records: RecordItem[] = [
  {
    recordId: 'r0',
    fields: { f_name: '薇诺娜舒敏保湿特护霜', f_spec: 'b5-A-1000' },
  },
]

function textEl(id: string, value: string, y: number, w: number, h: number | 'auto'): TextElement {
  return {
    id,
    kind: 'text',
    x: 0,
    y,
    w,
    h,
    style: { fontFamily: 'system', fontSizePt: 10.5, color: '#1f2329', align: 'left', lineHeight: 1.5 },
    nodes: [{ type: 'text', text: value }],
  }
}

function docOf(elements: AnyElement[]): TemplateDoc {
  return {
    ...emptyTemplate('record'),
    bands: { header: [], loop: { elements, offsetMm: 0 }, footer: [] },
  }
}

interface BlockReport {
  kind: string
  elementId: string
  xMm: number
  yMm: number
  wMm: number
  hMm: number
  /** iframe 里该块容器的**实测宽度**（mm）—— 用来确认"拉长了宽度但打印仍被压窄"这类宽度失真 */
  domWMm: number
  /** iframe 里该块容器的实测高度（mm） */
  domHMm: number
  /** iframe 里块**内容**的实测高度（mm）—— 溢出时它会大于 domHMm */
  contentHMm: number
  /** 内容实际结束位置（mm） */
  contentBottomMm: number
  /** 文本折成了几行（内容高 / 单行高，保留 1 位小数） */
  lines: number
}

interface CaseReport {
  id: string
  title: string
  elements: string
  blocks: BlockReport[]
  /** 内容越过下一个块顶部 → 叠压 */
  overlaps: string[]
  modelContentOverflow: string[]
  /** 渲染告警（type only）：用来确认"盒子高 < 内容高"会给出可定位的提示 */
  warnings: string[]
}

function pxToMm(px: number): number {
  return px / mmToPx(1)
}

/** 单行高（mm）：10.5pt × 1.5 行距 —— 用来把"内容高"换成"折了几行" */
const LINE_H_MM = ((10.5 * 1.5 * 25.4) / 72)

/** 卡住时能看出卡在哪一步（无头环境里"没结果"和"卡住"长得一样） */
function stage(s: string): void {
  ;(window as unknown as { __stage: string }).__stage = s
}

async function measureCase(id: string, title: string, elements: AnyElement[]): Promise<CaseReport> {
  stage(`${id}:render`)
  const doc = docOf(elements)
  const ctx = emptyRenderContext({
    fields,
    fieldMap: new Map(fields.map((f) => [f.id, f])),
    today: '2026-09-15',
    totalRows: records.length,
  })
  // 不传 skipMeasure：走真实 DOM 测量，和插件里跑的是同一条链路
  const out = await renderDocument({ doc, records, ctx, forPreview: false, title })
  stage(`${id}:frame`)

  const blocks: BlockReport[] = []
  const overlaps: string[] = []
  const modelContentOverflow: string[] = []

  const frame = document.createElement('iframe')
  frame.setAttribute('data-case', id)
  frame.style.width = `${mmToPx(out.pageWidthMm)}px`
  frame.style.height = `${mmToPx(out.pageHeightMm)}px`
  const holder = document.createElement('div')
  holder.className = 'case'
  const h3 = document.createElement('h3')
  h3.textContent = title
  holder.appendChild(h3)
  holder.appendChild(frame)
  // 必须先挂进文档：**游离节点上的 iframe 不会触发 load**（srcdoc 也不会被解析），
  // 挂在文档里的 iframe 才有 load 事件。踩过一次，卡在 stage=A:frame 不动。
  document.getElementById('cases')?.appendChild(holder)

  await new Promise<void>((resolve) => {
    frame.addEventListener('load', () => resolve(), { once: true })
    frame.srcdoc = out.html
  })
  stage(`${id}:measure`)

  const fd = frame.contentDocument
  if (!fd)
    return {
      id,
      title,
      elements: JSON.stringify(elements.map((e) => ({ y: e.y, w: e.w, h: e.h }))),
      blocks,
      overlaps,
      modelContentOverflow,
      warnings: out.warnings.map((w) => `${w.kind}: ${w.message}`),
    }

  for (const page of out.pages) {
    for (const b of page.blocks) {
      const node = fd.querySelector(`.bp-el[data-el="${b.elementId}"]`) as HTMLElement | null
      const contentNode = (node?.firstElementChild ?? node) as HTMLElement | null
      const domHMm = node ? pxToMm(node.getBoundingClientRect().height) : 0
      const domWMm = node ? pxToMm(node.getBoundingClientRect().width) : 0
      const contentHMm = contentNode ? pxToMm(contentNode.getBoundingClientRect().height) : 0
      blocks.push({
        kind: b.kind,
        elementId: b.elementId,
        xMm: round2(b.xMm),
        yMm: round2(b.yMm),
        wMm: round2(b.wMm),
        hMm: round2(b.hMm),
        domWMm: round2(domWMm),
        domHMm: round2(domHMm),
        contentHMm: round2(contentHMm),
        contentBottomMm: round2(b.yMm + Math.max(domHMm, contentHMm)),
        lines: Math.round((contentHMm / LINE_H_MM) * 10) / 10,
      })
    }
  }

  // 叠压判定：内容实际结束位置越过"下一个块"的顶部（同一栏内）
  for (let i = 0; i < blocks.length; i++) {
    const a = blocks[i]
    for (let j = 0; j < blocks.length; j++) {
      if (i === j) continue
      const b = blocks[j]
      const sameColumn = a.xMm < b.xMm + b.wMm - 0.5 && b.xMm < a.xMm + a.wMm - 0.5
      if (!sameColumn) continue
      if (b.yMm <= a.yMm) continue
      if (a.contentBottomMm > b.yMm + 0.2) {
        overlaps.push(
          `${a.elementId}(内容到 ${a.contentBottomMm}mm) 压住 ${b.elementId}(顶部 ${b.yMm}mm)`,
        )
      }
    }
    // 模型层（模型给的 h）是否也装不下内容
    if (a.contentHMm > a.hMm + 0.2) {
      modelContentOverflow.push(`${a.elementId}: 内容 ${a.contentHMm}mm > 模型 h ${a.hMm}mm`)
    }
  }

  const pre = document.createElement('pre')
  pre.textContent = blocks
    .map(
      (b) =>
        `${b.elementId}\n  kind=${b.kind} x=${b.xMm} y=${b.yMm} w=${b.wMm} (DOM 宽 ${b.domWMm})\n  模型 h=${b.hMm} / DOM ${b.domHMm} / 内容 ${b.contentHMm}（${b.lines} 行）`,
    )
    .join('\n')
  pre.textContent += `\n叠压：${overlaps.length ? overlaps.join('；') : '无'}`
  pre.textContent += `\n告警：${out.warnings.length ? out.warnings.map((w) => `${w.kind} ${w.message}`).join('；') : '无'}`
  holder.appendChild(pre)

  return {
    id,
    title,
    elements: JSON.stringify(elements.map((e) => ({ y: e.y, w: e.w, h: e.h }))),
    blocks,
    overlaps,
    modelContentOverflow,
    warnings: out.warnings.map((w) => `${w.kind}: ${w.message}`),
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

async function main(): Promise<void> {
  const reports: CaseReport[] = []
  // A. 用户复现：名称元素窄（换行）+ 显式 h=6mm（一行高），规格型号在 y=8
  reports.push(
    await measureCase('A', 'A 显式 h：窄元素 + 名称换行（用户场景）', [
      textEl('el_name', '薇诺娜舒敏保湿特护霜', 0, 30, 6),
      textEl('el_spec', 'b5-A-1000', 8, 60, 6),
    ]),
  )
  // B. 对照：同样的几何，但 h 用 'auto'（会被测量）
  reports.push(
    await measureCase('B', "B 对照：h='auto'（走测量）", [
      textEl('el_name_auto', '薇诺娜舒敏保湿特护霜', 0, 30, 'auto'),
      textEl('el_spec_auto', 'b5-A-1000', 8, 60, 6),
    ]),
  )
  // C. 对照：显式 h 足够高（不溢出）
  reports.push(
    await measureCase('C', 'C 对照：显式 h 足够（12mm）', [
      textEl('el_name_tall', '薇诺娜舒敏保湿特护霜', 0, 30, 12),
      textEl('el_spec_tall', 'b5-A-1000', 14, 60, 6),
    ]),
  )
  // D. 用户说的"长度拉得特别长"：宽 100mm → 必须真的打 100mm 宽、一行放得下，且不压下面
  reports.push(
    await measureCase('D', 'D 拉长宽度：100mm 宽元素 + 下方元素', [
      textEl('el_wide', '薇诺娜舒敏保湿特护霜', 0, 100, 6),
      textEl('el_below', 'b5-A-1000', 8, 60, 6),
    ]),
  )

  ;(window as unknown as { __fidelity: unknown }).__fidelity = { ready: true, reports }
  document.title = 'probe-ready'
}

main().catch((e: unknown) => {
  ;(window as unknown as { __fidelity: unknown }).__fidelity = {
    ready: true,
    error: e instanceof Error ? `${e.message}\n${e.stack ?? ''}` : String(e),
  }
  document.title = 'probe-error'
})
