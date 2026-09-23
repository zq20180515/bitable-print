/**
 * Word 导入的中间表示（IR）
 *
 * 设计目标（PRD F3-05）：**与模板模型解耦**。
 * - 解析层（docx-read）只负责产出 IR，不关心"模板元素/版式区"这些编辑器概念；
 * - 映射层（to-template）负责 IR → TemplateDoc。
 * 这样解析逻辑可以在 Node 里单测（不碰 DOM、不碰模板工厂函数）。
 *
 * 单位约定（与 `src/lib/types.ts` 一致）：
 * - 所有长度一律 **mm**；
 * - 字号一律 **pt**；
 * - 行距：倍数存放在 `lineHeight`，固定行距存放在 `lineHeightPt`。
 * DOCX 原始单位（twips / EMU / 半磅）在 docx-read 里就换算掉，IR 里不出现。
 */

import type { Align, MarginMm, Orientation, PaperKey, SysVarKey, VAlign } from '../lib/types'

// ============================================================
// 页面设置
// ============================================================

export interface IRPageSetup {
  /** 纵向原值（mm）。横向时渲染器自行交换，与 PageSetup 的约定保持一致 */
  widthMm: number
  heightMm: number
  orientation: Orientation
  margin: MarginMm
  /** 页眉区距上边缘 mm */
  headerMm: number
  /** 页脚区距下边缘 mm */
  footerMm: number
  /** 反推出的标准纸型；推不出来则为 custom */
  paper: PaperKey
  /** 文档内的节数量（>1 时只取第一节，记入报告 F3-07） */
  sectionCount: number
  /** 是否解析到了 sectPr（没解析到时用默认值，记入报告） */
  found: boolean
}

// ============================================================
// 样式
// ============================================================

/** 字符级样式（对应 w:rPr） */
export interface IRFontStyle {
  fontFamily?: string
  fontSizePt?: number
  bold?: boolean
  italic?: boolean
  underline?: boolean
  strike?: boolean
  color?: string
  /** 高亮 / 底纹（`w:highlight` 或 `w:shd`） */
  background?: string
  /** 上下标：v1 不渲染，记入报告 */
  vertAlign?: 'superscript' | 'subscript'
}

/** 段落级样式（对应 w:pPr，继承自样式表的同名属性） */
export interface IRParaStyle extends IRFontStyle {
  align?: Align
  vAlign?: VAlign
  indentLeftMm?: number
  indentRightMm?: number
  indentFirstLineMm?: number
  spaceBeforePt?: number
  spaceAfterPt?: number
  /** 倍数行距 */
  lineHeight?: number
  /** 固定/最小行距，pt */
  lineHeightPt?: number
  /** 引用的段落样式 ID（w:pStyle），仅用于排查 */
  pStyleId?: string
}

// ============================================================
// 行内对象
// ============================================================

export interface IRImage {
  kind: 'image'
  /** 关系 ID（r:embed / r:id），经 rels 可拿到 media 路径 */
  relId: string
  /** 直接内嵌的 base64（w:binData / VML），与 relId 二选一 */
  inlineDataUrl?: string
  widthMm: number
  heightMm: number
  /** wp:anchor → true（浮动，已降级为行内，记入报告） */
  floating: boolean
  /** 浮动时的锚点偏移（mm，相对页面左上角），仅当 floating 时有意义 */
  offsetXMm?: number
  offsetYMm?: number
  alt?: string
}

export interface IRTextBox {
  kind: 'textbox'
  /** 几何是否可信；false 时上层降级为"提取纯文本"并记入报告 */
  geometryOk: boolean
  /** 相对版心左上角 mm（drawingml 用 off 减去页边距得到） */
  xMm: number
  /** 相对锚点段落顶部的偏移 mm；undefined 表示只能按流式位置就地放置 */
  yMm?: number
  widthMm: number
  heightMm: number
  /** 定位来源，排查用 */
  source: 'drawingml' | 'vml'
  /** 解析告警（geometryOk=false 时给上层写报告用） */
  warning?: string
  /** 文本框内的内容（复用块结构） */
  blocks: IRBlock[]
}

