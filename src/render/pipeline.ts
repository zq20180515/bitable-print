/**
 * 渲染流水线：把「模板 + 记录 + 已解析图片」变成「可直接预览/打印的 HTML + 分页模型」。
 *
 * 顺序严格对齐 PRD BP-5 / BP-6：
 *   图片预取（由调用方在**进入预览前**完成，见 RenderContext.images）
 *     → 元素树渲染成块 HTML
 *     → 异步分批测量高度
 *     → 分页
 *     → 输出 HTML（预览与打印共用这一份）
 *
 * 为什么要"分批让出主线程"（F2-33 / E-43）：侧边栏是一个 320~400px 的窄 iframe，
 * 与主表格共用同一个渲染进程。一次性测量几百个块会让整个多维表格卡住两三秒，
 * 用户会以为插件崩了。因此每处理约 30 个块就 `await requestAnimationFrame` 让出一次。
 */

import type { AnyElement, TemplateDoc, TableElement } from '../lib/types'
import { finite, pageRenderSize, PT_TO_MM } from '../lib/types'
import type { RecordItem } from '../lib/data-source'
import { formatDateTime } from '../lib/field-types'
import type { MeasuredBlock, RecordGroup } from './layout'
import { paginate } from './layout'
import type { RenderContext, RenderWarning, RenderedDoc } from './context'
import { dedupeWarnings } from './context'
import type { MeasureHost, MeasureItem } from './measure'
import { canMeasure, createMeasureHost, measureBlocks, yieldToHost } from './measure'
import {
  buildDocumentHtml,
  contentBoxOf,
  MEASURE_PAGE_PLACEHOLDER,
  planLoopTable,
  renderElement,
  renderLoopTableRows,
  renderTableRows,
  replacePageTokens,
  tableHeaderRowCount,
  tableRepeatHeader,
  type RenderScope,
} from './html'

// ============================================================
// 入参
// ============================================================

export interface PipelineInput {
  doc: TemplateDoc
  /** 打印范围内的记录（已由数据层拉取并筛选好） */
  records: RecordItem[]
  /** 渲染上下文：字段、图片、系统变量。**渲染器不发任何网络请求** */
  ctx: RenderContext
  /**
   * 聚合进度回调（"渲染 + 测量"两阶段合并计数，保证单调递增）。
   * 注意：这里的 total 是**内容块数量**，不是记录数量。
   */
  onProgress?: (done: number, total: number) => void
  signal?: AbortSignal
  /** 页面标题（写进 <title>） */
  title?: string
  /** 预览模式：屏幕上加纸张阴影；打印时自动关闭 */
  forPreview?: boolean
  /** 供单测/特殊环境注入测量宿主；不传则自动创建 */
  measureHost?: MeasureHost
  /** 置 true 可跳过 DOM 测量（Node 自测用） */
  skipMeasure?: boolean
}

/** 内部使用：比 MeasuredBlock 多几个构建期信息 */
interface BuiltBlock extends MeasuredBlock {
  /** 是否还需要 DOM 测量高度（显式给了 h 的块也要量：见 `boxHMm`） */
  needMeasure: boolean
  measureRows: boolean
  /**
   * 作者**显式设定的盒子高度**（mm）；`h:'auto'` 时为 0。
   *
   * 为什么要留着它：h 是"盒子高"，不是"内容高"。文本一换行、图片一按宽高等比放大，
   * 内容就会顶出盒子。旧实现直接拿 h 当占位高度，于是下面那个元素被摆在盒子上，
   * 打出来两个元素叠在一起（用户报的"画布上不重叠、打印出来重叠"）。
   * 现在 hMm 取 max(盒子高, 内容高)，盒子高只作**下限**，另存一份用于给出告警文案。
   */
  boxHMm: number
  /** 表格原始行数（测量失败时按行均分估算用） */
  rowCount?: number
  /** 该块渲染时使用的上下文（表格片段重渲染要用） */
  scope: RenderScope
  /**
   * 该块是"多记录并成一张大表"（`rowsFromRecords`）的产物。
   *
   * 它不属于任何单独一条记录，因此测量键**必须与记录无关**：
   * 测量键是按 elementId + recordId 去重的，若沿用记录维度的键，
   * 同一张表会被当成 N 个块测 N 次，`rowHeightsMm` 互相覆盖、分页随之失效。
   */
  mergedRecords?: boolean
}

