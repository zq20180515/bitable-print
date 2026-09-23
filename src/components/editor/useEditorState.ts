/**
 * 在线模板编辑器的状态中枢（受控组件 + 内部历史栈）。
 *
 * 为什么是"受控 + 内部撤销栈"这个组合：
 * - doc 的唯一事实来源在父组件（App）：编辑器只负责"提出变更"（onChange），
 *   模板 JSON 何时落库、何时弹保存确认这类业务逻辑不该侵入编辑器。
 * - 但撤销/重做必须是同步、连续、可合并的（PRD F2-04：栈深 50、800ms 合并连续同类操作）。
 *   如果把历史栈放到父组件，每次敲键盘都要往返一层，合并窗口也变得不可控。
 *   因此历史栈（doc 的不可变快照）留在编辑器内部。
 * - 外部若整体替换了 doc（切换模板 / Word 导入），我们会检测到引用变化且内容不等价时
 *   清空历史，避免出现"撤销一步回到上一个模板"的事故。
 *
 * 坐标系约定（与 lib/types.ts 一致）：所有 y 都是 **距版心顶部的绝对 mm 坐标**，
 * 三个版式区（每页重复区 / 循环区 / 表尾区）共用同一个坐标系，渲染时统一 + marginTop。
 * 这样做的好处是元素跨区搬移时不需要换算 y，省掉一整类 off-by-margin 的 bug。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
// 表格单行高的**唯一口径**（文字行高 + 上下内边距 + 边框余量）——
// elementHeightMm 的 table 分支直接复用它，不要另写一套
import { rowMm } from '../../lib/skeletons'
import {
  contentBoxSize,
  finite,
  newId,
  ptToMm,
  type AnyElement,
  type AttachElement,
  type BarcodeElement,
  type ElementKind,
  type FieldBlockElement,
  type HLineElement,
  type ImageElement,
  type InlineField,
  type InlineNode,
  type PageBreakElement,
  type PageSetup,
  type QrCodeElement,
  type SysVarKey,
  type TableCell,
  type TableElement,
  type TableRow,
  type TextElement,
  type TextStyle,
  type TemplateDoc,
  DEFAULT_ATTACH_CONFIG,
  DEFAULT_GRID,
  DEFAULT_TEXT_STYLE,
} from '../../lib/types'
import { fieldMeta } from '../../lib/field-types'
import type { FieldMeta } from '../../lib/data-source'
// 查询原语已下沉到 `./table-query`（见下面「纯工具：表格单元格」那一段的说明）。
// 这里 import 是为了**本文件内部**继续能用（`findCell` 在 `sameNodeRef` 那一段还要用），
// 同时把同一个名字原样转出去，让所有 `from './useEditorState'` 的老引用照旧工作。
import { findCell, type CellLocation } from './table-query'
// 版式区原语（readBand / withBand / findElement / dropElement / moveElementToBand）同样已下沉，
// 理由与 table-query 一模一样：`cell-child.ts` 要能被 Node 直接加载，且不能反向依赖本文件
// （会形成 useEditorState ⇄ cell-child 的循环依赖）。这里 import 供本文件内部使用 + 原样转出。
import {
  dropElement,
  findElement,
  moveElementToBand,
  readBand,
  withBand,
  type BandKey,
  type FoundElement,
} from './doc-bands'
// 格内子元素（单元格里的图片/二维码/条形码/附件…）的定位与写回。
import { dropCellChild, findCellChild, isCellChildId, normalizeChildOutOfCell, patchCellChild } from './cell-child'
// `cellWidthMm`：格内百分比 → 纸上 mm 的**唯一换算基准**（复制格内元素时要用）。
// 方向是单向的：`table-actions` 只依赖 round / table-query / types，不反向依赖本文件。
import { cellWidthMm } from './table-actions'

// ============================================================
// 常量
// ============================================================

/** 连续同类操作（如连续输入文字）合并为一步的时间窗（PRD F2-04：800ms） */
export const MERGE_WINDOW_MS = 800
/** 撤销栈深度（PRD F2-04：50 步） */
export const MAX_HISTORY = 50
/** 循环区最小可视化高度（mm），避免空循环区看不出可放置区域 */
export const MIN_LOOP_EXTENT_MM = 40

/**
 * 版式区标识，与 TemplateBands 的键对应（loop 指向 bands.loop.elements）。
 * **定义已下沉到 `./doc-bands`**，这里原样转出（老引用不用改）。
 */
export type { BandKey } from './doc-bands'

/**
 * 版式区的**界面文案 —— 全项目唯一来源**。
 *
 * ⚠️ `header` 叫「表头区」而不是「每页重复区」（真机反馈 2026-09-22：「把每页重复区改为表头区」）：
 * 用户的心智模型是 Word 的页眉，"每页重复"描述的是**渲染行为**，不是他要往里放的东西。
 *
 * ⚠️ 别再就地抄第二份：`InspectPanel.tsx` 抄过一份自己的 `BAND_LABEL`，
 * 于是这次改名只改到一半 —— 它那一行「节点路径」还写着"每页重复区"。要用就 import 这个。
 */
export const BAND_LABEL: Record<BandKey, string> = {
  header: '表头区',
  loop: '循环区',
  footer: '表尾区',
}

export const BAND_HINT: Record<BandKey, string> = {
  header: '区外内容每页重复渲染，适合表头、公司抬头',
  /**
   * ⚠️ 循环区的**橙色括弧不是打印范围**（2026-09-18 真机反馈后补这句）。
   *
   * 它结构上永远到不了版心底边 —— `computeBandLayout` 至少留 40mm 给表尾区。
   * 用户把这根橙线当成了"打印范围"："左侧橙色的边框就不再往下蔓延了，导致元素明明还在画布内，
   * 但却无法打印出来"。真正的可打印边界是版心那圈**灰虚线**（现在挂了一枚常驻标签）。
   */
  loop: '区内元素按数据行重复，适合明细行；橙色括弧是循环区范围，**不是**可打印区边界（可打印区见版心灰虚线）',
  footer: '仅在最后一页渲染，适合合计、签章；打印时整区贴着版心底部，画布按版式区自上而下示意',
}

export const SYSVAR_LABEL: Record<SysVarKey, string> = {
  rowNo: '行号',
  pageNo: '页码',
  pageCount: '总页数',
  // 合并形态：用户要求「页码和页数可以合并在一起，单独设置是否显示总页数」。
  // 标签写成「页码 / 总页数」，是为了跟它两边的「页码」「总页数」并排时一眼看出是这两者的合并体
  pageOfTotal: '页码 / 总页数',
  today: '当前日期',
  totalRows: '数据总条数',
  printTime: '打印时间',
}

/** 系统变量在面板里的露出顺序。打印时间紧跟当前日期 —— 两者都是"输出这一刻的机器时间"，放在一起才找得到 */
export const SYSVAR_KEYS: SysVarKey[] = ['rowNo', 'pageNo', 'pageCount', 'pageOfTotal', 'today', 'printTime', 'totalRows']

/**
 * 新建表格的默认线色。
 *
 * 原来是 `#c9cdd4`：它和画布网格线的实际观感（≈ rgb(237,238,238)）只差一档对比度
 * （对照度约 1.36:1），用户的原话是"表格边框和内部的线条都不清晰，和画布的网格重合了，
 * 无法区分"。这里改用骨架里早就在用的 `#8f959e`（`lib/skeletons.ts` 的列头表就是这个色）——
 * 一份内容只有一种默认线色，画布与导出才不会各说各话；对照度提到约 2.6:1，一眼分得开。
 */
export const DEFAULT_TABLE_LINE = '#8f959e'

// ============================================================
// 纯工具：画布网格
// ============================================================

export interface GridOptions {
  /** 网格间距（mm），保证 > 0 */
  gridMm: number
  showGrid: boolean
  snapToGrid: boolean
}

/**
 * PageSetup 里这三个字段都是**可选**的（老模板没有，不需要 schema 迁移），
 * 读的地方一律走这里兜底，避免 Canvas / Inspector 各写一份 `?? 5`。
 */
