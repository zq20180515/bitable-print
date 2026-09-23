/**
 * IR → TemplateDoc 映射（PRD F3.2 还原范围 / 附录 B 支持矩阵）
 *
 * 这里做三件容易出错的事，都在下面各自有注释说明：
 * 1) **版式区切分**：循环标签圈出的区间进 `loop`，其前的内容进 `header`（每页重复），
 *    其后的内容进 `footer`（仅末页）。没有循环标签时全部进 `loop`。
 * 2) **流式定位**：模板元素需要 y 坐标，但 Word 是流式排版、我们是绝对定位，
 *    所以必须做**行高估算**（prose 里没有排版引擎可用）。估算公式集中在
 *    `estimateTextHeightMm` / `estimateTableHeightMm`，只依赖字符宽度近似，不依赖 DOM。
 * 3) **行内节点的拆分**：模板的 `InlineNode` 里**没有图片**，而占位符/图片/分页符
 *    在 Word 里都是行内的。因此一个段落可能被拆成「文本段 + 图片元素 + 文本段」多个元素，
 *    由 `paragraphElements()` 负责。
 */

import {
  DEFAULT_TEXT_STYLE,
  PT_TO_MM,
  contentBoxSize,
  newId,
} from '../lib/types'
import type {
  AnyElement,
  ImageElement,
  InlineNode,
  MarginMm,
  PageBreakElement,
  PageSetup,
  TableBorderStyle,
  TableCell,
  TableElement,
  TableRow,
  TemplateDoc,
  TextElement,
  TextStyle,
} from '../lib/types'
import { SCHEMA_VERSION } from '../lib/types'
import type {
  IRBlock,
  IRBorders,
  IRDoc,
  IRFontStyle,
  IRImage,
  IRPageSetup,
  IRParagraph,
  IRParaStyle,
  IRPlaceholder,
  IRRunObject,
  IRTable,
  IRTableCell,
  IRTableRow,
  IRTextBox,
  IRUnsupported,
} from './ir'
import type { IRLoopRange } from './ir'
import { addIssueOnce, locParagraph, locTable, type CompatReport } from './report'
import { buildRunSpans } from './placeholders'

// ============================================================
// 绑定
// ============================================================

export interface FieldBinding {
  fieldId: string | null
  fieldName: string
  fieldTypeSnapshot?: number
}

export interface ToTemplateOptions {
  /** 占位符名 → 绑定信息（来自 match.ts 的匹配结果，或用户手工改绑后的结果） */
  bindField?: (name: string) => FieldBinding | undefined
  /**
   * 需要"忽略（转为纯文本）"的占位符名集合（PRD F3-18 的第二个动作）。
   * 命中时不生成 InlineField，而是把原文（如 `${客户名称}`）当普通文本渲染。
   */
  ignorePlaceholders?: ReadonlySet<string>
  /** 循环区（自动识别或手动圈定）。缺省时读取 ir.loop.ranges */
  loopRanges?: readonly IRLoopRange[]
  /** 追加降级记录 */
  report?: CompatReport
  /** relId → dataURL；缺省时用 `ir.media`（改绑重建时不必再传一次） */
  media?: Map<string, string>
}

// ============================================================
// 页面设置
// ============================================================

export function mapPageSetup(ir: IRPageSetup): PageSetup {
  const margin: MarginMm = {
    top: r2(ir.margin.top),
    right: r2(ir.margin.right),
    bottom: r2(ir.margin.bottom),
    left: r2(ir.margin.left),
  }
  return {
    paper: ir.paper,
    widthMm: r2(ir.widthMm),
    heightMm: r2(ir.heightMm),
    orientation: ir.orientation,
    margin,
    headerMm: r2(ir.headerMm),
    footerMm: r2(ir.footerMm),
  }
}

// ============================================================
// 样式
// ============================================================