export interface IRUnsupported {
  kind: 'unsupported'
  /** 报告用标签，如 "图表"、"OLE 对象" */
  label: string
  /** 文档中插入的占位文字，如 "【图表已忽略】" */
  placeholderText: string
  action: 'ignored' | 'degraded'
  /** 位置描述（生成时即确定，避免事后回溯块序号） */
  location: string
  detail?: string
}

export interface IRSysVar {
  kind: 'sysvar'
  key: SysVarKey
  /** 原始域指令，如 " PAGE " */
  instr: string
}

export type IRRunObject = IRImage | IRTextBox | IRUnsupported | IRSysVar | { kind: 'pageBreak' }

/** 一个 w:r。文本与行内对象按出现顺序排列：对象在 run 内相对文本的位置由 objIndex 表达 */
export interface IRRun {
  text: string
  style: IRFontStyle
  objects: IRRunObject[]
  /**
   * 对象在 run 文本中的插入位置（字符偏移，升序）。
   * 长度与 objects 一致：拆分行内节点时，先把 text 按这些位置切开，再插入对象。
   */
  objOffsets: number[]
}

// ============================================================
// 占位符（跨 run 的关键结构）
// ============================================================

export type PlaceholderSyntax = 'dollar' | 'guillemet' | 'mustache' | 'bracket'

// ⛔ 这里原来有 `PLACEHOLDER_SYNTAX_LABEL`（把 PlaceholderSyntax 映射成"人看的写法"）。
//    2026-09-21 清死导出时删掉：全项目没有任何地方引用它。
//    ⚠️ 如实记一笔：**当时也没有别的"人话写法"映射** —— 四种写法（`${}` / `«»` / `{{}}` / `[]`）
//    的识别全在 `placeholders.ts` 的正则里，界面上没有任何"支持哪些写法"的提示。
//    ⇒ 将来若要加这个提示，这里是新建的落点，别以为有个现成常量被误删了。
//    `PlaceholderSyntax` 这个**类型**仍在使用，所以只删常量、保留类型。

export interface IRPlaceholder {
  /** 原文形态，如 `${客户名称}` */
  raw: string
  /** 字段名（已剥离壳子） */
  name: string
  syntax: PlaceholderSyntax
  /** 在**段落拼接文本**中的字符区间 [start, end) */
  start: number
  end: number
  /** 映射回 run 的起点：run 索引 + 该 run 内字符偏移 */
  startRun: number
  startOffset: number
  /** 映射回 run 的终点：run 索引 + 该 run 内字符偏移（endOffset 为"结束后的下一个字符位置"） */
  endRun: number
  endOffset: number
}

export interface IRPlaceholderRef extends IRPlaceholder {
  /** 所在块索引（blocks 数组下标） */
  blockIndex: number
}

// ============================================================
// 块级结构
// ============================================================

export interface IRParagraph {
  kind: 'paragraph'
  /** 全段落文本 = 所有 run 文本按顺序拼接。**占位符匹配的基准** */
  text: string
  runs: IRRun[]
  style: IRParaStyle
  placeholders: IRPlaceholder[]
  pageBreakBefore: boolean
  /** 编号列表（w:numPr）。v1 只还原为纯文本符号 */
  list?: { level: number; marker: string; ordered: boolean }
  /** 空段落（用于保留垂直留白） */
  isEmpty: boolean
}

export interface IRBorderEdge {
  /** OOXML 的 w:val：single / double / dashed / none / nil ... */
  style: string
  widthPt: number
  color: string
}

export interface IRBorders {
  top?: IRBorderEdge
  bottom?: IRBorderEdge
  left?: IRBorderEdge
  right?: IRBorderEdge
  insideH?: IRBorderEdge
  insideV?: IRBorderEdge
}

export interface IRTableCell {
  /** 跨越的网格列数（w:gridSpan） */
  colspan: number
  /** w:vMerge 的原始语义 */
  vMerge?: 'restart' | 'continue'
  /** 单元格内容块 */
  blocks: IRBlock[]
  style: IRParaStyle
  border?: IRBorders
  paddingMm?: number
  /** 单元格宽度 mm（w:tcW） */
  widthMm?: number
}