export function gridOptions(p: PageSetup): GridOptions {
  const raw = finite(p.gridMm, DEFAULT_GRID.gridMm)
  return {
    // 0 / 负数 / NaN 会让吸附与网格渲染除零，直接回落到默认值
    gridMm: raw > 0 ? raw : DEFAULT_GRID.gridMm,
    showGrid: p.showGrid ?? DEFAULT_GRID.showGrid,
    snapToGrid: p.snapToGrid ?? DEFAULT_GRID.snapToGrid,
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

/**
 * 把 mm 坐标吸附到网格。
 *
 * `bypass` 是给"按住 Alt 临时不吸附"用的：不吸附时也要走一次取整，
 * 否则拖动会产生 3.1415926 这种坐标，渲染时又要在别处补取整。
 *
 * 先四舍五入到 mm 的百分位再返回，是因为 gridMm 可能是 2.5 这类小数，
 * `Math.round(v/2.5)*2.5` 会产出 7.500000000000001 之类的浮点毛刺。
 */
export function snapMm(v: number, step: number, enabled: boolean, bypass = false): number {
  const n = finite(v, 0)
  if (!enabled || bypass || !Number.isFinite(step) || step <= 0) return round2(n)
  return round2(Math.round(n / step) * step)
}

// ============================================================
// 纯工具：版式区读写（**已经下沉到 `./doc-bands`，这里只是转出去**）
// ============================================================
//
// 为什么下沉：`cell-child.ts`（格内子元素的定位与写回）要用这几个原语，而它
//   ① 必须能被 **Node 直接加载**（`test/*.mjs` 单测跑在 Node 下）；从本文件 import 会把 React 拖进去；
//   ② 从本文件 import 还会形成 `useEditorState ⇄ cell-child` 的**循环依赖**。
// 若各写一份 —— 同一套版式区寻址逻辑两份，**会静默分叉**（`BAND_LABEL` 刚才就栽过一次）。
//
// 所以原语住进 `./doc-bands`（只依赖 `lib/types`，运行时零依赖），本文件改成转出去：
// 全项目仍然只剩一份实现，而那些 `from './useEditorState'` 的老引用一行都不用改。
//
// 这几个名字既 import（上面那一段）又 re-export：本文件内部还要用它们，
// 而 `export … from` 不建立本地绑定。

export { dropElement, findElement, moveElementToBand, readBand, withBand } from './doc-bands'
export type { FoundElement } from './doc-bands'

// ============================================================
// 纯工具：表格单元格（**已经下沉到 `./table-query`，这里只是转出去**）
// ============================================================
//
// 为什么下沉：B 批的表格动作层 `table-actions.ts` 也要用 `findCell` / `updateCell`，
// 而那一层必须能被 **Node 直接加载**（`__selftest.mts` 跑在 Node 下）。
// 若从本文件 import，1301 行的 hooks 模块会把 React 一起拖进去；若各写一份，
// 同一套查找逻辑两份**会静默分叉**（这个项目已经栽过三次）。
//
// 所以原语住进 `./table-query`（只依赖类型、运行时零依赖），本文件改成**转出去**：
// 全项目仍然只剩一份实现，而 `from './useEditorState'` 的那些老引用一行都不用改。
//
// `findCell` 既 import（上面那行）又 re-export：本文件内部还要用它，
// 而 `export … from` 不建立本地绑定。

export { findCell, updateCell } from './table-query'
export type { CellLocation } from './table-query'

/** "第 N 行第 M 列" 这类定位文案，Canvas 的 title 与 Inspector 的面包屑共用 */
export function cellLabel(loc: CellLocation): string {
  return `第 ${loc.rowIdx + 1} 行 第 ${loc.colIdx + 1} 列`
}

// ============================================================
// 纯工具：行内节点（字段占位符 / 系统变量 / 文字片段）
// ============================================================

/**
 * 一处行内节点的定位：哪个元素、哪一格（文本元素内部为 null）、第几个节点。
 *
 * 为什么要带上前两级：`InlineField.style` 是**节点级覆写**，同一份文档里
 * 「第 3 格的第 0 个节点」和「第 5 格的第 0 个节点」是两回事，
 * 只靠 index 会在多个格子之间串味。
 */
export interface NodeRef {
  elementId: string
  cellId: string | null
  index: number
}

export function sameNodeRef(a: NodeRef | null | undefined, b: NodeRef | null | undefined): boolean {
  return !!a && !!b && a.elementId === b.elementId && a.cellId === b.cellId && a.index === b.index
}

/**
 * 这个定位下的整条 nodes 数组。
 * 定位已失效（元素/格子被删掉、下标越界）时返回 null —— 界面据此自动退回上一层，
 * 不必在每个删除路径上都去清一次选中状态。
 */
export function nodesAtRef(doc: TemplateDoc, ref: NodeRef): InlineNode[] | null {
  const found = findElement(doc, ref.elementId)
  if (!found) return null
  const el = found.el
  if (ref.cellId) {
    if (el.kind !== 'table') return null
    const loc = findCell(el.rows, ref.cellId)
    return loc && ref.index < loc.cell.nodes.length ? loc.cell.nodes : null
  }
  return el.kind === 'text' && ref.index < el.nodes.length ? el.nodes : null
}

export function nodeAtRef(doc: TemplateDoc, ref: NodeRef): InlineNode | null {
  const nodes = nodesAtRef(doc, ref)
  return nodes ? (nodes[ref.index] ?? null) : null
}

/** 节点在界面上的叫法。用来回答"我现在改的是哪一层" */
export function nodeKindLabel(n: InlineNode): string {
  if (n.type === 'field') return `字段「${n.fieldName || '未绑定'}」`
  if (n.type === 'sysvar') return `系统变量「${SYSVAR_LABEL[n.key]}」`
  if (n.type === 'br') return '换行'
  return '文字片段'
}

/** 能承载**自己样式**的行内节点（硬换行没有 style 字段） */
export type StyledInlineNode = Exclude<InlineNode, { type: 'br' }>

/**
 * 读一处节点的样式覆写。
 *
 * 单独抽出来只是为了把"硬换行没有 style"这一次类型收窄写在一处 ——
 * 顶栏工具栏与右侧面板都要读它，两边各写一遍 `n.type === 'br' ? {} : n.style`
 * 迟早会有一边忘了收窄（tsc 会先报，但下一次改的人未必看得懂为什么要写这一句）。
 */
export function nodeStyleOf(n: InlineNode): TextStyle {
  return n.type === 'br' ? {} : (n.style ?? {})
}

/** 节点级样式里"设过"的项数。0 就是没有覆写、完全继承外层 */
export function nodeStyleCount(n: InlineNode): number {
  if (n.type === 'br' || !n.style) return 0
  return Object.values(n.style).filter((v) => v !== undefined).length
}

/**
 * 改节点自己的样式。`patch` 里值为 `undefined` 表示**清掉这一项覆写**（回到继承外层），
 * 而不是写一个 undefined 进去 —— 后者会让内联 CSS 输出一堆空声明。
 */
export function withNodeStyle(n: StyledInlineNode, patch: TextStyle): StyledInlineNode {
  const style: TextStyle = { ...(n.style ?? {}) }
  const bag = style as Record<string, unknown>
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete bag[k]
    else bag[k] = v
  }
  // 覆写被清空后把 style 整个去掉：留着 `style: {}` 会让序列化出来的文档多一层噪声
  return Object.keys(style).length ? ({ ...n, style } as StyledInlineNode) : ({ ...n, style: undefined } as StyledInlineNode)
}

/** 能承载**自己属性**的行内节点（目前只有系统变量有 `format` / `hideTotal`） */
export type SysVarNode = Extract<InlineNode, { type: 'sysvar' }>

export function isSysVarNode(n: InlineNode | null | undefined): n is SysVarNode {
  return !!n && n.type === 'sysvar'
}

/**
 * 改系统变量自己的**非样式**属性：`format`（时间类变量的显示格式）与
 * `hideTotal`（仅 `pageOfTotal`：不输出"共 N 页"）。
 *
 * 与 `withNodeStyle` 同一套口径：值为 `undefined` = 清掉这一项（回到该变量自己的默认），
 * 而不是写一个 undefined 进去 —— 后者会让产物里多出一堆无意义的字段。
 *
 * 为什么单独一个函数而不是塞进 `withNodeStyle`：这两项只在 `InlineSysVar` 上有，
 * 混进 TextStyle 会把"样式覆写"这条口径搅浑（`nodeStyleCount` 数的是覆写项数，
 * 把 hideTotal 算进去会让「清除覆写」的语义变得说不清）。
 */
export function withSysVarProps(
  n: SysVarNode,
  patch: { format?: string | undefined; hideTotal?: boolean | undefined },
): SysVarNode {
  const out = { ...n } as SysVarNode & Record<string, unknown>
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete out[k]
    else out[k] = v
  }
  return out
}

// ============================================================
// 纯工具：元素尺寸估算（用于版心校验与循环区高度）
// ============================================================
/** h 可能是 'auto'，读数值时统一走这里，避免把字符串喂给数学运算 */
export function heightOf(h: number | 'auto', fallback: number): number {
  return typeof h === 'number' && Number.isFinite(h) ? h : fallback
}