export function mapTextStyle(src: IRParaStyle | IRFontStyle): TextStyle {
  const out: TextStyle = {}
  if (src.fontFamily !== undefined) out.fontFamily = src.fontFamily
  if (src.fontSizePt !== undefined) out.fontSizePt = src.fontSizePt
  if (src.bold !== undefined) out.bold = src.bold
  if (src.italic !== undefined) out.italic = src.italic
  if (src.underline !== undefined) out.underline = src.underline
  if (src.strike !== undefined) out.strike = src.strike
  if (src.color !== undefined) out.color = src.color
  if (src.background !== undefined) out.background = src.background
  const para = src as IRParaStyle
  if (para.align !== undefined) out.align = para.align
  if (para.vAlign !== undefined) out.vAlign = para.vAlign
  if (para.lineHeight !== undefined) out.lineHeight = para.lineHeight
  if (para.lineHeightPt !== undefined) out.lineHeightPt = para.lineHeightPt
  if (para.spaceBeforePt !== undefined) out.spaceBeforePt = para.spaceBeforePt
  if (para.spaceAfterPt !== undefined) out.spaceAfterPt = para.spaceAfterPt
  if (para.indentLeftMm !== undefined) out.indentLeftMm = para.indentLeftMm
  if (para.indentRightMm !== undefined) out.indentRightMm = para.indentRightMm
  if (para.indentFirstLineMm !== undefined) out.indentFirstLineMm = para.indentFirstLineMm
  return out
}

// ============================================================
// 尺寸估算（没有排版引擎，只能近似）
// ============================================================

const DEFAULT_FONT_PT = DEFAULT_TEXT_STYLE.fontSizePt

function lineHeightPtOf(style: TextStyle): number {
  if (style.lineHeightPt !== undefined) return style.lineHeightPt
  const fs = style.fontSizePt ?? DEFAULT_FONT_PT
  return (style.lineHeight ?? DEFAULT_TEXT_STYLE.lineHeight) * fs
}

/**
 * 单字符宽度估算：CJK / 全角符号算一个字宽，其余算半个。
 * 不做字体度量（拿不到字体文件），但相对关系足够决定换行行数。
 */
function charWidthMm(ch: string, fontSizePt: number): number {
  const code = ch.codePointAt(0) ?? 32
  const wide = code >= 0x2e80 // CJK 统一表意文字起始区，含中日韩标点
  return (wide ? 1 : 0.5) * fontSizePt * PT_TO_MM
}

function measureLines(text: string, style: TextStyle, widthMm: number): number {
  if (widthMm <= 0) return 1
  const fs = style.fontSizePt ?? DEFAULT_FONT_PT
  let lines = 1
  let cur = 0
  for (const ch of text) {
    if (ch === '\n') {
      lines++
      cur = 0
      continue
    }
    const w = charWidthMm(ch, fs)
    if (cur + w > widthMm && cur > 0) {
      lines++
      cur = w
    } else {
      cur += w
    }
  }
  return lines
}

/** 行内节点 → 用于测量的近似文本（字段按字段名长度 + 壳子估算） */
function nodesToMeasureText(nodes: readonly InlineNode[]): string {
  let out = ''
  for (const n of nodes) {
    if (n.type === 'text') out += n.text
    else if (n.type === 'br') out += '\n'
    else if (n.type === 'sysvar') out += '000'
    else out += `${n.fieldName.length + 2}字`
  }
  return out
}

export function estimateTextHeightMm(
  nodes: readonly InlineNode[],
  style: TextStyle,
  widthMm: number,
): number {
  const text = nodesToMeasureText(nodes)
  // 空段落也要占一行高，否则段间留白全部塌陷
  const lines = text.trim() === '' ? 1 : measureLines(text, style, widthMm)
  const lh = lineHeightPtOf(style)
  return r2(lines * lh * PT_TO_MM + (style.spaceBeforePt ?? 0) * PT_TO_MM + (style.spaceAfterPt ?? 0) * PT_TO_MM)
}

function estimateTableRowHeightMm(row: IRTableRow, widths: readonly number[], paddingMm: number): number {
  let max = 0
  let col = 0
  for (const cell of row.cells) {
    if (cell.vMerge === 'continue') {
      col += cell.colspan
      continue
    }
    const spanWidth = sumRange(widths, col, cell.colspan)
    col += cell.colspan
    const inner = cellBlocksToNodes(cell.blocks)
    const innerHeight = estimateTextHeightMm(inner, mapTextStyle(cell.style), Math.max(5, spanWidth - paddingMm * 2))
    max = Math.max(max, innerHeight + paddingMm * 2)
  }
  return r2(max)
}

