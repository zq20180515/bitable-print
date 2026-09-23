/**
 * 分页引擎（**纯函数，不碰 DOM**）。
 *
 * 职责边界：输入"已经量好高度的块 + 每页可用高度 + 分页规则"，输出 PageModel[]。
 * 刻意不在这里做测量、也不生成 HTML —— 这样分页算法可以在 Node 里被完整单测
 * （见 `__selftest.mts`），而分页恰恰是全项目最容易出回归的地方。
 *
 * 坐标约定：所有块的位置都是**相对版心左上角**的 mm，x/y 都从 0 开始。
 *
 * 版式区语义（对齐 PRD 术语表 / F2-29）：
 * - header 块（循环区之外）：**每一页都克隆一份**，在版心顶部占据 headerReserve 高度；
 * - loop 块（循环区内）：按记录顺序流式排布，放不下就换页；
 * - footer 块（表尾区）：**仅最后一页**渲染，并从版心底部往上量 footerReserve 高度。
 */

import type { ElementKind } from '../lib/types'
import { finite } from '../lib/types'
import type { PageModel, PlacedBlock, RenderWarning } from './context'

/** 浮点比较容差（mm）。分页是"差 0.01mm 也放过"的场景，容差能避免整块白白换页 */
export const PAGE_EPS = 0.05

// ============================================================
// 输入模型
// ============================================================

export interface MeasuredTableRow {
  rowId: string
  /** 行高 mm（含上下边框） */
  hMm: number
  /** 是否表头行；表头行必须位于 tableRows 数组**前部** */
  isHeader?: boolean
}

/** 一个已经量好高度的块（由 pipeline 产出） */
export interface MeasuredBlock {
  elementId: string
  kind: ElementKind
  /** 相对版心左边界的 x（mm），同行并排的元素 x 不同、y 相同 */
  xMm: number
  /** 相对版心上边界的 y（mm），仅用于把块归到同一"排" */
  yMm: number
  wMm: number
  hMm: number
  /** 作者显式设定的盒子高（mm，0 = `h:'auto'`）；由 pipeline 注入，见 context.ts 的 PlacedBlock 注释 */
  boxHMm: number
  html: string

  // ---- 表格专用：只有表格需要"按行拆分"，其它元素都是原子块 ----
  /** 按行测量结果（含表头行） */
  tableRows?: MeasuredTableRow[]
  /** 前部表头行数量 */
  headerRowCount?: number
  /** 表头行是否每页重复（PRD F2-29 硬要求） */
  repeatHeader?: boolean
  /**
   * 由 pipeline 注入：生成 [startRow, endRow) 行区间的表格片段 html。
   * 用回调而不是让 layout 自己拼 HTML，是为了让 layout 与 HTML 结构解耦，
   * 同时又能保证"片段 html 的表头重复规则"和分页结果一致。
   */
  tableFragmentHtml?: (startRow: number, endRow: number) => string

  /** 整块不跨页（break-inside: avoid）——表格不按行拆 */
  keepTogether?: boolean
  /** 分页符元素：放在它**之前**强制换页 */
  forceBreakBefore?: boolean
  /** 分页符元素：放在它**之后**强制换页 */
  forceBreakAfter?: boolean
}

export interface RecordGroup {
  /** 记录在打印范围内的 0 基下标 */
  recordIndex: number
  blocks: MeasuredBlock[]
}

export interface LayoutInput {
  /** 每页重复区（版心顶部），每页克隆 */
  headerBlocks?: MeasuredBlock[]
  records: RecordGroup[]
  /** 表尾区，仅末页 */
  footerBlocks?: MeasuredBlock[]
  /** 版心高度（mm） */
  contentHeightMm: number
  /** 记录模板批量排布方式（PRD F5-07） */
  batchLayout?: 'default' | 'continuous'
  /** 每 N 条记录强制分页（PRD F5-09） */
  perPageN?: number | null
}

export interface LayoutResult {
  pages: PageModel[]
  warnings: RenderWarning[]
}

/** 一排：y 区间互相重叠的块视为同一排（并排摆放的元素） */
export interface MeasuredRow {
  rowId: string
  blocks: MeasuredBlock[]
  /** 本排的**可视高度** = maxBottomMm - minYMm（不含排前的空白） */
  hMm: number
  /** 本排所有块 y 的最小值；emitRow 用它把块放到"相对排顶"的位置 */
  minYMm: number
  /** 本排所有块 (y + h) 的最大值；用于同行判定 */
  maxBottomMm: number
  forceBreakBefore: boolean
  forceBreakAfter: boolean
  /** 该排"独占一个可拆分表格"时才允许按行拆 */
  table?: MeasuredBlock
}

