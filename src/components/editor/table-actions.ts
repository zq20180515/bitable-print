/**
 * 表格动作层：合并 / 拆分 / 行列增删 / 列宽 / 行高。
 *
 * 也收一个**读取侧**的换算 `colEdgeFrac`（列宽数组 → 列边界占比）：它读的正是
 * `setColWidthPatch` 写的那个 `colWidthsMm`，读写方同处一文件，将来改列宽语义
 * （最小列宽钳制 / 列宽和与总宽的关系）时不会漏掉另一头 —— 理由详见该函数自己的注释。
 *
 * ## 为什么要有这个文件
 *
 * 这些动作原来**各自关在组件闭包里**：
 *   - `Inspector.tsx` 的 `TableAttrs` 里：`addRow` / `delRow` / `addCol` / `delCol` / `setColWidth`
 *   - `Inspector.tsx` 的 `CellPanel` 里：`mergeRight` / `mergeDown` / `splitCell` / `patchCell`
 *
 * 顶栏的表格工具条与 `CellPanel` 是**兄弟组件**，够不到那两处闭包。B 批要在工具条上
 * 再给一套合并 / 拆分 / 边框线，如果不先提升，**顺手就会各写一份** —— 这个项目在
 * "同一个逻辑两处各写一套"上已经栽过三次。
 *
 * 所以这里把动作提成**纯函数**：输入 `TableElement` + 定位，输出 `Partial<TableElement>`
 * 的补丁，由调用方 `api.mergeElement(el.id, patch, mergeKey)` 写回。
 *
 * ## 两条硬约束
 *
 * 1. **本文件的运行时依赖只有 `src/lib/types.ts`、`./round.ts` 与 `./table-query.ts`**
 *    （后两者同样只依赖类型 / 纯函数）。它要能被 Node 直接加载 —— `__selftest.mts` 就是跑在 Node 下的；
 *    一旦这里 import 了 React / `.tsx`，Node 层就再也跑不起来。
 *    **不要**为了一个数据表去 import `./useEditorState`（1301 行 hooks 模块）。
 *    `findCell` / `updateCell` 走 `./table-query`：一份实现，两个调用方（本文件与 `useEditorState`），
 *    而不是各自扫一遍 `rows`。
 *    `round1` 走 `./round`：收口前项目里有 5 份副本、且不是同一种行为，详见 `round.ts` 的文件头。
 *
 * 2. **确认层在动作里，不在调用方**。合并会**整个丢掉**被并进来的那个单元格
 *    （连同它的字段绑定），拆分补回来的是空单元格 —— 这是修过的真实数据丢失缺陷。
 *    `applyMergeRight` / `applyMergeDown` 强制接收一个 `decide` 回调：
 *    被丢弃的单元格非空时**必须**先问过它，返回 false 就整体不产生补丁。
 *
 *    这样"工具条绕过确认层"在结构上就做不到 —— 不是靠调用方自觉。
 */

import {
  finite,
  newId,
  type InlineNode,
  type SysVarKey,
  type AnyElement,
  type CellBorders,
  type TableBorderStyle,
  type TableCell,
  type TableElement,
  type TableRow,
  type TextStyle,
} from '../../lib/types'
import { round1 } from './round'
import { findCell, updateCell } from './table-query'

/**
 * 这一层要写回的补丁。
 *
 * 刻意不是 `TableElement`：动作只该改它自己那几项，写成整个元素会把调用方
 * 手里那份可能已经过期的 `element` 整个盖上去（把别人刚改的字段冲掉）。
 */
export interface TableActionResult {
  patch: Partial<TableElement>
  /** 动作结束后建议选中的单元格（合并后是留下的那一格）；undefined = 保持当前选中 */
  nextCellId?: string
}

/** 一次动作的"要不要做"决策：`discarded` 非空时被调用；返回 false = 取消 */
export type MergeDecision = (discarded: DiscardedPart[]) => boolean

/**
 * 被合并**丢掉**的那个单元格里有什么。
 *
 * 刻意返回**结构**而不是中文串（原实现返回 `['字段「产品名称」']` 这种给人看的串）：
 *   - 断言中文串等于断言文案，改一个字测试就红，而那**不是行为**；
 *   - 拼中文字面量要用 `SYSVAR_LABEL`，那会把 1301 行的 hooks 模块拖进 Node 套件。
 *
 * 所以：**"丢了什么"是结构（这里），"怎么说"是文案（`discardedPartsText`）**，各有一条断言守着。
 */
export type DiscardedPart =
  /** `fieldName` 为 null = 未绑定字段的占位符（打印时会输出空白，更要拦） */
  | { kind: 'field'; fieldName: string | null }
  | { kind: 'sysvar'; key: SysVarKey }
  | { kind: 'text'; text: string }
  /**
   * 多出来的**图片单元格**（2026-09-22 加）。
   *
   * 一格只装得下一个 `attachment`（它的打印配置是单份的）⇒ 矩形选区合并时，
   * 除锚点那格以外的图片会被丢掉。文本可以按换行拼进去、图片不行 —— 所以它是
   * "合并保留文本"之后**唯一仍然会丢东西**的一类，必须能进确认层。
   */
  | { kind: 'attachment'; count: number }

/**
 * 只算"有内容"的节点：空白单元格被并掉是正常操作，拦下来只会变成无谓的摩擦。
 * 字段占位符是最贵的一种内容 —— 用户得重新找字段、重新配一遍。
 */
export function discardedPartsOf(cell: TableCell): DiscardedPart[] {
  const out: DiscardedPart[] = []
  for (const n of cell.nodes) {
    if (n.type === 'field') out.push({ kind: 'field', fieldName: n.fieldName ? n.fieldName : null })
    else if (n.type === 'sysvar') out.push({ kind: 'sysvar', key: n.key })
    else if (n.type === 'text' && n.text.trim() !== '') out.push({ kind: 'text', text: n.text.trim() })
  }
  return out
}

/** 结构里是不是"有东西"（决定要不要弹确认） */
export function hasDiscardedContent(parts: DiscardedPart[]): boolean {
  return parts.length > 0
}

/**
 * 结构 → 用户看到的那句话。
 *
 * **文案与以前逐字一致**（用户已经看过那句话，改措辞就是行为变化、不是重构）：
 *   `字段「产品名称」` / `一个未绑定的字段占位符` / `「页码」` / `「合计」`
 *   超过 3 项时只列前 3 项 + `等 N 处内容`。
 *
 * 系统变量的标签由调用方注入（浏览器侧传 `SYSVAR_LABEL`），
 * 所以本文件仍然不需要知道标签表长什么样、也不必 import 它。
 */
export function discardedPartsText(parts: DiscardedPart[], sysvarLabel: (key: SysVarKey) => string): string[] {
  const out = parts.map((p) => {
    if (p.kind === 'field') return p.fieldName ? `字段「${p.fieldName}」` : '一个未绑定的字段占位符'
    if (p.kind === 'sysvar') return `「${sysvarLabel(p.key)}」`
    if (p.kind === 'attachment') return `${p.count} 个图片单元格`
    return `「${p.text}」`
  })
  // 一格堆了太多东西时只列前三个，剩下的用数量带过 —— 提示要说人话，不是把内容倒出来
  if (out.length > 3) return [...out.slice(0, 3), `等 ${out.length} 处内容`]
  return out
}

// ============================================================
// 基础
// ============================================================

/** 空白单元格（增列 / 拆分会用到）。整表面板与单元格面板共用同一份形状 */
export function emptyCell(): TableCell {
  return { id: newId('cell'), colspan: 1, rowspan: 1, nodes: [] }
}

/**
 * 深拷贝到"可以就地改"的层级。
 *
 * 只拷 `rows` / `cells` 两层：行内 `nodes` 是只读的（合并只搬 `colspan` / `rowspan`，
 * 不动节点），深拷它会白白重建一堆对象，还让 `nodes` 的引用相等性失效
 * （Canvas 与 Inspector 都靠引用相等判断"这一格没变"）。
 */
function cloneRows(rows: TableRow[]): TableRow[] {
  return rows.map((r) => ({ ...r, cells: r.cells.map((c) => ({ ...c })) }))
}

function cols(el: TableElement): number {
  return el.colWidthsMm.length
}

// ============================================================
// 合并 / 拆分
// ============================================================

/**
 * 右合并。`decide` 只在**被并掉的那一格非空**时被调用；它返回 false 就整体不产生补丁。
 *
 * 为什么必须经过 `decide`：合并丢弃的 `nodes` 是不可恢复的（拆分补的是空单元格）。
 * 把这一步做进动作里，工具条与面板就不可能各自决定"要不要问用户"。
 */
export function applyMergeRight(el: TableElement, cellId: string, decide: MergeDecision): TableActionResult | null {
  const loc = findCell(el.rows, cellId)
  if (!loc) return null
  const rows = cloneRows(el.rows)
  const row = rows[loc.rowIdx]
  const a = row?.cells[loc.colIdx]
  const b = row?.cells[loc.colIdx + 1]
  if (!row || !a || !b) return null
  const parts = discardedPartsOf(b)
  // ⚠️ 只在**真的会丢东西**时才问 `decide`。
  // "空单元格合并不弹确认"是原实现的行为（不给无谓摩擦），把它做成动作层的结构性保证，
  // 而不是指望每个调用方都记得"空的时候点确认要返回 true"。
  if (hasDiscardedContent(parts) && !decide(parts)) return null
  row.cells.splice(loc.colIdx, 2, { ...a, colspan: Math.max(1, a.colspan) + Math.max(1, b.colspan) })
  return { patch: { rows }, nextCellId: a.id }
}