function sumRange(arr: readonly number[], start: number, count: number): number {
  let s = 0
  for (let i = start; i < start + count && i < arr.length; i++) s += arr[i]
  return s || 40
}

// ============================================================
// 行内节点拆分
// ============================================================

interface CutRange {
  start: number
  end: number
}

type Piece =
  | { kind: 'text'; offset: number; style: IRFontStyle; text: string }
  | { kind: 'field'; offset: number; style: IRFontStyle; ph: IRPlaceholder }
  | { kind: 'object'; offset: number; style: IRFontStyle; obj: IRRunObject }

/** 拆块优先级：同一偏移上"块级对象"要排在文本之前（例如分页符紧跟其后的文字） */
function piecePriority(p: Piece): number {
  return p.kind === 'object' ? 0 : p.kind === 'field' ? 1 : 2
}

/**
 * 把段落拆成有序的 piece 序列。
 * `cuts` 是需要从正文里剔除的区间（当前只有循环开始/结束标签文字）。
 */
function paragraphPieces(para: IRParagraph, cuts: readonly CutRange[]): Piece[] {
  const spans = buildRunSpans(para.runs.map((r) => r.text))
  const total = spans.length > 0 ? spans[spans.length - 1].end : 0

  const blocked: CutRange[] = []
  for (const ph of para.placeholders) blocked.push({ start: ph.start, end: ph.end })
  for (const c of cuts) blocked.push({ start: c.start, end: Math.min(c.end, total) })
  blocked.sort((a, b) => a.start - b.start)

  const pieces: Piece[] = []

  para.runs.forEach((run, i) => {
    const span = spans[i]
    if (!span) return
    let cursor = span.start
    for (const b of blocked) {
      if (b.end <= span.start || b.start >= span.end) continue
      const s = Math.max(b.start, span.start)
      const e = Math.min(b.end, span.end)
      if (s > cursor) {
        pieces.push({ kind: 'text', offset: cursor, style: run.style, text: textBetween(para, cursor, s) })
      }
      cursor = Math.max(cursor, e)
    }
    if (cursor < span.end) {
      pieces.push({ kind: 'text', offset: cursor, style: run.style, text: textBetween(para, cursor, span.end) })
    }
    run.objects.forEach((obj, k) => {
      pieces.push({ kind: 'object', offset: span.start + (run.objOffsets[k] ?? run.text.length), style: run.style, obj })
    })
  })

  for (const ph of para.placeholders) {
    pieces.push({
      kind: 'field',
      offset: ph.start,
      style: para.runs[ph.startRun]?.style ?? {},
      ph,
    })
  }

  pieces.sort((a, b) => a.offset - b.offset || piecePriority(a) - piecePriority(b))
  return pieces
}

/** 取段落拼接文本里的区间（按 run 边界逐段取，保证与 run 文本完全一致） */
function textBetween(para: IRParagraph, start: number, end: number): string {
  let out = ''
  let cursor = 0
  for (const run of para.runs) {
    const runStart = cursor
    const runEnd = cursor + run.text.length
    cursor = runEnd
    if (runEnd <= start || runStart >= end) continue
    const s = Math.max(start, runStart) - runStart
    const e = Math.min(end, runEnd) - runStart
    out += run.text.slice(s, e)
  }
  return out
}

// ============================================================
// 版式区与布局
// ============================================================

class Emitter {
  cursorY = 0
  readonly elements: AnyElement[] = []
  readonly widthMm: number

  // 注意：这里**不能**用 TS 的构造函数参数属性（constructor(readonly x: T)），
  // 因为 Node 的 `--experimental-strip-types` 只做类型擦除、不做语法转换，
  // 参数属性属于"需要生成代码"的语法，会导致自测脚本无法直接运行。
  constructor(widthMm: number) {
    this.widthMm = widthMm
  }

  /** 流式追加：y 取当前游标，游标下移元素高度 */
  flow(el: AnyElement): void {
    el.y = r2(this.cursorY)
    this.elements.push(el)
    if (typeof el.h === 'number') this.cursorY = r2(this.cursorY + el.h)
  }

  /** 绝对定位追加（浮动文本框等）：不影响游标 */
  abs(el: AnyElement, xMm: number, yMm: number): void {
    el.x = r2(xMm)
    el.y = r2(yMm)
    this.elements.push(el)
  }
}

