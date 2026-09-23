/**
 * 表格的**悬浮操作层**（2026-09-22，用户规格 一·二）。
 *
 * 用户原话："表格 hover 态：鼠标移到表格上时，左侧出现一个「表格手柄」按钮（点按后整个表格可拖动）；
 * 表格顶边显示列拖动手柄点、左边显示行手柄点"；
 * "鼠标悬停在行首 / 列首位置，出现「+」悬浮按钮：点一下即在该行下方插入一行、在该列右侧插入一列"；
 * "鼠标靠近表格底部边缘或右边缘时，出现一条虚线感应区，点击即可追加一行 / 追加一列"。
 *
 * ── 为什么单独一个组件 ──────────────────────────────────────────
 * `Canvas.tsx` 已经 2000+ 行，而这一层是**纯展示 + 纯回调**：它自己不改文档、不管选中、
 * 不认识事件时序。抽出来之后，"表格上有哪些悬浮入口"这件事能一眼看全，
 * 也不会再往 Canvas 里塞一段 150 行的内联 JSX。
 *
 * ── 三条约束（都来自本项目踩过的坑）──────────────────────────────
 *   1. **所有东西都挂在元素盒子外沿**（`top: -Npx` / `left: -Npx`）：表格内部每一格都要能被点中，
 *      把按钮压在格子上的话，"点这一格"这个最常用的动作会被抢走（旧代码的 `.bp-tbl-size` 注释里
 *      专门写过这条）。
 *   2. **尺寸乘 `--bp-inv`**：画布整体被 `transform: scale()` 缩放，不反向缩放的话
 *      50% 缩放时这些 18px 的小按钮会小到点不着。
 *   3. **每个按钮都要 `stopPropagation`**：不拦的话，pointerdown 会冒泡到 `.bp-el`，
 *      变成"拖动整个表格"—— 那是"点一下插一行却把表格拖走了"这种最恼人的缺陷。
 */
import type { ReactNode } from 'react'
import type { TableElement } from '../../lib/types'
import { colEdgeFrac, tableGrid } from './table-actions'

export interface TableAffordProps {
  el: TableElement
  /** 每一行的底边（px，相对元素盒子；末项 = 表底边） */
  rowEdges: readonly number[]
  /** 每一行的**首格 id**（用来定位"在这一行下方插入"） */
  rowAnchorIds: readonly (string | null)[]
  /** 每一列的**首行格 id** */
  colAnchorIds: readonly (string | null)[]
  /** 整个表格可拖动（复用画布既有的拖动会话，不自造一套） */
  onGripDown(ev: React.PointerEvent): void
  insertRow(where: 'above' | 'below', cellId: string): void
  insertCol(where: 'left' | 'right', cellId: string): void
}

/** 一列的宽度占比 → 该列右边界的位置（%）。列宽为 0 时退化成均分，避免除零 */
function rightPct(el: TableElement, i: number): number {
  return colEdgeFrac(el.colWidthsMm, i) * 100
}

export function TableAfford({
  el,
  rowEdges,
  rowAnchorIds,
  colAnchorIds,
  onGripDown,
  insertRow,
  insertCol,
}: TableAffordProps): ReactNode {
  const stop = (ev: React.PointerEvent): void => {
    // 约束 ③：不拦就会变成"拖动整个表格"
    ev.stopPropagation()
  }

  return (
    <div className="bp-tbl-afford" onPointerDown={stop}>
      {/* ---- 表格手柄：按住即拖动整表（复用画布的拖动会话）---- */}
      <button
        type="button"
        className="bp-tbl-afford__grip"
        title="按住拖动整个表格"
        aria-label="按住拖动整个表格"
        onPointerDown={(ev) => {
          ev.stopPropagation()
          onGripDown(ev)
        }}
      >
        {/* 六个小点 = 通用的"抓手"图形。项目不用图标字体，这里用纯 CSS 点阵（见 editor.css） */}
        <span className="bp-tbl-afford__dots" aria-hidden />
      </button>

      {/* ---- 列：顶边手柄点 + 右侧「+」---- */}
      {el.colWidthsMm.map((_, i) => {
        const anchor = colAnchorIds[i]
        return (
          <span key={`c${i}`} className="bp-tbl-afford__col" style={{ left: `${rightPct(el, i)}%` }}>
            <span className="bp-tbl-afford__mark" aria-hidden />
            <button
              type="button"
              className="bp-tbl-afford__plus"
              title="在右侧插入一列"
              aria-label={`在第 ${i + 1} 列右侧插入一列`}
              disabled={!anchor}
              onClick={() => anchor && insertCol('right', anchor)}
            >
              +
            </button>
          </span>
        )
      })}

      {/* ---- 行：左边手柄点 + 下方「+」---- */}
      {rowEdges.map((top, i) => {
        const anchor = rowAnchorIds[i]
        return (
          <span key={`r${i}`} className="bp-tbl-afford__row" style={{ top }}>
            <span className="bp-tbl-afford__mark" aria-hidden />
            <button
              type="button"
              className="bp-tbl-afford__plus"
              title="在下方插入一行"
              aria-label={`在第 ${i + 1} 行下方插入一行`}
              disabled={!anchor}
              onClick={() => anchor && insertRow('below', anchor)}
            >
              +
            </button>
          </span>
        )
      })}

      {/* ---- 边缘虚线感应区：点一下追加一行 / 一列 ---- */}
      <button
        type="button"
        className="bp-tbl-afford__edge is-bottom"
        title="点击在表格末尾追加一行"
        aria-label="在表格末尾追加一行"
        onClick={() => {
          const a = rowAnchorIds[rowAnchorIds.length - 1]
          if (a) insertRow('below', a)
        }}
      />
      <button
        type="button"
        className="bp-tbl-afford__edge is-right"
        title="点击在表格末尾追加一列"
        aria-label="在表格末尾追加一列"
        onClick={() => {
          const a = colAnchorIds[colAnchorIds.length - 1]
          if (a) insertCol('right', a)
        }}
      />
    </div>
  )
}

/**
 * 给表格算出"每行 / 每列用哪一格当定位锚点"。
 *
 * 为什么要锚点 id 而不是行列号：插入/删除动作的入参是 **cellId**（见 `table-actions` 的注释 ——
 * 行列号在确认层开着的时候会变，id 不会）。这里把"第 i 行 / 第 j 列"翻译成那一格，
 * 是唯一需要网格知识的地方，所以和组件放在一起。
 *
 * ⚠️ 列的锚点取**第 0 行**那一格：第 0 行可能因为纵向合并在某列没有格子（那时取 null ⇒ 按钮禁用），
 *    这是刻意的 —— 那一列的插入位置本来就该由用户先在别处决定。
 */
export function tableAnchors(el: TableElement): { rowAnchorIds: (string | null)[]; colAnchorIds: (string | null)[] } {
  const colCount = el.colWidthsMm.length
  const grid = tableGrid(el.rows, colCount)

  const rowAnchorIds = el.rows.map((_, r) => {
    const row = grid[r] ?? []
    for (let c = 0; c < colCount; c += 1) {
      const g = row[c]
      if (g && g.rowStart === r) return g.cell.id
    }
    return null
  })

  const colAnchorIds: (string | null)[] = []
  for (let c = 0; c < colCount; c += 1) {
    const g = grid[0]?.[c] ?? null
    colAnchorIds.push(g ? g.cell.id : null)
  }

  return { rowAnchorIds, colAnchorIds }
}