/** 下合并。与 `applyMergeRight` 同一套确认口径 */
export function applyMergeDown(el: TableElement, cellId: string, decide: MergeDecision): TableActionResult | null {
  const loc = findCell(el.rows, cellId)
  if (!loc) return null
  const rows = cloneRows(el.rows)
  const a = rows[loc.rowIdx]?.cells[loc.colIdx]
  const b = rows[loc.rowIdx + 1]?.cells[loc.colIdx]
  if (!a || !b) return null
  const parts = discardedPartsOf(b)
  if (hasDiscardedContent(parts) && !decide(parts)) return null
  a.rowspan = Math.max(1, a.rowspan) + Math.max(1, b.rowspan)
  rows[loc.rowIdx + 1].cells.splice(loc.colIdx, 1)
  // 下合并后留下的还是原来那一格，选中不需要变 —— 与原实现一致
  return { patch: { rows } }
}

/** 拆分能不能点（跨列 / 跨行任一 > 1） */
export function canSplitCell(el: TableElement, cellId: string): boolean {
  const loc = findCell(el.rows, cellId)
  if (!loc) return false
  return Math.max(1, finite(loc.cell.colspan, 1)) > 1 || Math.max(1, finite(loc.cell.rowspan, 1)) > 1
}

/**
 * 拆分。补回来的是**空单元格** —— 这就是合并会丢内容的原因，也是确认层存在的理由。
 */
export function applySplitCell(el: TableElement, cellId: string): TableActionResult | null {
  const loc = findCell(el.rows, cellId)
  if (!loc) return null
  const rows = cloneRows(el.rows)
  const c = rows[loc.rowIdx]?.cells[loc.colIdx]
  if (!c) return null
  const extraCols = Math.max(0, finite(c.colspan, 1) - 1)
  const extraRows = Math.max(0, finite(c.rowspan, 1) - 1)
  c.colspan = 1
  c.rowspan = 1
  for (let k = 1; k <= extraCols; k += 1) rows[loc.rowIdx].cells.splice(loc.colIdx + k, 0, emptyCell())
  for (let r = 1; r <= extraRows; r += 1) {
    const target = rows[loc.rowIdx + r]
    if (!target) break
    for (let k = 0; k <= extraCols; k += 1) target.cells.splice(loc.colIdx + k, 0, emptyCell())
  }
  return { patch: { rows } }
}

// ============================================================
// 列宽 / 行高
// ============================================================

/** 拖列边框或改列宽输入框：列宽数组与元素总宽**必须同步**（类型注释里的约束，见 E-45） */
export function setColWidthPatch(el: TableElement, colIdx: number, mm: number): Partial<TableElement> | null {
  if (colIdx < 0 || colIdx >= el.colWidthsMm.length) return null
  const next = [...el.colWidthsMm]
  next[colIdx] = mm
  return { colWidthsMm: next, w: round1(next.reduce((a, b) => a + b, 0)) }
}

/**
 * 拖**元素外框**改总宽时：按比例缩放列宽，保住「Σ 列宽 === 元素 `w`」这个不变量。
 *
 * 背景（2026-09-18 飞书真机反馈）：元素 resize 过去**只写 `w`、不同步 `colWidthsMm`**
 * —— 唯一保持二者同步的是列宽专用路径 `setColWidthPatch`。
 * 而画布把列宽写成**绝对 mm** 并配 `table-layout: fixed`，按 CSS 定宽表格算法
 * `used width = max(W, Σ列宽)` ⇒ **把蓝框缩窄，表格纹丝不动**。
 * 用户原话："把蓝色选区的宽高都缩小，发现蓝色区域是缩小了，但实际的原表格还保持不变，
 * 这个蓝色选区和实际的表格压根就不是一体的一样。"
 *
 * 打印侧本来就会按 `w` 压缩列宽（`render/html.ts` 的 `table-compressed`）⇒
 * 这条修完，画布与打印的口径也一致了。
 *
 * @param newWMm 元素的新总宽（mm）
 */
export function scaleColWidths(el: TableElement, newWMm: number): Partial<TableElement> {
  const target = Math.max(1, round1(newWMm))
  const cur = el.colWidthsMm.map((c) => Math.max(0, c))
  const sum = cur.reduce((a, b) => a + b, 0)
  if (cur.length === 0 || sum <= 0) return { w: target }
  const scaled = cur.map((c) => round1((c / sum) * target))
  // 尾列吸收取整误差：否则 Σ 会比 target 差 0.1mm 量级，越拖越偏
  const acc = scaled.reduce((a, b) => a + b, 0)
  scaled[scaled.length - 1] = round1(scaled[scaled.length - 1] + (target - acc))
  return { w: round1(scaled.reduce((a, b) => a + b, 0)), colWidthsMm: scaled }
}

/**
 * 第 `i` 条**列边界**在表格总宽里的占比（0..1）。`i` = "这条边界左边那一列"的下标，
 * 也就是"第 `i` 列右沿"。
 *
 * 边界序列（含两端外沿）恒为 `[0, c₀, c₀+c₁, …, Σc] / Σc`：
 * 左外沿是 0（`i = -1`）、右外框是 1（`i = 列数-1`）。列表里只有第 `1..n` 条
 * —— **左外沿没有手柄**，与需求 ⑧「左外/上外不加手柄」同一口径。
 *
 * 内部竖线（`i = 0..n-2`）与最右边那条外框（`i = n-1`）共用这一份换算 ——
 * 两处各写一套的话，"拖外框"和"拖内部竖线"的落点迟早会分叉。
 *
 * ## 为什么分母是**列宽之和**，不是元素总宽 `el.w`
 *
 * 这两个量**必然**对不上，而且差得很有规律：上面 `setColWidthPatch` 写回的总宽是
 * `round1(列宽和)`（留一位小数），列宽数组自己则是两位小数。真实模板实测
 * `Σc = 150.14` 而 `el.w = 150.1`。
 *
 * 若拿 `el.w` 当分母，末边界会算成 `150.14 / 150.1 = 1.00027` —— **吃到 1 以上**，
 * 最后那根外框手柄被推到表格外一点点。那正是需求 ⑧ 要修的"竖线没落在格线上"的
 * 同一种毛病（只差半个像素，肉眼看着"偶发"）。
 *
 * 用列宽和当分母则：两端恒为 0 与 1，分数随列宽**单调**，且与 `el.w` 的取整无关。
 * 代价是"列宽和 ≠ 打印出来的实际总宽"这层信息在这里被忽略 —— 那是对的：
 * 几何误差归 `setColWidthPatch`（它负责让两者一致），这里只负责"按作者给的列宽分格子"。
 *
 * 列宽和不是正数（空数组 / 全 0 列宽）时用一个占位分母兜底，**不产生 NaN / Infinity**
 * —— 画布会把 NaN 写成 `NaN%` 的 left，那一整排手柄会静默消失。
 */
export function colEdgeFrac(colWidthsMm: readonly number[], i: number): number {
  const total = colWidthsMm.reduce((a, b) => a + b, 0) || 1
  let sum = 0
  for (let k = 0; k <= i && k < colWidthsMm.length; k += 1) sum += colWidthsMm[k]
  return sum / total
}

/**
 * 硬行高下限（mm）。**拖到这条线以下就写回 `undefined`（自适应），不是写这个值。**
 *
 * 写成"下限 6mm"是数据损失：那一行再也长不回去，内容会溢出。
 * `undefined` 才是 `TableRow.heightMm` 的第三态（见 `types.ts:355`），也是可逆的那一态。
 */
/**
 * 行高下限 = **24px**（用户规格 三："限制最小值：行高 ≥ 24px，列宽 ≥ 32px"）。
 *
 * 数值为什么是 mm：模型里行高列宽都存 mm（打印单位），而规格给的是**屏幕像素**。
 * 换算按 96dpi（CSS 标准）：24px = 24 ÷ 96 × 25.4 ≈ 6.35mm，取 6.4 留一点余量。
 * ⚠️ 改之前是 6mm（≈22.7px）—— 是一个"看着差不多"的手感值，不是任何规格要求的数。
 */
export const MIN_ROW_MM = 6.4

/**
 * 列宽下限 = **32px**（同上）≈ 8.47mm，取 8.5。
 *
 * ⚠️ 2026-09-22 之前这里是 4mm（≈15px），而且**同一个量在这个文件里还有第二个定义**
 *    （`MIN_COL_MM_TABLE`，我给 insertColAt 写的时候另开的一份）。
 *    两个常量描述同一件事 ⇒ 迟早一个改了另一个没改。现在只留这一个，画布也从这里 import。
 */
export const MIN_COL_MM = 8.5

/** 拖行边框。`mm === undefined` = 复位成自适应（双击行边框也走这里） */
export function setRowHeightPatch(el: TableElement, rowIdx: number, mm: number | undefined): Partial<TableElement> | null {
  const row = el.rows[rowIdx]
  if (!row) return null
  const rows = el.rows.map((r, i) => {
    if (i !== rowIdx) return r
    if (mm === undefined || mm < MIN_ROW_MM) {
      // 显式删掉这个键，而不是写 undefined —— JSON 序列化后两种写法不同，
      // 而"复位自适应"必须产出与从未设过行高的行**完全一样**的对象
      const { heightMm: _drop, ...rest } = r
      return rest as TableRow
    }
    return { ...r, heightMm: round1(mm) }
  })
  return { rows }
}

// ============================================================
// 行列增删
// ============================================================

export function addRowPatch(el: TableElement): TableActionResult {
  const n = cols(el)
  return { patch: { rows: [...el.rows, { id: newId('row'), cells: Array.from({ length: n }, emptyCell) }] } }
}

