/**
 * 单元格子元素的**定位与写入**（2026-09-22，真机反馈第 3 条）。
 *
 * 用户原话：「单元格内的元素……完全无法对单元格内的图片、二维码和条形码进行编辑，
 * 点击该单元格后，右侧的属性面板显示 @image#1:Clipboard_Screenshot.png 未绑定字段」
 * —— 点格子显示的是**格子的字段占位**，而格子里那个真元素根本没有被选中的机会。
 *
 * ── 为什么需要这个模块（而不是往 findElement 里加递归）──────────────────
 * `findElement(doc, id)` 只在**版式区**里找元素，找到的结果是 `{el, band}` ——
 * 调用方（`mergeElement` / `removeElement`）靠 `band` 写回。而格内子元素**不属于任何版式区**，
 * 它的写回路径是"改它所在的那张表的某一格"。两者结构不同，硬塞进同一个返回值里
 * 只会让每个调用方都去判"这次是不是子元素"。
 *
 * ── 三个设计决定（动它之前先读这三条）──────────────────────────────────
 *
 * ① **下钻只有一层**：一格最多一个块级子元素（`MAX_CELL_CHILDREN = 1`），
 *    而且 `CELL_BLOCK_KINDS` 里**没有 `table`** ⇒ 结构上不可能嵌套。所以不需要递归搜索。
 *
 * ② **用复合 id 表达"某个格子里的那个元素"**：`child:<tableId>:<cellId>`。
 *    这样它就是一个**普通字符串**，能直接流进现有的 `select(id)` / `mergeElement(id, patch)` /
 *    撤销栈的 `mergeKey`，改动面最小；而 `findCellChild` 负责把它解回三元组。
 *    ⚠️ 走这条路的代价：`selectedId` 里会出现这种合成 id，**任何按 id 找元素的地方都要能容忍它** ——
 *    所以 `mergeElement` / `removeElement` / `selected` / `setElementBand` 四处都加了分支（见 useEditorState）。
 *
 * ③ **写回 = 重建那张表的 rows**（不是就地改）：克隆 rows → 换掉那一格里的子元素 → 用 `withBand` 落回原版式区。
 *    与其它动作层一样走"整份快照"路线，撤销栈因此天然正确。
 */

import type { AnyElement, TableElement, TemplateDoc } from '../../lib/types'
// ⚠️ 只从 `./doc-bands` 取 —— 不要从 `./useEditorState` 取。那个模块是 React hooks 模块，
// 而本文件必须能被 Node 直接加载（单测要跑），并且反向引用会和 useEditorState 形成循环依赖。
// `BandKey` 就是从 doc-bands 转出去的，类型上是同一个。
import { findElement, readBand, withBand, type BandKey } from './doc-bands'
/*
 * `round1` 的**规范实现**（`round.ts`）。
 * ⚠️ 不要在本文件里再写一份 —— 本项目有一条守卫钉着"全项目恰好一处定义"
 * （`src/components/editor/__selftest.mts` 的「已收口」断言），我第一次就是这么被拦下来的。
 * `round.ts` 只依赖 `lib/types`，因此不影响"本文件要能被 Node 直接加载"这条约束。
 */
import { round1 } from './round'
// 尺寸口径的规范实现在 lib/（见下方 re-export 处的说明）—— 这里要**本地**用到 `childWidthPct`
import { childWidthPct } from '../../lib/cell-geometry'

const PREFIX = 'child:'

/** 复合 id：`child:<tableId>:<cellId>` */
export function cellChildId(tableId: string, cellId: string): string {
  return `${PREFIX}${tableId}:${cellId}`
}

/**
 * 解回 `{tableId, cellId}`；不是子元素 id 就返回 null。
 *
 * 用**第一个冒号**切一刀、再用**最后一个冒号**切第二刀：
 * tableId 与 cellId 都是 `newId()` 生成的（无冒号），但万一将来 id 里允许冒号，
 * 这样切也比 `split(':')` 稳（后者会因为多出来的段而错位）。
 */
export function parseCellChildId(id: string | null | undefined): { tableId: string; cellId: string } | null {
  if (!id || !id.startsWith(PREFIX)) return null
  const rest = id.slice(PREFIX.length)
  const cut = rest.lastIndexOf(':')
  if (cut <= 0 || cut >= rest.length - 1) return null
  return { tableId: rest.slice(0, cut), cellId: rest.slice(cut + 1) }
}

export interface FoundCellChild {
  tableId: string
  cellId: string
  /** 那张表在哪个版式区（写回要用） */
  band: BandKey
  /** 那张表（未修改的快照） */
  table: TableElement
  /** 格子里的那个子元素 */
  child: AnyElement
}

/** 按复合 id 找到"格内子元素" —— 找不到（表/格/子元素任一缺失）返回 null */
export function findCellChild(doc: TemplateDoc, id: string | null | undefined): FoundCellChild | null {
  const parsed = parseCellChildId(id)
  if (!parsed) return null
  const found = findElement(doc, parsed.tableId)
  if (!found || found.el.kind !== 'table') return null
  const row = found.el.rows.find((r) => r.cells.some((c) => c.id === parsed.cellId))
  const cell = row?.cells.find((c) => c.id === parsed.cellId)
  const child = cell?.children?.[0]
  if (!cell || !child) return null
  return { tableId: parsed.tableId, cellId: parsed.cellId, band: found.band, table: found.el, child }
}