export interface IRTableRow {
  cells: IRTableCell[]
  /** w:trPr/w:tblHeader：每页重复的表头行 */
  isHeader: boolean
  heightMm?: number
  /** 行高是否为"精确值"（hRule=exact）；否则视为最小高度 */
  heightExact?: boolean
}

export interface IRTable {
  kind: 'table'
  rows: IRTableRow[]
  colWidthsMm: number[]
  border: IRBorders
  cellPaddingMm?: number
  align?: Align
  /** 表格总宽 mm（求和得到，超过版心时由映射层压缩） */
  widthMm: number
}

export type IRBlock = IRParagraph | IRTable | IRUnsupported

// ============================================================
// 循环标签
// ============================================================

export type LoopSyntax =
  | 'mustache' // {{#each}} ... {{/each}}
  | 'brace' // {#列表} ... {/列表}
  | 'cjk-bracket' // [[循环开始]] ... [[循环结束]]
  | 'cjk-fullwidth' // 【循环开始】 ... 【循环结束】

export interface IRLoopTag {
  role: 'start' | 'end'
  /** 原样保留的标签文本（语法未实测确认，必须留着给上层展示） */
  raw: string
  /** 标签里带的集合名（如果有） */
  name?: string
  syntax: LoopSyntax
  /** 标签所在的块索引 */
  blockIndex: number
  /** 标签在块内的字符偏移（同一段落里可能存在多个标签） */
  charOffset: number
  /** 是否由用户手动圈定（manualLoop）产生 */
  manual?: boolean
}

export interface IRLoopRange {
  startBlock: number
  endBlock: number
  /** 循环体集合名 */
  name?: string
  syntax: LoopSyntax | 'manual'
  /** 首/末标签的原文（**原样保留**，语法未确认时 UI 要给用户看） */
  startTagRaw: string
  endTagRaw: string
  /** 标签在所在段落文本中的字符偏移，映射层据此把标签文字从正文里剪掉 */
  startTagOffset: number
  endTagOffset: number
}

/** 疑似循环标签但没识别出配对的结果，交给 UI 提示用户"手动圈定" */
export interface IRUnrecognizedTag {
  raw: string
  blockIndex: number
  /** 为什么判为疑似：关键字 / 特殊符号 */
  reason: string
}

export interface IRLoopDetection {
  /** 配对成功的循环区（v1 只支持一层，多个循环按文档顺序排列） */
  ranges: IRLoopRange[]
  /** 识别到但没配对的标签 */
  unmatched: IRLoopTag[]
  /** 疑似标签（UI 用来提示"可能需要手动圈定"） */
  unrecognized: IRUnrecognizedTag[]
}

// ============================================================
// 文档 IR
// ============================================================

export interface IRDocumentInfo {
  /** 是否含 VBA 宏（word/vbaProject.bin） */
  hasMacro: boolean
  /** 是否含图表部件（word/charts/*） */
  hasCharts: boolean
  /** 是否含 SmartArt 部件（word/diagrams/*） */
  hasDiagrams: boolean
  /** 页眉/页脚部件数量（内容不还原，只提示） */
  headerFooterParts: number
  /** 是否含脚注/尾注部件 */
  hasFootnotes: boolean
  /** 是否含嵌入字体（word/fontTable.xml 之外的 font*.odttf） */
  hasEmbeddedFonts: boolean
  /** 文档里的节数量 */
  sectionCount: number
}

export interface IRDoc {
  pageSetup: IRPageSetup
  blocks: IRBlock[]
  /** 循环检测结果（未做检测时为 null） */
  loop: IRLoopDetection | null
  /** 全文占位符（带块索引） */
  placeholders: IRPlaceholderRef[]
  /**
   * 已解析出的图片数据：relId → dataURL。
   *
   * 为什么挂在 IR 上（而不是只作为 buildIr 的返回值）：
   * 用户在导入向导里改绑字段后，界面会调 `rebuildWithMatches(ir, ...)` **重新映射**一次模板。
   * 如果图片数据只走"解析结果"这条线，重建时调用方一旦忘了透传 media，**所有图片会静默丢失**。
   * 放在 IR 上就没有这个失手的机会。
   * （IR 是内存对象、不落库，Map 不影响序列化。）
   */
  media: Map<string, string>
  info: IRDocumentInfo
}