// ============================================================
// 行归组
// ============================================================

/**
 * 把一条记录内的块按"排"归组。
 *
 * 为什么要归组：模板里两个图片可以并排摆放（x 不同、y 相同），
 * 如果逐块进流式排版就会被拆成上下两行，视觉上完全变了。
 * 归组后"排"是分页的原子单位：一排要么整排留在本页，要么整排换页。
 */
export function groupIntoRows(blocks: MeasuredBlock[]): MeasuredRow[] {
  const sorted = [...blocks].sort((a, b) => a.yMm - b.yMm || a.xMm - b.xMm)
  const rows: MeasuredRow[] = []
  for (const b of sorted) {
    const last = rows[rows.length - 1]
    const bottom = b.yMm + b.hMm
    // 同行判定：块的 y 落在**上一排的纵向跨度内** → 说明是和上一排并排摆放的
    // （注意比的是 maxBottomMm，不是 hMm —— 后者是跨度高度，不含排的起始 y）
    const sameRow = !!last && b.yMm < last.maxBottomMm - PAGE_EPS
    if (sameRow && last) {
      last.blocks.push(b)
      last.maxBottomMm = Math.max(last.maxBottomMm, bottom)
      last.hMm = last.maxBottomMm - last.minYMm
      last.forceBreakBefore = last.forceBreakBefore || !!b.forceBreakBefore
      last.forceBreakAfter = last.forceBreakAfter || !!b.forceBreakAfter
    } else {
      rows.push({
        rowId: b.elementId,
        blocks: [b],
        hMm: b.hMm,
        minYMm: b.yMm,
        maxBottomMm: bottom,
        forceBreakBefore: !!b.forceBreakBefore,
        forceBreakAfter: !!b.forceBreakAfter,
      })
    }
  }
  for (const r of rows) {
    r.table =
      r.blocks.length === 1 &&
      r.blocks[0].kind === 'table' &&
      !!r.blocks[0].tableRows &&
      r.blocks[0].tableRows!.length > 0
        ? r.blocks[0]
        : undefined
  }
  return rows
}

/** 版式区占用的高度：= max(y + h) */
function reservedHeight(blocks: MeasuredBlock[]): number {
  let max = 0
  for (const b of blocks) max = Math.max(max, b.yMm + b.hMm)
  return Math.max(0, finite(max))
}

// ============================================================
// 分页主流程
// ============================================================