export function delRowPatch(el: TableElement): TableActionResult | null {
  if (el.rows.length <= 1) return null
  return { patch: { rows: el.rows.slice(0, -1) } }
}

/** 上限 12 列：与原实现一致（再多在 A4 版心里已经没法看了） */
export const MAX_COLS = 12

export function addColPatch(el: TableElement): TableActionResult | null {
  const n = cols(el)
  if (n >= MAX_COLS) return null
  /*
   * ⚠️ 真机反馈（2026-09-22）：「增加列会导致整个表格尺寸扩张，改为在**不改变表格整体尺寸**的
   *    前提下增加列」。原来新列拿一个平均列宽、`w` 跟着变大 ⇒ 表格变宽，用户排好的版式随即错位。
   * ⇒ 总宽守恒：老列按 `n/(n+1)` 等比缩、新列拿 `1/(n+1)`，Σ 恒等于原来的 `w`。
   *    `w` 刻意**不写进补丁** —— 它不该变（写个同值只会多一次无意义写入）。（加行不涉及宽度，保持现状。）
   */
  const total = finite(el.w, el.colWidthsMm.reduce((a, b) => a + b, 0))
  const share = total / (n + 1)
  const shrink = n / (n + 1)
  return {
    patch: {
      colWidthsMm: [...el.colWidthsMm.map((w) => round1(finite(w, share) * shrink)), round1(share)],
      rows: el.rows.map((r) => ({ ...r, cells: [...r.cells, emptyCell()] })),
    },
  }
}

export function delColPatch(el: TableElement): TableActionResult | null {
  const n = cols(el)
  if (n <= 1) return null
  const removed = el.colWidthsMm[n - 1] ?? 0
  return {
    patch: {
      colWidthsMm: el.colWidthsMm.slice(0, -1),
      // 下限 10mm：删列时元素可以变窄，但不该窄到负值 / 0（那样画布上就点不到了）
      w: round1(Math.max(10, finite(el.w, 100) - removed)),
      rows: el.rows.map((r) => ({ ...r, cells: r.cells.length > 1 ? r.cells.slice(0, -1) : r.cells })),
    },
  }
}

// ============================================================
// 行内节点（供单元格内容编辑复用；同样保持纯）
// ============================================================

/** 就地替换某一格的全部节点（走共享的 `updateCell`，不自己再写一遍 map） */
export function setCellNodesPatch(rows: TableRow[], cellId: string, nodes: InlineNode[]): Partial<TableElement> | null {
  const next = updateCell(rows, cellId, { nodes })
  // updateCell 找不到时原样返回同一个引用 —— 靠这条契约判断"点空了"
  return next === rows ? null : { rows: next }
}

// ============================================================
// 网格摊平 + 按位置插入 / 删除行列（2026-09-22，用户规格 一·二）
// ============================================================
//
// 用户原话："直接在表格上增删行列（不进属性面板）……**关键**：增删行列时：
// 已有的合并关系、单元格内挂的子元素、行高列宽数组都要**正确平移**，不能错位或丢失。"
//
// ── 为什么必须有这一节（而不是照抄既有实现）────────────────────────
// 既有的 `addRowPatch` / `addColPatch` / `delRowPatch` / `delColPatch` 只能**在末尾**
// 追加 / 删最后一行列 —— 它们是"整表结构"面板用的。真机上"在某一行下方插入"必须支持任意位置，
// 而任意位置 + 合并关系 = 一个**二维几何问题**，凭数组下标硬推一定会在合并处错位。
//
// 本表的合并是 **span 模型**（见 `applyMergeRight/Down`）：
//   · 被合并覆盖的格子**不在数组里** —— 所以"第 i 行有 5 个 cells"不代表"第 i 行有 5 列"；
//   · 数组下标 ≠ 网格列号。⇒ 任何按列的操作都必须先摊平成网格。
// `tableGrid()` 就是那一步，且它是**只读**的：把 `(行, 列) → {cell, colStart, rowSpan…}` 算出来，
// 后面四个动作全部基于它，谁也不用再自己数列。

/** 网格里的一格：指向真实的单元格对象，外加它在网格中的位置 */
export interface GridCell {
  cell: TableCell
  /** 网格列起点（0-based） */
  colStart: number
  colSpan: number
  /** 网格行起点 */
  rowStart: number
  rowSpan: number
}

/**
 * 把 span 模型摊平成 `rows × cols` 的网格。
 *
 * `grid[r][c]` = 覆盖这一格的单元格（**同一个对象**会在它覆盖的每格出现 —— 靠引用相等判重）；
 * `null` = 这一格是空的、需要补一个 `emptyCell()`。
 *
 * ⚠️ 传入的 `rows` 决定了返回的 `cell` 引用：**要就地改就得传副本**
 *    （所以调用方一律 `cloneRows` 之后再摊平，否则会改到原始文档对象）。
 */
export function tableGrid(rows: readonly TableRow[], colCount: number): (GridCell | null)[][] {
  const n = Math.max(0, Math.floor(colCount))
  const grid: (GridCell | null)[][] = rows.map(() => Array.from({ length: n }, () => null))
  for (let r = 0; r < rows.length; r += 1) {
    let col = 0
    for (const cell of rows[r].cells) {
      // 跳过已经被**上方 rowspan** 占住的列
      while (col < n && grid[r][col]) col += 1
      if (col >= n) break
      const colSpan = Math.max(1, finite(cell.colspan, 1))
      const rowSpan = Math.max(1, finite(cell.rowspan, 1))
      const gc: GridCell = { cell, colStart: col, colSpan, rowStart: r, rowSpan }
      for (let rr = r; rr < Math.min(rows.length, r + rowSpan); rr += 1) {
        for (let k = 0; k < colSpan && col + k < n; k += 1) grid[rr][col + k] = gc
      }
      col += colSpan
    }
  }
  return grid
}

/** 某一行里"从这一行开始"的格子（按数组顺序），带它们的网格列起点 */
function rowEntries(grid: (GridCell | null)[][], rowIdx: number, colCount: number): GridCell[] {
  const out: GridCell[] = []
  const seen = new Set<string>()
  const row = grid[rowIdx] ?? []
  for (let c = 0; c < colCount; c += 1) {
    const g = row[c]
    if (!g || g.rowStart !== rowIdx || seen.has(g.cell.id)) continue
    seen.add(g.cell.id)
    out.push(g)
  }
  return out
}

/**
 * 某一格在纸上的**实际宽度**（mm）—— 合并单元格取跨列之和，找不到就退回整表宽。
 *
 * 为什么要有它（而不是各处自己 `colWidthsMm[colIdx]`）：
 * "这一格多宽"是**百分比 ↔ mm 换算的基准**（格内子元素的 `w` 是占格宽百分比，
 * 见 types.ts 第 ④ 条），至少有三处要用：取出到画布（EditorShell）、复制格内元素（useEditorState）、
 * 以及以后任何"把格内东西换算到纸上"的动作。`colWidthsMm[colIdx]` 那种写法在**合并单元格**
 * 上是错的（数组下标 ≠ 网格列号），而错的方式是"尺寸差一点"，不会报错。
 */
export function cellWidthMm(el: TableElement, cellId: string): number {
  const loc = findCell(el.rows, cellId)
  if (!loc) return finite(el.w, 0)
  const grid = tableGrid(el.rows, el.colWidthsMm.length)[loc.rowIdx] ?? []
  const g = grid.find((x) => x?.cell.id === cellId)
  if (!g) return finite(el.w, 0)
  const span = Math.max(1, finite(g.colSpan, 1))
  const sum = el.colWidthsMm
    .slice(g.colStart, g.colStart + span)
    .reduce((a, b) => a + finite(b, 0), 0)
  // 列宽数组缺失/全是 0 时别返回 0（那会让调用方算出 0 宽的元素）—— 退回整表宽
  return sum > 0 ? sum : finite(el.w, 0)
}

/** 表格行列的下限：至少要留一行一列（否则表格就不存在了） */
export const MIN_TABLE_ROWS = 1
export const MIN_TABLE_COLS = 1

/**
 * 表格**行数上限**。
 *
 * 原来这个 200 是写死在 `resizeTableTo` 里的字面量，而新写的「拆分单元格」也要用同一个上限
 * ⇒ 提成常量，免得两处各写一个数、哪天只改一处（列那边本来就有 `MAX_COLS`）。
 * 200 行是"画布上还能用"的经验上限（一行按 6mm 算，200 行 = 1.2m 长的纸）。
 */
export const MAX_TABLE_ROWS = 200

/**
 * 「拆分单元格」一次最多拆成几行。
 *
 * 与 `MAX_TABLE_ROWS` 分开：那是"整表能有多长"，这是"一根格子里切几块"。
 * 用户在弹窗里手输，给 20 是够用且不会被手滑成 200 的档位（列数沿用 `MAX_COLS`）。
 */
export const MAX_SPLIT_ROWS = 20

/**
 * 在 `rowIdx` 的**上方 / 下方**插入一行。
 *
 * 平移规则（两条，缺一个就会错位）：
 *   ① 跨过插入线的竖向合并 ⇒ `rowspan + 1`（它现在多盖一行）；
 *   ② 新行**只补没被那些合并盖住的列** —— 盖住的槽位在 span 模型里本来就该"没有格子"，
 *      补了会变成"合并区域里多出一格"，渲染时表现为表格被撑歪。
 */