/** 元素在版面占用的高度（mm）。'auto' 走启发式估算——真实高度只有渲染器能测，编辑器只需要一个量级正确的值 */
export function elementHeightMm(el: AnyElement): number {
  if (el.kind === 'hline') return Math.max(heightOf(el.h, 1), 0.5)
  if (el.kind === 'pagebreak') return Math.max(heightOf(el.h, 4), 2)
  if (el.h !== 'auto') return Math.max(finite(el.h, 10), 0.5)

  const fsPt = finite(el.style?.fontSizePt, DEFAULT_TEXT_STYLE.fontSizePt)
  const fsMm = ptToMm(fsPt)
  const lineMm = fsMm * finite(el.style?.lineHeight, DEFAULT_TEXT_STYLE.lineHeight)
  const widthMm = Math.max(finite(el.w, 60), 5)
  // 中文按 1 字宽 ≈ 1 字号估算，西文更窄；这里取 0.95 折中
  const perLine = Math.max(1, Math.floor(widthMm / (fsMm * 0.95)))

  let chars = 1
  let hardLines = 1
  if (el.kind === 'text') {
    for (const n of el.nodes) {
      if (n.type === 'text') chars += n.text.length
      else if (n.type === 'br') hardLines += 1
      else chars += 6 // 占位符按 6 个字符宽度估
    }
  } else if (el.kind === 'fieldBlock') {
    chars = 8 + (el.prefix?.length ?? 0) + (el.suffix?.length ?? 0)
  } else if (el.kind === 'attach') {
    return 30
  } else if (el.kind === 'table') {
    /**
     * 表格：**按行估算**（2026-09-18 飞书真机反馈后修正）。
     *
     * 旧式对表格直接落到下面的 `else → return 20` —— 一个**与行数、行高、内容全无关的常数**。
     * 而画布的选中框（蓝框 + 8 个手柄）用的就是这个值 ⇒ 与真实 `<table>` 差很远：
     * 用户原话："默认是 4 行×3 列，但实际的蓝色选区却在下方多框选了一个区域，
     * 最后一行还特别高，**因为最后一行压根不属于表格区域**"；
     * 而且"把蓝色选区的宽高都缩小，蓝色区域缩小了，但实际的原表格还保持不变"。
     * 实测对照：4 行空表真实约 13mm，旧估算却给 20mm（多出约 7mm 的空带）。
     *
     * 单行高复用 `lib/skeletons.ts` 的 `rowMm`（文字行高 + 上下内边距 + 边框余量），
     * **不另写一套**；行显式给了 `heightMm` 就用它（那才是作者的真实意图）。
     */
    const pad = finite(el.cellPaddingMm, 1.5)
    const total = el.rows.reduce((sum, r) => {
      // 行显式给了高度 ⇒ 那就是作者的真实意图，直接用
      if (typeof r.heightMm === 'number' && r.heightMm > 0) return sum + r.heightMm
      /**
       * ⚠️ **空行和有内容的行高度不一样**，不能都用 `rowMm`。
       *
       * `rowMm` = 文字行高 + 上下内边距 + 边框余量（≈8.59mm）—— 它假定每行有一行字。
       * 而刚拖进来的表格是**全空**的，空单元格没有行盒，一行只有内边距 ≈3.4mm。
       * 实测对照：默认 4 行空表真实约 13mm（4 × 3.4 = 13.6）⇒ 与估算吻合；
       * 若一律用 rowMm 会估成 34mm，蓝框反而更离谱（换个方向错而已）。
       */
      const hasContent = r.cells.some((c) => (c.nodes?.length ?? 0) > 0)
      return sum + (hasContent ? rowMm(fsPt, pad) : pad * 2 + 0.4)
    }, 0)
    return Math.max(2, total)
  } else {
    return 20
  }
  const lines = Math.max(hardLines, Math.ceil(chars / perLine))
  return Math.max(2, lines * lineMm)
}

/**
 * 对齐到版心：六种模式（左 / 水平居中 / 右 / 上 / 垂直居中 / 下），**纯函数**。
 *
 * 为什么只做"对齐到版心"而不是"对齐到某个元素"：画布没有多选模型
 * （一次只选中一个元素），而"把这一块摆到纸中间"是单元素也成立、且最常用的诉求。
 * 多元素对齐要等"多选"这个前提先存在 —— 那是另一件事，不该在这里假装支持。
 *
 * 只返回**要改的那一维**（水平模式只给 `x`，垂直模式只给 `y`），
 * 于是调用方 merge 进去时另一个维度原样保留。整份 {x,y} 都给会让"只改水平"变成"顺手也把 y 归位"，
 * 那种副作用在拖动之后尤其突兀。
 */
export type AlignMode = 'left' | 'hcenter' | 'right' | 'top' | 'vcenter' | 'bottom'

export function alignedXY(
  box: { x: number; y: number; w: number; h: number },
  mode: AlignMode,
  content: { w: number; h: number },
): { x?: number; y?: number } {
  switch (mode) {
    case 'left':
      return { x: 0 }
    case 'hcenter':
      return { x: Math.max(0, (content.w - box.w) / 2) }
    case 'right':
      return { x: Math.max(0, content.w - box.w) }
    case 'top':
      return { y: 0 }
    case 'vcenter':
      return { y: Math.max(0, (content.h - box.h) / 2) }
    default:
      return { y: Math.max(0, content.h - box.h) }
  }
}

export interface BandLayout {
  contentWMm: number
  contentHMm: number
  /** 循环区起点（= bands.loop.offsetMm），也是"每页重复区"与"循环区"的分界线 */
  loopTopMm: number
  /** 循环区可视化高度 */
  loopExtentMm: number
  /** 表尾区起点（循环区底边） */
  footerTopMm: number
}

/**
 * 版面分区几何：Canvas 画分隔线、Inspector 做越界校验、检查条统计超界都用它。
 *
 * ── ⚠️ 分区必须**互相独立**（2026-09-23 真机反馈第 3 条）────────────────
 * 用户原话：「拖动表头区的元素时，会导致循环区的元素也一起变动……请检查其他区域有没有类似BUG」。
 *
 * 原来两处分区位置都是**被别区的内容高度推着走**的：
 *   · 循环区起点 = `max(循环区声明起点, 表头区实测内容高)`（在 pipeline / Canvas 里算）；
 *   · 表尾区起点 = `循环区起点 + **循环区内容高度**`。
 * 于是"在表头里往下拖一点"会把整个循环区推下去；"在循环区里往下拖一点"会把表尾区推下去。
 * 两个都是同一类毛病：**一个区的坐标取决于另一个区的内容**。
 *
 * 现在两处都改成**只依赖各自声明的量**：
 *   · 表头区高度 = `bands.loop.offsetMm`（用户可在页面属性里改，0 = 不要表头区）；
 *     表头区里的元素被**夹在自己带内**（见 Canvas 的 `beginSession`），所以它永远撑不破这个高度；
 *   · 表尾区 = **贴版心底部**（`contentH - footerReserve`）—— 这正是打印端的落点
 *     （`render/layout.ts` 的 `top = max(0, contentH - footerReserve)`），
 *     于是画布与打印**首次完全一致**，而且它只随表尾区自己的内容变化。
 *
 * 循环区高度 = 两者之间剩下的空间（不再是"内容高度"）。
 */
export function computeBandLayout(doc: TemplateDoc): BandLayout {
  const { w: contentWMm, h: contentHMm } = contentBoxSize(doc.pageSetup)
  const loopTopMm = Math.min(Math.max(0, finite(doc.bands.loop.offsetMm)), contentHMm)

  /** 表尾区整组占用的高度（与 Canvas 的 `footerReserveMm`、渲染层的 `footerReserve` 同一口径） */
  const footerReserveMm = doc.bands.footer.reduce((m, el) => Math.max(m, finite(el.y, 0) + elementHeightMm(el)), 0)
  /* 表尾区：贴版心底部（与打印一致）；至少留一块可见空间，且不许压到循环区的下界 */
  const footerTopMm = Math.max(
    loopTopMm + MIN_LOOP_EXTENT_MM,
    Math.min(contentHMm, contentHMm - footerReserveMm),
  )

  return {
    contentWMm,
    contentHMm,
    loopTopMm,
    loopExtentMm: Math.max(0, footerTopMm - loopTopMm),
    footerTopMm,
  }
}

// ============================================================
// 纯工具：模板检查（PRD BP-4 / E3）
// ============================================================

export type IssueKind = 'invalidField' | 'unboundField' | 'outOfBounds'

export interface TemplateIssue {
  /** 稳定 key，供 React 列表与去重使用 */
  id: string
  level: 'block' | 'warn'
  kind: IssueKind
  message: string
  /** 便于在详情列表中定位 */
  elementId: string
  elementLabel: string
  band: BandKey
}

export interface TemplateAnalysis {
  issues: TemplateIssue[]
  /** 失效字段引用的去重元素数 */
  invalidElementIds: string[]
  unboundElementIds: string[]
  outOfBoundsElementIds: string[]
  /** 模板完全为空（E-46） */
  isEmpty: boolean
}

export function elementLabel(el: AnyElement): string {
  switch (el.kind) {
    case 'text': {
      const t = el.nodes
        .map((n) => (n.type === 'text' ? n.text : n.type === 'field' ? n.fieldName : '系统变量'))
        .join('')
        .trim()
      return t ? `文本「${t.slice(0, 12)}${t.length > 12 ? '…' : ''}」` : '文本段落'
    }
    case 'table':
      return `表格 ${el.rows.length}×${el.colWidthsMm.length}`
    case 'image':
      return '固定图片'
    case 'hline':
      return '水平线'
    case 'pagebreak':
      return '分页符'
    case 'fieldBlock':
      return `字段块「${el.fieldName || '未绑定'}」`
    case 'attach':
      return `附件块「${el.fieldName || '未绑定'}」`
    case 'qrcode':
      return `二维码「${codeSourceLabel(el.source)}」`
    case 'barcode':
      return `条形码「${codeSourceLabel(el.source)}」`
    default:
      return '元素'
  }
}

/** 码的来源摘要，供检查清单与属性面板标题复用（不重复写两套） */
export function codeSourceLabel(source: { kind: 'field'; fieldName: string } | { kind: 'static'; value: string }): string {
  if (source.kind === 'field') return source.fieldName || '未绑定字段'
  return source.value ? source.value.slice(0, 12) : '未填写内容'
}

function isInlineField(n: InlineNode): n is InlineField {
  return n.type === 'field'
}

interface FieldRef {
  fieldId: string | null
  fieldName: string
}

/** 收集元素引用的全部字段占位符（含表格单元格内部） */
export function collectFieldRefs(el: AnyElement): FieldRef[] {
  switch (el.kind) {
    case 'text':
      return el.nodes.filter(isInlineField).map((n) => ({ fieldId: n.fieldId, fieldName: n.fieldName }))
    case 'fieldBlock':
      return [{ fieldId: el.fieldId, fieldName: el.fieldName }]
    case 'attach':
      return [{ fieldId: el.fieldId, fieldName: el.fieldName }]
    // 码绑定字段时同样要进检查清单：否则"二维码没绑字段"会被静默放过，
    // 打印出来是一片空白，用户根本不知道问题出在哪。
    case 'qrcode':
    case 'barcode':
      return el.source.kind === 'field'
        ? [{ fieldId: el.source.fieldId, fieldName: el.source.fieldName }]
        : []
    case 'table':
      return el.rows.flatMap((r) =>
        r.cells.flatMap((c) =>
          c.nodes.filter(isInlineField).map((n) => ({ fieldId: n.fieldId, fieldName: n.fieldName })),
        ),
      )
    default:
      return []
  }
}