function r2(n: number): number {
  return Math.round(n * 100) / 100
}

// ============================================================
// 主入口
// ============================================================

export function toTemplate(ir: IRDoc, opts: ToTemplateOptions = {}): TemplateDoc {
  const pageSetup = mapPageSetup(ir.pageSetup)
  const box = contentBoxSize(pageSetup)
  const contentWidth = Math.max(20, box.w)
  const ctx: MapCtx = {
    contentWidth,
    // 缺省用 ir.media：任何一次"改绑/改循环区后重建"都不会把图片弄丢
    media: opts.media ?? ir.media,
    bind: opts.bindField,
    ignore: opts.ignorePlaceholders ?? EMPTY_IGNORE,
    report: opts.report,
    cutMap: new Map(),
    paraNo: 0,
    tableNo: 0,
  }

  const ranges = (opts.loopRanges ?? ir.loop?.ranges ?? []).slice().sort((a, b) => a.startBlock - b.startBlock)
  // v1 只处理一层循环：取第一个区间。多层/嵌套的现实出现概率低，且官方模板尚未实测（E-2）
  const loop = ranges.length > 0 ? ranges[0] : undefined

  // 循环标签文字必须从正文里剔除，否则会原样打印出来
  if (loop) {
    if (loop.startTagRaw) {
      ctx.cutMap.set(loop.startBlock, [
        { start: loop.startTagOffset, end: loop.startTagOffset + loop.startTagRaw.length },
      ])
    }
    if (loop.endTagRaw) {
      const existing = ctx.cutMap.get(loop.endBlock) ?? []
      existing.push({ start: loop.endTagOffset, end: loop.endTagOffset + loop.endTagRaw.length })
      ctx.cutMap.set(loop.endBlock, existing)
    }
  }

  const headerEmitter = new Emitter(contentWidth)
  const loopEmitter = new Emitter(contentWidth)
  const footerEmitter = new Emitter(contentWidth)

  ir.blocks.forEach((block, idx) => {
    const emitter = !loop
      ? loopEmitter
      : idx < loop.startBlock
        ? headerEmitter
        : idx <= loop.endBlock
          ? loopEmitter
          : footerEmitter
    emitBlock(block, idx, emitter, ctx)
  })

  if (ctx.report && loop?.syntax === 'manual') {
    addIssueOnce(ctx.report, 'degraded', {
      kind: 'manual-loop',
      label: '循环区（手动圈定）',
      location: locParagraph(loop.startBlock + 1),
      detail: '循环标签语法未实测确认，当前循环区由用户手动圈定',
    })
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    pageSetup,
    bands: {
      header: headerEmitter.elements,
      loop: { elements: loopEmitter.elements, offsetMm: r2(headerEmitter.cursorY) },
      footer: footerEmitter.elements,
    },
  }
}

interface MapCtx {
  contentWidth: number
  media: Map<string, string>
  bind?: (name: string) => FieldBinding | undefined
  /** 被用户选择"忽略（转纯文本）"的占位符名 */
  ignore: ReadonlySet<string>
  report?: CompatReport
  /** 块索引 → 需要剔除的字符区间（循环标签） */
  cutMap: Map<number, CutRange[]>
  paraNo: number
  tableNo: number
}

const EMPTY_IGNORE: ReadonlySet<string> = new Set<string>()

// ============================================================
// 块 → 元素
// ============================================================

function emitBlock(block: IRBlock, blockIndex: number, emitter: Emitter, ctx: MapCtx): void {
  if (block.kind === 'paragraph') {
    ctx.paraNo++
    emitParagraph(block, blockIndex, ctx.paraNo, emitter, ctx)
    return
  }
  if (block.kind === 'table') {
    ctx.tableNo++
    emitter.flow(tableElement(block, ctx.tableNo, emitter.widthMm, ctx))
    return
  }
  // IRUnsupported：在原位置放一个灰色占位文本，保证版面结构不塌
  emitter.flow(unsupportedElement(block, emitter.widthMm, ctx))
}

