/**
 * 三条分区带的「标签条」落点计算（**纯函数**，不碰 DOM）。
 *
 * ── 为什么需要它 ────────────────────────────────────────────────
 * 用户原话："当前的画布不太好区域（区分），只能靠右侧的属性 tab 去猜，
 * 做画布分区可视化：A4 纸上直接画了三条分区带 —— 每页重复区（灰）、循环区（橙色高亮，
 * 因为现在在循环区）、表尾区（灰），左侧竖排小标签，不用再去右侧 tab 猜。"
 *
 * 三条带的**真实几何**来自 `computeBandLayout`，但有两个坑必须在这里解决：
 *
 *   ① **空分区的高度可以是 0**。`loopTopMm = bands.loop.offsetMm`，
 *      标题/页眉区没放东西时它就是 0 —— 于是"每页重复区"和"循环区"的上边界重合。
 *      两条标签条画在同一条线上会叠在一起，看着像一处涂污。
 *   ② **矮分区塞不下一条标签条**。循环区最小高度 `MIN_LOOP_EXTENT_MM` 很小，
 *      缩放到 50% 时可能只有几个像素。
 *
 * ⇒ 规则（两条，都很局部）：
 *   · 高度小于 `minBandPx` 的带**不画标签条**（它的名字由左侧竖排标签承担，那里不挤）；
 *   · 剩下的按**真实边界自上而下**排，若与前一条重叠则**下推**到 `barHpx + gapPx` 之后。
 *     下推是可接受的：标签条本身只有 18px 高，且带内没有内容会被它盖住（它在带的顶部）。
 */

import type { BandKey } from './useEditorState'

/** 一条带的可视化输入：真实上边界 + 真实高度（单位都是**屏幕像素**） */
export interface BandGeometry {
  key: BandKey
  /** 带的真实上边界（相对版心顶部，px） */
  topPx: number
  /** 带的真实高度（px）；0 = 空分区 */
  heightPx: number
}

export interface BandBar {
  key: BandKey
  /** 标签条的上沿（相对版心顶部，px）—— 已被防重叠下推过 */
  topPx: number
  /** 是否因为防重叠被下推过（UI 可据此弱化它，说明"这条不是真实边界"） */
  shifted: boolean
}

export interface BandBarOptions {
  /** 标签条自身高度（px） */
  barHpx: number
  /** 两条之间至少留的空隙（px） */
  gapPx?: number
  /** 低于这个高度就不画标签条（px） */
  minBandPx?: number
}

/** 标签条默认高度：屏幕上恒定 18px（画布用 `--bp-inv` 反向缩放，缩放后视觉尺寸不变） */
export const BAND_BAR_H_PX = 18

/**
 * 算出每条带要不要标签条、画在哪里。
 *
 * 输入顺序无所谓（内部按 `topPx` 排序），这样调用方不用先排好 —— 排序是这条函数的职责，
 * 而"调用方记得先排序"是那种迟早会忘的约定。
 */
export function layoutBandBars(
  bands: ReadonlyArray<BandGeometry>,
  { barHpx = BAND_BAR_H_PX, gapPx = 2, minBandPx = 14 }: BandBarOptions = { barHpx: BAND_BAR_H_PX },
): BandBar[] {
  const visible = bands
    .filter((b) => b.heightPx >= minBandPx)
    .slice()
    .sort((a, b) => a.topPx - b.topPx)

  const out: BandBar[] = []
  let prevBottom = Number.NEGATIVE_INFINITY
  for (const b of visible) {
    const floor = prevBottom === Number.NEGATIVE_INFINITY ? Number.NEGATIVE_INFINITY : prevBottom + gapPx
    const topPx = Math.max(b.topPx, floor)
    out.push({ key: b.key, topPx, shifted: topPx > b.topPx + 0.5 })
    prevBottom = topPx + barHpx
  }
  return out
}

/**
 * 左侧竖排标签的落点（同理防重叠）。
 *
 * 与标签条不同：**三条都要有**（哪怕高度是 0）—— 用户要的正是"一眼看出有三个区、
 * 我在哪一个"。挤在一起时按顺序下推，宁可整体往下挪一点，也不能缺一条。
 */
export function layoutBandGutters(
  bands: ReadonlyArray<BandGeometry>,
  { labelHpx, gapPx = 6 }: { labelHpx: number; gapPx?: number },
): BandBar[] {
  const sorted = bands.slice().sort((a, b) => a.topPx - b.topPx)
  const out: BandBar[] = []
  let prevBottom = Number.NEGATIVE_INFINITY
  for (const b of sorted) {
    // 竖排标签贴在**带的中线**上（带太矮就退化成贴上边界）
    const anchor = b.topPx + Math.min(b.heightPx / 2, 24)
    const floor = prevBottom === Number.NEGATIVE_INFINITY ? Number.NEGATIVE_INFINITY : prevBottom + gapPx
    const topPx = Math.max(anchor, floor)
    out.push({ key: b.key, topPx, shifted: topPx > anchor + 0.5 })
    prevBottom = topPx + labelHpx
  }
  return out
}

/** 三条带的名称与说明（画布与左侧标签共用一份，避免两处各写一遍还写得不一样） */
export const BAND_META: Record<BandKey, { name: string; tip: string }> = {
  /*
   * 名字用「表头区」而不是「每页重复区」（真机反馈 2026-09-22：「首先把每页重复去改为表头区」）——
   * 用户的心智模型就是 Word 的页眉，说「重复」反而要多想一步。行为不变（仍是每页重复打印）。
   */
  header: { name: '表头区', tip: '标题 / 页眉，每页打印一次' },
  loop: { name: '循环区', tip: '每条记录重复一次' },
  footer: { name: '表尾区', tip: '签名 / 合计在每页底部' },
}