/**
 * 扫一遍模板，产出检查清单。
 * PRD 要求"必须显式提示，不能静默丢值"（E-13），所以失效引用一律单条列出。
 */
export function analyzeTemplate(doc: TemplateDoc, fields: FieldMeta[]): TemplateAnalysis {
  const known = new Set(fields.map((f) => f.id))
  const layout = computeBandLayout(doc)
  const issues: TemplateIssue[] = []
  const invalid = new Set<string>()
  const unbound = new Set<string>()
  const outOfBounds = new Set<string>()
  let total = 0

  const bands: BandKey[] = ['header', 'loop', 'footer']
  for (const band of bands) {
    for (const el of readBand(doc, band)) {
      total += 1
      const label = elementLabel(el)
      const x = finite(el.x)
      const y = finite(el.y)
      const w = Math.max(0, finite(el.w))
      const h = elementHeightMm(el)

      // 越界判定加 0.5mm 容差：缩放取整会带来亚毫米误差，不该误报
      const over =
        x < -0.5 ||
        x + w > layout.contentWMm + 0.5 ||
        y < -0.5 ||
        y + h > layout.contentHMm + 0.5
      if (over) {
        outOfBounds.add(el.id)
        issues.push({
          id: `oob:${el.id}`,
          level: 'warn',
          kind: 'outOfBounds',
          message: `${label} 超出纸张可打印区域`,
          elementId: el.id,
          elementLabel: label,
          band,
        })
      }

      for (const ref of collectFieldRefs(el)) {
        if (!ref.fieldId) {
          unbound.add(el.id)
          issues.push({
            id: `unbound:${el.id}:${ref.fieldName}`,
            level: 'block',
            kind: 'unboundField',
            message: `${label} 中的「${ref.fieldName || '未命名'}」未绑定字段`,
            elementId: el.id,
            elementLabel: label,
            band,
          })
        } else if (!known.has(ref.fieldId)) {
          invalid.add(el.id)
          issues.push({
            id: `invalid:${el.id}:${ref.fieldId}`,
            level: 'block',
            kind: 'invalidField',
            message: `${label} 引用的字段「${ref.fieldName}」已不存在`,
            elementId: el.id,
            elementLabel: label,
            band,
          })
        }
      }
    }
  }

  return {
    issues,
    invalidElementIds: [...invalid],
    unboundElementIds: [...unbound],
    outOfBoundsElementIds: [...outOfBounds],
    isEmpty: total === 0,
  }
}

// ============================================================
// 纯工具：文本内容 ⇄ 行内节点 序列化
// ============================================================

const SYSVAR_BY_LABEL: Record<string, SysVarKey> = Object.fromEntries(
  (Object.keys(SYSVAR_LABEL) as SysVarKey[]).map((k) => [SYSVAR_LABEL[k], k]),
) as Record<string, SysVarKey>

/**
 * 把纯文本里"看起来像标记"的部分转义掉，让往返成为恒等变换。
 *
 * 为什么两种标记都要转义：`${名称}` 对应字段占位符、`【标签】` 对应对应系统变量，
 * 而 textToNodes 见到任一形态都会产出"活的"节点。字面文本里出现这两者时如果不转义，
 * 用户双击文本框、什么都没改就点走，字面文字就会被悄悄换成活的字段/系统变量。
 * `${…}` 的典型来源是 F3-18「忽略（转为纯文本）」；`【…】` 的典型来源是
 * Word 正文里的填写说明（如"此处填写【当前日期】"）。
 *
 * 只转义**完整且能命中**的标记：
 * - `${…}` 只要有配对的 `}` 就转义（内容任意，因为字段名没有封闭集合）；
 * - `【…】` 只在括号内是**已知的系统变量标签**时才转义——不认识的标签本来就会被
 *   textToNodes 兜成纯文本，转了反而会把正文里正常的「【备注】」也加上反斜杠。
 * 这条"只转已知标签"的规则同时还保证了逐键输入安全：用户敲 `【`、`【页` 都不可能
 * 构成已知标签，所以打字过程中绝不会凭空冒出反斜杠（这一点比 `${` 还更稳）。
 *
 * 判定要 trim，和 textToNodes 里的 `SYSVAR_BY_LABEL[x.trim()]` 保持一致，
 * 否则「【 页码 】」会出现"这边不转、那边认活"的不对称。
 *
 * ⚠️ 已知歧义（用前缀字符做转义必然的代价，不要试图"修"成双写反斜杠）：
 * 当文本节点**以反斜杠结尾**、且紧跟一个字段/系统变量节点时，序列化出来的
 * `路径：\${文件名}` 与被转义的字面 `路径：${文件名}` 是**同一个字符串**，单看字符串无法区分。
 * 这是编码本身的歧义，不是实现疏忽。
 * **触发条件不是"用户手打反斜杠"**：这个结构可以由普通 .docx 导入直接产生
 * （Word 里的 `路径：\${文件名}` → 文本"\` + 字段节点），用户只要**编辑了那个段落**
 * （哪怕只加一个句号）就会走到这里。因此不能靠"用户不会这么输入"来搪塞，必须真消歧：
 * 消歧逻辑放在 textToNodes 里，靠 prevNodes 判断该结构是否存在（见 hasBackslashBeforeMarker）。
 * 之所以不用"双写反斜杠"来消歧：那会让用户每次敲一个 `\` 就看到 `\\`、而且删不掉，
 * 把一个罕见输入造成的问题换成一个必然发生、更显眼的输入问题，得不偿失。
 *
 * 残留局限（**仅剩一种，且向导流程产不出来**）：同一个元素里**同名**既存在活字段节点、
 * 又存在字面标记文本时，消歧按名字命中就判为活字段，于是那处**字面会被升成活字段**
 * （实测：字段节点数 1 → 2）。注意失败方向与"字段降成字面"相反——是字面变成活的。
 * 为什么说向导产不出来：F3-18 的「忽略」是**按占位符名全局生效**的
 * （`ignoredPlaceholderNames` 返回 Set<string>，match.ts:44；to-template 命中该名字的
 * 每一处都输出原文），所以一个名字要么全是字面、要么全是活字段，不可能同名两态共存；
 * 要构造只能靠人工编辑 JSON/节点。真要根治得把消歧从"按名字"升级为"按出现次序"
 * （用 prevNodes 按文档序给每个名字排一个 live/literal 队列，逐次消费），当前判断为不值得。
 */
function escapeTags(text: string): string {
  return text
    // 用函数式替换，避免替换串里的 `$` 被当成 $&/$1 之类的模式
    .replace(/\$\{[^}]*\}/g, (tag) => '\\' + tag)
    .replace(/【([^】]*)】/g, (tag, label: string) => (label.trim() in SYSVAR_BY_LABEL ? '\\' + tag : tag))
}

/**
 * 为什么需要这层序列化：文本块里可以混排"纯文字 + 字段占位符 + 系统变量"，
 * 但如果就地编辑直接用纯 textarea，编辑一次就会把占位符全丢掉。
 * 折中方案是让占位符在编辑态退化成可读的标记文本（`${字段名}` / `【页码】`），
 * 提交时再按标记还原成节点。用户既能改文字，也能手打一个占位符出来。
 *
 * 纯文本一侧要先 escapeTags 再输出（见该函数注释）；字段/系统变量节点输出的
 * 是**不带**反斜杠的标记，因为那正是"活的"标记该有的形态。
 */
export function nodesToText(nodes: readonly InlineNode[]): string {
  return nodes
    .map((n) => {
      if (n.type === 'text') return escapeTags(n.text)
      if (n.type === 'br') return '\n'
      if (n.type === 'field') return `\${${n.fieldName}}`
      return `【${SYSVAR_LABEL[n.key]}】`
    })
    .join('')
}

/**
 * 相邻纯文本合并。转义与换行会把一段文字切出多个 text 节点，
 * 不合并的话"打开就地编辑、什么都没改又关掉"会因节点数变化被 Canvas 的
 * JSON 比对误判成一次修改（凭空多一条撤销记录），也会让序列化结果不再幂等。
 */
function mergeAdjacentText(nodes: InlineNode[]): InlineNode[] {
  const out: InlineNode[] = []
  for (const n of nodes) {
    const prev = out[out.length - 1]
    // 显式判 undefined，别依赖 `prev?.type` 的收窄，免得 strict 下推不出联合类型的分支
    if (prev !== undefined && prev.type === 'text' && n.type === 'text') {
      out[out.length - 1] = { type: 'text', text: prev.text + n.text }
    } else {
      out.push(n)
    }
  }
  return out
}

/**
 * 判断节点序列里是否存在"文本节点以反斜杠结尾、紧跟一个会产出标记的节点"的结构。
 *
 * 这就是 `\${X}` 歧义的唯一来源：此时序列化出来的 `\${X}` 与"被转义的字面 `${X}`"
 * 是同一个字符串。**这个结构可以由普通 .docx 导入直接产生**——Word 段落里的
 * `路径：\${文件名}`（例如路径类模板）会被导入成 [文本"路径："、文本"\`、字段"文件名"]，
 * 也就是说：反斜杠不必由用户手打，用户只要**编辑了这个段落**（哪怕只加一个句号），
 * 就会走到需要消歧的路径上。所以这里不能靠"用户不会这么输入"来搪塞。
 */