function emitParagraph(
  para: IRParagraph,
  blockIndex: number,
  paraNo: number,
  emitter: Emitter,
  ctx: MapCtx,
): void {
  // 元素级样式 = 段落属性优先，缺的用该段第一个有字体的 run 兜底。
  // 为什么兜底：Word 里字体/字号几乎总是写在 run 上（w:rPr），段落属性里没有；
  // 如果元素只带段落属性，编辑器里这一段就会显示成默认字体，用户会以为导入丢了字体。
  const fallbackRun = para.runs.find((r) => Object.keys(r.style).length > 0)
  const style: TextStyle = {
    ...(fallbackRun ? mapTextStyle(fallbackRun.style) : {}),
    ...mapTextStyle(para.style),
  }

  const cuts = ctx.cutMap.get(blockIndex) ?? []
  const pieces = paragraphPieces(para, cuts)

  // 循环标签常常独占一整段。剪掉标签后如果这一段什么都不剩，就**整段丢弃**，
  // 否则会凭空多出一行空白（渲染出来就是循环体上方/下方多一道空行）。
  const onlyCutText =
    cuts.length > 0 && pieces.every((p) => p.kind === 'text' && p.text.trim() === '')
  if (onlyCutText) return

  if (para.pageBreakBefore) {
    emitter.flow(pageBreakElement(emitter.widthMm, style))
  }

  const indentLeft = style.indentLeftMm ?? 0
  const indentRight = style.indentRightMm ?? 0
  const availWidth = Math.max(10, emitter.widthMm - indentLeft - indentRight)

  let nodes: InlineNode[] = []
  /** 本段是否已经产出过元素（文本元素、图片、分页符、文本框…都算） */
  let emitted = false

  /**
   * 把累积的行内节点落成一个文本元素。
   * `force=true` 时才允许落"空文本元素"（真·空段落要占一行高，不能丢）。
   * 遇块级对象（图片/分页符/文本框）时的 flush 不 force —— 否则会凭空多出一个空文本框元素。
   */
  const flush = (force = false): void => {
    if (!force && nodes.length === 0) return
    emitter.flow({
      id: newId('txt'),
      kind: 'text',
      x: r2(indentLeft),
      y: 0,
      w: r2(availWidth),
      h: estimateTextHeightMm(nodes, style, availWidth),
      nodes,
      ...(Object.keys(style).length > 0 ? { style } : {}),
    })
    nodes = []
    emitted = true
  }

  // 编号列表：v1 用纯文本符号模拟（IR 里已注明是简化）
  if (para.list && para.list.marker) {
    nodes.push({ type: 'text', text: `${para.list.marker} ` })
  }

  for (const piece of pieces) {
    if (piece.kind === 'text') {
      pushTextNodes(nodes, piece.text, mapTextStyle(piece.style))
      continue
    }
    if (piece.kind === 'field') {
      nodes.push(fieldNode(piece.ph, piece.style, ctx))
      continue
    }
    // 对象
    const obj = piece.obj
    if (obj.kind === 'sysvar') {
      const st = mapTextStyle(piece.style)
      nodes.push({ type: 'sysvar', key: obj.key, ...(Object.keys(st).length > 0 ? { style: st } : {}) })
      continue
    }
    if (obj.kind === 'pageBreak') {
      flush()
      emitter.flow(pageBreakElement(emitter.widthMm, style))
      emitted = true
      continue
    }
    if (obj.kind === 'image') {
      flush()
      const el = imageElement(obj, ctx)
      if (el) {
        emitter.flow(el)
        emitted = true
      } else if (ctx.report) {
        addIssueOnce(ctx.report, 'degraded', {
          kind: 'image-dropped',
          label: '图片',
          location: locParagraph(paraNo),
          detail: '图片数据缺失，已替换为文字占位',
        })
      }
      if (!el) nodes.push({ type: 'text', text: '【图片】' })
      continue
    }
    if (obj.kind === 'textbox') {
      flush()
      emitTextBox(obj, paraNo, emitter, ctx)
      emitted = true
      continue
    }
    // unsupported
    flush()
    emitter.flow(unsupportedElement(obj, emitter.widthMm, ctx))
  }

  // 收尾：还有没收的文本就落一个元素；整段什么都没产出（真·空段落）也要占一行高
  if (nodes.length > 0) flush(true)
  else if (!emitted) flush(true)
}