const BATCH = 30
/** 盒子高比内容高矮多少才告警（mm）。0.5mm 以下属于浮点/四舍五入噪声，报了只会烦人 */
const BOX_OVERFLOW_WARN_MM = 0.5
/** 只给告警文案用：免得出现 11.110000000000001 这种鬼数字 */
const round2 = (n: number): number => Math.round(n * 100) / 100
const MEASURE_KEY = (elementId: string, recordId: string | null | undefined): string => `${elementId}@${recordId ?? 'none'}`
/**
 * 合并大表的测量键后缀。
 * 该块跨所有记录，键不能带 recordId —— 一张表只能被测量一次（否则行高互相覆盖）。
 */
const MERGED_MEASURE_SCOPE = '__all_records__'

/**
 * ⛔ 这里原本有一份 `yieldToHost` 的**副本**（与 `measure.ts` 里那份逐字节相同）。
 * 2026-09-21 收口成一份：两份都踩同一个坑，而"改一份忘一份"正是本项目吃过多次的亏。
 * 坑本身写在 `measure.ts` 的 `yieldToHost` 上 —— **隐藏页里 rAF 不触发 ⇒ 分批循环永久停住**。
 */

/** 行内节点里的纯文本长度，用于测量失败时的兜底估算 */
function inlineTextLength(nodes: unknown): number {
  if (!Array.isArray(nodes)) return 0
  let n = 0
  for (const v of nodes) {
    const o = v as { type?: string; text?: string }
    if (o?.type === 'text') n += String(o.text ?? '').length
    else n += 8 // 字段 / 系统变量按 8 个字估算
  }
  return n
}

function elementsTextLength(el: AnyElement): number {
  if (el.kind === 'text') return inlineTextLength(el.nodes)
  if (el.kind === 'fieldBlock') return 12
  return 0
}

/**
 * 测量不可用时的兜底高度（mm）。
 * 只在"非浏览器环境"或容器被移除时命中；目的是避免 0 高度导致所有块叠在一起，
 * 而不是为了得到正确分页 —— 真机环境下测量一定是可用的。
 */
function fallbackHeightMm(el: AnyElement, widthMm: number): number {
  const chars = elementsTextLength(el)
  if (chars > 0) {
    const ptSize = finite(el.style?.fontSizePt, 10.5)
    const lineH = finite(el.style?.lineHeightPt, ptSize * finite(el.style?.lineHeight, 1.5)) * PT_TO_MM
    const perLine = Math.max(1, Math.floor(widthMm / Math.max(0.5, ptSize * PT_TO_MM * 1.05)))
    return Math.max(6, Math.ceil(chars / perLine) * lineH)
  }
  return typeof el.h === 'number' && el.h > 0 ? el.h : 8
}

// ============================================================
// 元素 → 块
// ============================================================

interface BandBuildOptions {
  /** 该版式区内的 y 偏移（循环区的 offsetMm） */
  yOffsetMm?: number
}