function hasBackslashBeforeMarker(nodes?: readonly InlineNode[]): boolean {
  if (!nodes) return false
  for (let i = 0; i < nodes.length - 1; i += 1) {
    const cur = nodes[i]
    const next = nodes[i + 1]
    if (cur?.type === 'text' && cur.text.endsWith('\\') && (next?.type === 'field' || next?.type === 'sysvar')) {
      return true
    }
  }
  return false
}

/**
 * 把标记文本还原成行内节点。
 *
 * `prevNodes` 是"上一轮这份文本对应的节点"，只为保住**用户在向导里显式选定的 fieldId**。
 * 为什么非它不可：`${名称}` 这套语法只带名字、不带 id，而**同名字段是真实存在的**
 * （PRD F3-19：匹配到多个同名字段时默认绑第一个、允许用户改绑第二个；F3-19 里用户在
 * Word 导入匹配页改绑的那个 id 会被导入侧正确写进节点）。若这里一律按名字反查 fields，
 * 用户双击文本框、什么都没改就点走，绑定就会被悄悄改回**第一个**同名字段——
 * 又是一次静默改写，而且因为 JSON 不等还会平白多一条撤销记录。
 *
 * 有了 prevNodes 的表，"打开编辑又原样关掉"在**绑定层面**也是恒等变换：节点不变 →
 * Canvas 的 JSON 比对直接短路 → 不改绑、不进撤销栈。只有真正新敲进去的 `${…}`
 * （表里查不到）才回落到按名字查 fields。
 */
export function textToNodes(text: string, fields: FieldMeta[], prevNodes?: readonly InlineNode[]): InlineNode[] {
  // 无改动短路：draft 与 prevNodes 的序列化结果一字不差时，直接原样返回。
  //
  // 这一步同时买到三样东西：
  // ① "打开就地编辑、什么都没改又关掉"成为**严格恒等**（不改绑、不进撤销栈、不丢快照）；
  // ② 保住了用户/导入侧产出的节点结构，而不是按语法重新规范化（结构本身也是信息）；
  // ③ 化解 `\` 转义的一处固有歧义：字符串 `\${X}` 既能读成"被转义的字面 ${X}"，
  //    也能读成"字面反斜杠 + 活的字段 X"（文本节点以反斜杠结尾、紧跟字段/系统变量节点时）。
  //    单看字符串无法区分——这是用前缀字符做转义必然的代价（见 escapeTags 注释）。
  //    有 prevNodes 就不必猜：完全没改动时，答案就是 prevNodes 本身。
  if (prevNodes && nodesToText(prevNodes) === text) return [...prevNodes]

  const out: InlineNode[] = []
  // 上一轮的"名字 → 绑定"。**含未绑定（fieldId 为 null）**：反斜杠歧义的消解需要知道
  // 上一轮这里本来就是个字段，哪怕它当时没绑上；重名时保留先出现的那个，保证确定性。
  const prevFields = new Map<string, { fieldId: string | null; fieldTypeSnapshot?: number }>()
  for (const n of prevNodes ?? []) {
    if (n.type !== 'field') continue
    if (prevFields.has(n.fieldName)) continue
    prevFields.set(n.fieldName, {
      fieldId: n.fieldId,
      // 快照跟着绑定一起留住，否则"无改动的一次编辑"也会把它抹掉
      ...(n.fieldTypeSnapshot !== undefined ? { fieldTypeSnapshot: n.fieldTypeSnapshot } : {}),
    })
  }
  // 上一轮出现过的系统变量，供 `\【标签】` 的歧义消解使用
  const prevSysvars = new Set<SysVarKey>()
  for (const n of prevNodes ?? []) {
    if (n.type === 'sysvar') prevSysvars.add(n.key)
  }
  // 本轮文本是否来自"反斜杠紧贴标记"的结构（见下方消歧逻辑）
  const ambiguous = hasBackslashBeforeMarker(prevNodes)

  // 一次性匹配 转义态 / 正常态 的两种标记，其余按纯文本切段。
  // 转义分支必须排在对应正常分支前面，否则 `\${x}` 会先被字段分支吃掉、转义就白做了。
  const re = /\\\$\{([^}]*)\}|\\【([^】]*)】|\$\{([^}]*)\}|【([^】]*)】/g
  let cursor = 0
  let m: RegExpExecArray | null
  const pushText = (raw: string): void => {
    if (!raw) return
    const parts = raw.split('\n')
    parts.forEach((p, i) => {
      if (i > 0) out.push({ type: 'br' })
      if (p) out.push({ type: 'text', text: p })
    })
  }
  while ((m = re.exec(text))) {
    pushText(text.slice(cursor, m.index))
    cursor = m.index + m[0].length
    if (m[1] !== undefined) {
      // 转义态：字面 `${…}`（例如被「忽略」的占位符原文），绝不能变成字段。
      // 但若上一轮存在"反斜杠紧贴标记"的结构，这个 `\` 可能是那段文本自己的字面反斜杠，
      // 后面的标记其实是个**活字段**——那就按活字段还原，别把字段吃掉。
      const name = m[1].trim()
      const prev = ambiguous ? prevFields.get(name) : undefined
      if (prev) {
        pushText('\\')
        out.push({
          type: 'field',
          fieldId: prev.fieldId,
          fieldName: name,
          ...(prev.fieldTypeSnapshot !== undefined ? { fieldTypeSnapshot: prev.fieldTypeSnapshot } : {}),
        })
      } else {
        pushText('${' + m[1] + '}')
      }
    } else if (m[2] !== undefined) {
      // 同上：转义态本应还原成字面 `【…】`（正文里本来就写着的标签字样），
      // 但"反斜杠紧贴标记"时它也可能是字面反斜杠 + 活系统变量。
      const key = ambiguous ? SYSVAR_BY_LABEL[m[2].trim()] : undefined
      if (key && prevSysvars.has(key)) {
        pushText('\\')
        out.push({ type: 'sysvar', key })
      } else {
        pushText('【' + m[2] + '】')
      }
    } else if (m[3] !== undefined) {
      const name = m[3].trim()
      const prev = prevFields.get(name)
      if (prev && prev.fieldId !== null) {
        out.push({
          type: 'field',
          fieldId: prev.fieldId,
          fieldName: name,
          // 显式展开而不是 `...prev`：否则 fieldId 会被重复指定，tsc 报 TS2783
          ...(prev.fieldTypeSnapshot !== undefined ? { fieldTypeSnapshot: prev.fieldTypeSnapshot } : {}),
        })
      } else {
        const hit = fields.find((f) => f.name === name)
        // 不新造 fieldTypeSnapshot：它的语义是"导入绑定那一刻的类型快照"（见 types.ts:154），
        // 编辑器侧的插入路径（Inspector 的 FieldPicker）也一律不写，两边保持一致。
        out.push({ type: 'field', fieldId: hit ? hit.id : null, fieldName: name })
      }
    } else if (m[4] !== undefined) {
      const key = SYSVAR_BY_LABEL[m[4].trim()]
      out.push(key ? { type: 'sysvar', key } : { type: 'text', text: `【${m[4]}】` })
    }
  }
  pushText(text.slice(cursor))
  return mergeAdjacentText(out)
}

// ============================================================
// 纯工具：元素工厂
// ============================================================

export type NewElementSpec =
  | { kind: 'text'; text?: string }
  | { kind: 'table'; rows?: number; cols?: number; header?: boolean }
  | { kind: 'image'; dataUrl: string; widthMm: number; heightMm: number }
  | { kind: 'hline' }
  | { kind: 'pagebreak' }
  | { kind: 'fieldBlock'; fieldId: string | null; fieldName: string; fieldType?: number }
  | { kind: 'attach'; fieldId: string | null; fieldName: string; fieldType?: number }
  | { kind: 'qrcode' }
  | { kind: 'barcode' }

/**
 * 码的前景 / 背景默认色。
 * 这属于**内容色**（真的会被打印出来的墨色），不是插件 UI 主题色，
 * 因此和字段类型色块、色板同一性质，允许写死十六进制 —— 它不能跟着暗色模式翻。
 */
export const DEFAULT_CODE_FG = '#000000'
export const DEFAULT_CODE_BG = '#ffffff'

export const ELEMENT_LABEL: Record<ElementKind, string> = {
  text: '文本段落',
  table: '表格',
  image: '固定图片',
  hline: '水平线',
  pagebreak: '分页符',
  fieldBlock: '字段块',
  attach: '附件字段块',
  qrcode: '二维码',
  barcode: '条形码',
}