export function paginate(input: LayoutInput): LayoutResult {
  const contentH = Math.max(0, finite(input.contentHeightMm))
  const headerBlocks = input.headerBlocks ?? []
  const footerBlocks = input.footerBlocks ?? []
  const headerReserve = reservedHeight(headerBlocks)
  const footerReserve = reservedHeight(footerBlocks)
  const warnings: RenderWarning[] = []

  const pages: PageModel[] = []
  let page: PageModel = { index: 0, recordRange: [0, 0], blocks: [] }
  let cursorY = headerReserve
  let usedBottom = headerReserve
  let recordsOnPage = 0
  /** 当前页是否已经有"内容"（不只是克隆的重复区）。用于避免分页符造出空白页 */
  let hasContent = false

  function startPage(): void {
    const p: PageModel = { index: pages.length, recordRange: [0, 0], blocks: [] }
    pages.push(p)
    // 循环区之外的重复区内容：每页克隆一份（PRD F2-29）
    for (const b of headerBlocks) p.blocks.push(placeBlock(b, b.xMm, b.yMm))
    page = p
    cursorY = headerReserve
    usedBottom = headerReserve
    recordsOnPage = 0
    hasContent = false
  }

  /**
   * 换页。
   * 关键防呆：如果当前页只有重复区、还没有任何内容，就**不要**再开新页，
   * 否则模板开头/结尾连续出现两个分页符时会产出整页空白（打印出来是一张白纸）。
   */
  function breakPage(): void {
    if (!hasContent && pages.length > 0) return
    startPage()
  }

  function placeBlock(b: MeasuredBlock, xMm: number, yMm: number): PlacedBlock {
    return {
      elementId: b.elementId,
      kind: b.kind,
      xMm: finite(xMm),
      yMm: finite(yMm),
      wMm: Math.max(0, finite(b.wMm)),
      hMm: Math.max(0, finite(b.hMm)),
      boxHMm: Math.max(0, finite(b.boxHMm)),
      html: b.html,
    }
  }

  function markRecord(p: PageModel, recordIndex: number): void {
    if (p.recordRange[0] === p.recordRange[1]) {
      p.recordRange[0] = recordIndex
      p.recordRange[1] = recordIndex + 1
      return
    }
    p.recordRange[0] = Math.min(p.recordRange[0], recordIndex)
    p.recordRange[1] = Math.max(p.recordRange[1], recordIndex + 1)
  }

  /**
   * 排内放置：算出本排每个块最终落在哪个 y。
   *
   * 为什么不能只按作者给的 y 摆（用户报的"画布上不重叠、打印出来重叠了"）：
   * 块的 y 是作者摆的绝对位置，但**高度是内容决定的** —— 文本一换行就比作者标的高。
   * 上面那个块的实测底边到了 11mm，而作者把下面那个块摆在 8mm，两者必然压在一起。
   *
   * 所以这里补一条硬约束：**同一纵栏（x 区间重叠）内，后放的块不得早于前一个的底边**。
   * 纯粹横向并排（x 不重叠）的块不受影响，仍严格按作者给的 y 落位，
   * "标签 + 值并排"这类排版不会被改坏。
   */
  function layoutRow(row: MeasuredRow, topY: number): PlacedBlock[] {
    const sorted = [...row.blocks].sort((a, b) => a.yMm - b.yMm || a.xMm - b.xMm)
    const out: PlacedBlock[] = []
    for (const b of sorted) {
      const x = finite(b.xMm)
      const w = Math.max(0, finite(b.wMm))
      let top = topY + (b.yMm - row.minYMm)
      for (const p of out) {
        const sameColumn = x < p.xMm + p.wMm - PAGE_EPS && p.xMm < x + w - PAGE_EPS
        if (sameColumn) top = Math.max(top, p.yMm + p.hMm)
      }
      out.push(placeBlock(b, x, top))
    }
    return out
  }

  /** 本排放置后真正占用的高度（会把"被内容顶下去"的量算进去，供放不下时换页判断） */
  function rowHeightOf(row: MeasuredRow, topY: number): number {
    const placed = layoutRow(row, topY)
    return placed.reduce((m, p) => Math.max(m, p.yMm + p.hMm), topY) - topY
  }

  /**
   * 把一排块落到当前页。
   *
   * @param clipBottomMm 需要**截断**时传版心底边（mm）：块的 y/h 会被裁到这个高度，
   *   整块落在它之外的直接不落。用于"超出可打印区的部分不打印"（2026-09-19 用户口径）。
   *   不传 = 不裁（默认，保持既有行为）。
   */
  function emitRow(row: MeasuredRow, topY: number, recordIndex: number, clipBottomMm?: number): void {
    // 排内偏移 = 块的 y **相对本排 y 最小值**的差。
    //
    // ⚠️ 这里曾经写成 `topY + b.yMm`，是个会累积放大的布局 bug：
    // cursor 里已经含了上一排的高度，而 y 又是"距版心顶部的绝对偏移"，
    // 两者相加等于把偏移算了两遍 —— 实测 y=0/6/12、h=6 的三个元素会被渲染到 0 / 12 / 30，
    // 行距逐行翻倍。Word 导入正是"y 累加"的约定，所以导入的模板排版会明显走样。
    // 减掉 minYMm 后，同一排内各块保持相对位置，排与排之间严丝合缝。
    const placed = layoutRow(row, topY)
    const kept =
      clipBottomMm == null
        ? placed
        : placed
            // 整块落在截断线之外 ⇒ 一个字都不印
            .filter((p) => p.yMm < clipBottomMm - PAGE_EPS)
            // 压线 ⇒ 高度裁到截断线（hMm 决定打印侧的 min-height，
            // 而页面盒本身是 overflow:hidden 的整纸高，所以超出的内容会被自然裁掉）
            .map((p) => ({ ...p, hMm: Math.max(0, Math.min(p.hMm, clipBottomMm - p.yMm)) }))
    for (const p of kept) page.blocks.push(p)
    // 游标取"放置后真实的底边"：同栏被顶下去的块会拉长本排高度，
    // 让下一排接着它排，否则下一排又会压上来。
    cursorY = kept.reduce((m, p) => Math.max(m, p.yMm + p.hMm), topY)
    usedBottom = Math.max(usedBottom, cursorY)
    // 分页符本身是"零高度、无内容"的块。如果把它算作内容，模板开头/结尾的
    // 分页符就会造出一整页空白（打印出来是一张白纸），所以这里显式排除它。
    if (cursorY - topY > 0.01 || row.blocks.some((b) => b.html.length > 0)) hasContent = true
    markRecord(page, recordIndex)
  }

  /**
   * 表格按行拆分（PRD F2-29：循环区高度不足时自动换页）。
   * 表头行在 repeatHeader 时**每一页片段都重新带上** —— 这是"打印出来第二页没有表头"
   * 这类用户投诉的根源，必须硬保证。
   */
  function splitTable(block: MeasuredBlock, recordIndex: number, startTop: number): void {
    const rows = block.tableRows ?? []
    const hh = Math.min(Math.max(0, block.headerRowCount ?? 0), rows.length)
    const headRows = rows.slice(0, hh)
    const bodyRows = rows.slice(hh)
    const headH = headRows.reduce((s, r) => s + finite(r.hMm), 0)

    if (bodyRows.length === 0) {
      // 只有表头，没有正文行：按普通整块处理
      emitRow(
        {
          rowId: block.elementId,
          blocks: [block],
          hMm: block.hMm,
          minYMm: finite(block.yMm),
          maxBottomMm: finite(block.yMm) + finite(block.hMm),
          forceBreakBefore: false,
          forceBreakAfter: false,
        },
        startTop,
        recordIndex,
      )
      return
    }

    let bodyStart = 0
    let first = true
    // 第一段从调用方算好的位置开始（已经含了该块在记录内的 y 偏移，不要再加一次）；
    // 后续片段从新页版心顶部开始
    const firstTop = startTop
    // 死循环保护：正常路径下每轮至少消费一行；加个上限纯属防御（表行数不可能超过它）
    for (let guard = 0; guard <= rows.length + 1; guard++) {
      if (bodyStart >= bodyRows.length) break

      const withHead = first || !!block.repeatHeader
      const startY = first ? firstTop : cursorY
      let y = startY + (withHead ? headH : 0)
      let end = bodyStart
      while (end < bodyRows.length && y + finite(bodyRows[end].hMm) <= contentH + PAGE_EPS) {
        y += finite(bodyRows[end].hMm)
        end++
      }
      if (end === bodyStart) {
        // 一行都放不下 → 至少放一行，避免死循环；位置必然溢出，记警告（E-41）
        y += finite(bodyRows[bodyStart].hMm)
        end = bodyStart + 1
        warnings.push({
          kind: 'row-split',
          message: '表格单行高度超出一整页，已强制放置并可能溢出（可在模板中设置"整行不跨页"）',
          elementId: block.elementId,
          pageIndex: page.index,
        })
      }

      // startRow 必须表达"这是续排片段"：>0 时 html 生成器才知道要克隆表头行。
      // 若这里写成 `withHead ? 0 : ...`，repeatHeader 的续排片段就会拿到 [0,total) 而**重复渲染整张表**。
      const startRow = first ? 0 : hh + bodyStart
      const endRow = hh + end
      // 注意：fragmentHtml 内部自行决定是否重复表头（它知道 repeatHeader 与 startRow）
      const html = block.tableFragmentHtml ? block.tableFragmentHtml(startRow, endRow) : block.html
      page.blocks.push({
        elementId: block.elementId,
        kind: 'table',
        xMm: finite(block.xMm),
        yMm: finite(startY),
        wMm: Math.max(0, finite(block.wMm)),
        hMm: Math.max(0, y - startY),
        // 表格走 auto 高度分支（`heightCss` 对 table 直接返回空串），所以这里给 0 即可
        boxHMm: 0,
        html,
      })
      cursorY = y
      usedBottom = Math.max(usedBottom, y)
      hasContent = true
      markRecord(page, recordIndex)

      bodyStart = end
      if (bodyStart < bodyRows.length) breakPage()
      first = false
    }
  }

  /**
   * 目标位置 = max(作者指定的绝对 y, 当前排版游标)。
   *
   * 取 max 的两层含义：
   *  - 正常情况 = 作者给的 y → **所见即所得**（编辑器画布就是按 y 在版式区内绝对定位画的）
   *  - 若前面内容因自动换行变高、把游标推到了该 y 之后 → 用游标兜底，保证不重叠
   *
   * 这与表头区（`placeBlock(b, b.xMm, b.yMm)` 绝对定位）在语义上对齐了，
   * 之前"流式游标 + 再加绝对 y"是把偏移算两遍，会产出逐行放大的空隙。
   *
   * ⚠️ **`recordTop` 是本记录在本页上的起点**（2026-09-18 真机反馈后补）。
   *
   * 作者给元素的是**记录内的相对 y**；而 `cursorY` 是**全页累积**的。
   * 旧式 `max(minYMm, cursorY)` 把两者直接比大小 ⇒ 第 2 条记录起，`cursorY` 已经很大，
   * `max()` 一律取到游标 ⇒ **记录内的相对间距被吃掉**，几条记录挤成一坨。
   * 用户原话："第一条记录的提交人和下方的表格位置关系是正常的……但后面几条排版就出问题了，挤在一起"。
   *
   * ⇒ 改成 `max(recordTop + 相对y, cursorY)`：**记录内**用"记录起点 + 相对 y"，
   * 游标只负责"不许压到前面已放的内容"。
   * 第 1 条记录时 `recordTop = 0` ⇒ 与旧式**逐字节等价**，所以既有断言不会被改动波及。
   */
  function rowTop(row: MeasuredRow, recordTop: number): number {
    return Math.max(recordTop + finite(row.minYMm), cursorY)
  }

  function placeRow(row: MeasuredRow, recordIndex: number, recordTop: number): void {
    /**
     * ⚠️ 先兜"作者把这一排摆到版心之外"（2026-09-18 飞书真机反馈后修正）。
     *
     * `rowTop(row) = max(minYMm, cursorY)`，而 `minYMm` 是作者在画布上的**绝对 y**。
     * 画布上纸张比版心大，所以作者**可以**把元素拖到版心下方（越界本来由画布的斜纹遮罩
     * 与检查条提示，见 F2-14）。但版心之外打印时**印不出来**，于是旧行为是：
     *   ① 判断"放不下" ⇒ `breakPage()` 开一张新页；
     *   ② `emitRow(row, rowTop(row))` 仍然用那个越界的 y ⇒ 块落在纸外，什么都印不出；
     *   ③ 净结果 = **元素静默消失 + 白多一页空白纸**
     *      （用户真机原话："该元素不会被打印出来，且最后会多一页空白的打印纸"）。
     *
     * PRD F2-30 的口径是"默认跨页更安全，**不丢数据**" ⇒ 这里**钳回页内并告警**，
     * 而不是让它消失。钳位点取 `max(cursorY, contentH - 本排高)`：
     * **尽量贴页底、但不早于排版游标**（早了会压到前面的内容），且不额外开新页。
     */
    const authoredTop = finite(row.minYMm)
    if (authoredTop >= contentH - PAGE_EPS) {
      /**
       * 整排都在可打印区之下 ⇒ **不打印**（2026-09-19 用户口径）。
       *
       * 用户原话："把元素拖到超出灰色虚线，那么这个元素会被放在第二个页面打印，
       * 即一个模板会拆分成两页……改为**直接强制切段，超出的部分不打印**。"
       *
       * ⚠️ 口径变更说明：上一轮这里是"**钳回页内**"（PRD F2-30"不丢数据"）。
       * 用户明确推翻了它 —— 他要的是"摆在外面就不印"，而不是"悄悄挪回来印"。
       * 但**仍然告警**：静默消失是这个项目最忌讳的形状，
       * 用户必须能从报告里知道"有个东西在灰虚线外面、这次没印"。
       *
       * 注意这里只针对"**整块**在可打印区之外"。若只是**压线**（起点在里面、底边在外面），
       * 那属于正常分页（清单类模板必须能把一条记录排到下一页），不做截断。
       */
      warnings.push({
        kind: 'out-of-bounds',
        message:
          '这一排整个被摆到了可打印区域（版心）之外，**这次不会打印它** —— ' +
          '可打印区 = 纸张减去上下页边距（画布上就是那圈灰虚线），没印出来的部分不会留白补位；' +
          '请把它拖回灰虚线以内，或把纸张 / 页边距调大',
        elementId: row.rowId,
        pageIndex: page.index,
      })
      return
    }

    // 换页判断必须用**放置后**的高度：同栏块被顶下去时本排会变高，
    // 用作者原始跨度（row.hMm）判断会让变高的排刚好卡在页底，底部被裁掉。
    if (rowTop(row, recordTop) + rowHeightOf(row, rowTop(row, recordTop)) <= contentH + PAGE_EPS) {
      emitRow(row, rowTop(row, recordTop), recordIndex)
      return
    }

    // 放不下：独占一个可拆分表格 → 按行拆到多页
    if (row.table && !row.table.keepTogether) {
      // 先看整张表能不能在**下一个空页**里装下：能装就整表换页，
      // 避免为了填满当前页底部而产出"只带一行正文"的丑陋碎片。
      const topOnFreshPage = Math.max(recordTop + authoredTop, headerReserve)
      if (hasContent && topOnFreshPage + rowHeightOf(row, topOnFreshPage) <= contentH + PAGE_EPS) {
        breakPage()
        // 换到新页 ⇒ 本记录在新页上的起点回到版心顶
        emitRow(row, rowTop(row, 0), recordIndex)
        return
      }
      splitTable(row.table, recordIndex, rowTop(row, recordTop))
      return
    }

    // 其它情况整排换页（keepTogether / break-inside: avoid 的语义）
    const hadContent = hasContent
    breakPage()
    // 换到新页 ⇒ 本记录在新页上的起点回到版心顶（recordTop 重置为 0）
    if (rowTop(row, 0) + rowHeightOf(row, rowTop(row, 0)) > contentH + PAGE_EPS) {
      // 换到空页依然放不下 → 强制放置并告警（PRD F2-30：默认跨页更安全，不丢数据）
      if (hadContent) {
        warnings.push({
          kind: 'row-split',
          message: '单行内容高于一整页，已强制放置并可能溢出（可在模板中开启"整行不跨页"改为另起一页）',
          elementId: row.rowId,
          pageIndex: page.index,
        })
      }
    }
    emitRow(row, rowTop(row, 0), recordIndex)
  }

  // ---- 逐记录、逐排填页 ----
  startPage()
  for (const g of input.records) {
    // 记录模板默认模式：一份记录一张纸（PRD F5-07 / F2-32）
    if (input.batchLayout === 'default' && hasContent) breakPage()
    // 视图模板"每 N 条一页"（PRD F5-09）
    const perPageN = input.perPageN ?? null
    if (perPageN && perPageN > 0 && recordsOnPage >= perPageN) breakPage()

    /**
     * **本记录在本页上的起点**（见 `rowTop` 的注释）。
     *
     * 本页还没有任何内容 ⇒ 0（版心顶；此时与旧式 `max(y, cursorY)` 等价，
     * 所以第 1 条记录的行为逐字节不变）；已有内容 ⇒ 接在上一条的底边之后。
     * 换页（`breakPage()`）会把 `cursorY` 重置成 `headerReserve`，所以这里跟着重取。
     */
    let recordTop = hasContent ? cursorY : 0
    const rows = groupIntoRows(g.blocks)
    for (const row of rows) {
      if (row.forceBreakBefore) {
        breakPage()
        recordTop = 0
      }
      placeRow(row, g.recordIndex, recordTop)
      if (row.forceBreakAfter) {
        breakPage()
        recordTop = 0
      }
    }
    recordsOnPage++
    if (rows.length === 0) markRecord(page, g.recordIndex)
  }

  // ---- 表尾区：仅最后一页；放不下就单独占一页 ----
  if (footerBlocks.length > 0) {
    if (hasContent && usedBottom + footerReserve > contentH + PAGE_EPS) {
      startPage()
    }
    if (pages.length === 0) startPage()
    const top = Math.max(0, contentH - footerReserve)
    for (const b of footerBlocks) page.blocks.push(placeBlock(b, b.xMm, top + b.yMm))
    hasContent = true
  }

  if (pages.length === 0) startPage()

  return { pages, warnings }
}

/** 兼容只关心页面的调用方 */
export function paginatePages(input: LayoutInput): PageModel[] {
  return paginate(input).pages
}