function pushTextNodes(target: InlineNode[], text: string, style: TextStyle): void {
  if (text === '') return
  const hasStyle = Object.keys(style).length > 0
  const parts = text.split('\n')
  parts.forEach((part, i) => {
    if (i > 0) target.push({ type: 'br' })
    if (part !== '') target.push({ type: 'text', text: part, ...(hasStyle ? { style } : {}) })
  })
}

function fieldNode(ph: IRPlaceholder, style: IRFontStyle, ctx: MapCtx | undefined): InlineNode {
  const st = mapTextStyle(style)
  const hasStyle = Object.keys(st).length > 0
  // F3-18 的第二个动作："忽略该占位符（转为纯文本）"—— 保留原文，不再当变量
  if (ctx?.ignore.has(ph.name)) {
    return { type: 'text', text: ph.raw, ...(hasStyle ? { style: st } : {}) }
  }
  const binding = ctx?.bind?.(ph.name)
  // F3-18：未绑定也保留下来（fieldId = null + fieldName），供用户后续绑定，绝不静默丢弃
  const node: InlineNode = {
    type: 'field',
    fieldId: binding?.fieldId ?? null,
    fieldName: binding?.fieldName ?? ph.name,
    ...(binding?.fieldTypeSnapshot !== undefined ? { fieldTypeSnapshot: binding.fieldTypeSnapshot } : {}),
    ...(hasStyle ? { style: st } : {}),
  }
  return node
}

function pageBreakElement(widthMm: number, style: TextStyle): PageBreakElement {
  return {
    id: newId('pb'),
    kind: 'pagebreak',
    x: 0,
    y: 0,
    w: r2(widthMm),
    h: 0,
    style,
  }
}

function imageElement(img: IRImage, ctx: MapCtx): ImageElement | undefined {
  const dataUrl = ctx.media.get(img.relId)
  if (!dataUrl) return undefined
  return {
    id: newId('img'),
    kind: 'image',
    x: 0,
    y: 0,
    // 尺寸已在解析层按 wp:extent 的 EMU 等比换算成 mm（F3-10）
    w: r2(Math.max(1, img.widthMm)),
    h: r2(Math.max(1, img.heightMm)),
    dataUrl,
    fit: 'contain',
  }
}

function unsupportedElement(block: IRUnsupported, widthMm: number, ctx: MapCtx): TextElement {
  void ctx
  return {
    id: newId('txt'),
    kind: 'text',
    x: 0,
    y: 0,
    w: r2(widthMm),
    h: 6,
    nodes: [{ type: 'text', text: block.placeholderText }],
    style: {
      align: 'center',
      color: '#8f959e',
      background: '#f2f3f5',
      fontSizePt: 9,
      lineHeight: 1.4,
    },
  }
}

// ============================================================
// 文本框
// ============================================================

function emitTextBox(box: IRTextBox, paraNo: number, emitter: Emitter, ctx: MapCtx): void {
  const nodes = cellBlocksToNodes(box.blocks, ctx)
  const style = textBoxStyle(box)

  if (!box.geometryOk) {
    // 降级：把内容当普通文本紧跟在锚点位置（报告已在解析层登记）
    emitter.flow({
      id: newId('txt'),
      kind: 'text',
      x: 0,
      y: 0,
      w: r2(Math.max(10, emitter.widthMm)),
      h: estimateTextHeightMm(nodes, style, emitter.widthMm),
      nodes,
      style,
    })
    return
  }

  if (box.warning && ctx.report) {
    addIssueOnce(ctx.report, 'degraded', {
      kind: 'textbox-approximate',
      label: '文本框（浮动定位）',
      location: locParagraph(paraNo),
      detail: box.warning,
    })
  }

  const w = Math.max(5, box.widthMm)
  const y = box.yMm ?? emitter.cursorY
  emitter.abs(
    {
      id: newId('txt'),
      kind: 'text',
      x: 0,
      y: 0,
      w: r2(w),
      h: r2(Math.max(1, box.heightMm)),
      nodes,
      style: { ...style, align: style.align ?? 'left' },
      locked: false,
    },
    box.xMm,
    y,
  )

  // 文本框内的表格无法塞进行内节点，作为独立元素叠放在文本框下方（尽力还原）
  const innerTables = collectTables(box.blocks)
  let offsetY = y + Math.max(1, box.heightMm)
  for (const t of innerTables) {
    ctx.tableNo++
    emitter.abs(tableElement(t, ctx.tableNo, Math.max(20, w), ctx), box.xMm, offsetY)
    offsetY += 8
  }
}