/** 新建元素的默认尺寸与样式。宽度默认占满版心，避免用户一放进去就要拖宽度 */
export function createDefaultElement(spec: NewElementSpec, contentWMm: number): AnyElement {
  const base = { id: newId(spec.kind), x: 0, y: 0 }
  switch (spec.kind) {
    case 'text':
      return {
        ...base,
        kind: 'text',
        w: contentWMm,
        h: 'auto',
        style: { ...DEFAULT_TEXT_STYLE },
        nodes: textToNodes(spec.text ?? '双击编辑文字', []),
      } satisfies TextElement
    case 'table': {
      /*
       * 默认 **3 行 × 4 列**（用户规格 一："添加表格时弹出默认行列数选择（默认 3 行 × 4 列）"）。
       * ⚠️ 2026-09-22 之前这里是 `cols ?? 3` / `rows ?? 4` —— 也就是"3 列 4 行"，
       *    与规格写的"3 行 4 列"**正好相反**。别凭 `?? 3` 的先后顺序去猜它的语义。
       */
      const cols = Math.max(1, Math.min(spec.cols ?? 4, 8))
      const rows = Math.max(1, Math.min(spec.rows ?? 3, 50))
      const hasHeader = spec.header ?? true
      const colW = contentWMm / cols
      return {
        ...base,
        kind: 'table',
        w: contentWMm,
        h: 'auto',
        colWidthsMm: Array.from({ length: cols }, () => Math.round(colW * 100) / 100),
        border: { mode: 'all', widthPt: 0.75, color: DEFAULT_TABLE_LINE },
        repeatHeader: true,
        cellPaddingMm: 1.5,
        /*
         * ⚠️ **真机反馈（2026-09-22）**：新建的表原来只给首行写了 `isHeader: true` 这个**标记**，
         *    却没有套表头**样式** ⇒ 用户看到的表头和普通行一模一样，必须「右键取消表头再重设」
         *    才看见变化（因为那一步走的是 `setHeaderStylePatch`，它会真的加粗/居中/加底纹）。
         * ⇒ 建表时就把样式一起写上，让默认表头一眼是表头。底纹色与 `setHeaderStylePatch` 同一份值。
         */
        rows: Array.from({ length: rows }, (_, r) => ({
          id: newId('row'),
          isHeader: hasHeader && r === 0,
          cells: Array.from({ length: cols }, () => ({
            id: newId('cell'),
            colspan: 1,
            rowspan: 1,
            nodes: [],
            ...(hasHeader && r === 0
              ? { style: { bold: true, align: 'center' as const, background: '#f2f3f5' } }
              : {}),
          })),
        })),
      } satisfies TableElement
    }
    case 'image':
      return {
        ...base,
        kind: 'image',
        w: Math.max(1, spec.widthMm),
        h: Math.max(1, spec.heightMm),
        dataUrl: spec.dataUrl,
        fit: 'contain',
      } satisfies ImageElement
    case 'hline':
      return {
        ...base,
        kind: 'hline',
        w: contentWMm,
        h: 1,
        thicknessPt: 0.75,
        color: DEFAULT_TEXT_STYLE.color,
      } satisfies HLineElement
    case 'pagebreak':
      return { ...base, kind: 'pagebreak', w: contentWMm, h: 4 } satisfies PageBreakElement
    case 'fieldBlock': {
      const meta = fieldMeta(spec.fieldType)
      // 附件字段拖进来直接生成附件块，否则打印出来只是一串文件名
      if (meta.renderKind === 'attachment') {
        return {
          ...base,
          kind: 'attach',
          w: contentWMm,
          h: 30,
          fieldId: spec.fieldId,
          fieldName: spec.fieldName,
          config: { ...DEFAULT_ATTACH_CONFIG },
        } satisfies AttachElement
      }
      return {
        ...base,
        kind: 'fieldBlock',
        w: Math.max(20, contentWMm * 0.6),
        h: 'auto',
        fieldId: spec.fieldId,
        fieldName: spec.fieldName,
        style: { ...DEFAULT_TEXT_STYLE },
      } satisfies FieldBlockElement
    }
    case 'attach':
      return {
        ...base,
        kind: 'attach',
        w: contentWMm,
        h: 30,
        fieldId: spec.fieldId,
        fieldName: spec.fieldName,
        config: { ...DEFAULT_ATTACH_CONFIG },
      } satisfies AttachElement
    // 二维码默认 28×28mm：这是"扫码枪能稳定识别"的常见下限，再小就要靠提高纠错等级硬撑。
    // 内容默认留空（不编造一个示例网址），由 Inspector 引导用户选字段或手填。
    case 'qrcode':
      return {
        ...base,
        kind: 'qrcode',
        w: 28,
        h: 28,
        source: { kind: 'static', value: '' },
        ecLevel: 'M',
        showText: false,
        foreground: DEFAULT_CODE_FG,
        background: DEFAULT_CODE_BG,
      } satisfies QrCodeElement
    // 条形码默认 50×18mm：Code128 越窄条越细，18mm 高在 203dpi 热敏机上还扫得动
    case 'barcode':
      return {
        ...base,
        kind: 'barcode',
        w: Math.min(contentWMm, 50),
        h: 18,
        source: { kind: 'static', value: '' },
        format: 'code128',
        showText: true,
        foreground: DEFAULT_CODE_FG,
        background: DEFAULT_CODE_BG,
      } satisfies BarcodeElement
    default:
      return {
        ...base,
        kind: 'text',
        w: contentWMm,
        h: 'auto',
        nodes: [],
      } satisfies TextElement
  }
}

// ============================================================
// Hook
// ============================================================

/**
 * 把编辑器的"默认字体 / 字号"偏好盖到刚创建的元素上。
 * 之所以放在插入之后而不是塞进 createDefaultElement，是因为这个偏好不属于模板契约
 * （TemplateDoc 里没有这两个字段），只影响新元素、不写进 JSON（见 F2-28 不做样式集继承）。
 */
export function applyDefaultTextStyle(el: AnyElement, style: TextStyle): AnyElement {
  if (el.kind === 'text' || el.kind === 'fieldBlock') {
    return { ...el, style: { ...el.style, ...style } }
  }
  if (el.kind === 'table') {
    return {
      ...el,
      rows: el.rows.map((r) => ({ ...r, cells: r.cells.map((c) => ({ ...c, style: { ...c.style, ...style } })) })),
    }
  }
  return el
}

export interface UseEditorStateArgs {
  doc: TemplateDoc
  onChange: (doc: TemplateDoc) => void
  /** 当前表字段列表；用于把"字段已失效/未绑定"扫出来（PRD E-13 / BP-4） */
  fields?: FieldMeta[]
  /**
   * Esc 键的"上一级"处理。
   *
   * 为什么需要它：编辑器里存在**层级**（表格 → 单元格），Esc 的语义应该是"退一级"，
   * 而不是"直接取消选中整个元素"——用户在单元格里按 Esc 期望回到整表，不是把表格的选中丢掉。
   * 返回 true 表示"我处理掉了，别再清空选中"。
   *
   * 外部每次渲染都可以传新函数，内部用 ref 镜像，因此不会让 keydown 监听器反复重绑。
   */
  onEscape?: () => boolean
}

export interface EditorApi {
  doc: TemplateDoc
  layout: BandLayout
  analysis: TemplateAnalysis

  selectedId: string | null
  selected: AnyElement | null
  selectedBand: BandKey | null
  /**
   * 选中的是一个**格内子元素**时给出它所在的格子；否则 null。
   *
   * 为什么要有它（而不是让面板去猜 id 前缀）：面板要据此**换一套控件** ——
   * 格内元素的 X/Y 无意义、`w` 是百分比、`h` 是最大高度（见 types.ts 第 ④ 条）。
   * 若面板照自由层那套渲染，"宽度(mm)" 这个输入框会是个**点了没反应**的控件，
   * 那比不显示更坏（本项目在这一点上栽过）。判据只此一处，不在 UI 里再判断一次。
   */
  selectedInCell: { tableId: string; cellId: string } | null
  select(id: string | null): void

  addElement(el: AnyElement, band?: BandKey): void
  /** patch 用泛型保住类型：Inspector 里能对 TableElement 传 { border } 而被检查 */
  mergeElement<T extends AnyElement = AnyElement>(id: string, patch: Partial<T>, mergeKey?: string): void
  removeElement(id: string): void
  setElementBand(id: string, band: BandKey): void
  /**
   * 表头区高度（mm）= `bands.loop.offsetMm`：**循环区从版心顶部往下多少毫米开始**，
   * 也就是表头区占的高度。`0` = 不要表头区（真机反馈 2026-09-23 第 2 条：
   * 「表头区改为可以删除或者增加，在页面属性中设置」）。
   *
   * 为什么不塞进 `pageSetup`：它不是纸张/边距那一类印刷属性，而是**版式区**的属性
   * （字段在 `TemplateDoc.bands.loop` 里），混进 pageSetup 会造出第二个存放位置。
   */
  setLoopOffset(mm: number): void

  setPageSetup(patch: Partial<PageSetup>): void
  replaceDoc(next: TemplateDoc): void

  // ---- 右键菜单（2026-09-22）：全屏画布接管右键，菜单里放真动作 ----
  /** 复制指定元素到**插件内剪贴板**（不是系统剪贴板：跨文档粘贴需要序列化，那超出本轮范围） */
  copyElement(id: string): boolean
  /** 剪切 = 复制 + 删除 */
  cutElement(id: string): boolean
  /** 粘贴到指定版式区；给了 `at` 就落在那里，否则相对原位置右下偏移 4mm */
  pasteClipboard(band?: BandKey, at?: { x: number; y: number }): void
  /** 剪贴板里有没有东西（决定"粘贴"是灰的还是可点） */
  clipboardHas: boolean
  /** 把指定元素对齐到版心（六种模式，纯函数 `alignedXY`） */
  alignElement(id: string, mode: AlignMode): void
  /** 网格吸附开关（画布右键菜单里那一项） */
  toggleSnap(): void
  /** 图层顺序：渲染顺序 = 数组顺序，末尾在最上层 */
  moveZIndex(id: string, where: 'front' | 'back' | 'forward' | 'backward'): void