/** 把某张表的 rows 换掉（其余字段原样），并用 `withBand` 落回原版式区 */
function replaceTableRows(doc: TemplateDoc, band: BandKey, tableId: string, rows: TableElement['rows']): TemplateDoc {
  return withBand(
    doc,
    band,
    readBand(doc, band).map((e) => (e.id === tableId && e.kind === 'table' ? { ...e, rows } : e)),
  )
}

/** 改格内子元素（patch 合并进去）—— 与 `mergeElement` 同语义，只是写回路径不同 */
export function patchCellChild(
  doc: TemplateDoc,
  id: string,
  patch: Partial<AnyElement>,
): TemplateDoc | null {
  const hit = findCellChild(doc, id)
  if (!hit) return null
  const rows = hit.table.rows.map((r) => ({
    ...r,
    cells: r.cells.map((c) =>
      c.id !== hit.cellId
        ? c
        : { ...c, children: (c.children ?? []).map((ch) => (ch.id === hit.child.id ? ({ ...ch, ...patch } as AnyElement) : ch)) },
    ),
  }))
  return replaceTableRows(doc, hit.band, hit.tableId, rows)
}

/** 把格内子元素**从格子里摘掉**（元素本身的属性面板用不到，但 `removeElement` 要走这条） */
export function dropCellChild(doc: TemplateDoc, id: string): TemplateDoc | null {
  const hit = findCellChild(doc, id)
  if (!hit) return null
  const rows = hit.table.rows.map((r) => ({
    ...r,
    cells: r.cells.map((c) => (c.id !== hit.cellId ? c : { ...c, children: (c.children ?? []).filter((ch) => ch.id !== hit.child.id) })),
  }))
  return replaceTableRows(doc, hit.band, hit.tableId, rows)
}

/**
 * 把格内子元素**搬到一个版式区**（"取出到画布"用）。
 * 返回新文档；调用方随后自己 `addElement`。
 */
export function takeOutCellChild(doc: TemplateDoc, id: string): { doc: TemplateDoc; child: AnyElement } | null {
  const hit = findCellChild(doc, id)
  if (!hit) return null
  const next = dropCellChild(doc, id)
  if (!next) return null
  return { doc: next, child: hit.child }
}

/** 这个 id 是不是"格内子元素"（给那些只认版式区元素的地方一个显式的判据，而不是靠 `findElement` 返回 null 去猜） */
export function isCellChildId(id: string | null | undefined): boolean {
  return parseCellChildId(id) !== null
}

// ============================================================
// 尺寸口径（`w` 在格内是百分比、`h` 是固定高度；见 types.ts 的 TableCell.children 第 ④ 条）
// ============================================================

/** 占单元格宽度的百分比的**下限**：再窄就看不见了，那种"拖了半天什么都没了"必须堵掉 */
/*
 * ⚠️ `MIN_CELL_CHILD_PCT` / `childWidthPct` / `childHeightMm` 的**规范实现**已下沉到
 * `lib/cell-geometry.ts`。理由与 `round1` 那条一样，只是方向相反：
 * **渲染引擎**（`render/html.ts`）也要用同一套口径，而 `render/` 绝不能反向 import
 * `components/editor/`（会形成循环依赖，且渲染引擎必须能被 Node 直接加载）。
 * 这里只做 re-export，保住全部既有引用（含 `cell-child.selftest.mts` 与 Canvas）。
 */
export { MIN_CELL_CHILD_PCT, childHeightMm, childWidthPct } from '../../lib/cell-geometry'

/**
 * **进格子**：把一个自由层元素归一化成格内子元素。
 *
 * 口径：撑满格子宽度 + 高度由内容决定（= 它被扔进格子之前画布上的样子）。
 * 不这么做的话，自由层的 `w: 40`（mm）会被读成 40%，图片比用户预期小一半 —— 而且
 * 用户没做任何操作，只是把东西放进了格子，尺寸不该"自己变一下"。
 *
 * ⚠️ **码是例外**（真机反馈 2026-09-23 第 8 条：「单元格内的二维码、条形码……会超出单元格的限制」）：
 * 二维码/条形码是**正方形/长条**，若让它的高度"由内容决定"，它就会跟着**格宽**长
 * （width:100% ⇒ 高 = 宽），一个 40mm 宽的格子会得到一个 40mm 高的码，把整行撑高。
 * 所以码给一个**默认高度**（18mm ≈ 常见的打印码尺寸），配合"等比缩放到框内"就不会溢出，
 * 用户想要更大/更小再去面板里改「高」。
 */
export const CELL_CHILD_CODE_H_MM = 18

export function normalizeChildInCell<T extends AnyElement>(child: T): T {
  if (child.kind === 'qrcode' || child.kind === 'barcode') {
    return { ...child, w: 100, h: CELL_CHILD_CODE_H_MM }
  }
  return { ...child, w: 100, h: 'auto' }
}

/**
 * **出格子**：把格内子元素换回自由层。
 *
 * `w` 从百分比换算成 mm（`cellWidthMm * pct / 100`）—— 这样"取出到画布"后
 * 它在纸上的**视觉宽度与在格子里一致**，不会突然变成 100% 版心宽。
 * `h` 保持原值：`'auto'` 在自由层同样是"高度由内容决定"，是合法的自由层取值。
 */
export function normalizeChildOutOfCell<T extends AnyElement>(child: T, cellWidthMm: number): T {
  const pct = childWidthPct(child)
  const w = Math.max(2, round1((Number.isFinite(cellWidthMm) && cellWidthMm > 0 ? cellWidthMm : 20) * pct / 100))
  return { ...child, w, x: 0, y: 0 }
}