function buildBlocks(
  elements: AnyElement[],
  scope: RenderScope,
  ctx: RenderContext,
  bands: BandBuildOptions,
  warnings: RenderWarning[],
): BuiltBlock[] {
  const out: BuiltBlock[] = []
  const yOffset = finite(bands.yOffsetMm, 0)
  for (const el of elements) {
    const wMm = Math.max(0, finite(el.w))
    const hNum = typeof el.h === 'number' && el.h > 0 ? el.h : null
    // 每个元素有**自己的**容器宽度：表格按元素宽度渲染列宽，
    // 附件按元素宽度换行。用版心宽度会把窄元素渲染错，进而量错高度。
    const elScope: RenderScope = {
      ...scope,
      widthMm: wMm > 0 ? wMm : scope.widthMm,
      heightMm: hNum ?? undefined,
    }
    const res = renderElement(el, elScope, ctx)
    warnings.push(...res.warnings)

    const base: BuiltBlock = {
      elementId: el.id,
      kind: el.kind,
      xMm: Math.max(0, finite(el.x)),
      yMm: Math.max(0, finite(el.y)) + yOffset,
      wMm: elScope.widthMm,
      hMm: 0,
      html: res.html,
      needMeasure: false,
      measureRows: false,
      boxHMm: 0,
      scope: elScope,
    }

    if (el.kind === 'pagebreak') {
      // 分页符不产出可见内容，只表达"此处强制另起一页"（F2-31）
      base.forceBreakAfter = true
      out.push(base)
      continue
    }

    if (el.kind === 'table') {
      const t = el as TableElement
      base.needMeasure = true
      base.measureRows = true
      base.rowCount = t.rows.length
      base.headerRowCount = tableHeaderRowCount(t)
      base.repeatHeader = tableRepeatHeader(t)
      base.tableFragmentHtml = (startRow: number, endRow: number): string => {
        const frag = renderTableRows(t, startRow, endRow, elScope, ctx)
        warnings.push(...frag.warnings)
        return frag.html
      }
      // 显式高度只能当"下限"：表格真实高度必须由行高推出，否则按行拆分必错
      base.hMm = hNum ?? 0
      out.push(base)
      continue
    }

    if (hNum !== null) {
      // 显式 h 只是"盒子高"，不是"内容高"：内容照样可能更高（文本换行、图片按宽等比放大），
      // 所以显式 h 的块**也要量一次**，量出来比盒子高就撑大 hMm（见 boxHMm 注释）。
      base.boxHMm = hNum
      base.hMm = hNum
      base.needMeasure = true
    } else {
      base.needMeasure = true
    }
    out.push(base)
  }
  return out
}

// ============================================================
// 循环区「多记录并成一张大表」（TableElement.rowsFromRecords）
// ============================================================

/** 该元素是不是声明了"由记录铺行"的表格 */
function isRowsFromRecordsTable(el: AnyElement): el is TableElement {
  return el.kind === 'table' && (el as TableElement).rowsFromRecords === true
}

/**
 * 判定能否走"一张连续大表"。
 *
 * ⚠️ **2026-09-23 第二次反馈第 7 条：放宽了"循环区恰好一个元素"这条限制。**
 *
 * 用户原话：「表格下方**无**其他元素 ⇒ 打印出来是台账；表格下方**有**其他元素 ⇒ 打印出来是一份份单据。
 * 不论是否设置了标题行……修复这个 BUG，应当能由用户决定」。
 * 起因就是原来那条限制：循环区只要多一个元素就**退化成按记录重复**，
 * 而 UI 侧的开关又因为同一条判据被禁用，用户**既改不了也看不出为什么**。
 *
 * 现在的判据只剩两条：
 *   1. 循环区里**声明了 `rowsFromRecords` 的表格恰好一个**（多张同时铺行无法定义先后 ⇒ 退回并告警）；
 *   2. 至少有一条记录（没有记录时合并只会产出孤零零一个表头）。
 *
 * 循环区里**其它元素**的处理见下面 `mergedTable` 分支：只按第一条记录渲染一次、排在表格之后。
 */
function mergedLoopTableOf(loopElements: AnyElement[], recordCount: number): TableElement | null {
  if (recordCount <= 0) return null
  const declared = loopElements.filter(isRowsFromRecordsTable)
  return declared.length === 1 ? declared[0] : null
}