  undo(): void
  redo(): void
  canUndo: boolean
  canRedo: boolean

  /**
   * 结束当前的合并窗口。
   * 拖动/缩放松开时必须调用一次——否则"拖完停一会儿再拖同一个元素"会被合并成同一步撤销，
   * 撤销一下会跳回很早的位置，用户会以为撤销坏了。
   */
  endMerge(): void

  dirty: boolean
  markClean(): void
}

export function useEditorState({ doc, onChange, fields = [], onEscape }: UseEditorStateArgs): EditorApi {
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [history, setHistory] = useState<{ past: TemplateDoc[]; future: TemplateDoc[] }>({
    past: [],
    future: [],
  })
  /** 未保存基线：用 state 而非 ref，这样 markClean 之后 dirty 会自动重算 */
  const [baseline, setBaseline] = useState<TemplateDoc>(doc)

  // 用 ref 镜像 doc，让所有回调保持引用稳定（避免子组件因回调变化而全量重渲染）
  const docRef = useRef<TemplateDoc>(doc)
  docRef.current = doc
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange
  /** 我们最后一次"提议"出去的 doc 引用，用于区分"自己触发的回流"和"外部替换" */
  const emittedRef = useRef<TemplateDoc>(doc)
  const mergeRef = useRef<{ key: string; at: number } | null>(null)
  const historyRef = useRef(history)
  historyRef.current = history

  // ---- 外部替换检测：只在引用变化时做一次深比较，避免每次渲染都 JSON.stringify ----
  useEffect(() => {
    if (doc === emittedRef.current) return
    if (doc === docRef.current) {
      emittedRef.current = doc
      return
    }
    let same = false
    try {
      same = JSON.stringify(doc) === JSON.stringify(docRef.current)
    } catch {
      same = false
    }
    if (same) {
      emittedRef.current = doc
      docRef.current = doc
      return
    }
    // 真的被外部换掉了（切换模板 / 导入）：清空历史，重新设基线
    emittedRef.current = doc
    docRef.current = doc
    mergeRef.current = null
    setBaseline(doc)
    setHistory({ past: [], future: [] })
    setSelectedId(null)
  }, [doc])

  // ---- 提交 ----
  const commit = useCallback((next: TemplateDoc, mergeKey?: string) => {
    const prev = docRef.current
    if (next === prev) return
    const now = Date.now()
    const prevMerge = mergeRef.current
    const mergeable = !!mergeKey && !!prevMerge && prevMerge.key === mergeKey && now - prevMerge.at < MERGE_WINDOW_MS

    docRef.current = next
    emittedRef.current = next
    // 合并窗口内不新增历史条目：连续输入文字只应产生一步撤销
    if (mergeable) {
      setHistory((h) => (h.future.length ? { past: h.past, future: [] } : h))
    } else {
      setHistory((h) => ({ past: [...h.past, prev].slice(-MAX_HISTORY), future: [] }))
    }
    mergeRef.current = mergeKey ? { key: mergeKey, at: now } : null
    onChangeRef.current(next)
  }, [])

  const undo = useCallback(() => {
    const h = historyRef.current
    if (h.past.length === 0) return
    const prev = h.past[h.past.length - 1]
    const cur = docRef.current
    setHistory({ past: h.past.slice(0, -1), future: [cur, ...h.future].slice(0, MAX_HISTORY) })
    docRef.current = prev
    emittedRef.current = prev
    mergeRef.current = null
    onChangeRef.current(prev)
  }, [])

  const redo = useCallback(() => {
    const h = historyRef.current
    if (h.future.length === 0) return
    const next = h.future[0]
    const cur = docRef.current
    setHistory({ past: [...h.past, cur].slice(-MAX_HISTORY), future: h.future.slice(1) })
    docRef.current = next
    emittedRef.current = next
    mergeRef.current = null
    onChangeRef.current(next)
  }, [])

  // ---- 元素操作 ----
  const addElement = useCallback(
    (el: AnyElement, band: BandKey = 'loop') => {
      const cur = docRef.current
      commit(withBand(cur, band, [...readBand(cur, band), el]))
      setSelectedId(el.id)
    },
    [commit],
  )

  const mergeElement = useCallback(
    <T extends AnyElement = AnyElement,>(id: string, patch: Partial<T>, mergeKey?: string) => {
      const cur = docRef.current
      /**
       * 格内子元素走**另一条写回路径**（改它所在的那张表的某一格），
       * 因为 `findElement` 只扫版式区、子元素不属于任何版式区。
       * `patchCellChild` 返回 null 表示"这个 id 现在找不到了"（表/格/子元素被删掉了），
       * 此时**静默忽略** —— 不能落一个空 patch 覆盖掉整份文档。
       */
      if (isCellChildId(id)) {
        const next = patchCellChild(cur, id, patch as Partial<AnyElement>)
        if (next) commit(next, mergeKey)
        return
      }
      const found = findElement(cur, id)
      if (!found) return
      const merged = { ...found.el, ...patch } as AnyElement
      commit(withBand(cur, found.band, readBand(cur, found.band).map((e) => (e.id === id ? merged : e))), mergeKey)
    },
    [commit],
  )

  const removeElement = useCallback(
    (id: string) => {
      /**
       * 删除格内子元素 = 把它从格子里摘掉（`dropCellChild`），
       * 而不是 `dropElement` —— 后者扫的是版式区，对子元素是**恒等操作**（什么都不会发生），
       * 于是"右侧面板点删除、元素还在"。
       */
      if (isCellChildId(id)) {
        const next = dropCellChild(docRef.current, id)
        if (next) commit(next)
      } else {
        commit(dropElement(docRef.current, id))
      }
      setSelectedId((s) => (s === id ? null : s))
    },
    [commit],
  )

  const setElementBand = useCallback(
    (id: string, band: BandKey) => {
      /**
       * 子元素**没有所属版式区**，改 band 对它无意义（它跟着那张表走）。
       * 显式挡掉而不是让它掉进 `moveElementToBand`：那个函数对找不到的 id 返回**原文档**，
       * 而这里 `commit(同一个引用)` 会被 `dirty` 比较判成"没变"——虽然无害，
       * 但"点了没反应"要在代码上说清楚是哪一种没反应。
       */
      if (isCellChildId(id)) return
      commit(moveElementToBand(docRef.current, id, band))
    },
    [commit],
  )

  /**
   * 选中 id 的 **ref 镜像**：给"不在渲染闭包里"的回调/监听器用（快捷键、右键菜单动作）。
   * ⚠️ 它必须声明在**用到它的那些 useCallback 之前** —— 声明在下面时 tsc 会报
   *    `Block-scoped variable used before its declaration`（同作用域内的词法引用，与"何时调用"无关）。
   */
  const setLoopOffset = useCallback(
    (mm: number) => {
      const cur = docRef.current
      const next = Math.max(0, Math.min(round2(finite(mm, 0)), contentBoxSize(cur.pageSetup).h / 2))
      if (next === finite(cur.bands.loop.offsetMm, 0)) return
      commit({
        ...cur,
        bands: { ...cur.bands, loop: { ...cur.bands.loop, offsetMm: next } },
      })
    },
    [commit],
  )

  const selectedIdRef = useRef(selectedId)
  selectedIdRef.current = selectedId

  /**
   * ---- 右键菜单用到的几个元素级动作（2026-09-22）--------------------------------
   *
   * 全屏画布上按右键，飞书给的是它自己的**兜底宿主菜单**（只有一个"重新加载"）。
   * 我们接管之后菜单里要放真动作 —— 这些就是那几个动作，都走 `commit` ⇒ 天然进撤销栈。
   */

  /** 插件内剪贴板。用 ref 存，因为它**不该**触发重渲染（只有"有没有"这个事实要触发）。 */
  const clipboardRef = useRef<AnyElement | null>(null)
  const [clipboardHas, setClipboardHas] = useState(false)

  /**
   * ⚠️ 这几个动作**显式接收 id**，而不是"作用于当前选中项"。
   *
   * 原因是一次真实的竞态：`selectedIdRef.current = selectedId` 是**渲染期**赋值的，
   * 而右键菜单的动作会在"先 `select(id)`、紧接着 `copy()`"这种写法里跑 —— 同一个 tick 内
   * ref 还是旧值，复制到的是**上一个**元素。传 id 就没有这个时间窗。
   */
  const copyElement = useCallback((id: string): boolean => {
    const cur = docRef.current
    /*
     * 格内子元素走另一条路（`findElement` 只扫版式区，对它恒返回 null ⇒ 不补这一段的话
     * Ctrl+C 在格内元素上是**静默无效**的）。
     *
     * ⚠️ 进剪贴板前要**换算成自由层的 mm**：格内 `w` 是百分比，直接粘到画布上会被当 mm 读
     *    （`100` ⇒ 100mm 宽，占掉大半张 A4）。基准用那一格的实际宽度 ⇒ 粘到画布上的视觉宽度
     *    与它在格子里一致。粘**回格子**时 `insertIntoCell` / 元素入格那条路会再归一化成 100%，
     *    所以"格内 → 格内"（最常用：把一个二维码的配置抄到另一格）同样是对的。
     */
    const childHit = id ? findCellChild(cur, id) : null
    if (childHit) {
      const out = normalizeChildOutOfCell(childHit.child, cellWidthMm(childHit.table, childHit.cellId))
      clipboardRef.current = JSON.parse(JSON.stringify(out)) as AnyElement
      setClipboardHas(true)
      return true
    }
    const found = id ? findElement(cur, id) : null
    if (!found) return false
    /*
     * 深拷贝用 JSON 往返：元素全是纯数据（`dataUrl` 是字符串，没有 Date/Map/函数），
     * 而这个项目没有引入 lodash/cloneDeep。⚠️ 唯一的边界是 `h` 可能是 `'auto'` —— 字符串，
     * JSON 往返同样保真。
     */
    clipboardRef.current = JSON.parse(JSON.stringify(found.el)) as AnyElement
    setClipboardHas(true)
    return true
  }, [])

  const cutElement = useCallback(
    (id: string): boolean => {
      if (!copyElement(id)) return false
      removeElement(id)
      return true
    },
    [copyElement, removeElement],
  )

  /**
   * 粘贴：落在 `at`（版心 mm 坐标）附近 —— 右键点在哪儿就贴哪儿。
   * 没有 `at` 时相对原位置右下偏移 4mm，**不会**和原件完全重合（重合了用户以为没粘上）。
   */
  const pasteClipboard = useCallback(
    (band: BandKey = 'loop', at?: { x: number; y: number }) => {
      const src = clipboardRef.current
      if (!src) return
      const copy = JSON.parse(JSON.stringify(src)) as AnyElement
      const next: AnyElement = {
        ...copy,
        id: newId(copy.kind === 'text' ? 'txt' : 'el'),
        x: at ? at.x : finite(copy.x, 0) + 4,
        y: at ? at.y : finite(copy.y, 0) + 4,
      }
      commit(withBand(docRef.current, band, [...readBand(docRef.current, band), next]))
      setSelectedId(next.id)
    },
    [commit],
  )

  /**
   * 对齐到**版心**（不是"对齐到另一个元素"—— 单元素没有多选模型，先做这一档）。
   * 具体算术在纯函数 `alignedXY` 里（可单测，且不用起画布）。
   */
  const alignElement = useCallback(
    (id: string, mode: AlignMode) => {
      const cur = docRef.current
      const found = id ? findElement(cur, id) : null
      if (!found) return
      const box = contentBoxSize(cur.pageSetup)
      const el = found.el
      const patch = alignedXY(
        { x: finite(el.x, 0), y: finite(el.y, 0), w: Math.max(1, finite(el.w, 20)), h: elementHeightMm(el) },
        mode,
        { w: box.w, h: box.h },
      )
      commit(withBand(cur, found.band, readBand(cur, found.band).map((e) => (e.id === el.id ? { ...e, ...patch } : e))))
    },
    [commit],
  )

  /** 网格吸附开关（右键菜单「网格吸附 ✓」用）。`gridOptions` 读的就是这一对字段。 */
  const toggleSnap = useCallback(() => {
    const cur = docRef.current
    commit({ ...cur, pageSetup: { ...cur.pageSetup, snapToGrid: !cur.pageSetup.snapToGrid } })
  }, [commit])

  /**
   * 排列（图层顺序）。**渲染顺序 = 数组顺序**（数组末尾画在最上层），所以"置顶/置底"就是挪数组位置。
   *
   * ⚠️ 已经在顶/底时**直接 return，不提交**：空提交会在撤销栈里留一步"什么都没变"的步骤，
   *    用户按一次撤销会觉得"没反应"，再按一次才真的回退 —— 那是撤销坏了的观感。
   */
  const moveZIndex = useCallback(
    (id: string, where: 'front' | 'back' | 'forward' | 'backward') => {
      const cur = docRef.current
      const found = findElement(cur, id)
      if (!found) return
      const arr = readBand(cur, found.band)
      const i = arr.findIndex((e) => e.id === id)
      if (i < 0) return
      const next = arr.slice()
      if (where === 'front') {
        if (i === arr.length - 1) return
        next.splice(i, 1)
        next.push(found.el)
      } else if (where === 'back') {
        if (i === 0) return
        next.splice(i, 1)
        next.unshift(found.el)
      } else if (where === 'forward') {
        if (i >= arr.length - 1) return
        const t = next[i + 1]
        next[i + 1] = next[i]
        next[i] = t
      } else {
        if (i <= 0) return
        const t = next[i - 1]
        next[i - 1] = next[i]
        next[i] = t
      }
      commit(withBand(cur, found.band, next))
    },
    [commit],
  )

  const setPageSetup = useCallback(
    (patch: Partial<PageSetup>) => {
      const cur = docRef.current
      commit({ ...cur, pageSetup: { ...cur.pageSetup, ...patch } })
    },
    [commit],
  )

  const replaceDoc = useCallback(
    (next: TemplateDoc) => {
      commit(next)
    },
    [commit],
  )

  // ---- 快捷键（PRD F2-04） ----
  // 输入态不拦截：textarea 的原生撤销对"正在输入的几个字"更符合直觉，
  // 我们的文档级撤销留给"结构性操作"。
  // ⚠️ `selectedIdRef` 已提到上面（右键菜单那几个动作要用它）。
  /** onEscape 每次渲染都是新函数（它闭包了 EditorShell 的 state），用 ref 镜像避免重绑监听器 */
  const onEscapeRef = useRef(onEscape)
  onEscapeRef.current = onEscape
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
      const mod = e.ctrlKey || e.metaKey
      const key = e.key.toLowerCase()
      if (mod && key === 'z') {
        e.preventDefault()
        if (e.shiftKey) redo()
        else undo()
        return
      }
      if (mod && key === 'y') {
        e.preventDefault()
        redo()
        return
      }
      if (!mod && (e.key === 'Delete' || e.key === 'Backspace')) {
        const id = selectedIdRef.current
        if (!id) return
        e.preventDefault()
        removeElement(id)
        return
      }
      if (e.key === 'Escape') {
        // 先给"层级上移"一次机会（单元格 → 整表），没人接手才清空选中
        if (onEscapeRef.current?.()) return
        setSelectedId(null)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [undo, redo, removeElement])

  // ---- 派生 ----
  const layout = useMemo(() => computeBandLayout(doc), [doc])
  const found = useMemo(() => (selectedId ? findElement(doc, selectedId) : null), [doc, selectedId])
  /**
   * 选中的是**格内子元素**时的下钻结果。
   *
   * `findElement` 只扫版式区，对 `child:<tableId>:<cellId>` 恒返回 null ⇒ 不补这一步的话，
   * `selected` 是 null、右侧面板会跳回「页面设置」—— 用户点格子里的图片，面板却在讲纸张大小。
   * 真机反馈第 3 条那句「点击该单元格后，右侧属性面板显示 @image#1:… 未绑定字段」，
   * 根子就在这里：他**根本没有机会选中格子里的那个元素**。
   *
   * `!found &&` 短路：正常元素的 id 不可能是复合 id，真的同时命中时以版式区那个为准。
   *
   * ── ⚠️ 这里把 `child.id` **改写成复合 id**（2026-09-22 真机 e2e 抓到的第二个 bug）──────
   * 面板里每一处写入都是 `onMerge(element.id, patch)` / `onRemove(element.id)`。
   * 如果 `selected` 原样返回子元素，那个 `id` 是**它自己的 id**（`el_ab12`）而不是复合 id
   * ⇒ `mergeElement` 两条路都找不到它（`isCellChildId` 为假 + `findElement` 返回 null）
   * ⇒ **静默什么都不做**。用户看到的是"面板里改了宽度，画布纹丝不动"
   * （e2e ⑫j 实测：输入框显示 95、画布还是 100%）。
   *
   * 所以定一条不变量：**选中对象的 `id`，就是它在选中模型里的 id**。
   * 面板因此一行都不用改；`patchCellChild` / `dropCellChild` 内部仍按**真实 id** 匹配那一格
   * （它们先 `findCellChild` 拿到真元素，再比 `ch.id === hit.child.id`），不受影响。
   */
  const foundChild = useMemo(
    () => {
      if (found || !selectedId) return null
      const hit = findCellChild(doc, selectedId)
      return hit ? { ...hit, child: { ...hit.child, id: selectedId } as AnyElement } : null
    },
    [doc, selectedId, found],
  )
  const analysis = useMemo(() => analyzeTemplate(doc, fields), [doc, fields])

  const markClean = useCallback(() => {
    setBaseline(docRef.current)
  }, [])

  const endMerge = useCallback(() => {
    mergeRef.current = null
  }, [])

  return {
    doc,
    layout,
    analysis,
    selectedId,
    selected: found ? found.el : (foundChild?.child ?? null),
    /**
     * 格内子元素**没有**自己的版式区 —— 它跟着那张表走，所以这里给表的版式区，
     * 而不是 `null`：`null` 会让面板退回默认的 `'loop'`，一个放进表头区表格里的图片
     * 会在面板上显示"循环区"。给真值 + `selectedInCell` 让面板**讲清楚它改不了**，
     * 比给一个错误的默认值好。
     */
    selectedBand: found ? found.band : (foundChild?.band ?? null),
    selectedInCell: foundChild ? { tableId: foundChild.tableId, cellId: foundChild.cellId } : null,
    select: setSelectedId,
    addElement,
    mergeElement,
    removeElement,
    setElementBand,
    setLoopOffset,
    setPageSetup,
    replaceDoc,
    copyElement,
    cutElement,
    pasteClipboard,
    clipboardHas,
    alignElement,
    toggleSnap,
    moveZIndex,
    undo,
    redo,
    canUndo: history.past.length > 0,
    canRedo: history.future.length > 0,
    endMerge,
    dirty: doc !== baseline,
    markClean,
  }
}