export function insertRowAt(el: TableElement, rowIdx: number, where: 'above' | 'below'): TableActionResult | null {
  const colCount = cols(el)
  if (colCount <= 0) return null
  const at = where === 'above' ? rowIdx : rowIdx + 1
  if (!Number.isFinite(at) || at < 0 || at > el.rows.length) return null

  const rows = cloneRows(el.rows)
  const grid = tableGrid(rows, colCount)

  // ① 跨线的竖向合并加一行
  for (let r = 0; r < at; r += 1) {
    for (const cell of rows[r].cells) {
      const rs = Math.max(1, finite(cell.rowspan, 1))
      if (r + rs > at) cell.rowspan = rs + 1
    }
  }

  // ② 新行：只给"没被跨线合并覆盖"的列补空格
  const covered = new Set<number>()
  for (let c = 0; c < colCount; c += 1) {
    const g = grid[at - 1]?.[c] ?? null
    if (g && g.rowStart + g.rowSpan > at) covered.add(c)
  }
  const newRow: TableRow = { id: newId('row'), cells: [] }
  for (let c = 0; c < colCount; c += 1) if (!covered.has(c)) newRow.cells.push(emptyCell())
  rows.splice(at, 0, newRow)
  return { patch: { rows }, nextCellId: newRow.cells[0]?.id }
}

/**
 * 在 `colIdx` 的**左侧 / 右侧**插入一列。
 *
 * 平移规则：
 *   ① 跨过插入线的横向合并 ⇒ `colspan + 1`；
 *   ② 其余行**补一个空单元格**，插入位置 = 该行里第一个"列起点 ≥ 插入位"的格子之前；
 *      跨线合并那一行**不补**（它自己变宽了）。
 *   ③ `colWidthsMm` 同步插入一列（取左邻列宽，缺省取 20mm），并按总和更新元素总宽 `w`
 *      —— 这是 `setColWidthPatch` 那条不变量的延续：**Σ列宽 === w**。
 */
export function insertColAt(el: TableElement, colIdx: number, where: 'left' | 'right'): TableActionResult | null {
  const colCount = cols(el)
  if (colCount <= 0) return null
  const at = where === 'left' ? colIdx : colIdx + 1
  if (!Number.isFinite(at) || at < 0 || at > colCount) return null

  const rows = cloneRows(el.rows)
  const grid = tableGrid(rows, colCount)

  for (let r = 0; r < rows.length; r += 1) {
    const entries = rowEntries(grid, r, colCount)
    // ① 本行里跨线的格子变宽；它覆盖了插入位 ⇒ 本行不再补空格
    let covered = false
    for (const g of entries) {
      if (g.colStart < at && g.colStart + g.colSpan > at) {
        g.cell.colspan = Math.max(1, finite(g.cell.colspan, 1)) + 1
        covered = true
      }
    }
    if (covered) continue
    /*
     * ② 还没被"从上方延伸下来的 rowspan"盖住才补。
     *    判据用摊平后的网格：插入位的左右两格任意一个属于"上面那行开始的合并" ⇒ 该槽被占。
     */
    const leftOfPos = at > 0 ? (grid[r]?.[at - 1] ?? null) : null
    const atPos = grid[r]?.[at] ?? null
    const fromAbove =
      (leftOfPos && leftOfPos.rowStart < r && leftOfPos.colStart + leftOfPos.colSpan > at) ||
      (atPos && atPos.rowStart < r && atPos.colStart < at)
    if (fromAbove) continue
    const idx = entries.findIndex((e) => e.colStart >= at)
    const insertAt = idx === -1 ? rows[r].cells.length : idx
    /*
     * 新格**继承左邻格的样式**（2026-09-23 真机反馈第 4 条：「新增加的列不会继承同行的标题行效果」）。
     *
     * 不继承的话：在标题行上插入一列，那一行的新格子是**白底普通字**，与同行的标题格明显不一致；
     * 用户得再手动设一遍（而这个"再设一遍"没有任何提示，很容易漏）。
     * 取左邻格而不是右邻格：插入点右边的格可能是被合并块盖住的位置，左边一定存在。
     */
    const neighbour = rows[r].cells[Math.max(0, insertAt - 1)]
    const freshCell = emptyCell()
    if (neighbour?.style) freshCell.style = { ...neighbour.style }
    rows[r].cells.splice(insertAt, 0, freshCell)
  }

  const widths = [...el.colWidthsMm]
  const w = where === 'left' ? (widths[Math.max(0, at - 1)] ?? 20) : (widths[at] ?? widths[widths.length - 1] ?? 20)
  widths.splice(at, 0, round1(Math.max(MIN_COL_MM, finite(w, 20))))
  /*
   * ⚠️ **总宽守恒**（真机反馈 2026-09-23 第 6 条）：「编辑单元格后，插入新列，整个表格会被横向扩张，
   *    改为插入列后**不改变原表格大小**，在此基础插入列」。
   *
   * 新列先按邻列宽度占位，再把**所有列等比缩回原来的总宽**：表格外框一动不动，
   * 只是每列窄了一点 —— 这才是"在原尺寸里塞进一列"。不这么做的话 `w` 会跟着变大，
   * 用户排好的版式立刻错位（表格还会盖住右边的元素）。
   *
   * 口径与 `addColPatch`（末尾加列）**完全一致**：两条路都插列，宽度语义必须一样。
   * 缩放**复用 `scaleColWidths`**，不在本函数里再写一遍等比 + 取整 ——
   * 那个函数还负责"把取整误差让尾列吸收"，少了这一步 `Σ列宽 === w` 这条不变量会因
   * 浮点尾差（119.99999999999999 ≠ 120）被判红（第一版就是这么红的）。
   * 只加行不涉及宽度，保持原样。
   */
  const origTotal = el.colWidthsMm.reduce((a, b) => a + finite(b, 0), 0)
  const scaled = scaleColWidths({ ...el, colWidthsMm: widths }, origTotal > 0 ? origTotal : finite(el.w, 100))
  return { patch: { rows, colWidthsMm: scaled.colWidthsMm ?? widths, w: scaled.w ?? round1(finite(el.w, 100)) } }
}

/**
 * 删除第 `rowIdx` 行。
 *
 * 三条规则，按"数据会不会丢"分开处理：
 *   ① 上方跨进来的合并 ⇒ `rowspan - 1`；
 *   ② **从这一行开始**的纵向合并 ⇒ 内容不丢，整格下沉到下一行（`rowspan - 1`）；
 *   ③ 只属于这一行的格子（rowspan === 1 且不是②） ⇒ **丢弃**，丢弃前必须过 `decide`
 *      —— 与合并同一套口径：宁可弹一次确认，也不能静默删掉用户打的字。
 */
export function deleteRowAt(el: TableElement, rowIdx: number, decide: MergeDecision): TableActionResult | null {
  const colCount = cols(el)
  if (el.rows.length <= MIN_TABLE_ROWS) return null
  if (!Number.isFinite(rowIdx) || rowIdx < 0 || rowIdx >= el.rows.length) return null

  const rows = cloneRows(el.rows)
  const grid = tableGrid(rows, colCount)

  // ③ 先问：这一行里"只属于这一行"的格子会被丢掉
  const doomed: TableCell[] = []
  for (const g of rowEntries(grid, rowIdx, colCount)) {
    if (Math.max(1, finite(g.cell.rowspan, 1)) <= 1) doomed.push(g.cell)
  }
  const parts = doomed.flatMap((c) => discardedPartsOf(c))
  if (hasDiscardedContent(parts) && !decide(parts)) return null

  // ② 从这一行开始的纵向合并：下沉到下一行
  const movers = rowEntries(grid, rowIdx, colCount)
    .filter((g) => Math.max(1, finite(g.cell.rowspan, 1)) > 1)
    .map((g) => ({ cell: g.cell, colStart: g.colStart, rowSpan: Math.max(1, finite(g.cell.rowspan, 1)) }))

  // ① 上方跨进来的合并收缩
  for (let r = 0; r < rowIdx; r += 1) {
    for (const cell of rows[r].cells) {
      const rs = Math.max(1, finite(cell.rowspan, 1))
      if (r + rs > rowIdx) cell.rowspan = rs - 1
    }
  }

  rows.splice(rowIdx, 1)

  // ②（续）把下沉的格子放进新的第 rowIdx 行，位置按列起点排
  for (const m of movers) {
    const target = rows[rowIdx]
    if (!target) break
    m.cell.rowspan = m.rowSpan - 1
    const g = tableGrid(rows, colCount)
    const entries = rowEntries(g, rowIdx, colCount)
    const idx = entries.findIndex((e) => e.colStart > m.colStart)
    target.cells.splice(idx === -1 ? target.cells.length : idx, 0, m.cell)
  }

  return { patch: { rows } }
}

/**
 * 删除第 `colIdx` 列。
 *
 * 与删行对称：
 *   ① 跨线横向合并 ⇒ `colspan - 1`；
 *   ② 从这一列开始的横向合并 ⇒ `colspan - 1`（内容保留，位置自然左移一位）；
 *   ③ 只属于这一列的格子 ⇒ 丢弃（过 `decide`）；
 *   ④ `colWidthsMm` 同步删一列并更新 `w`。
 */