/**
 * 构建"一张连续大表"的块：表头行一份 + 每条记录各一遍数据行。
 *
 * 只产出**一个**块，并以 `mergedRecords` 标记，使测量键与记录无关（见 BuiltBlock 注释）。
 * 分页不在这里做：把完整的逐行高度交给 `splitTable`，它已经能按行拆分并每页重复表头（F2-29）。
 *
 * 已知语义边界：`perPageN`（视图模板"每 N 条强制分页"）与合并大表天然冲突 ——
 * 合并后表格按页高连续铺行，不再按记录边界分页。模板声明 rowsFromRecords 即视为
 * 用户选择了"连续台账"，此时不再叠加每 N 条分页。
 */
function buildMergedLoopTableBlock(
  table: TableElement,
  records: RecordItem[],
  ctx: RenderContext,
  contentW: number,
  yOffsetMm: number,
  warnings: RenderWarning[],
): BuiltBlock {
  // 与 buildBlocks 保持一致：元素宽度为 0 时退回版心宽度
  const wNum = Math.max(0, finite(table.w))
  const wMm = wNum > 0 ? wNum : contentW
  const hNum = typeof table.h === 'number' && table.h > 0 ? table.h : null
  const scopeOfRecord = (i: number): RenderScope => ({
    record: records[i] ?? null,
    recordIndex: i,
    widthMm: wMm,
    heightMm: hNum ?? undefined,
    elementId: table.id,
  })
  const plan = planLoopTable(table, records.length)

  const tableFragmentHtml = (startRow: number, endRow: number): string => {
    const frag = renderLoopTableRows(table, plan, startRow, endRow, scopeOfRecord, ctx)
    warnings.push(...frag.warnings)
    return frag.html
  }

  return {
    elementId: table.id,
    kind: 'table',
    xMm: Math.max(0, finite(table.x)),
    yMm: Math.max(0, finite(table.y)) + yOffsetMm,
    wMm,
    hMm: hNum ?? 0,
    html: tableFragmentHtml(0, plan.totalRows),
    needMeasure: true,
    measureRows: true,
    boxHMm: hNum ?? 0,
    // 行数是**虚拟行数**：测量失败时按它均分，才能得到"整张大表"的高度
    rowCount: plan.totalRows,
    headerRowCount: plan.headerCount,
    repeatHeader: tableRepeatHeader(table),
    tableFragmentHtml,
    mergedRecords: true,
    scope: scopeOfRecord(0),
  }
}

// ============================================================
// 主流程
// ============================================================