function textBoxStyle(box: IRTextBox): TextStyle {
  const first = box.blocks.find((b): b is IRParagraph => b.kind === 'paragraph')
  const style = first ? mapTextStyle(first.style) : {}
  return { fontSizePt: DEFAULT_FONT_PT, lineHeight: 1.2, ...style }
}

function collectTables(blocks: readonly IRBlock[]): IRTable[] {
  const out: IRTable[] = []
  for (const b of blocks) {
    if (b.kind === 'table') out.push(b)
    else if (b.kind === 'paragraph') {
      // 段落里的对象不可能是表格（文本框嵌套的表格一定是块级）
      continue
    }
  }
  return out
}

// ============================================================
// 表格
// ============================================================

function tableElement(table: IRTable, tableNo: number, availWidth: number, ctx: MapCtx): TableElement {
  // 列宽可能略大于版心（Word 允许溢出），按比例压缩，避免元素被裁掉（对齐 PRD E-45 的处理思路）
  let widths = table.colWidthsMm.slice()
  const sum = widths.reduce((a, b) => a + b, 0)
  const width = Math.min(sum, availWidth)
  if (sum > availWidth && sum > 0) {
    const k = availWidth / sum
    widths = widths.map((w) => w * k)
  }

  const padding = table.cellPaddingMm ?? 1.3
  const rows = buildRows(table, widths, padding, tableNo, ctx)
  const border = mapTableBorder(table.border)

  let x = 0
  if (table.align === 'center') x = Math.max(0, (availWidth - width) / 2)
  else if (table.align === 'right') x = Math.max(0, availWidth - width)

  const height = rows.reduce((a, r) => a + (r.heightMm ?? 0), 0)

  const repeatHeader = rows.some((r) => r.isHeader)
  return {
    id: newId('tbl'),
    kind: 'table',
    x: r2(x),
    y: 0,
    w: r2(width),
    h: r2(height),
    colWidthsMm: widths.map((w) => r2(w)),
    rows,
    border,
    ...(repeatHeader ? { repeatHeader: true } : {}),
    cellPaddingMm: r2(padding),
  }
}

/** 处理 gridSpan / vMerge → colspan / rowspan */
function buildRows(
  table: IRTable,
  widths: readonly number[],
  padding: number,
  tableNo: number,
  ctx: MapCtx,
): TableRow[] {
  // 先建立"网格占用表"：vMerge=continue 的单元格本身不渲染，但要能被上面的 restart 找到
  const occupancy = new Map<string, { cell: IRTableCell; row: number; col: number }>()
  table.rows.forEach((row, ri) => {
    let col = 0
    for (const cell of row.cells) {
      occupancy.set(`${ri}:${col}`, { cell, row: ri, col })
      col += cell.colspan
    }
  })

  const rows: TableRow[] = []
  table.rows.forEach((row, ri) => {
    let col = 0
    const cells: TableCell[] = []
    for (const cell of row.cells) {
      const startCol = col
      col += cell.colspan
      if (cell.vMerge === 'continue') continue // 已被上面的 restart 单元格吞掉

      let rowspan = 1
      if (cell.vMerge === 'restart') {
        let probe = ri + 1
        for (;;) {
          const below = occupancy.get(`${probe}:${startCol}`)
          if (!below || below.cell.vMerge !== 'continue') break
          rowspan++
          probe++
        }
      }

      const nodes = cellBlocksToNodes(cell.blocks, ctx)
      const cellPadding = cell.paddingMm ?? padding
      const cellStyle = mapTextStyle(cell.style)
      cells.push({
        id: newId('cell'),
        colspan: cell.colspan,
        rowspan,
        nodes,
        ...(Object.keys(cellStyle).length > 0 ? { style: cellStyle } : {}),
        paddingMm: r2(cellPadding),
      })
    }

    const heightMm = row.heightMm ?? estimateTableRowHeightMm(row, widths, padding)
    rows.push({
      id: newId('row'),
      cells,
      ...(row.isHeader ? { isHeader: true } : {}),
      heightMm: r2(heightMm),
    })
  })

  if (ctx.report && table.rows.some((r) => r.cells.some((c) => hasNestedTable(c.blocks)))) {
    addIssueOnce(ctx.report, 'degraded', {
      kind: 'nested-table',
      label: '嵌套表格',
      location: locTable(tableNo),
      detail: '嵌套表格无法在单元格内还原，内容已合并为文本',
    })
  }
  return rows
}