export function deleteColAt(el: TableElement, colIdx: number, decide: MergeDecision): TableActionResult | null {
  const colCount = cols(el)
  if (colCount <= MIN_TABLE_COLS) return null
  if (!Number.isFinite(colIdx) || colIdx < 0 || colIdx >= colCount) return null

  const rows = cloneRows(el.rows)
  const grid = tableGrid(rows, colCount)

  const doomed: TableCell[] = []
  for (let r = 0; r < rows.length; r += 1) {
    for (const g of rowEntries(grid, r, colCount)) {
      const span = Math.max(1, finite(g.cell.colspan, 1))
      if (g.colStart === colIdx && span <= 1 && Math.max(1, finite(g.cell.rowspan, 1)) <= 1) doomed.push(g.cell)
    }
  }
  const parts = doomed.flatMap((c) => discardedPartsOf(c))
  if (hasDiscardedContent(parts) && !decide(parts)) return null

  for (let r = 0; r < rows.length; r += 1) {
    for (const g of rowEntries(grid, r, colCount)) {
      const span = Math.max(1, finite(g.cell.colspan, 1))
      if (span <= 1) continue
      if (g.colStart < colIdx && g.colStart + span > colIdx) g.cell.colspan = span - 1
      else if (g.colStart === colIdx) g.cell.colspan = span - 1
    }
    rows[r].cells = rows[r].cells.filter((c) => !doomed.includes(c))
  }

  const widths = [...el.colWidthsMm]
  widths.splice(colIdx, 1)
  return { patch: { rows, colWidthsMm: widths, w: round1(widths.reduce((a, b) => a + b, 0)) } }
}

// ============================================================
// 矩形选区合并 / 拆分（2026-09-22，用户规格 四·核心）
// ============================================================
//
// 用户原话："在表格内按下鼠标并拖动，形成矩形多选区域……**合并单元格**：矩形选区合并为一个大单元格；
// 被合并单元格内的文本按换行拼接保留，图片等子元素保留首个并提示用户。"
//
// ── 三个必须先想清楚的点（不然一定出错）─────────────────────────────
//
// ① **选区的边界不能切进已有的合并块**。
//    用户框选时常见的是"从某个合并格中间划过去"。若按原始矩形合并，会把那个合并块**切开** ——
//    切出来的半块既不符合他点选的东西，也毁掉了原来的合并。所以先把矩形**扩张**到覆盖所有被碰到的格。
//
// ② **扩张之后，覆盖集未必还是矩形**。
//    例：一个 2×1 的横合并格 + 它右下角一个独立格 —— 框选到横合并格的右半 + 独立格，
//    扩张后覆盖集是"上排两格 + 下排一格"，不是矩形。这时**拒绝合并并说明原因**，
//    而不是硬合并成一个奇怪的结果（本项目一贯口径：宁可说"不行"，不要产出怪东西）。
//
// ③ **文本按换行拼接**，但附件/子元素这类**装不进一格**的东西只能保留第一个，
//    并且必须走 `decide` 让用户知情 —— 与 `applyMergeRight/Down` 同一套确认口径。

/** 网格坐标（0-based，含两端） */
export interface CellRange {
  r1: number
  c1: number
  r2: number
  c2: number
}

/** 把两个角点归一成"左上 / 右下"（用户可能从右下往左上拖） */
export function normalizeRange(a: { r: number; c: number }, b: { r: number; c: number }): CellRange {
  return {
    r1: Math.min(a.r, b.r),
    c1: Math.min(a.c, b.c),
    r2: Math.max(a.r, b.r),
    c2: Math.max(a.c, b.c),
  }
}

/** 选区内覆盖了几格（按网格算，不是按数组长度） */
export function rangeArea(range: CellRange): number {
  return (range.r2 - range.r1 + 1) * (range.c2 - range.c1 + 1)
}

/**
 * 把矩形扩张到"不切开任何已有合并块"。
 *
 * 反复扩张直到稳定：一个合并块被碰到 ⇒ 它的完整范围并进来 ⇒ 可能又碰到别的块。
 * （实际表格里这种连锁很少超过两轮，但循环写到稳定为止才是对的 —— 写"扩张一次"是能过大多数用例、
 *   在个别布局下静默出错的写法。）
 */
export function expandRangeToWholeCells(
  rows: readonly TableRow[],
  colCount: number,
  range: CellRange,
): CellRange {
  const grid = tableGrid(rows, colCount)
  let cur = { ...range }
  for (let guard = 0; guard < 64; guard += 1) {
    let changed = false
    for (let r = cur.r1; r <= cur.r2 && r < rows.length; r += 1) {
      for (let c = cur.c1; c <= cur.c2 && c < colCount; c += 1) {
        const g = grid[r]?.[c]
        if (!g) continue
        const gr2 = Math.min(rows.length - 1, g.rowStart + g.rowSpan - 1)
        const gc2 = Math.min(colCount - 1, g.colStart + g.colSpan - 1)
        if (g.rowStart < cur.r1 || g.colStart < cur.c1 || gr2 > cur.r2 || gc2 > cur.c2) {
          cur = {
            r1: Math.min(cur.r1, g.rowStart),
            c1: Math.min(cur.c1, g.colStart),
            r2: Math.max(cur.r2, gr2),
            c2: Math.max(cur.c2, gc2),
          }
          changed = true
        }
      }
    }
    if (!changed) break
  }
  return cur
}

/**
 * 扩张后的覆盖集**是不是一个矩形**。
 * 不是的话合并的语义就说不清（用户框出来的是 L 形），必须拒绝。
 */
export function rangeIsRectangular(rows: readonly TableRow[], colCount: number, range: CellRange): boolean {
  const grid = tableGrid(rows, colCount)
  const want = new Set<string>()
  for (let r = range.r1; r <= range.r2; r += 1) for (let c = range.c1; c <= range.c2; c += 1) want.add(`${r},${c}`)

  // 选区内碰到的每个合并块，它的**完整覆盖**必须都落在选区里
  const seen = new Set<string>()
  for (const key of want) {
    const [r, c] = key.split(',').map(Number)
    const g = grid[r]?.[c]
    if (!g || seen.has(g.cell.id)) continue
    seen.add(g.cell.id)
    for (let rr = g.rowStart; rr < g.rowStart + g.rowSpan && rr < rows.length; rr += 1) {
      for (let cc = g.colStart; cc < g.colStart + g.colSpan && cc < colCount; cc += 1) {
        if (!want.has(`${rr},${cc}`)) return false
      }
    }
  }
  return true
}

/** 把一个单元格的 nodes 收成"一段文本"的行内节点（合并时按换行拼接用） */
function nodesAsLine(cell: TableCell): InlineNode[] {
  return cell.nodes.length > 0 ? cell.nodes : []
}

/**
 * 矩形选区 → 一个合并格。
 *
 * 保留**左上角那一格**（它的 id 不变 ⇒ 后续"选中/编辑"的锚点稳定），其余格：
 *   · 文本 / 字段 / 系统变量 ⇒ 依次拼到左上角那格后面，**格子之间插一个换行**（规格 四 原话）；
 *   · 附件配置等"一格只能留一个"的东西 ⇒ 保留第一个，其余进 `decide` 让用户确认（与合并同口径）；
 *   · 新格的 `colspan/rowspan` = 选区尺寸。
 *
 * 返回 `null` 的情况都表示"这一下不该发生"：范围非法、不是矩形、或用户取消了确认。
 */
export function mergeRange(
  el: TableElement,
  rawRange: CellRange,
  decide: MergeDecision,
): TableActionResult | null {
  const colCount = cols(el)
  if (colCount <= 0 || el.rows.length === 0) return null
  if (rawRange.r1 > rawRange.r2 || rawRange.c1 > rawRange.c2) return null
  if (rangeArea(rawRange) < 2) return null
  if (rawRange.r1 < 0 || rawRange.c1 < 0 || rawRange.r2 >= el.rows.length || rawRange.c2 >= colCount) return null

  const range = expandRangeToWholeCells(el.rows, colCount, rawRange)
  if (!rangeIsRectangular(el.rows, colCount, range)) return null

  const grid = tableGrid(el.rows, colCount)
  const anchor = grid[range.r1]?.[range.c1]
  if (!anchor) return null

  const rows = cloneRows(el.rows)
  // 选区内、**不是**锚点那一格的单元格（按 id 去重，因为一个合并块会在多格出现）
  const others: TableCell[] = []
  const seen = new Set<string>([anchor.cell.id])
  for (let r = range.r1; r <= range.r2; r += 1) {
    for (let c = range.c1; c <= range.c2; c += 1) {
      const g = grid[r]?.[c]
      if (!g || seen.has(g.cell.id)) continue
      seen.add(g.cell.id)
      others.push(g.cell)
    }
  }
  if (others.length === 0) return null

  /*
   * ⚠️ **文本不进 `parts`**：规格明说"被合并单元格内的文本按换行拼接保留" ⇒ 它没有丢，
   * 丢掉的是**多出来的图片单元格**（一格只装得下一个 `attachment`，锚点那格自己的留下）。
   * 把保留的东西也报成"会丢弃"，用户会为了不存在的事点一次确认。
   */
  const attachments = others.filter((c) => c.attachment).length
  const parts: DiscardedPart[] = attachments > 0 ? [{ kind: 'attachment', count: attachments }] : []
  if (hasDiscardedContent(parts) && !decide(parts)) return null

  // 锚点格：尺寸变成选区大小 + 文本按换行拼接
  const target = rows[range.r1].cells.find((c) => c.id === anchor.cell.id)
  if (!target) return null
  const merged: InlineNode[] = [...nodesAsLine(target)]
  for (const c of others) {
    const line = nodesAsLine(c)
    if (line.length === 0) continue
    if (merged.length > 0) merged.push({ type: 'br' })
    merged.push(...line)
  }
  target.colspan = range.c2 - range.c1 + 1
  target.rowspan = range.r2 - range.r1 + 1
  target.nodes = merged

  // 其余格的 id 全部从数组里摘掉（span 模型：被覆盖的格子不该留在数组里）
  const dropIds = new Set(others.map((c) => c.id))
  const nextRows = rows.map((row, r) => {
    if (r < range.r1 || r > range.r2) return row
    return { ...row, cells: row.cells.filter((c) => !dropIds.has(c.id)) }
  })

  return { patch: { rows: nextRows }, nextCellId: target.id }
}

