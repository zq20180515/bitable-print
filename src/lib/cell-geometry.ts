/**
 * 格内子元素的**尺寸口径**（纯函数，无任何依赖）。
 *
 * 为什么单独一个文件、而不是留在 `components/editor/cell-child.ts`：
 * **渲染引擎（`render/html.ts`）也要用同一套口径**。而 `render/` 绝不能反向 import
 * `components/editor/`（那是 UI 层，还带着 doc-bands / round 这些版式区原语）——
 * 渲染引擎必须能被 Node 直接加载，反向依赖会形成循环。
 *
 * 本项目在这一点上已经栽过两次（`table-query.ts`、`cell-child.ts`），
 * 所以凡是被"画布 + 打印"两端共用的判据，一律下沉到 `lib/`。
 *
 * 口径定义见 `types.ts` 的 `TableCell.children` 第 ④ 条：
 * 格内 `w` = **占单元格内容宽度的百分比**（默认 100），`h` = 固定盒高（`'auto'` = 由内容决定），
 * `x` / `y` 在格内**无意义**。
 */

/** 占单元格宽度的百分比**下限**：再窄就看不见了，那种"拖了半天什么都没了"必须堵掉 */
export const MIN_CELL_CHILD_PCT = 10

/**
 * 子元素占单元格宽度的百分比（渲染用）。
 *
 * 容错要点：老数据（这个字段还没被当成百分比之前建的）里 `w` 是 mm 数（如 40），
 * 直接当百分比用会得到 40% —— 那还能看；但 `w` 缺失/为 0/为负时会退化成"0 宽"（看不见），
 * 所以**一律退回 100**。超过 100 的也夹回 100（格子里的东西不该横向溢出去）。
 */
export function childWidthPct(child: { w?: number | string }): number {
  const raw = typeof child.w === 'number' && Number.isFinite(child.w) ? child.w : 100
  if (raw <= 0) return 100
  return Math.max(MIN_CELL_CHILD_PCT, Math.min(100, raw))
}

/**
 * 子元素的固定高度（mm）；`h: 'auto'` 或非正数 → `null`（= 由内容决定，与自由层同一语义）。
 *
 * 有固定高度时画布/打印会给它一个**定高的盒子**（`overflow:hidden`），
 * 图片按 `fit` 适配这个盒子 —— 和自由层那张图片的行为一模一样，用户不用学第二套。
 */
export function childHeightMm(child: { h?: number | string }): number | null {
  const h = child.h
  if (typeof h !== 'number' || !Number.isFinite(h) || h <= 0) return null
  return h
}

/**
 * 子元素在格子里的**实际渲染宽度**（mm）。
 *
 * ⚠️ 这是修 2026-09-23 真机反馈第 1 / 2 条的关键：
 * 格内子元素原先拿到的 `scope.widthMm` 是**表格自己的宽度**（`render/pipeline.ts` 的
 * `scopeOfRecord` 给的是 `wMm` = 表宽）⇒ 一张附件图片被"适配"到表宽、二维码被画成表宽那么大，
 * 于是图片横向撑满整张表、码大到看不见。
 *
 * `cellContentWidthMm` 必须是**单元格内容区宽度**（列宽含 colspan 再减左右内边距）——
 * 外层盒子的 `width:N%` 是相对包含块（= td 内容区）算的，两边口径必须一致，
 * 否则"占格宽 50%"会与内层真实尺寸差一点，肉眼看不出来但打印会偏。
 */
export function childBoxWidthMm(child: { w?: number | string }, cellContentWidthMm: number): number {
  const base = Number.isFinite(cellContentWidthMm) && cellContentWidthMm > 0 ? cellContentWidthMm : 0
  return Math.max(1, (base * childWidthPct(child)) / 100)
}