export async function renderDocument(input: PipelineInput): Promise<RenderedDoc> {
  const { doc, records } = input
  const warnings: RenderWarning[] = []
  const box = contentBoxOf(doc.pageSetup)
  const contentW = box.w
  const contentH = box.h

  // 系统变量的"数据总条数"优先用上下文给的，缺省退化成"本次范围条数"
  const ctx: RenderContext = {
    ...input.ctx,
    totalRows: input.ctx.totalRows > 0 ? input.ctx.totalRows : records.length,
    // ${打印时间} 在**进入渲染时取一次**：如果每个块各取一次 new Date()，
    // 一篇跨分钟的文档会出现两个打印时间，用户会怀疑打的是两份不同的东西。
    printTime: input.ctx.printTime || formatDateTime(Date.now(), 'YYYY-MM-DD HH:mm'),
  }

  const loopElements = doc.bands.loop?.elements ?? []
  /*
   * 表头区 / 表尾区的**启用开关**（2026-09-23 第二次反馈：「表头区和表尾区在侧边属性中选择开启或者关闭」）。
   *
   * 缺省（字段不存在，含所有老模板）= 启用 ⇒ 行为逐字节不变。
   * 关闭的做法就是"给渲染层一个空数组" —— 这样 `paginate` 那边一行都不用改：
   * 没有 header 块 ⇒ `headerReserve = 0`；没有 footer 块 ⇒ 正文下界回到版心下界。
   * ⚠️ 画布**不受影响**（元素还在、还能编辑），只有打印/预览跳过它们。
   */
  const headerElements = doc.bands.headerEnabled === false ? [] : (doc.bands.header ?? [])
  const footerElements = doc.bands.footerEnabled === false ? [] : (doc.bands.footer ?? [])
  const firstRecord = records.length > 0 ? records[0] : null
  const lastRecord = records.length > 0 ? records[records.length - 1] : null

  // 循环区外（每页重复区）的字段占位符渲染**首行值**（PRD F2-16）
  const headerBlocks = buildBlocks(
    headerElements,
    { record: firstRecord, recordIndex: 0, widthMm: contentW },
    ctx,
    {},
    warnings,
  )
  const footerBlocks = buildBlocks(
    footerElements,
    { record: lastRecord, recordIndex: Math.max(0, records.length - 1), widthMm: contentW },
    ctx,
    {},
    warnings,
  )

  /*
   * 循环区起始位置（**绝对** mm，版心坐标系）。
   *
   * ⚠️ 必须是 `max(声明值, 表头块实测高度)`，**不能**写成 `max(0, 声明值 - 表头高度)`。
   * 后者是 2026-09-23 真机反馈第 3 条（「拖动表头区的元素时，会带动循环区的元素移动」）
   * 在渲染侧的同款毛病：表头内容一变，循环区就跟着上下跑。
   * 而且它与 `el.y` 的语义对不上 —— `el.y` 是**相对循环区起点**的偏移，
   * 那么起点本身就应该是这个绝对值。
   *
   * 画布侧 `Canvas.tsx` 的 `loopStartMm` 用的是**同一个公式**（把实测换成估算）。
   * 两边一致 ⇒ 画布上摆在哪、打印就落在哪。
   */
  const headerReserve = headerBlocks.reduce((m, b) => Math.max(m, b.yMm + b.hMm), 0)
  const loopOffset = Math.max(finite(doc.bands.loop?.offsetMm), headerReserve)

  // ---- 循环区：能否合并成"一张连续大表" ----
  const mergedTable = mergedLoopTableOf(loopElements, records.length)
  // 声明了 rowsFromRecords 却放不进这个形状时**必须出警告**，不能静默按记录重复，
  // 否则用户以为拿到的是连续台账、实际是 N 张各带表头的小表。
  // ⚠️ 2026-09-23 第 7 条放宽判据后，唯一还会落到这里的情况是
  //    「循环区里有**多张**表都声明了按记录铺行」—— 那才是真的无法确定先后。
  if (mergedTable === null && records.length > 0) {
    const declared = loopElements.filter(isRowsFromRecordsTable)
    if (declared.length > 1) {
      warnings.push({
        kind: 'loop-table-conflict',
        message:
          `循环区里有 ${declared.length} 张表格都勾选了「多条记录排进同一张表」，无法确定谁先谁后，` +
          '已退回"每条记录重复渲染一遍"的方式。请只保留一张开启该选项。',
        elementId: declared[0].id,
      })
    }
  }

  const loopBlockCount = mergedTable ? 1 : loopElements.length * records.length
  const total = Math.max(1, headerBlocks.length + loopBlockCount + footerBlocks.length)
  const half = Math.ceil(total / 2)
  const groups: RecordGroup[] = []
  const loopBuilt: BuiltBlock[][] = []
  let mergedBlock: BuiltBlock | null = null
  let built = 0
  let sinceYield = 0

  if (mergedTable) {
    // 所有记录进**同一个** RecordGroup：分页看到的是一张表，而不是 N 张
    mergedBlock = buildMergedLoopTableBlock(mergedTable, records, ctx, contentW, loopOffset, warnings)
    /*
     * ⚠️ 循环区里**表格之外**的元素（2026-09-23 第 7 条放宽判据后新增的分支）。
     *
     * 放宽之前"循环区只有这一个元素"是硬前提，所以这条分支根本不存在；
     * 放宽之后必须补上 —— 否则那些元素会**整块静默消失**（不报错、不告警，只是没了，最坏的那种）。
     *
     * 口径：**只按第一条记录渲染一次**，排在表格之后。
     * 这与"视图模板里表格外的元素只在第一页出现一次"是同一套语义（2026-09-23 用户拍板）。
     * 位置靠 layout 的**游标兜底**（`rowTop = max(recordTop + y, cursorY)`）自然落到表格下方：
     * 模板里它们本来就在表格下面、y 更大，而表格铺完 N 行后游标已经越过它们。
     */
    const others = loopElements.filter((el) => el.id !== mergedTable.id)
    const otherBlocks =
      others.length > 0
        ? buildBlocks(
            others,
            { record: records[0] ?? null, recordIndex: 0, widthMm: contentW },
            ctx,
            { yOffsetMm: loopOffset },
            warnings,
          )
        : []
    if (others.length > 0) {
      warnings.push({
        kind: 'loop-table-conflict',
        // ⚠️ `elementId` 必须给：用户要能点着这条提示跳到那张表上去改（这里的"那张表"就是被合并的这张）
        elementId: mergedTable.id,
        message:
          '「多条记录排进同一张表」已开启：循环区里表格之外的其它元素**只会按第一条记录渲染一次**（排在表格下方）。' +
          '若希望它们每条记录都重复一遍，请把那些元素移到「表尾区」，或者关掉这个选项。',
      })
    }
    /*
     * ⚠️ 表格与其它元素**必须分成两个 RecordGroup** —— 这是 2026-09-23 第二次反馈第 1 条的**真凶**。
     *
     * 放进同一组时，`groupIntoRows` 会按"块的 y 落在上一排的纵向跨度内"判为同一排
     * （`layout.ts` 的 `sameRow = b.yMm < last.maxBottomMm - PAGE_EPS`）——
     * 而合并大表的 `hMm` 是**所有记录铺开后的高度**，于是排在表格下方的元素**必然落进表格那一排**。
     * 那一排里有两个块 ⇒ `row.table` 不成立 ⇒ 失去"按行拆到多页"的资格
     * ⇒ `placeRow` 只能整排硬塞进当前页。
     * 症状正是用户截图那样：**27 行全在第一页，第二页到最后一页全空白**（打印 11 页却只有第 1 页有内容）。
     *
     * 分成两组之后，靠 layout 的 `recordTop = hasContent ? cursorY : 0` 把第二组排在表格**之后**，
     * 既不同排、位置也对。
     */
    groups.push({ recordIndex: 0, blocks: [mergedBlock] })
    if (otherBlocks.length > 0) groups.push({ recordIndex: 0, blocks: otherBlocks })
    loopBuilt.push([mergedBlock, ...otherBlocks])
    built += 1 + otherBlocks.length
  } else {
    for (let i = 0; i < records.length; i++) {
      if (input.signal?.aborted) break
      const blocks = buildBlocks(
        loopElements,
        { record: records[i], recordIndex: i, widthMm: contentW },
        ctx,
        { yOffsetMm: loopOffset },
        warnings,
      )
      groups.push({ recordIndex: i, blocks })
      loopBuilt.push(blocks)
      built += blocks.length
      sinceYield += blocks.length
      if (sinceYield >= BATCH) {
        sinceYield = 0
        input.onProgress?.(Math.min(half, Math.round((built / total) * half)), total)
        await yieldToHost()
      }
    }
  }
  input.onProgress?.(half, total)

  // ---- 测量：只量"高度未知 / 表格"的块，显式高度的块直接跳过，省掉一整轮 DOM 操作 ----
  const byKey = new Map<string, BuiltBlock>()
  const measureItems: MeasureItem[] = []
  const collect = (list: BuiltBlock[]): void => {
    for (const b of list) {
      if (!b.needMeasure) continue
      // 合并大表不属于任何一条记录 → 键里不能带 recordId，否则同一张表会被测 N 次
      const key = b.mergedRecords
        ? MEASURE_KEY(b.elementId, MERGED_MEASURE_SCOPE)
        : MEASURE_KEY(b.elementId, b.scope.record?.recordId)
      if (byKey.has(key)) continue
      byKey.set(key, b)
      // 测量**单独**把页码令牌换成等宽数字占位（见 MEASURE_PAGE_PLACEHOLDER）：
      // 令牌有 8/9 个字符、最终只会变成一两个数字，直接量会把窄框的页码元素多算一整行。
      // 只换这一份入参，`b.html`（也就是最终产物）保持令牌不动，等分页后逐页替换。
      measureItems.push({
        elementId: key,
        html: replacePageTokens(b.html, MEASURE_PAGE_PLACEHOLDER, MEASURE_PAGE_PLACEHOLDER),
        widthMm: b.wMm,
        measureRows: b.measureRows,
      })
    }
  }
  collect(headerBlocks)
  collect(footerBlocks)
  for (const list of loopBuilt) collect(list)

  const useMeasure = !input.skipMeasure && canMeasure() && measureItems.length > 0
  let measured = new Map<string, { elementId: string; heightMm: number; rowHeightsMm?: number[]; ok: boolean }>()
  let host: MeasureHost | null = null
  if (useMeasure) {
    try {
      host = input.measureHost ?? createMeasureHost()
      measured = await measureBlocks(host, measureItems, {
        batchSize: BATCH,
        signal: input.signal,
        onProgress: (done, totalItems) => {
          // 渲染阶段占前半程，测量阶段占后半程，合并成一条单调递增的进度
          const ratio = done / Math.max(1, totalItems)
          input.onProgress?.(Math.min(total, half + Math.round(ratio * (total - half))), total)
        },
      })
    } catch {
      // 测量环境异常不应该让整个渲染失败：降级为估算兜底
      measured = new Map()
    } finally {
      host?.destroy()
    }
  }
  const measureAllFailed =
    useMeasure && measureItems.length > 0 && [...measured.values()].every((m) => !m.ok)

  for (const [key, b] of byKey) {
    const m = measured.get(key)
    if (b.kind === 'table') {
      const rowHeights = m?.rowHeightsMm
      if (rowHeights && rowHeights.length > 0) {
        b.tableRows = rowHeights.map((h, i) => ({
          rowId: `${b.elementId}_r${i}`,
          hMm: finite(h),
          isHeader: i < (b.headerRowCount ?? 0),
        }))
        b.hMm = Math.max(b.hMm, rowHeights.reduce((s, v) => s + finite(v), 0))
      } else {
        // 量不到行高：按行数均分估算，保证"按行拆分 + 每页重复表头"这条路径不会因 0 高度而失效
        const rows = Math.max(1, b.rowCount ?? 1)
        const each = Math.max(4, b.hMm > 0 ? b.hMm / rows : 8)
        b.tableRows = Array.from({ length: rows }, (_, i) => ({
          rowId: `${b.elementId}_r${i}`,
          hMm: each,
          isHeader: i < (b.headerRowCount ?? 0),
        }))
        b.hMm = each * rows
      }
    } else if (b.needMeasure) {
      const contentH = m && m.ok && m.heightMm > 0 ? m.heightMm : 0
      if (contentH > 0) {
        // 内容只会把盒子**撑大**，绝不会缩小：作者显式设定的 h 是下限。
        // （否则"特意留白的文本框""想占位但内容很少的元素"会被内容压扁、后面的元素整体上移。）
        b.hMm = Math.max(b.hMm, contentH)
        // 量到了、而且确实比盒子高 → 明确告警。这正是"画布上不重叠、打印出来重叠"的诱因：
        // 用户以为自己画的是 6mm 高的框，实际内容要 11mm。
        //
        // ⚠️ 文案里**只放作者设定的盒子高**，不放实测内容高：`element-overflow` 是按
        // `kind|elementId|message` 模板级去重的，而实测高度是**逐条记录**变的
        // （每条记录的值长短不同），一旦写进 message，同一个元素就会按记录数刷出十几条
        // 几乎一样的提示，把问题清单淹掉。盒子高是模板属性，写进来正好稳定。
        if (b.boxHMm > 0 && contentH > b.boxHMm + BOX_OVERFLOW_WARN_MM) {
          warnings.push({
            kind: 'element-overflow',
            message: `元素设定高度 ${round2(
              b.boxHMm,
            )}mm 小于内容实际高度，已按内容高度排版（下方元素会自动顺移；在画布上拉高该元素可消除此提示）`,
            elementId: b.elementId,
            recordId: b.scope.record?.recordId,
          })
        }
      } else if (b.hMm <= 0) {
        // 量不到（无头环境 / 测量失败）：保持旧行为 —— 用估算高度兜底，或沿用显式 h。
        // 这里**刻意不**把 max(盒子高, 估算高) 写进来：估算值没有实测可信，
        // 让它反过来撑大盒子只会在非浏览器环境里凭空改掉分页结果。
        const el = findElement(doc, b.elementId)
        b.hMm = el ? fallbackHeightMm(el, b.wMm) : 8
      }
    }
  }

  if (measureAllFailed) {
    warnings.push({
      kind: 'element-overflow',
      message: '当前环境无法测量元素真实高度（可能未在浏览器中渲染），已按估算高度分页，结果仅供参考',
    })
  }

  // ---- 元素超界检查（PRD F2-14 / E-44：提示级，不阻止操作） ----
  const checkOverflow = (list: BuiltBlock[]): void => {
    for (const b of list) {
      if (b.wMm <= 0 || b.kind === 'pagebreak') continue
      const overRight = b.xMm + b.wMm > contentW + 0.1
      // 会被按行拆到多页的表格不算"纵向超界"，否则每张稍大的表格都会误报
      // （它本来就会被拆分并逐页重复表头，属于正常分页，不是排版错误）
      const splittable = b.kind === 'table' && !b.keepTogether && (b.tableRows?.length ?? 0) > 0
      const overBottom = !splittable && b.yMm + b.hMm > contentH + 0.1
      if (overRight || overBottom) {
        warnings.push({
          kind: 'element-overflow',
          message: `元素超出可打印区域（${overRight ? '右侧' : ''}${overRight && overBottom ? '、' : ''}${
            overBottom ? '下方' : ''
          }越界），打印时会被裁剪`,
          elementId: b.elementId,
          recordId: b.scope.record?.recordId,
        })
      }
    }
  }
  checkOverflow(headerBlocks)
  checkOverflow(footerBlocks)
  for (const list of loopBuilt) checkOverflow(list)

  // ---- 分页 ----
  const layout = paginate({
    headerBlocks,
    records: groups,
    footerBlocks,
    contentHeightMm: contentH,
    batchLayout: ctx.batchLayout,
    perPageN: ctx.perPageN,
  })
  warnings.push(...layout.warnings)

  // 合并大表的分页是把**同一张表**切成多个续排片段，所有片段都覆盖同一批记录，
  // 所以这些页的记录区间是 [0, 记录数) 而不是只有第一条（分页器只认 RecordGroup 的起始下标，
  // 单张跨记录的表无法在那里表达"到第几条"，所以在结果上补齐）。
  if (mergedBlock && records.length > 1) {
    for (const p of layout.pages) {
      if (p.blocks.some((b) => b.elementId === mergedBlock!.elementId)) p.recordRange = [0, records.length]
    }
  }

  // ---- 输出 HTML（预览与打印共用这一份，F5-01） ----
  const html = buildDocumentHtml(layout.pages, doc.pageSetup, ctx, {
    title: input.title,
    forPreview: input.forPreview,
  })

  const size = pageRenderSize(doc.pageSetup)
  return {
    pages: layout.pages,
    html,
    pageWidthMm: size.w,
    pageHeightMm: size.h,
    marginMm: doc.pageSetup.margin,
    warnings: dedupeWarnings(warnings),
  }
}

function findElement(doc: TemplateDoc, id: string): AnyElement | null {
  const pools: AnyElement[][] = [doc.bands.header ?? [], doc.bands.loop?.elements ?? [], doc.bands.footer ?? []]
  for (const pool of pools) {
    for (const el of pool) if (el.id === id) return el
  }
  return null
}