// ============================================================
// 选区样式（2026-09-22，用户规格 四：浮动工具条上的对齐 / 加粗 / 底纹 / 表头行）
// ============================================================

/**
 * 列出选区里**真正要改的单元格**（按 id 去重）。
 *
 * 为什么不去重不行：一个合并块会在它覆盖的每个网格位置出现 ⇒ 不去重就会对同一格写同一份 patch 好几次
 * （结果一样，但每次都会新建对象、破坏 `nodes`/`style` 的引用相等性，画布那边靠它判断"这格没变"）。
 */
export function rangeCells(el: TableElement, rawRange: CellRange): TableCell[] {
  const colCount = cols(el)
  if (colCount <= 0) return []
  const range = expandRangeToWholeCells(el.rows, colCount, rawRange)
  const grid = tableGrid(el.rows, colCount)
  const out: TableCell[] = []
  const seen = new Set<string>()
  for (let r = range.r1; r <= range.r2 && r < el.rows.length; r += 1) {
    for (let c = range.c1; c <= range.c2 && c < colCount; c += 1) {
      const g = grid[r]?.[c]
      if (!g || seen.has(g.cell.id)) continue
      seen.add(g.cell.id)
      out.push(g.cell)
    }
  }
  return out
}

/**
 * 给选区批量套一层样式（对齐 / 加粗 / 底纹 / 垂直对齐 / 字色 / 行高）。
 *
 * ⚠️ `style` 是**合并**而不是替换：`{...cell.style, ...patch}` —— 直接替换会把这一格原有的
 *    字体/字号一起抹掉，用户点一下"居中"发现字全变回去了。
 * ⚠️ `undefined` 值要**能清掉**原来的设置（比如取消加粗）：所以调用方传 `{bold: undefined}`
 *    时这一项会变成显式 undefined，而 `TextStyle` 的语义正是"undefined = 用默认"。
 */
export function patchRangeStyle(
  el: TableElement,
  rawRange: CellRange,
  patch: Partial<TextStyle>,
): TableActionResult | null {
  const targets = new Set(rangeCells(el, rawRange).map((c) => c.id))
  if (targets.size === 0) return null
  const rows = cloneRows(el.rows).map((row) => ({
    ...row,
    cells: row.cells.map((c) => (targets.has(c.id) ? { ...c, style: { ...c.style, ...patch } } : c)),
  }))
  return { patch: { rows } }
}

/**
 * 把选区内涉及的行**设为 / 取消表头行**（规格 五：整行加粗 + 居中 + 底纹，打印跨页重复）。
 *
 * 语义取"全部已是表头 ⇒ 取消，否则设为表头"（与右键菜单那一项同口径）——
 * 混合状态下一律"设为"，因为用户点它的意图通常是"我要这几行当表头"。
 */
export function setHeaderRowsPatch(el: TableElement, rawRange: CellRange, on: boolean): TableActionResult | null {
  const r = setHeaderStylePatch(el, rawRange, on)
  if (!r) return null
  const colCount = cols(el)
  const range = expandRangeToWholeCells(el.rows, colCount, rawRange)
  /* 行还多两件事：`isHeader` 标记 + 打开"跨页重复" —— 打印层读的就是这两个 */
  let rows = (r.patch.rows as TableRow[]).map((row, i) =>
    i < range.r1 || i > range.r2 ? row : { ...row, isHeader: on },
  )
  /*
   * ⚠️ 取消标题行时**角格要留着**（第 1 行第 1 列）：它同属标题列，列还勾着的时候
   *    把它清成普通格，用户看到的就是"标题列还在、但左上角那格掉队了"
   *    （真机反馈 2026-09-23 第 5 条）。
   */
  if (!on && el.headerCol === true) {
    rows = rows.map((row, i) =>
      i !== 0
        ? row
        : {
            ...row,
            cells: row.cells.map((c, ci) =>
              ci !== 0
                ? c
                : { ...c, style: { ...c.style, bold: true, align: 'center' as const, background: c.style?.background ?? '#f2f3f5' } },
            ),
          },
    )
  }
  return { patch: { ...r.patch, rows, repeatHeader: on ? true : el.repeatHeader } }
}

/**
 * 这一格是不是**标题格**（2026-09-23 真机反馈第 9 条：标题行 / 标题列里**不允许插入字段**）。
 *
 * 判据分两半，各有出处：
 *   · **行** —— `row.isHeader`（结构位；打印层也读它，用于"跨页重复表头"）；
 *   · **列** —— `el.headerCol` + **这一格确实落在第一网格列**。
 *
 * ⚠️ 列这一半原来靠**样式**反推，2026-09-23 改掉了：角格（第 1 行第 1 列）同属行与列，
 *    用样式反推会让"只勾了标题行"被读成"标题列也开着"。位标记与样式各管一件事
 *    （见 types.ts 的 `TableElement.headerCol`）。
 */
export function isHeaderCellAt(el: TableElement, cellId: string): boolean {
  const grid = tableGrid(el.rows, cols(el))
  for (let r = 0; r < el.rows.length; r += 1) {
    const g = (grid[r] ?? []).find((x) => x?.cell.id === cellId)
    if (!g) continue
    if (el.rows[r]?.isHeader === true) return true
    return el.headerCol === true && g.colStart === 0
  }
  return false
}

/** 第一列是不是标题列（面板里的开关读它）。**判据只有 `headerCol` 这一位**，不再看样式 */
export function isFirstColHeaderStyled(el: TableElement): boolean {
  return el.headerCol === true
}

/**
 * 「设置标题列」：改第一列的标题样式 + 记下 `headerCol` 这一位。
 *
 * ⚠️ 取消时**不能动角格**（第 1 行第 1 列）：它同属标题行，行还勾着的时候把它清成普通格
 * 正是真机反馈第 5 条那句「取消设置标题列，那么第一行第一个单元格就会变成普通单元格，
 * 但这个单元格是行和列共有的」。
 */
export function setHeaderColPatch(el: TableElement, on: boolean): TableActionResult | null {
  const colCount = cols(el)
  if (colCount <= 0) return null
  const grid = tableGrid(el.rows, colCount)
  const row0IsHeader = el.rows[0]?.isHeader === true
  const rows = cloneRows(el.rows).map((row, r) => ({
    ...row,
    cells: row.cells.map((c) => {
      const g = (grid[r] ?? []).find((x) => x?.cell.id === c.id)
      if (!g || g.colStart !== 0) return c
      if (!on && r === 0 && row0IsHeader) return c
      return {
        ...c,
        style: {
          ...c.style,
          bold: on,
          align: (on ? 'center' : 'left') as 'center' | 'left',
          background: on ? (c.style?.background ?? '#f2f3f5') : undefined,
        },
      }
    }),
  }))
  return { patch: { rows, headerCol: on } }
}

/**
 * 表头**样式**（整行/整列加粗 + 居中 + 底纹）—— 行与列**共用这一份实现**。
 *
 * ⚠️ 为什么列没有 `isHeader` 那样的标记位（2026-09-22，规格 五："任意列右键 → 设为标题列，规则同上"）：
 *    行上的 `isHeader` 不是给样式用的，而是**打印层**用来算"跨页重复表头"的（`render/html.ts` 的
 *    `headerRowCount`）。列**不存在跨页重复**这回事，加一个没人读的标记只会变成第二个真相源 ——
 *    "我明明是标题列，为什么打印不重复"这种问题就是这么长出来的。
 *    ⇒ 列的"是标题"完全由它自己的样式表达（加粗/居中/底纹），这三样跟着格子走，
 *      插列删列时天然正确（新插入的空格没有这些样式，也就不是标题列）。
 */
export function setHeaderStylePatch(el: TableElement, rawRange: CellRange, on: boolean): TableActionResult | null {
  const colCount = cols(el)
  if (colCount <= 0) return null
  const targets = new Set(rangeCells(el, rawRange).map((c) => c.id))
  if (targets.size === 0) return null
  const rows = cloneRows(el.rows).map((row) => ({
    ...row,
    cells: row.cells.map((c) =>
      targets.has(c.id)
        ? {
            ...c,
            style: {
              ...c.style,
              bold: on,
              align: (on ? 'center' : 'left') as 'center' | 'left',
              background: on ? (c.style?.background ?? '#f2f3f5') : undefined,
            },
          }
        : c,
    ),
  }))
  return { patch: { rows } }
}

// ============================================================
// 拆分单元格（2026-09-23 真机反馈第 7 条）
// ============================================================

export type SplitCellResult = { ok: true; patch: Partial<TableElement> } | { ok: false; reason: string }