function hasNestedTable(blocks: readonly IRBlock[]): boolean {
  return blocks.some((b) => b.kind === 'table')
}

/**
 * 把单元格里的块拍平成行内节点。
 * 注意：模板的 `TableCell.nodes` 只支持行内节点，所以
 * - 多个段落之间用 `br` 分隔（近似软换行）；
 * - 嵌套表格 / 图片 / 文本框只能取文字（有损），由调用方登记报告。
 *
 * `ctx` 可省：省掉时只做"测量用"的近似拍平（不关心绑定/忽略策略）。
 */
function cellBlocksToNodes(blocks: readonly IRBlock[], ctx?: MapCtx): InlineNode[] {
  const out: InlineNode[] = []
  let first = true
  for (const b of blocks) {
    if (!first) out.push({ type: 'br' })
    first = false
    if (b.kind === 'paragraph') {
      out.push(...paragraphToPlainNodes(b, ctx))
    } else if (b.kind === 'table') {
      out.push(...tableToPlainNodes(b, ctx))
    } else {
      out.push({ type: 'text', text: b.placeholderText })
    }
  }
  return out
}

function paragraphToPlainNodes(para: IRParagraph, ctx?: MapCtx): InlineNode[] {
  const nodes: InlineNode[] = []
  if (para.list?.marker) nodes.push({ type: 'text', text: `${para.list.marker} ` })
  const pieces = paragraphPieces(para, [])
  for (const piece of pieces) {
    if (piece.kind === 'text') pushTextNodes(nodes, piece.text, mapTextStyle(piece.style))
    else if (piece.kind === 'field') nodes.push(fieldNode(piece.ph, piece.style, ctx))
    else {
      const obj = piece.obj
      if (obj.kind === 'sysvar') nodes.push({ type: 'sysvar', key: obj.key })
      else if (obj.kind === 'image') nodes.push({ type: 'text', text: '【图片】' })
      else if (obj.kind === 'textbox') nodes.push(...cellBlocksToNodes(obj.blocks, ctx))
      else if (obj.kind === 'unsupported') nodes.push({ type: 'text', text: obj.placeholderText })
      // pageBreak 在单元格内忽略（单元格内分页无意义）
    }
  }
  return nodes
}

function tableToPlainNodes(table: IRTable, ctx?: MapCtx): InlineNode[] {
  const out: InlineNode[] = []
  table.rows.forEach((row, ri) => {
    if (ri > 0) out.push({ type: 'br' })
    row.cells.forEach((cell, ci) => {
      if (ci > 0) out.push({ type: 'text', text: '\t' })
      out.push(...cellBlocksToNodes(cell.blocks, ctx))
    })
  })
  return out
}

function mapTableBorder(b: IRBorders): TableBorderStyle {
  const outer = b.top ?? b.bottom ?? b.left ?? b.right
  const inner = b.insideH ?? b.insideV
  const hasOuterH = !!(b.top || b.bottom)
  const hasOuterV = !!(b.left || b.right)
  const hasFullOuter = hasOuterH && hasOuterV

  let mode: TableBorderStyle['mode']
  if (!outer && !inner) mode = 'none'
  else if (hasOuterH && hasOuterV && inner) mode = 'all'
  else if (hasOuterH && !hasOuterV && (b.insideH || inner)) mode = 'horizontal' // 三线表
  else if (!hasOuterV && !outer) mode = 'horizontal'
  else if (hasFullOuter && !inner) mode = 'outer'
  else if (inner && !outer) mode = 'horizontal'
  else if (outer) mode = 'outer'
  else mode = 'all'

  const ref = outer ?? inner
  return {
    mode,
    widthPt: ref ? ref.widthPt : 0.5,
    color: ref ? ref.color : '#000000',
  }
}
