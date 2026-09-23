/**
 * 表格的**查询 / 就地改写**原语：定位一个单元格、按 id 替换一格。
 *
 * ## 为什么要有这个文件
 *
 * `findCell` / `updateCell` / `CellLocation` 原来住在 `useEditorState.ts`（1301 行的 hooks 模块）。
 * 新的表格动作层 `table-actions.ts` 也需要它们，于是出现两条路：
 *
 *   a. 从 `useEditorState` import —— 会把 React 拖进**纯函数层**，
 *      而那一层要能被 Node 直接加载（`__selftest.mts` 就是跑在 Node 下的）；
 *   b. 自己再扫一遍 `rows` —— 同一套查找逻辑两份，**会静默分叉**。
 *
 * 两条都不能接受，所以走第三条：**把原语下沉到这里**（只依赖类型，运行时零依赖）。
 * 之后 `useEditorState.ts` 改成从这里 re-export，全项目**只剩一份实现**。
 *
 * 在那次 re-export 落地之前，`__selftest.mts` 里有一条**交叉断言**钉着
 * "本文件的 findCell 与 useEditorState 的 findCell 在同一组输入上结果一致"，
 * 所以这段共存期不会悄悄分叉。
 */

import type { TableCell, TableRow } from '../../lib/types'

export interface CellLocation {
  rowIdx: number
  colIdx: number
  cell: TableCell
  row: TableRow
}

/**
 * 按 id 定位单元格。
 *
 * 为什么要按 id 找而不是按 (row, col) 下标：合并/拆分单元格之后行列下标会错位
 * （跨列单元格占掉的位置在数据里根本不存在），下标定位会改错格子。
 */
export function findCell(rows: TableRow[], cellId: string | null | undefined): CellLocation | null {
  if (!cellId) return null
  for (let r = 0; r < rows.length; r += 1) {
    const row = rows[r]
    if (!row) continue
    const colIdx = row.cells.findIndex((c) => c.id === cellId)
    if (colIdx < 0) continue
    const cell = row.cells[colIdx]
    if (cell) return { rowIdx: r, colIdx, cell, row }
  }
  return null
}

/**
 * 就地替换某个单元格，返回新的 rows 数组。
 *
 * 找不到时**原样返回同一个引用** —— 上游是 `commit(next)`，引用相等会被短路成"无改动"。
 * 这条不是优化，是契约：调用方靠它判断"这一下点空了"。
 */
export function updateCell(rows: TableRow[], cellId: string, patch: Partial<TableCell>): TableRow[] {
  let hit = false
  const next = rows.map((r) => {
    if (!r.cells.some((c) => c.id === cellId)) return r
    hit = true
    return { ...r, cells: r.cells.map((c) => (c.id === cellId ? { ...c, ...patch } : c)) }
  })
  return hit ? next : rows
}