/**
 * 把某一格拆成 `wantRows × wantCols` 个格子。
 *
 * 用户原话（第 7 条）：「改为拆分单元格（点击后被选中的单元格会被拆分，会出现弹窗，提示输入几行几列）」。
 *
 * ── 语义（对齐 Word 的「拆分单元格」）──────────────────────────────────
 * 目标区域 = 从这一格开始、向下 `wantRows` 行、向右 `wantCols` 列的**矩形**，
 * 矩形里每一格都变成 1×1：
 *   · 这一格原本是合并块（如 2×2）⇒ 填 2×2 就是**取消合并**；
 *   · 这一格是普通格（1×1）⇒ 填 2×2 会先给它补 1 行 1 列，再切成 4 格。
 * 所以要求 `wantRows ≥ 当前 rowspan`、`wantCols ≥ 当前 colspan`（比它小没有意义，明确拒绝并说明原因）。
 *
 * ── 为什么直接复用 `insertRowAt` / `insertColAt` 来"补行补列" ─────────────
 * 这两个函数已经处理了**合并格跨线**（上面/左边有 rowspan/colspan 时要顺手加宽它，而不是补一个空格子
 * 把网格撑歪）以及**总宽守恒**。自己再写一遍"补一行/补一列"必然会和它们分叉，而分叉的表现是
 * "表格看着歪了"，极难归因。
 *
 * ⚠️ 副作用要说清（**不是 bug，是这一版明确接受的取舍**）：
 *    补列走的是 `insertColAt` 的比例缩（整表每列都窄一点、总宽不变）⇒
 *    **别的行里那一列的格子也会跟着变窄**。要让它保持原宽，就得把邻居的格子合并起来
 *    （colspan 手术），而那一手术在有内容的邻居上会**丢东西**。
 *    取舍：宁可整表等比窄一点点（和"插入一列"是同一个可见结果），也不静默吃掉用户打的字。
 *
 * ── 三条护栏（宁可不做，也不做错）──────────────────────────────────
 *   ① 目标格找得到、行列数合法、且不小于它当前占的行列；
 *   ② 目标区域里**不能有别的合并格**跨进来（那是要给别人做 span 手术的情形）；
 *   ③ 目标区域里别的格子**不能有内容**（静默清掉用户打的字是这个项目最不能接受的一类缺陷）。
 * 被拒时返回 `reason`，调用方原样显示。
 */
export function splitCellToGrid(
  el: TableElement,
  cellId: string,
  wantRowsRaw: number,
  wantColsRaw: number,
): SplitCellResult {
  const wantRows = Math.floor(finite(wantRowsRaw, 1))
  const wantCols = Math.floor(finite(wantColsRaw, 1))
  if (wantRows < 1 || wantCols < 1) return { ok: false, reason: '行列数都得填 1 或更多' }
  if (wantCols > MAX_COLS) return { ok: false, reason: `一次最多拆成 ${MAX_COLS} 列` }
  if (wantRows > MAX_SPLIT_ROWS) return { ok: false, reason: `一次最多拆成 ${MAX_SPLIT_ROWS} 行` }

  const loc = findCell(el.rows, cellId)
  if (!loc) return { ok: false, reason: '找不到这一格' }
  /* 网格列起点：合并格在 `row.cells` 里的**数组下标 ≠ 网格列号**，必须摊平后取 */
  const g0 = (tableGrid(el.rows, cols(el))[loc.rowIdx] ?? []).find((x) => x?.cell.id === cellId)
  if (!g0) return { ok: false, reason: '找不到这一格的位置' }
  const r0 = loc.rowIdx
  const c0 = g0.colStart
  const cs = Math.max(1, g0.colSpan)
  const rs = Math.max(1, g0.rowSpan)
  if (wantRows < rs || wantCols < cs) {
    return { ok: false, reason: `这一格现在占 ${rs} 行 × ${cs} 列，拆不成更小的 ${wantRows} × ${wantCols}` }
  }

  /* ① 补足行列。补在目标块的**外侧**（行补在块下方、列补在块右侧）⇒ 补出来的格子必然落在块内且是空的 */
  let cur = el
  for (let i = rs; i < wantRows; i += 1) {
    const r = insertRowAt(cur, r0 + rs - 1, 'below')
    if (!r) return { ok: false, reason: '补行失败（已经到行数上限）' }
    cur = { ...cur, ...r.patch }
  }
  let colsAdded = false
  for (let i = cs; i < wantCols; i += 1) {
    const r = insertColAt(cur, c0 + cs - 1, 'right')
    if (!r) return { ok: false, reason: '补列失败（已经到列数上限）' }
    cur = { ...cur, ...r.patch }
    colsAdded = true
  }

  /* ② 护栏：块内除它自己以外，不许有别的合并格、也不许有内容 */
  const grid = tableGrid(cur.rows, cols(cur))
  for (let ri = r0; ri < r0 + wantRows; ri += 1) {
    for (let ci = c0; ci < c0 + wantCols; ci += 1) {
      const g = grid[ri]?.[ci]
      if (!g) return { ok: false, reason: '这块区域超出了表格范围' }
      if (g.cell.id === loc.cell.id) continue
      if (Math.max(1, finite(g.colSpan, 1)) > 1 || Math.max(1, finite(g.rowSpan, 1)) > 1) {
        return { ok: false, reason: '这块区域里有别的合并格，请先把它们拆开' }
      }
      if (g.cell.nodes.length > 0 || (g.cell.children?.length ?? 0) > 0) {
        return { ok: false, reason: `「${cellBrief(g.cell)}」里有内容，拆下去会丢东西；请先清空它` }
      }
    }
  }

  /* ③ 重建目标矩形：每格都变成 1×1。内容留在**左上那一格**（分开放会让人分不清哪块是原文），
        样式沿用原格（标题格的加粗/底纹因此跟着走） */
  const style = loc.cell.style
  const rows = cur.rows.map((row, ri) => {
    if (ri < r0 || ri >= r0 + wantRows) return row
    /* 这一行里"目标块最左那一格"在本行数组里的下标 */
    const cut = row.cells.findIndex((c) => grid[ri]?.[c0]?.cell.id === c.id)
    if (cut < 0) return row
    const fresh: TableCell[] = Array.from({ length: wantCols }, (_, k) => {
      const freshCell = emptyCell()
      if (style) freshCell.style = { ...style }
      if (ri === r0 && k === 0) {
        freshCell.nodes = [...loc.cell.nodes]
        if (loc.cell.children) freshCell.children = [...loc.cell.children]
      }
      return freshCell
    })
    return { ...row, cells: [...row.cells.slice(0, cut), ...fresh, ...row.cells.slice(cut + wantCols)] }
  })

  const patch: Partial<TableElement> = { rows }
  /* 补过列才需要回写列宽（`insertColAt` 已经把总宽守恒算好了，这里只是把它带出去） */
  if (colsAdded) {
    patch.colWidthsMm = cur.colWidthsMm
    patch.w = cur.w
  }
  return { ok: true, patch }
}

/** 护栏文案里给"别的格子"一个短名字（那里没有行列号可用，只能拿内容当标识） */
function cellBrief(c: TableCell): string {
  const t = c.nodes
    .map((n) => (n.type === 'text' ? n.text : n.type === 'field' ? `「${n.fieldName}」` : ''))
    .join('')
    .trim()
  return t.slice(0, 8) || '这一格'
}


/** 新建表格的默认列数（规格："默认 3 行 × 4 列"）。也用来反推"一格大概多宽" */
export const DEFAULT_TABLE_COLS = 4

/**
 * 新建表格时**一行大概多高**（mm）。
 *
 * 为什么是 8：默认字体 10.5pt + 1.5 倍行距 + 上下 padding 差不多就是这个量级
 * （画布上实测一行约 30px ≈ 8mm）。用它把"拖出的高度"换算成行数，
 * 换算出来的表格才不会一放上去就比用户画的框高出一大截。
 */
export const TABLE_ROW_MM = 8

/**
 * 「拖出矩形 → 自动换算行列数」（规格 一：**或**支持在画布上按住拖出矩形后按矩形宽高自动换算行列数）。
 *
 * 两条换算规则：
 *   · **列**按"单元格宽度 ≈ 版心宽 ÷ 默认列数"折算 —— 用户画的框有多宽，就放得下几列；
 *   · **行**按 `TABLE_ROW_MM` 折算。
 * 上下限与动作层一致（列 ≤ `MAX_COLS`、行 ≤ 50，至少 1×1）：
 * 拖得再小也是一个 1×1 的表格，而不是"什么都没插进去"。
 */
export function tableSizeFromRect(rectWMm: number, rectHMm: number, contentWMm: number): { rows: number; cols: number } {
  const cellW = Math.max(4, finite(contentWMm, 180) / DEFAULT_TABLE_COLS)
  const rawCols = finite(rectWMm, 0) / cellW
  const rawRows = finite(rectHMm, 0) / TABLE_ROW_MM
  /*
   * ⚠️ 返回的是 `{ rows, cols }`（行在前）—— 不只是好看：本项目的断言做的是**深比较**，
   *    `{cols, rows}` 与 `{rows, cols}` 会被判成不相等（实测：6 条断言因为这个红）。
   *    统一成"行在前"，与 `createDefaultElement({kind:'table', rows, cols})` 的写法一致。
   */
  return {
    rows: Math.max(MIN_TABLE_ROWS, Math.min(Math.round(rawRows), 50)),
    cols: Math.max(MIN_TABLE_COLS, Math.min(Math.round(rawCols), MAX_COLS)),
  }
}

// ============================================================
// 拖拽尺寸时的弱吸附（2026-09-22，用户规格 三 的可选项）
// ============================================================

/**
 * 拖行高 / 列宽时，新尺寸与**其它行列的尺寸**相差在容差内就吸上去（纯函数）。
 *
 * 规格原文："拖拽时若偏移量小于 6px，可轻微吸附到邻近行列的尺寸（可选）"。
 *
 * 三个刻意的决定：
 *   ① **只吸其它行列已有的尺寸**，不吸"5mm 整数网格" —— 后者会让"我就想要 47.3mm"变成做不到，
 *      而"和旁边那一列一样宽"才是用户真正在做的事（对齐表头与内容行）。
 *   ② 多峰时取**最近**的；距离相等取**先出现**的（表格里"先出现的"= 靠上的行/靠左的列，
 *      在视觉上更"像参照物"）。
 *   ③ 容差由调用方换算成 mm 传入（屏幕 6px ÷ 缩放 = 物理容差），本函数**只认 mm** ——
 *      与 `align-guides` 同一条纪律：判定层不出现 px。
 */
export function snapSizeToNeighbors(mm: number, neighborsMm: readonly number[], tolMm: number): number {
  if (!(tolMm > 0) || neighborsMm.length === 0) return mm
  let best: number | null = null
  let bestGap = Infinity
  for (const n of neighborsMm) {
    if (!Number.isFinite(n) || n <= 0) continue
    const gap = Math.abs(n - mm)
    if (gap <= tolMm && gap < bestGap) {
      best = n
      bestGap = gap
    }
  }
  return best ?? mm
}

// ============================================================
// 单元格单边边框（2026-09-22，用户规格 八）
// ============================================================

/** 一条边最终要不要画 */
export interface CellEdges {
  top: boolean
  right: boolean
  bottom: boolean
  left: boolean
}

/**
 * 把「整表 mode」与「单元格覆盖」合成**这一格四条边各画不画**（纯函数，画布与打印共用）。
 *
 * 为什么需要它：`TableBorderStyle.mode` 是**表级**的，而 `outer` / `horizontal` 的语义
 * 只有知道"这一格在表的哪个位置"才落得下来（最外那圈才画外框）。把这段几何判断放在渲染层里
 * 各写一份，画布与打印迟早对不上 —— 而"画布有、打印没有"是最难被发现的一类缺陷。
 *
 * ⚠️ `outer` 模式下，表本身的边框由 `<table>` 元素负责（见 `render/html.ts` 的 `tableBorder`），
 *    这里返回的 `true` 表示"这一格要自己画这条边"—— 只有用户**显式覆盖**成 true 时才会用到。
 */
export function resolveCellEdges(
  mode: TableBorderStyle['mode'],
  borders: CellBorders | undefined,
  at: { row: number; rows: number; col: number; cols: number },
): CellEdges {
  const lastRow = at.row === at.rows - 1
  const lastCol = at.col === at.cols - 1
  const base: CellEdges =
    mode === 'all'
      ? { top: true, right: true, bottom: true, left: true }
      : mode === 'outer'
        ? { top: at.row === 0, right: lastCol, bottom: lastRow, left: at.col === 0 }
        : mode === 'horizontal'
          ? { top: at.row === 0, right: false, bottom: true, left: false }
          : { top: false, right: false, bottom: false, left: false }
  // 覆盖：undefined = 跟随（`??` 而不是 `||` —— `false` 也是有效覆盖）
  return {
    top: borders?.top ?? base.top,
    right: borders?.right ?? base.right,
    bottom: borders?.bottom ?? base.bottom,
    left: borders?.left ?? base.left,
  }
}

/** 给选区内每一格套一层单边边框覆盖（复用 `rangeCells` 的"按 id 去重"） */
export function setCellBordersPatch(
  el: TableElement,
  rawRange: CellRange,
  patch: CellBorders,
): TableActionResult | null {
  const targets = new Set(rangeCells(el, rawRange).map((c) => c.id))
  if (targets.size === 0) return null
  const rows = cloneRows(el.rows).map((row) => ({
    ...row,
    cells: row.cells.map((c) => (targets.has(c.id) ? { ...c, borders: { ...c.borders, ...patch } } : c)),
  }))
  return { patch: { rows } }
}

// ============================================================
// 单元格作为素材容器（2026-09-22，用户规格 六）
// ============================================================

/** 单元格里最多放几个块级子元素。规格：「一个单元格默认放一个主元素」 */
export const MAX_CELL_CHILDREN = 1

/**
 * **能作为块级子元素驻留在单元格里**的取值（唯一来源）。
 *
 * ⚠️ 这份名单有**三个消费者**：画布渲染（`renderCellChild`）、拖入判定（`resolveDrop` 的探针）、
 *    以及「拖已有的元素进格子」那条路。三处各写一份必然出现「画得出来但拖不进去」。
 * 不在名单里的（表格 / 附件块 / 分页符）放进格子只会变成一个占位说明，所以**入口就该拦住**。
 */
/*
 * ⚠️ `attach`（附件字段）在 2026-09-22 被放进来：真机反馈「表格中还是无法直接放入字段类型——附件，
 *    附件一般就是图片，应该按照图片处理，如果不是图片，则在打印的时候就只打印文件名即可」。
 *    「图片→图片、非图片→文件名」正是 `AttachmentMode = 'all'` 的语义（打印端 `layoutAttachmentGroup`）。
 */
export const CELL_BLOCK_KINDS: ReadonlyArray<AnyElement['kind']> = [
  'image',
  'qrcode',
  'barcode',
  'hline',
  'text',
  'attach',
]

/**
 * 把块级元素放进单元格。
 *
 * 规则（与 `TableCell.children` 的类型注释一一对应）：
 *   · 一格最多 `MAX_CELL_CHILDREN` 个 ⇒ 已经有一个时**替换**它，并把 `replaced` 报给调用方
 *     （调用方据此提示用户"原来那个被换掉了"——静默替换是数据丢失，必须说出来）；
 *   · 只动 `children`，**不碰 `nodes`**：格子里的说明文字与放进去的图是两件事，各留各的；
 *   · 不碰 `w`/`h`：子元素跟着格子走，不参与版式计算（否则循环区高度会被格子里的图片撑变）。
 */
export function attachChildToCell(
  el: TableElement,
  cellId: string,
  child: AnyElement,
): (TableActionResult & { replaced: boolean }) | null {
  const loc = findCell(el.rows, cellId)
  if (!loc) return null
  const existing = loc.cell.children ?? []
  const replaced = existing.length >= MAX_CELL_CHILDREN
  const next = [...existing, child].slice(-MAX_CELL_CHILDREN)
  const rows = cloneRows(el.rows)
  const target = rows[loc.rowIdx]?.cells[loc.colIdx]
  if (!target) return null
  target.children = next
  return { patch: { rows }, replaced }
}

/**
 * 把单元格里的子元素**取出来**（规格："单元格内的元素可以再拖出来，回到画布自由层"）。
 *
 * 返回值里带上那个元素本身 —— 调用方要把它重新放回版式区（`addElement`），
 * 而"它是什么"只有这里知道。没有子元素时返回 `null`（= 什么都没发生，不产生空提交）。
 */
export function detachChildFromCell(
  el: TableElement,
  cellId: string,
): (TableActionResult & { child: AnyElement | null }) | null {
  const loc = findCell(el.rows, cellId)
  if (!loc) return null
  const existing = loc.cell.children ?? []
  if (existing.length === 0) return null
  const child = existing[existing.length - 1] ?? null
  const rows = cloneRows(el.rows)
  const target = rows[loc.rowIdx]?.cells[loc.colIdx]
  if (!target) return null
  target.children = []
  return { patch: { rows }, child }
}

/**
 * 把表格调整到指定的行列数（2026-09-22，用户规格 一："添加表格时弹出默认行列数选择"）。
 *
 * ⚠️ 它不是"重建一张表"——**已存在的内容按左上角对齐保留**：
 *    加行列走 `insertRowAt` / `insertColAt`（它们已经会把合并关系、行高列宽正确平移），
 *    减行列走 `deleteRowAt` / `deleteColAt`（会把"从这一行/列开始的合并"整体下沉/左移，不丢内容），
 *    真正要丢的格子过 `decide` —— 与合并同一套口径。
 *    这样"新建时选 3×4、后来改成 8×6、再改回 2×2"都不会把已填的东西弄乱。
 *
 * 返回 `null` 表示"什么都没发生"（尺寸没变、或越界）。
 */
export function resizeTableTo(
  el: TableElement,
  rows: number,
  /** ⚠️ 名字不能叫 `cols` —— 那会**遮蔽**本模块内的 `cols()` 辅助函数（`cols(cur)` 会变成"调用一个 Number"） */
  wantColsRaw: number,
  decide: MergeDecision,
): TableActionResult | null {
  const wantRows = Math.max(MIN_TABLE_ROWS, Math.min(Math.floor(finite(rows, 1)), MAX_TABLE_ROWS))
  const wantCols = Math.max(MIN_TABLE_COLS, Math.min(Math.floor(finite(wantColsRaw, 1)), MAX_COLS))
  if (wantRows === el.rows.length && wantCols === cols(el)) return null

  let cur = el
  // 先删后加（先删可以让"从 10 列变 4 列"少几次中间态；顺序不影响结果）
  while (cols(cur) > wantCols) {
    const r = deleteColAt(cur, cols(cur) - 1, decide)
    if (!r) return null
    cur = { ...cur, ...r.patch }
  }
  while (cur.rows.length > wantRows) {
    const r = deleteRowAt(cur, cur.rows.length - 1, decide)
    if (!r) return null
    cur = { ...cur, ...r.patch }
  }
  while (cols(cur) < wantCols) {
    const r = insertColAt(cur, cols(cur) - 1, 'right')
    if (!r) return null
    cur = { ...cur, ...r.patch }
  }
  while (cur.rows.length < wantRows) {
    const r = insertRowAt(cur, cur.rows.length - 1, 'below')
    if (!r) return null
    cur = { ...cur, ...r.patch }
  }

  /*
   * ⚠️ 返回的补丁只带**变化过的字段**：`colWidthsMm` / `w` 只在列数真的变过时才出现，
   *    否则"只改行数"也会顺手把列宽数组重写一遍（值相同但仍然是一次多余写入，
   *    而且会让调用方的 diff 判断失效）。
   */
  const patch: Partial<TableElement> = { rows: cur.rows }
  if (cols(cur) !== cols(el)) {
    patch.colWidthsMm = cur.colWidthsMm
    patch.w = cur.w
  }
  return { patch }
}
