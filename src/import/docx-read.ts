/**
 * DOCX 解压与解析（PRD F3.1 / F3.2 / 附录 B）
 *
 * 分工：
 * - `loadDocxParts()` 只负责 I/O（JSZip 解压 + 取部件），不解析；
 * - `buildIr()` 是**纯函数**（字符串/字节进，IR + 报告出），因此可以在 Node 里单测，
 *   自测脚本直接喂手写 XML 字符串即可，完全不需要真实 .docx 文件。
 *
 * 单位换算全部在这里完成（twips/EMU/半磅 → mm/pt），IR 层不出现 DOCX 原生单位。
 * 换算常量统一取自 `src/lib/types.ts`，避免各处硬编码 1/1440 之类的魔数。
 */

import JSZip from 'jszip'
import {
  EMU_TO_PX,
  HALF_PT_TO_PT,
  PAPER_MM,
  TWIPS_TO_MM,
  pxToMm,
} from '../lib/types'
import type { Align, PaperKey, SysVarKey, VAlign } from '../lib/types'
import type {
  IRBlock,
  IRBorderEdge,
  IRBorders,
  IRDoc,
  IRDocumentInfo,
  IRFontStyle,
  IRImage,
  IRPageSetup,
  IRParagraph,
  IRParaStyle,
  IRPlaceholder,
  IRRun,
  IRRunObject,
  IRTable,
  IRTableCell,
  IRTableRow,
  IRTextBox,
  IRUnsupported,
} from './ir'
import {
  DEFAULT_PLACEHOLDER_OPTIONS,
  findParagraphPlaceholders,
  resolvePlaceholderOptions,
  type PlaceholderOptions,
} from './placeholders'
import { createEmptyLoopDetection, detectLoops, type LoopScanOptions } from './loop'
import {
  addDegraded,
  addIgnored,
  addIssueOnce,
  createReport,
  finalizeReport,
  locDocument,
  locImage,
  locParagraph,
  locTable,
  locTextBox,
  type CompatReport,
} from './report'
import {
  attr,
  attrNum,
  childEls,
  findDeep,
  findDeepAll,
  findDeepAny,
  firstChild,
  onOff,
  parseXml,
  type XmlNode,
} from './xml'

// ============================================================
// 部件读取（唯一涉及 ZIP 的地方）
// ============================================================

export interface DocxParts {
  documentXml: string
  stylesXml?: string
  numberingXml?: string
  /** word/_rels/document.xml.rels */
  relsXml?: string
  /** zip 内路径（word/media/xxx.png）→ 二进制 */
  media: Map<string, Uint8Array>
  hasMacro: boolean
  hasCharts: boolean
  hasDiagrams: boolean
  headerFooterParts: number
  hasFootnotes: boolean
  hasEmbeddedFonts: boolean
}

/** E-23：解压失败 / 缺 document.xml 时抛出，上层转成"文件已损坏" */
export class DocxReadError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DocxReadError'
  }
}

export async function loadDocxParts(data: ArrayBuffer | Uint8Array): Promise<DocxParts> {
  let zip: JSZip
  try {
    zip = await JSZip.loadAsync(data)
  } catch (e) {
    throw new DocxReadError('文件已损坏或不是有效的 Word 文档')
  }

  // 少数导出工具会在 zip 里多包一层目录，这里兜一下底
  let docFile = zip.file('word/document.xml')
  if (!docFile) {
    const alt = Object.keys(zip.files).find((n) => /(^|\/)word\/document\.xml$/.test(n) || /(^|\/)document\.xml$/.test(n))
    if (alt) docFile = zip.file(alt)
  }
  if (!docFile) {
    // E-23：没有主文档部件一定不是 docx（可能是 zip 改名的其他文件）
    throw new DocxReadError('文件已损坏或不是有效的 Word 文档')
  }
  const documentXml = await docFile.async('string')

  const readOptional = async (path: string): Promise<string | undefined> => {
    const f = zip.file(path)
    return f ? f.async('string') : undefined
  }

  const media = new Map<string, Uint8Array>()
  let hasMacro = false
  let hasCharts = false
  let hasDiagrams = false
  let headerFooterParts = 0
  let hasFootnotes = false
  let hasEmbeddedFonts = false

  const names = Object.keys(zip.files)
  for (const name of names) {
    const f = zip.files[name]
    if (f.dir) continue
    if (name.startsWith('word/media/')) {
      // 图片二进制：直接读，不在这里转 dataURL（避免为未引用的图片做无谓的编码）
      media.set(name, await f.async('uint8array'))
    } else if (name === 'word/vbaProject.bin') {
      hasMacro = true
    } else if (/^word\/charts\/[^/]+\.xml$/.test(name)) {
      hasCharts = true
    } else if (/^word\/diagrams\//.test(name)) {
      hasDiagrams = true
    } else if (/^word\/(header|footer)\d*\.xml$/.test(name)) {
      headerFooterParts++
    } else if (name === 'word/footnotes.xml' || name === 'word/endnotes.xml') {
      hasFootnotes = true
    } else if (/^word\/fonts\/.*\.odttf$/i.test(name)) {
      hasEmbeddedFonts = true
    }
  }

  const parts: DocxParts = {
    documentXml,
    media,
    hasMacro,
    hasCharts,
    hasDiagrams,
    headerFooterParts,
    hasFootnotes,
    hasEmbeddedFonts,
  }
  const stylesXml = await readOptional('word/styles.xml')
  if (stylesXml !== undefined) parts.stylesXml = stylesXml
  const numberingXml = await readOptional('word/numbering.xml')
  if (numberingXml !== undefined) parts.numberingXml = numberingXml
  const relsXml = await readOptional('word/_rels/document.xml.rels')
  if (relsXml !== undefined) parts.relsXml = relsXml
  return parts
}

// ============================================================
// 关系表（rId → zip 内路径）
// ============================================================

function resolveRelTarget(target: string, baseDir: string): string {
  if (target.startsWith('/')) return target.slice(1)
  const stack = baseDir.split('/').filter(Boolean)
  for (const seg of target.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') {
      stack.pop()
      continue
    }
    stack.push(seg)
  }
  return stack.join('/')
}

export function parseRels(relsXml: string | undefined): Map<string, string> {
  const out = new Map<string, string>()
  if (!relsXml) return out
  const root = parseXml(relsXml)
  for (const rel of findDeepAll(root, ['Relationship'])) {
    const id = attr(rel, 'Id')
    const target = attr(rel, 'Target')
    const mode = attr(rel, 'TargetMode')
    if (!id || !target) continue
    if (mode === 'External') continue // 外链图片/超链接：拿不到内容，忽略
    out.set(id, resolveRelTarget(target, 'word'))
  }
  return out
}

// ============================================================
// 样式表
// ============================================================

interface StyleDef {
  type: string
  styleId: string
  basedOn?: string
  name?: string
  rPr?: IRFontStyle
  pPr?: IRParaStyle
}

export interface StyleTable {
  para: Map<string, StyleDef>
  char: Map<string, StyleDef>
  /**
   * 表格样式里的边框与内边距。
   * 为什么要单独存：很多 Word 表格**不在 tblPr 里直接写 tblBorders**，
   * 而是靠 `w:tblStyle` 引用样式（"网格型"等）。不查样式表的话这些表格会全丢边框。
   */
  table: Map<string, { borders?: IRBorders; cellMarMm?: number }>
  /** docDefaults 里的默认段落样式（含默认字体，Word 常把正文字体放这里） */
  defaultParagraph: IRParaStyle
}

export function parseStyles(stylesXml: string | undefined): StyleTable {
  const para = new Map<string, StyleDef>()
  const char = new Map<string, StyleDef>()
  const table = new Map<string, { borders?: IRBorders; cellMarMm?: number }>()
  let defaultParagraph: IRParaStyle = {}
  if (!stylesXml) return { para, char, table, defaultParagraph }

  const root = parseXml(stylesXml)
  const docDefaults = findDeep(root, 'w:docDefaults')
  if (docDefaults) {
    const rPrDefault = firstChild(docDefaults, 'w:rPrDefault')
    const rPr = firstChild(rPrDefault, 'w:rPr')
    const pPrDefault = firstChild(docDefaults, 'w:pPrDefault')
    const pPr = firstChild(pPrDefault, 'w:pPr')
    defaultParagraph = { ...parseRPr(rPr), ...parsePPr(pPr) }
    // pPr 内部可能还带 w:rPr（段落标记的字符属性），优先级更高
    const innerRPr = firstChild(pPr, 'w:rPr')
    if (innerRPr) Object.assign(defaultParagraph, parseRPr(innerRPr))
  }

  for (const style of findDeepAll(root, ['w:style'])) {
    const type = attr(style, 'w:type') ?? 'paragraph'
    const styleId = attr(style, 'w:styleId')
    if (!styleId) continue
    const nameNode = firstChild(style, 'w:name')
    // ⚠️ w:basedOn 是**子元素**（<w:basedOn w:val="Base"/>），不是 w:style 的属性 ——
    // 当成属性读会永远拿到 undefined，样式继承链断掉（字体/字号全丢），这是很隐蔽的坑。
    const basedOn = attr(firstChild(style, 'w:basedOn'), 'w:val')
    const def: StyleDef = {
      type,
      styleId,
      ...(basedOn ? { basedOn } : {}),
      ...(nameNode && attr(nameNode, 'w:val') ? { name: attr(nameNode, 'w:val') as string } : {}),
      ...(firstChild(style, 'w:rPr') ? { rPr: parseRPr(firstChild(style, 'w:rPr')) } : {}),
      ...(firstChild(style, 'w:pPr') ? { pPr: parsePPr(firstChild(style, 'w:pPr')) } : {}),
    }
    if (type === 'character') char.set(styleId, def)
    else if (type === 'table') {
      const tblPr = firstChild(style, 'w:tblPr')
      const borders = parseBorders(firstChild(tblPr, 'w:tblBorders'))
      const mar = firstChild(tblPr, 'w:tblCellMar')
      let cellMarMm: number | undefined
      if (mar) {
        const l = attrNum(firstChild(mar, 'w:left'), 'w:w')
        const t = attrNum(firstChild(mar, 'w:top'), 'w:w')
        const pick = l ?? t
        if (pick !== undefined) cellMarMm = pick * TWIPS_TO_MM
      }
      table.set(styleId, {
        ...(borders ? { borders } : {}),
        ...(cellMarMm !== undefined ? { cellMarMm } : {}),
      })
    } else para.set(styleId, def)
  }
  return { para, char, table, defaultParagraph }
}

/** 沿 basedOn 链合并段落样式（链长有限，加个环保护） */
function resolveParaStyleFromTable(table: StyleTable, styleId: string | undefined): IRParaStyle {
  if (!styleId) return {}
  const chain: StyleDef[] = []
  const seen = new Set<string>()
  let cur = table.para.get(styleId)
  while (cur && !seen.has(cur.styleId)) {
    seen.add(cur.styleId)
    chain.unshift(cur) // 基类在前
    cur = cur.basedOn ? table.para.get(cur.basedOn) : undefined
  }
  const out: IRParaStyle = {}
  for (const def of chain) {
    if (def.pPr) Object.assign(out, definedOnly(def.pPr))
    if (def.rPr) Object.assign(out, definedOnly(def.rPr))
  }
  return out
}

function resolveCharStyleFromTable(table: StyleTable, styleId: string | undefined): IRFontStyle {
  if (!styleId) return {}
  const chain: StyleDef[] = []
  const seen = new Set<string>()
  let cur = table.char.get(styleId)
  while (cur && !seen.has(cur.styleId)) {
    seen.add(cur.styleId)
    chain.unshift(cur)
    cur = cur.basedOn ? table.char.get(cur.basedOn) : undefined
  }
  const out: IRFontStyle = {}
  for (const def of chain) if (def.rPr) Object.assign(out, definedOnly(def.rPr))
  return out
}

/** 只保留有值的键，避免 undefined 覆盖掉基类里的设置 */
function definedOnly<T extends object>(src: T): Partial<T> {
  const out: Record<string, unknown> = {}
  for (const k of Object.keys(src)) {
    const v = (src as Record<string, unknown>)[k]
    if (v !== undefined) out[k] = v
  }
  return out as Partial<T>
}

// ============================================================
// w:rPr / w:pPr 解析
// ============================================================

const HIGHLIGHT_COLORS: Record<string, string> = {
  black: '#000000',
  blue: '#0000ff',
  cyan: '#00ffff',
  darkBlue: '#000080',
  darkCyan: '#008080',
  darkGray: '#808080',
  darkGreen: '#008000',
  darkMagenta: '#800080',
  darkRed: '#800000',
  darkYellow: '#808000',
  green: '#00ff00',
  lightGray: '#c0c0c0',
  magenta: '#ff00ff',
  red: '#ff0000',
  white: '#ffffff',
  yellow: '#ffff00',
}

function normColor(v: string | undefined): string | undefined {
  if (!v) return undefined
  const s = v.trim()
  if (s === '' || s.toLowerCase() === 'auto') return undefined
  return s.startsWith('#') ? s.toUpperCase() : `#${s.toUpperCase()}`
}

export function parseRPr(rPr: XmlNode | undefined): IRFontStyle {
  const out: IRFontStyle = {}
  if (!rPr) return out

  const fonts = firstChild(rPr, 'w:rFonts')
  if (fonts) {
    // 中文文档必须优先取 eastAsia，否则宋体/黑体全丢，只剩 Calibri 之类的西文字体
    const fam = attr(fonts, 'w:eastAsia') ?? attr(fonts, 'w:ascii') ?? attr(fonts, 'w:hAnsi')
    if (fam) out.fontFamily = fam
  }

  const sz = attrNum(firstChild(rPr, 'w:sz'), 'w:val')
  // w:sz 的单位是**半磅**（HALF_PT_TO_PT = 0.5），21 → 10.5pt
  if (sz !== undefined) out.fontSizePt = sz * HALF_PT_TO_PT

  const b = onOff(firstChild(rPr, 'w:b'))
  if (b !== undefined) out.bold = b
  const i = onOff(firstChild(rPr, 'w:i'))
  if (i !== undefined) out.italic = i

  const u = firstChild(rPr, 'w:u')
  if (u) out.underline = (attr(u, 'w:val') ?? 'single') !== 'none'

  const strike = onOff(firstChild(rPr, 'w:strike'))
  if (strike !== undefined) out.strike = strike

  const color = normColor(attr(firstChild(rPr, 'w:color'), 'w:val'))
  if (color) out.color = color

  const hl = attr(firstChild(rPr, 'w:highlight'), 'w:val')
  if (hl && hl !== 'none') out.background = HIGHLIGHT_COLORS[hl] ?? undefined
  const shd = normColor(attr(firstChild(rPr, 'w:shd'), 'w:fill'))
  if (shd && !out.background) out.background = shd

  const va = attr(firstChild(rPr, 'w:vertAlign'), 'w:val')
  if (va === 'superscript' || va === 'subscript') out.vertAlign = va

  return out
}

function mapAlign(v: string | undefined): Align | undefined {
  switch (v) {
    case 'left':
    case 'start':
      return 'left'
    case 'center':
      return 'center'
    case 'right':
    case 'end':
      return 'right'
    case 'both':
    case 'distribute':
      return 'justify'
    default:
      return undefined
  }
}

export function parsePPr(pPr: XmlNode | undefined): IRParaStyle {
  const out: IRParaStyle = {}
  if (!pPr) return out

  const jc = mapAlign(attr(firstChild(pPr, 'w:jc'), 'w:val'))
  if (jc) out.align = jc

  const ind = firstChild(pPr, 'w:ind')
  if (ind) {
    const left = attrNum(ind, 'w:left') ?? attrNum(ind, 'w:start')
    if (left !== undefined) out.indentLeftMm = left * TWIPS_TO_MM
    const right = attrNum(ind, 'w:right') ?? attrNum(ind, 'w:end')
    if (right !== undefined) out.indentRightMm = right * TWIPS_TO_MM
    const first = attrNum(ind, 'w:firstLine')
    if (first !== undefined) out.indentFirstLineMm = first * TWIPS_TO_MM
    const hanging = attrNum(ind, 'w:hanging')
    // 悬挂缩进 = 负的首行缩进，直接转成负值更贴近视觉结果（v1 不做悬挂的逐行对齐）
    if (hanging !== undefined && first === undefined) out.indentFirstLineMm = -hanging * TWIPS_TO_MM
  }

  const spacing = firstChild(pPr, 'w:spacing')
  if (spacing) {
    const before = attrNum(spacing, 'w:before')
    if (before !== undefined) out.spaceBeforePt = before / 20 // twips → pt（1pt = 20 twips）
    const after = attrNum(spacing, 'w:after')
    if (after !== undefined) out.spaceAfterPt = after / 20
    const line = attrNum(spacing, 'w:line')
    const rule = attr(spacing, 'w:lineRule')
    if (line !== undefined) {
      if (rule === 'exact' || rule === 'atLeast') {
        out.lineHeightPt = line / 20
      } else {
        // auto：w:line 是 240 分之一行（240 = 单倍行距）
        out.lineHeight = line / 240
      }
    }
  }

  const shd = normColor(attr(firstChild(pPr, 'w:shd'), 'w:fill'))
  if (shd) out.background = shd

  const pStyle = firstChild(pPr, 'w:pStyle')
  if (pStyle) {
    const id = attr(pStyle, 'w:val')
    if (id) out.pStyleId = id
  }

  const rPr = firstChild(pPr, 'w:rPr')
  if (rPr) Object.assign(out, parseRPr(rPr))

  return out
}

// ============================================================
// 边框
// ============================================================

function parseBorderEdge(node: XmlNode | undefined): IRBorderEdge | undefined {
  if (!node) return undefined
  const style = attr(node, 'w:val') ?? 'single'
  if (style === 'none' || style === 'nil') return undefined
  const szEighth = attrNum(node, 'w:sz')
  return {
    style,
    // w:sz 单位是 1/8 磅
    widthPt: szEighth !== undefined ? szEighth / 8 : 0.5,
    color: normColor(attr(node, 'w:color')) ?? '#000000',
  }
}

function parseBorders(node: XmlNode | undefined): IRBorders | undefined {
  if (!node) return undefined
  const out: IRBorders = {}
  const map: Record<string, keyof IRBorders> = {
    'w:top': 'top',
    'w:bottom': 'bottom',
    'w:left': 'left',
    'w:start': 'left',
    'w:right': 'right',
    'w:end': 'right',
    'w:insideH': 'insideH',
    'w:insideV': 'insideV',
  }
  let any = false
  for (const [tag, key] of Object.entries(map)) {
    const edge = parseBorderEdge(firstChild(node, tag))
    if (edge) {
      out[key] = edge
      any = true
    }
  }
  return any ? out : undefined
}

// ============================================================
// 编号表（v1 简化为纯文本符号）
// ============================================================

interface NumLevel {
  fmt: string
  text: string
  start: number
  indentLeftMm?: number
}

export interface NumberingTable {
  numToAbstract: Map<string, string>
  abstract: Map<string, Map<number, NumLevel>>
}

export function parseNumbering(xml: string | undefined): NumberingTable {
  const numToAbstract = new Map<string, string>()
  const abstract = new Map<string, Map<number, NumLevel>>()
  if (!xml) return { numToAbstract, abstract }
  const root = parseXml(xml)

  for (const abs of findDeepAll(root, ['w:abstractNum'])) {
    const id = attr(abs, 'w:abstractNumId')
    if (id === undefined) continue
    const levels = new Map<number, NumLevel>()
    for (const lvl of childEls(abs, 'w:lvl')) {
      const ilvl = attrNum(lvl, 'w:ilvl') ?? 0
      const start = attrNum(firstChild(lvl, 'w:start'), 'w:val') ?? 1
      const fmt = attr(firstChild(lvl, 'w:numFmt'), 'w:val') ?? 'decimal'
      const text = attr(firstChild(lvl, 'w:lvlText'), 'w:val') ?? ''
      const lvlPPr = firstChild(lvl, 'w:pPr')
      const ind = attrNum(firstChild(lvlPPr, 'w:ind'), 'w:left')
      levels.set(ilvl, {
        fmt,
        text,
        start,
        ...(ind !== undefined ? { indentLeftMm: ind * TWIPS_TO_MM } : {}),
      })
    }
    abstract.set(id, levels)
  }

  for (const num of findDeepAll(root, ['w:num'])) {
    const numId = attr(num, 'w:numId')
    const absId = attr(firstChild(num, 'w:abstractNumId'), 'w:val')
    if (numId !== undefined && absId !== undefined) numToAbstract.set(numId, absId)
  }

  return { numToAbstract, abstract }
}

function listMarkerOf(
  numbering: NumberingTable,
  numId: string | undefined,
  ilvl: number,
): { marker: string; ordered: boolean; indentLeftMm?: number } | undefined {
  if (numId === undefined) return undefined
  const absId = numbering.numToAbstract.get(numId)
  if (absId === undefined) return undefined
  const level = numbering.abstract.get(absId)?.get(ilvl)
  if (!level) return undefined
  const ordered = level.fmt !== 'bullet' && level.fmt !== 'none'
  if (level.fmt === 'none') return undefined
  // v1 不做真实编号计数（需要跨段落维护计数器），统一退化为"符号 + 起始序号"
  const marker = ordered ? `${level.start}.` : '•'
  return {
    marker,
    ordered,
    ...(level.indentLeftMm !== undefined ? { indentLeftMm: level.indentLeftMm } : {}),
  }
}

// ============================================================
// 图片：字节 → dataURL
// ============================================================

const B64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/**
 * 自己实现 base64：不依赖 Buffer（Node 类型未引入）也不依赖 btoa（浏览器专有），
 * 保证同一份代码在插件 iframe 与 Node 自测里行为完全一致。
 */
export function toBase64(bytes: Uint8Array): string {
  let out = ''
  const len = bytes.length
  for (let i = 0; i < len; i += 3) {
    const b0 = bytes[i]
    const b1 = i + 1 < len ? bytes[i + 1] : 0
    const b2 = i + 2 < len ? bytes[i + 2] : 0
    out += B64_CHARS[b0 >> 2]
    out += B64_CHARS[((b0 & 0x03) << 4) | (b1 >> 4)]
    out += i + 1 < len ? B64_CHARS[((b1 & 0x0f) << 2) | (b2 >> 6)] : '='
    out += i + 2 < len ? B64_CHARS[b2 & 0x3f] : '='
  }
  return out
}

const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  bmp: 'image/bmp',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  emf: 'image/emf',
  wmf: 'image/wmf',
  tif: 'image/tiff',
  tiff: 'image/tiff',
}

/** 浏览器渲染不了的格式：还原了也显示不出来，需要提示用户 */
const NON_RENDERABLE = new Set(['emf', 'wmf', 'tif', 'tiff'])

function mimeOf(path: string): string {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase()
  return MIME_BY_EXT[ext] ?? 'application/octet-stream'
}

function extOf(path: string): string {
  return path.slice(path.lastIndexOf('.') + 1).toLowerCase()
}

// ============================================================
// 解析上下文
// ============================================================

interface Ctx {
  styles: StyleTable
  numbering: NumberingTable
  rels: Map<string, string>
  media: Map<string, Uint8Array>
  /** 惰性生成的 dataURL 缓存，relId → dataURL */
  mediaUrls: Map<string, string>
  report: CompatReport
  placeholderOptions: PlaceholderOptions
  counters: { para: number; table: number; image: number; textbox: number }
  /** 已提示过的全局性问题只报一次 */
  flags: Set<string>
  /** 页左边距（mm）：文本框锚点坐标是相对页面左边缘的，换算到版心坐标要减掉它 */
  pageMarginLeftMm: number
}

function sectionCountOf(documentRoot: XmlNode): number {
  return findDeepAll(documentRoot, ['w:sectPr']).length
}

// ============================================================
// 入口：纯函数，可单测
// ============================================================

export interface BuildIrOptions {
  /** 占位符语法开关（F3-15） */
  placeholder?: Partial<PlaceholderOptions>
  /** 额外循环标签（E-2 未实测期间的自定义注入） */
  loopTags?: LoopScanOptions
  /** 是否做循环检测（默认 true） */
  detectLoop?: boolean
}

export interface BuildIrResult {
  ir: IRDoc
  report: CompatReport
  /** relId → dataURL 的图片表（只包含被实际引用的图片） */
  media: Map<string, string>
}

export function buildIr(parts: DocxParts, opts: BuildIrOptions = {}): BuildIrResult {
  const report = createReport()
  const ctx: Ctx = {
    styles: parseStyles(parts.stylesXml),
    numbering: parseNumbering(parts.numberingXml),
    rels: parseRels(parts.relsXml),
    media: parts.media,
    mediaUrls: new Map(),
    report,
    placeholderOptions: opts.placeholder
      ? resolvePlaceholderOptions(opts.placeholder)
      : { ...DEFAULT_PLACEHOLDER_OPTIONS },
    counters: { para: 0, table: 0, image: 0, textbox: 0 },
    flags: new Set(),
    pageMarginLeftMm: 0,
  }

  const root = parseXml(parts.documentXml)
  const body = findDeep(root, 'w:body')
  if (!body) throw new DocxReadError('文件已损坏或不是有效的 Word 文档')

  const pageSetup = parsePageSetup(root, sectionCountOf(root), report)
  ctx.pageMarginLeftMm = pageSetup.margin.left
  const blocks = parseBlocks(body.children, ctx)

  const placeholders = collectPlaceholders(blocks)
  const loop = opts.detectLoop === false ? createEmptyLoopDetection() : detectLoops(blocks, opts.loopTags ?? {})

  // 图片统一在这里落成 dataURL：只有**被引用**的图片才会被编码，避免为废图做无谓工作
  resolveImages(blocks, ctx)

  reportUnsupportedElements(blocks, report)
  reportDocumentIssues(parts, report, ctx)

  const ir: IRDoc = {
    pageSetup,
    blocks,
    loop,
    placeholders,
    // 图片数据随 IR 一起走：改绑字段后重新映射时也不会丢图（见 IRDoc.media 的说明）
    media: ctx.mediaUrls,
    info: documentInfo(parts, pageSetup.sectionCount),
  }

  finalizeReport(report)
  return { ir, report, media: ctx.mediaUrls }
}

// ============================================================
// 图片解析（IR 里只留 relId，二进制在这里落成 dataURL）
// ============================================================

function resolveImages(blocks: readonly IRBlock[], ctx: Ctx): void {
  let imageNo = 0

  const visit = (obj: IRRunObject): void => {
    if (obj.kind === 'image') {
      imageNo++
      resolveOneImage(obj, imageNo, ctx)
    } else if (obj.kind === 'textbox') {
      walkBlocks(obj.blocks)
    }
  }

  const walkBlocks = (list: readonly IRBlock[]): void => {
    for (const b of list) {
      if (b.kind === 'paragraph') {
        for (const run of b.runs) for (const obj of run.objects) visit(obj)
      } else if (b.kind === 'table') {
        for (const row of b.rows) for (const cell of row.cells) walkBlocks(cell.blocks)
      }
    }
  }

  walkBlocks(blocks)
}

function resolveOneImage(img: IRImage, imageNo: number, ctx: Ctx): void {
  if (img.inlineDataUrl) {
    ctx.mediaUrls.set(img.relId, img.inlineDataUrl)
    return
  }
  if (ctx.mediaUrls.has(img.relId)) return

  const path = ctx.rels.get(img.relId)
  if (!path) {
    addIssueOnce(ctx.report, 'ignored', {
      kind: 'image-missing-rel',
      label: '图片',
      location: locImage(imageNo),
      detail: '关系表中找不到该图片的引用',
    })
    return
  }
  const bytes = ctx.media.get(path)
  if (!bytes) {
    addIssueOnce(ctx.report, 'ignored', {
      kind: 'image-missing-file',
      label: '图片',
      location: locImage(imageNo),
      detail: `压缩包内缺少 ${path}`,
    })
    return
  }

  const ext = extOf(path)
  if (NON_RENDERABLE.has(ext)) {
    // EMF/WMF 是矢量格式，浏览器 <img> 读不了；TIFF 也不支持
    addDegraded(ctx.report, {
      kind: 'image-format',
      label: '图片格式',
      location: locImage(imageNo),
      detail: `${ext.toUpperCase()} 格式浏览器无法直接渲染，预览中可能空白`,
    })
  }

  const MAX_INLINE = 300 * 1024 // F6-06：模板 JSON 内嵌图片单张上限 300KB
  if (bytes.length > MAX_INLINE) {
    addDegraded(ctx.report, {
      kind: 'image-too-large',
      label: '图片体积过大',
      location: locImage(imageNo),
      detail: `${Math.round(bytes.length / 1024)}KB 已超过 300KB 建议上限，建议压缩后重新导入`,
    })
  }

  ctx.mediaUrls.set(img.relId, `data:${mimeOf(path)};base64,${toBase64(bytes)}`)
}

/** 从一份 docx 二进制得到 IR（loadDocxParts + buildIr） */
export async function readDocx(
  data: ArrayBuffer | Uint8Array,
  opts: BuildIrOptions = {},
): Promise<BuildIrResult> {
  const parts = await loadDocxParts(data)
  return buildIr(parts, opts)
}

function documentInfo(parts: DocxParts, sectionCount: number): IRDocumentInfo {
  return {
    hasMacro: parts.hasMacro,
    hasCharts: parts.hasCharts,
    hasDiagrams: parts.hasDiagrams,
    headerFooterParts: parts.headerFooterParts,
    hasFootnotes: parts.hasFootnotes,
    hasEmbeddedFonts: parts.hasEmbeddedFonts,
    sectionCount,
  }
}

/** 文档级（无具体位置）的问题在这里统一登记，避免散落在解析逻辑里 */
function reportDocumentIssues(parts: DocxParts, report: CompatReport, ctx: Ctx): void {
  if (parts.hasMacro) {
    addIgnored(report, {
      kind: 'macro',
      label: 'VBA 宏',
      location: locDocument(),
      detail: '插件不支持宏，也不会执行任何宏代码',
    })
  }
  if (parts.hasCharts && !ctx.flags.has('chart-inline')) {
    addIgnored(report, { kind: 'chart', label: '图表', location: locDocument() })
  }
  if (parts.hasDiagrams && !ctx.flags.has('diagram-inline')) {
    addIgnored(report, { kind: 'smartart', label: 'SmartArt / 图示', location: locDocument() })
  }
  if (parts.hasFootnotes) {
    addIgnored(report, { kind: 'footnote', label: '脚注 / 尾注', location: locDocument() })
  }
  if (parts.hasEmbeddedFonts) {
    addIgnored(report, {
      kind: 'embedded-font',
      label: '嵌入字体',
      location: locDocument(),
      detail: '渲染时使用系统字体替代',
    })
  }
  if (parts.headerFooterParts > 0) {
    addDegraded(report, {
      kind: 'header-footer',
      label: '页眉页脚内容',
      location: locDocument(),
      detail: '仅还原了距边距离，内容未还原（v1.1 增强）',
    })
  }
  if (ctx.flags.has('list')) {
    addDegraded(report, {
      kind: 'numbering',
      label: '编号 / 项目符号列表',
      location: locDocument(),
      detail: '已简化为纯文本符号',
    })
  }
}

// ============================================================
// 页面设置
// ============================================================

function guessPaper(widthMm: number, heightMm: number): PaperKey {
  for (const [key, size] of Object.entries(PAPER_MM)) {
    const dw = Math.abs(size.w - widthMm)
    const dh = Math.abs(size.h - heightMm)
    if (dw <= 1.5 && dh <= 1.5) return key as PaperKey
  }
  return 'custom'
}

export function parsePageSetup(
  documentRoot: XmlNode,
  sectionCount: number,
  report?: CompatReport,
): IRPageSetup {
  // F3-07：多节只取第一节。document.xml 里节的顺序是文档顺序，
  // 因此"第一个 w:sectPr"就是第一节（最后一节才挂在 body 尾部）。
  const sectPr = findDeep(documentRoot, 'w:sectPr')
  const fallback: IRPageSetup = {
    widthMm: 210,
    heightMm: 297,
    orientation: 'portrait',
    margin: { top: 20, right: 20, bottom: 20, left: 20 },
    headerMm: 12,
    footerMm: 12,
    paper: 'A4',
    sectionCount,
    found: false,
  }
  if (!sectPr) return fallback

  const pgSz = firstChild(sectPr, 'w:pgSz')
  const wTwips = attrNum(pgSz, 'w:w')
  const hTwips = attrNum(pgSz, 'w:h')
  let widthMm = wTwips !== undefined ? wTwips * TWIPS_TO_MM : 210
  let heightMm = hTwips !== undefined ? hTwips * TWIPS_TO_MM : 297
  const orientAttr = attr(pgSz, 'w:orient')
  let orientation: 'portrait' | 'landscape' = orientAttr === 'landscape' ? 'landscape' : 'portrait'

  // 有些导出工具会把横向的纸张直接写成宽>高而**不带** w:orient，这里兜一下底
  if (!orientAttr && widthMm > heightMm) {
    orientation = 'landscape'
    const t = widthMm
    widthMm = heightMm
    heightMm = t
  } else if (orientation === 'landscape' && widthMm > heightMm) {
    // 带 orient=landscape 时 pgSz 已经是横向值，转回归一化的纵向值
    const t = widthMm
    widthMm = heightMm
    heightMm = t
  }

  const pgMar = firstChild(sectPr, 'w:pgMar')
  const tw = (name: string, fallbackMm: number): number => {
    const v = attrNum(pgMar, name)
    return v !== undefined ? v * TWIPS_TO_MM : fallbackMm
  }
  // pgMar 缺失时用 Word 的默认 1 英寸（25.4mm），而不是模板默认的 20mm —— 忠实于原文档
  const margin = {
    top: tw('w:top', 25.4),
    right: tw('w:right', 25.4),
    bottom: tw('w:bottom', 25.4),
    left: tw('w:left', 25.4),
  }
  const headerMm = tw('w:header', 12.7)
  const footerMm = tw('w:footer', 12.7)

  if (report && sectionCount > 1) {
    addDegraded(report, {
      kind: 'multi-section',
      label: '多节文档',
      location: locDocument(),
      detail: `文档包含 ${sectionCount} 节，已仅采用第一节的页面设置`,
    })
  }

  return {
    widthMm,
    heightMm,
    orientation,
    margin,
    headerMm,
    footerMm,
    paper: guessPaper(widthMm, heightMm),
    sectionCount,
    found: true,
  }
}

// ============================================================
// 块级解析
// ============================================================

/** 展开"透明的"容器：内容控件/修订/超链接/AlternateContent 等 */
function expandContainer(node: XmlNode): XmlNode[] {
  switch (node.tag) {
    case 'w:sdt': {
      const content = firstChild(node, 'w:sdtContent')
      return content ? content.children : []
    }
    case 'w:ins':
    case 'w:moveTo':
    case 'w:smartTag':
    case 'w:customXml':
    case 'w:hyperlink':
      return node.children
    case 'w:del':
    case 'w:moveFrom':
      return [] // 修订删除的内容不还原
    case 'mc:AlternateContent': {
      // DrawingML 与 VML 是同一形状的两种表示，只取前者，否则内容会翻倍
      const choice = firstChild(node, 'mc:Choice')
      if (choice) return choice.children
      const fallback = firstChild(node, 'mc:Fallback')
      return fallback ? fallback.children : []
    }
    default:
      return [node]
  }
}

function expandAll(nodes: readonly XmlNode[]): XmlNode[] {
  const out: XmlNode[] = []
  for (const n of nodes) out.push(...expandContainer(n))
  return out
}

export function parseBlocks(nodes: readonly XmlNode[], ctx: Ctx): IRBlock[] {
  const out: IRBlock[] = []
  for (const raw of nodes) {
    for (const node of expandContainer(raw)) {
      switch (node.tag) {
        case 'w:p':
          out.push(parseParagraph(node, ctx))
          break
        case 'w:tbl':
          out.push(parseTable(node, ctx))
          break
        case 'w:sectPr':
          break // 页面设置已在 parsePageSetup 处理
        case 'w:altChunk':
          ctx.counters.para++
          addIgnored(ctx.report, {
            kind: 'alt-chunk',
            label: '外部嵌入内容（altChunk）',
            location: locParagraph(ctx.counters.para),
          })
          break
        case 'w:bookmarkStart':
        case 'w:bookmarkEnd':
        case 'w:proofErr':
        case 'w:permStart':
        case 'w:permEnd':
        case 'w:commentRangeStart':
        case 'w:commentRangeEnd':
          break
        case 'w:sdtContent':
          out.push(...parseBlocks(node.children, ctx))
          break
        case 'w:object': {
          const unsupported = makeUnsupported(
            'OLE 对象',
            '【OLE 对象已忽略】',
            'ignored',
            locParagraph(ctx.counters.para + 1),
          )
          out.push(unsupported)
          break
        }
        default:
          // 未知的块级元素：不猜，直接跳过（不打断导入）
          break
      }
    }
  }
  return out
}

function makeUnsupported(
  label: string,
  placeholderText: string,
  action: 'ignored' | 'degraded',
  location: string,
  detail?: string,
): IRUnsupported {
  return {
    kind: 'unsupported',
    label,
    placeholderText,
    action,
    location,
    ...(detail ? { detail } : {}),
  }
}

/**
 * 把 IR 里所有"未支持元素"登记进报告。
 *
 * 为什么放在 IR 落地之后统一做，而不是在解析现场随手 addIssue：
 * 解析现场分散在 run / drawing / pict / 块级 四五个分支，逐个补报告极易漏；
 * 而 `IRUnsupported` 已经把「标签 + 位置 + 动作」都带上了，这里只需一次遍历即可全覆盖。
 */
function reportUnsupportedElements(blocks: readonly IRBlock[], report: CompatReport): void {
  const visitObject = (obj: IRRunObject): void => {
    if (obj.kind === 'unsupported') {
      addIssueOnce(report, obj.action, {
        kind: kindOfLabel(obj.label),
        label: obj.label,
        location: obj.location,
        ...(obj.detail ? { detail: obj.detail } : {}),
      })
    } else if (obj.kind === 'textbox') {
      visitBlocks(obj.blocks)
    }
  }
  const visitBlocks = (list: readonly IRBlock[]): void => {
    for (const b of list) {
      if (b.kind === 'paragraph') {
        for (const run of b.runs) for (const obj of run.objects) visitObject(obj)
      } else if (b.kind === 'table') {
        for (const row of b.rows) for (const cell of row.cells) visitBlocks(cell.blocks)
      } else if (b.kind === 'unsupported') {
        addIssueOnce(report, b.action, {
          kind: kindOfLabel(b.label),
          label: b.label,
          location: b.location,
          ...(b.detail ? { detail: b.detail } : {}),
        })
      }
    }
  }
  visitBlocks(blocks)
}

/** 报告分类 key：让 UI 能按种类聚合（"3 处图表"） */
function kindOfLabel(label: string): string {
  if (label.startsWith('OLE')) return 'ole'
  if (label.startsWith('图表')) return 'chart'
  if (label.startsWith('SmartArt')) return 'smartart'
  if (label.startsWith('艺术字')) return 'wordart'
  if (label.startsWith('链接式图片')) return 'linked-image'
  if (label.startsWith('VML')) return 'vml-shape'
  if (label.startsWith('形状')) return 'shape'
  if (label.includes('altChunk')) return 'alt-chunk'
  return 'unsupported'
}

function collectPlaceholders(blocks: readonly IRBlock[]) {
  const out: IRDoc['placeholders'] = []
  blocks.forEach((b, idx) => {
    if (b.kind === 'paragraph') {
      for (const p of b.placeholders) out.push({ ...p, blockIndex: idx })
    } else if (b.kind === 'table') {
      // 表格里的占位符不属于"顶层块"，但字段匹配页仍需要看到它们
      for (const row of b.rows) {
        for (const cell of row.cells) {
          for (const inner of collectPlaceholders(cell.blocks)) {
            out.push({ ...inner, blockIndex: idx })
          }
        }
      }
    }
  })
  return out
}

// ============================================================
// 段落
// ============================================================

export function parseParagraph(p: XmlNode, ctx: Ctx): IRParagraph {
  ctx.counters.para++
  const paraIndex = ctx.counters.para
  const pPr = firstChild(p, 'w:pPr')

  const styleBase: IRParaStyle = { ...ctx.styles.defaultParagraph }
  const pStyleId = attr(firstChild(pPr, 'w:pStyle'), 'w:val')
  Object.assign(styleBase, resolveParaStyleFromTable(ctx.styles, pStyleId))
  Object.assign(styleBase, definedOnly(parsePPr(pPr)))

  // 段落默认字符样式（pPr/w:rPr）向内联 run 继承
  const paraRunStyle: IRFontStyle = {
    ...definedOnly(pickFontKeys(ctx.styles.defaultParagraph)),
    ...pickFontKeys(styleBase),
  }

  const runs: IRRun[] = []
  const pageBreakBefore = onOff(firstChild(pPr, 'w:pageBreakBefore')) === true

  // 复杂域（w:fldChar begin/instrText/separate/end）需要跨 run 的状态机
  let fieldInstr: string | null = null
  let fieldCollecting = false
  let fieldStyle: IRFontStyle = {}

  const pushRun = (run: IRRun): void => {
    runs.push(run)
  }

  const emitField = (instr: string): void => {
    const mapped = mapFieldInstr(instr)
    if (mapped) {
      pushRun({ text: '', style: { ...fieldStyle }, objects: [{ kind: 'sysvar', key: mapped, instr }], objOffsets: [0] })
    } else {
      // F3-27：其他域忽略并列入报告（缓存值本身作为普通文本保留，见下方 fldSimple 分支）
      addIssueOnce(ctx.report, 'ignored', {
        kind: 'field',
        label: `域代码 ${instr.trim().toUpperCase()}`,
        location: locParagraph(paraIndex),
        detail: '未识别的域已忽略',
      })
    }
  }

  for (const rawChild of p.children) {
    if (rawChild.tag === 'w:pPr') continue
    for (const child of expandContainer(rawChild)) {
      if (child.tag === 'w:fldSimple') {
        const instr = attr(child, 'w:instr') ?? ''
        const mapped = mapFieldInstr(instr)
        if (mapped) {
          const innerStyle = runStyleInherit(innerFirstRun(child), ctx, paraRunStyle)
          pushRun({ text: '', style: innerStyle, objects: [{ kind: 'sysvar', key: mapped, instr }], objOffsets: [0] })
        } else {
          // 未识别的域：把缓存结果当普通文本保留，总比丢内容好
          addIssueOnce(ctx.report, 'ignored', {
            kind: 'field',
            label: `域代码 ${instr.trim().toUpperCase() || '(未知)'}`,
            location: locParagraph(paraIndex),
            detail: '已作为静态文本保留',
          })
          for (const inner of childEls(child, 'w:r')) pushRun(parseRun(inner, ctx, paraRunStyle))
        }
        continue
      }
      if (child.tag !== 'w:r') continue

      const fldChar = firstChild(child, 'w:fldChar')
      if (fldChar) {
        const type = attr(fldChar, 'w:fldCharType')
        if (type === 'begin') {
          fieldInstr = ''
          fieldCollecting = true
          fieldStyle = runStyleInherit(child, ctx, paraRunStyle)
        } else if (type === 'separate') {
          fieldCollecting = false
        } else if (type === 'end') {
          if (fieldInstr !== null) emitField(fieldInstr)
          fieldInstr = null
          fieldCollecting = false
        }
        continue
      }

      if (fieldInstr !== null) {
        if (fieldCollecting) {
          const instrText = childEls(child, 'w:instrText')
          for (const it of instrText) fieldInstr += it.text
        }
        // 域结果区间（separate 之后）的内容由我们自己的系统变量渲染，跳过
        continue
      }

      pushRun(parseRun(child, ctx, paraRunStyle))
    }
  }

  const runTexts = runs.map((r) => r.text)
  const fullText = runTexts.join('')
  // ⚠️ 关键：先把整段文本拼起来再匹配占位符（见 placeholders.ts 的说明）
  const placeholders: IRPlaceholder[] = findParagraphPlaceholders(runTexts, fullText, ctx.placeholderOptions)

  let list: IRParagraph['list'] | undefined
  const numId = attr(firstChild(firstChild(pPr, 'w:numPr'), 'w:numId'), 'w:val')
  const ilvl = attrNum(firstChild(firstChild(pPr, 'w:numPr'), 'w:ilvl'), 'w:val') ?? 0
  if (numId !== undefined) {
    const marker = listMarkerOf(ctx.numbering, numId, ilvl)
    if (marker) {
      list = { level: ilvl, marker: marker.marker, ordered: marker.ordered }
      ctx.flags.add('list')
      if (marker.indentLeftMm !== undefined && styleBase.indentLeftMm === undefined) {
        styleBase.indentLeftMm = marker.indentLeftMm
      }
    }
  }

  const hasObjects = runs.some((r) => r.objects.length > 0)
  return {
    kind: 'paragraph',
    text: fullText,
    runs,
    style: styleBase,
    placeholders,
    pageBreakBefore,
    ...(list ? { list } : {}),
    isEmpty: fullText.trim() === '' && !hasObjects,
  }
}

function innerFirstRun(node: XmlNode): XmlNode | undefined {
  return findDeep(node, 'w:r')
}

function pickFontKeys(s: IRFontStyle): IRFontStyle {
  return {
    ...(s.fontFamily !== undefined ? { fontFamily: s.fontFamily } : {}),
    ...(s.fontSizePt !== undefined ? { fontSizePt: s.fontSizePt } : {}),
    ...(s.bold !== undefined ? { bold: s.bold } : {}),
    ...(s.italic !== undefined ? { italic: s.italic } : {}),
    ...(s.underline !== undefined ? { underline: s.underline } : {}),
    ...(s.strike !== undefined ? { strike: s.strike } : {}),
    ...(s.color !== undefined ? { color: s.color } : {}),
    ...(s.background !== undefined ? { background: s.background } : {}),
    ...(s.vertAlign !== undefined ? { vertAlign: s.vertAlign } : {}),
  }
}

function mapFieldInstr(instr: string): SysVarKey | undefined {
  const head = instr.trim().split(/\s+/)[0]?.toUpperCase() ?? ''
  switch (head) {
    case 'PAGE':
      return 'pageNo'
    case 'NUMPAGES':
      return 'pageCount'
    case 'DATE':
      return 'today'
    default:
      return undefined
  }
}

function runStyleInherit(r: XmlNode | undefined, ctx: Ctx, inherited: IRFontStyle): IRFontStyle {
  if (!r) return { ...inherited }
  const rPr = firstChild(r, 'w:rPr')
  const rStyleId = attr(firstChild(rPr, 'w:rStyle'), 'w:val')
  return {
    ...inherited,
    ...resolveCharStyleFromTable(ctx.styles, rStyleId),
    ...definedOnly(parseRPr(rPr)),
  }
}

// ============================================================
// run
// ============================================================

export function parseRun(r: XmlNode, ctx: Ctx, inherited: IRFontStyle): IRRun {
  const style = runStyleInherit(r, ctx, inherited)
  const run: IRRun = { text: '', style, objects: [], objOffsets: [] }

  const addObject = (obj: IRRunObject): void => {
    run.objects.push(obj)
    run.objOffsets.push(run.text.length)
  }

  for (const rawChild of r.children) {
    if (rawChild.tag === 'w:rPr') continue
    for (const child of expandContainer(rawChild)) {
      switch (child.tag) {
        case 'w:t':
          // 不 trim：xml:space="preserve" 的空格是排版的一部分
          run.text += child.text
          break
        case 'w:tab':
          run.text += '\t'
          break
        case 'w:br': {
          const type = attr(child, 'w:type')
          if (type === 'page') addObject({ kind: 'pageBreak' })
          else if (type === 'column') {
            run.text += '\n'
            addIssueOnce(ctx.report, 'degraded', {
              kind: 'column-break',
              label: '分栏符',
              location: locParagraph(ctx.counters.para),
              detail: '已按换行处理',
            })
          } else run.text += '\n'
          break
        }
        case 'w:cr':
          run.text += '\n'
          break
        case 'w:noBreakHyphen':
          run.text += '-'
          break
        case 'w:softHyphen':
          break
        case 'w:sym':
          addIssueOnce(ctx.report, 'degraded', {
            kind: 'symbol',
            label: '符号字符（w:sym）',
            location: locParagraph(ctx.counters.para),
            detail: '符号字体字形无法映射，已忽略该字符',
          })
          break
        case 'w:drawing': {
          const obj = parseDrawing(child, ctx)
          if (obj) addObject(obj)
          break
        }
        case 'w:pict': {
          const obj = parsePict(child, ctx)
          if (obj) addObject(obj)
          break
        }
        case 'w:object':
          addObject(
            makeUnsupported('OLE 对象', '【OLE 对象已忽略】', 'ignored', locParagraph(ctx.counters.para)),
          )
          break
        case 'w:fldSimple': {
          // 规范里 fldSimple 只能挂在段落上，但个别导出工具会塞进 run 里；
          // 这里兜底处理，至少不把内容丢掉
          const instr = attr(child, 'w:instr') ?? ''
          const mapped = mapFieldInstr(instr)
          if (mapped) {
            addObject({ kind: 'sysvar', key: mapped, instr })
          } else {
            addIssueOnce(ctx.report, 'ignored', {
              kind: 'field',
              label: `域代码 ${instr.trim().toUpperCase() || '(未知)'}`,
              location: locParagraph(ctx.counters.para),
              detail: '已作为静态文本保留',
            })
            for (const inner of childEls(child, 'w:r')) {
              const r = parseRun(inner, ctx, style)
              // 保留文本（注意对象的偏移要整体后移，避免位置错乱）
              const base = run.text.length
              run.text += r.text
              r.objects.forEach((o, k) => {
                run.objects.push(o)
                run.objOffsets.push(base + (r.objOffsets[k] ?? 0))
              })
            }
          }
          break
        }
        case 'w:footnoteReference':
        case 'w:endnoteReference':
          addIssueOnce(ctx.report, 'ignored', {
            kind: 'footnote',
            label: '脚注 / 尾注引用',
            location: locParagraph(ctx.counters.para),
          })
          break
        default:
          break
      }
    }
  }

  return run
}

// ============================================================
// 图形：嵌入式图片 / 浮动图片 / 文本框 / 图表 / SmartArt
// ============================================================

function emuToMm(emu: number): number {
  // EMU → px → mm。直接除 360000 也行，但走 types.ts 的常量可保证口径统一
  return pxToMm(emu * EMU_TO_PX)
}

function graphicDataUri(holder: XmlNode): string | undefined {
  const gd = findDeep(holder, 'a:graphicData')
  return gd ? attr(gd, 'uri') : undefined
}

/**
 * 读 `wp:posOffset`。
 * ⚠️ 它的值是**元素文本**（`<wp:posOffset>914400</wp:posOffset>`），不是 `w:val` 属性；
 * 当成属性读会永远 undefined，浮动对象的位置就全丢了。
 */
function offsetEmu(node: XmlNode | undefined): number | undefined {
  if (!node) return undefined
  const trimmed = node.text.trim()
  if (trimmed !== '') {
    const n = Number(trimmed)
    if (Number.isFinite(n)) return n
  }
  return attrNum(node, 'w:val')
}

/** 锚点水平/垂直偏移（EMU）。relativeFrom=page 时才是相对页面，其它情况相对文本区 */
function anchorOffsets(anchor: XmlNode): { xEmu?: number; yEmu?: number; xFromPage: boolean } {
  const posH = firstChild(anchor, 'wp:positionH')
  const posV = firstChild(anchor, 'wp:positionV')
  const xEmu = offsetEmu(firstChild(posH, 'wp:posOffset'))
  const yEmu = offsetEmu(firstChild(posV, 'wp:posOffset'))
  const xFromPage = attr(posH, 'relativeFrom') === 'page'
  return {
    ...(xEmu !== undefined ? { xEmu } : {}),
    ...(yEmu !== undefined ? { yEmu } : {}),
    xFromPage,
  }
}

function parseDrawing(drawing: XmlNode, ctx: Ctx): IRRunObject | undefined {
  const inline = firstChild(drawing, 'wp:inline')
  const anchor = firstChild(drawing, 'wp:anchor')
  const holder = inline ?? anchor
  if (!holder) {
    addIssueOnce(ctx.report, 'ignored', {
      kind: 'shape',
      label: '未知图形',
      location: locParagraph(ctx.counters.para),
    })
    return undefined
  }
  const floating = !!anchor

  const uri = graphicDataUri(holder) ?? ''
  if (uri.endsWith('/chart')) {
    // 标记一下，避免后面又在文档级重复报一条"存在图表"
    ctx.flags.add('chart-inline')
    return makeUnsupported('图表', '【图表已忽略】', 'ignored', locParagraph(ctx.counters.para), '可改为插入固定图片')
  }
  if (uri.endsWith('/diagram')) {
    ctx.flags.add('diagram-inline')
    return makeUnsupported('SmartArt / 图示', '【SmartArt 已忽略】', 'ignored', locParagraph(ctx.counters.para))
  }

  const txbx = findDeep(holder, 'w:txbxContent')
  if (txbx) return parseDrawingTextBox(holder, txbx, floating, ctx)

  const blip = findDeep(holder, 'a:blip')
  const embed = blip ? attr(blip, 'r:embed') : undefined
  const link = blip ? attr(blip, 'r:link') : undefined
  if (!embed) {
    const at = locParagraph(ctx.counters.para)
    if (link) {
      return makeUnsupported('链接式图片', '【链接图片已忽略】', 'ignored', at, '外部链接无法离线还原')
    }
    // 形状 / 艺术字等（没有图片数据，也没有文本框内容）
    const label = uri.includes('wordprocessingShape') ? '形状 / 艺术字' : '未知图形对象'
    return makeUnsupported(label, '【形状已忽略】', 'ignored', at)
  }

  const extent = firstChild(holder, 'wp:extent')
  const cx = attrNum(extent, 'cx')
  const cy = attrNum(extent, 'cy')
  ctx.counters.image++
  const docPr = findDeep(holder, 'wp:docPr')
  const image: IRImage = {
    kind: 'image',
    relId: embed,
    widthMm: cx !== undefined ? emuToMm(cx) : 40,
    heightMm: cy !== undefined ? emuToMm(cy) : 40,
    floating,
    ...(docPr && attr(docPr, 'descr') ? { alt: attr(docPr, 'descr') as string } : {}),
  }
  if (floating && anchor) {
    const off = anchorOffsets(anchor)
    if (off.xEmu !== undefined) image.offsetXMm = emuToMm(off.xEmu)
    if (off.yEmu !== undefined) image.offsetYMm = emuToMm(off.yEmu)
    // F3-11：浮动图片降级为行内图片，需要提示（同一段落里多张图只提示一次）
    addIssueOnce(ctx.report, 'degraded', {
      kind: 'floating-image',
      label: '浮动环绕图片',
      location: locParagraph(ctx.counters.para),
      detail: '已按行内方式还原',
    })
  }
  return image
}

function parseDrawingTextBox(
  holder: XmlNode,
  txbx: XmlNode,
  floating: boolean,
  ctx: Ctx,
): IRTextBox {
  ctx.counters.textbox++
  const boxIndex = ctx.counters.textbox

  // 尺寸优先取 wps:spPr/a:ext，其次取 wp:extent
  const spPr = findDeep(holder, 'wps:spPr')
  const xfrm = spPr ? firstChild(spPr, 'a:xfrm') : undefined
  const ext = xfrm ? firstChild(xfrm, 'a:ext') : undefined
  const extent = firstChild(holder, 'wp:extent')
  const cx = attrNum(ext, 'cx') ?? attrNum(extent, 'cx')
  const cy = attrNum(ext, 'cy') ?? attrNum(extent, 'cy')
  const off = xfrm ? firstChild(xfrm, 'a:off') : undefined
  const offX = attrNum(off, 'x')
  const offY = attrNum(off, 'y')

  // 位置优先用锚点偏移（相对页面的绝对定位）；锚点没给才退回形状自身的 a:off。
  // 两者**不能相加**：Word 在浮动锚点里通常把绝对位置写在 positionH/V 上，a:off 只作形状内基准。
  const anchorOff: { xEmu?: number; yEmu?: number; xFromPage: boolean } = floating
    ? anchorOffsets(holder)
    : { xFromPage: false }
  const posX = anchorOff.xEmu
  const posY = anchorOff.yEmu

  const widthMm = cx !== undefined ? emuToMm(cx) : 0
  const heightMm = cy !== undefined ? emuToMm(cy) : 0

  // X：锚点/形状偏移换算到**版心**坐标（relativeFrom=page 时才是相对页面，需要减左边距）
  let xMm = 0
  if (posX !== undefined) {
    xMm = Math.max(0, emuToMm(posX) - (anchorOff.xFromPage ? ctx.pageMarginLeftMm : 0))
  } else if (offX !== undefined) {
    xMm = Math.max(0, emuToMm(offX) - ctx.pageMarginLeftMm)
  }

  const geometryOk = widthMm > 0 && heightMm > 0
  const blocks = parseBlocks(txbx.children, ctx)

  if (!geometryOk) {
    addIssueOnce(ctx.report, 'degraded', {
      kind: 'textbox-degraded',
      label: '文本框',
      location: locTextBox(boxIndex),
      detail: '未能解析出文本框尺寸，已降级为就近位置的纯文本',
    })
    return {
      kind: 'textbox',
      geometryOk: false,
      xMm: 0,
      widthMm: 0,
      heightMm: 0,
      source: 'drawingml',
      warning: '缺少 wp:extent / a:ext 尺寸信息',
      blocks,
    }
  }

  const yEmu = posY ?? offY
  return {
    kind: 'textbox',
    geometryOk: true,
    xMm,
    ...(yEmu !== undefined ? { yMm: emuToMm(yEmu) } : {}),
    widthMm,
    heightMm,
    source: 'drawingml',
    warning: floating ? '浮动文本框的位置为近似还原（Word 的定位基准包含版式细节）' : undefined,
    blocks,
  }
}

/** VML 老式图形（w:pict）：文本框 / 图片 / 水印 / 形状 */
function parsePict(pict: XmlNode, ctx: Ctx): IRRunObject | undefined {
  const shape = findDeepAny(pict, ['v:shape', 'v:rect', 'v:roundrect', 'v:group', 'v:oval'])
  const style = shape ? attr(shape, 'style') : undefined
  const geom = style ? parseVmlStyle(style) : undefined

  if (findDeep(pict, 'v:textpath')) {
    return makeUnsupported('艺术字（VML）', '【艺术字已忽略】', 'ignored', locParagraph(ctx.counters.para))
  }

  const txbx = findDeep(pict, 'w:txbxContent')
  if (txbx) {
    ctx.counters.textbox++
    const boxIndex = ctx.counters.textbox
    const geometryOk = !!(geom && geom.widthMm > 0 && geom.heightMm > 0)
    const blocks = parseBlocks(txbx.children, ctx)
    if (!geometryOk) {
      addIssueOnce(ctx.report, 'degraded', {
        kind: 'textbox-degraded',
        label: '文本框',
        location: locTextBox(boxIndex),
        detail: '未能解析出文本框尺寸，已降级为就近位置的纯文本',
      })
    }
    return {
      kind: 'textbox',
      geometryOk,
      xMm: geom?.leftMm ?? 0,
      ...(geom?.topMm !== undefined ? { yMm: geom.topMm } : {}),
      widthMm: geom?.widthMm ?? 0,
      heightMm: geom?.heightMm ?? 0,
      source: 'vml',
      warning: 'VML 定位为近似还原',
      blocks,
    }
  }

  const imagedata = findDeep(pict, 'v:imagedata')
  if (imagedata) {
    const rid = attr(imagedata, 'r:id') ?? attr(imagedata, 'r:href')
    // w:binData 是直接内嵌的 base64，比 rels 更直接
    const bin = findDeep(pict, 'w:binData')
    if (bin && bin.text.trim()) {
      ctx.counters.image++
      return {
        kind: 'image',
        relId: `bin:${ctx.counters.image}`,
        inlineDataUrl: `data:image/png;base64,${bin.text.trim()}`,
        widthMm: geom?.widthMm ?? 40,
        heightMm: geom?.heightMm ?? 40,
        floating: false,
      }
    }
    if (rid) {
      ctx.counters.image++
      return {
        kind: 'image',
        relId: rid,
        widthMm: geom?.widthMm ?? 40,
        heightMm: geom?.heightMm ?? 40,
        floating: false,
      }
    }
  }

  const isWatermark = (attr(shape, 'id') ?? '').toLowerCase().includes('watermark')
  if (isWatermark) {
    addIgnored(ctx.report, {
      kind: 'watermark',
      label: '水印',
      location: locParagraph(ctx.counters.para),
    })
    return undefined
  }
  return makeUnsupported('VML 图形', '【图形已忽略】', 'ignored', locParagraph(ctx.counters.para))
}

/** 解析 VML 的 style="position:absolute;margin-left:10pt;width:100pt;height:50pt" */
function parseVmlStyle(style: string): {
  leftMm?: number
  topMm?: number
  widthMm: number
  heightMm: number
} | undefined {
  const props = new Map<string, string>()
  for (const part of style.split(';')) {
    const idx = part.indexOf(':')
    if (idx <= 0) continue
    props.set(part.slice(0, idx).trim().toLowerCase(), part.slice(idx + 1).trim())
  }
  const toMm = (v: string | undefined): number | undefined => {
    if (!v) return undefined
    const m = /^(-?[\d.]+)(pt|px|in|cm|mm|pc)?$/.exec(v.trim())
    if (!m) return undefined
    const n = Number(m[1])
    if (!Number.isFinite(n)) return undefined
    switch (m[2]) {
      case 'pt':
        return n * (25.4 / 72)
      case 'in':
        return n * 25.4
      case 'cm':
        return n * 10
      case 'px':
        return pxToMm(n)
      case 'pc':
        return n * (25.4 / 6)
      case 'mm':
      case undefined:
      default:
        return n
    }
  }
  const widthMm = toMm(props.get('width')) ?? 0
  const heightMm = toMm(props.get('height')) ?? 0
  if (widthMm === 0 && heightMm === 0) return undefined
  const leftMm = toMm(props.get('margin-left'))
  const topMm = toMm(props.get('margin-top'))
  return {
    ...(leftMm !== undefined ? { leftMm } : {}),
    ...(topMm !== undefined ? { topMm } : {}),
    widthMm,
    heightMm,
  }
}

// ============================================================
// 表格
// ============================================================

export function parseTable(tbl: XmlNode, ctx: Ctx): IRTable {
  ctx.counters.table++
  const tableIndex = ctx.counters.table
  const tblPr = firstChild(tbl, 'w:tblPr')

  const borders = parseBorders(firstChild(tblPr, 'w:tblBorders'))
  let cellPaddingMm: number | undefined
  const cellMar = firstChild(tblPr, 'w:tblCellMar')
  if (cellMar) {
    const l = attrNum(firstChild(cellMar, 'w:left'), 'w:w')
    const t = attrNum(firstChild(cellMar, 'w:top'), 'w:w')
    const pick = l ?? t
    if (pick !== undefined) cellPaddingMm = pick * TWIPS_TO_MM
  }
  // 直接属性缺失时回退到表格样式（很多模板靠 w:tblStyle 提供边框）
  const tblStyleId = attr(firstChild(tblPr, 'w:tblStyle'), 'w:val')
  const styleDef = tblStyleId ? ctx.styles.table.get(tblStyleId) : undefined
  const effectiveBorders = borders ?? styleDef?.borders
  if (cellPaddingMm === undefined && styleDef?.cellMarMm !== undefined) cellPaddingMm = styleDef.cellMarMm

  const gridNode = firstChild(tbl, 'w:tblGrid')
  const colWidthsMm: number[] = []
  if (gridNode) {
    for (const col of childEls(gridNode, 'w:gridCol')) {
      const w = attrNum(col, 'w:w')
      if (w !== undefined) colWidthsMm.push(w * TWIPS_TO_MM)
    }
  }

  const rows: IRTableRow[] = []
  for (const tr of childEls(tbl, 'w:tr')) {
    const trPr = firstChild(tr, 'w:trPr')
    // 递归表头行：<w:tblHeader/> 无 val 即 true
    const isHeader = onOff(firstChild(trPr, 'w:tblHeader')) === true
    const trHeightNode = firstChild(trPr, 'w:trHeight')
    const heightTwips = attrNum(trHeightNode, 'w:val')
    const hRule = attr(trHeightNode, 'w:hRule')

    const cells: IRTableCell[] = []
    childEls(tr, 'w:tc').forEach((tc) => {
      const tcPr = firstChild(tc, 'w:tcPr')
      const gridSpan = attrNum(firstChild(tcPr, 'w:gridSpan'), 'w:val') ?? 1
      const vMergeVal = attr(firstChild(tcPr, 'w:vMerge'), 'w:val')
      const hasVMerge = firstChild(tcPr, 'w:vMerge') !== undefined
      const vMerge: IRTableCell['vMerge'] = hasVMerge
        ? vMergeVal === 'restart'
          ? 'restart'
          : 'continue'
        : undefined

      const cellStyle: IRParaStyle = {}
      const shd = normColor(attr(firstChild(tcPr, 'w:shd'), 'w:fill'))
      if (shd) cellStyle.background = shd
      const vAlignRaw = attr(firstChild(tcPr, 'w:vAlign'), 'w:val')
      const vAlign: VAlign | undefined =
        vAlignRaw === 'center' ? 'middle' : vAlignRaw === 'bottom' ? 'bottom' : vAlignRaw === 'top' ? 'top' : undefined
      if (vAlign) cellStyle.vAlign = vAlign

      let paddingMm: number | undefined
      const tcMar = firstChild(tcPr, 'w:tcMar')
      if (tcMar) {
        const l = attrNum(firstChild(tcMar, 'w:left'), 'w:w')
        const t = attrNum(firstChild(tcMar, 'w:top'), 'w:w')
        const pick = l ?? t
        if (pick !== undefined) paddingMm = pick * TWIPS_TO_MM
      }

      const innerBlocks = parseBlocks(
        tc.children.filter((c) => c.tag !== 'w:tcPr'),
        ctx,
      )

      const tcW = attrNum(firstChild(tcPr, 'w:tcW'), 'w:w')
      const tcWType = attr(firstChild(tcPr, 'w:tcW'), 'w:type')
      const widthMm =
        tcW !== undefined && tcWType !== 'pct' && tcWType !== 'auto' ? tcW * TWIPS_TO_MM : undefined

      const tcBorders = parseBorders(firstChild(tcPr, 'w:tcBorders'))
      cells.push({
        colspan: gridSpan,
        ...(vMerge ? { vMerge } : {}),
        blocks: innerBlocks,
        style: cellStyle,
        ...(tcBorders ? { border: tcBorders } : {}),
        ...(paddingMm !== undefined ? { paddingMm } : {}),
        ...(widthMm !== undefined ? { widthMm } : {}),
      })
    })

    rows.push({
      cells,
      isHeader,
      ...(heightTwips !== undefined ? { heightMm: heightTwips * TWIPS_TO_MM } : {}),
      ...(hRule !== undefined ? { heightExact: hRule === 'exact' } : {}),
    })
  }

  // tblGrid 缺失（部分工具导出时省略）→ 用单元格宽度或均分兜底，避免列宽全 0
  if (colWidthsMm.length === 0) {
    const firstRow = rows.find((r) => r.cells.some((c) => !c.vMerge || c.vMerge === 'restart'))
    if (firstRow) {
      for (const c of firstRow.cells) {
        if (c.vMerge === 'continue') continue
        colWidthsMm.push(c.widthMm ?? 30)
      }
    }
    if (colWidthsMm.length === 0) colWidthsMm.push(150)
  }

  const widthMm = colWidthsMm.reduce((a, b) => a + b, 0)
  if (rows.every((r) => r.cells.length === 0)) {
    addIssueOnce(ctx.report, 'ignored', {
      kind: 'empty-table',
      label: '空表格',
      location: locTable(tableIndex),
    })
  }

  const jc = mapAlign(attr(firstChild(tblPr, 'w:jc'), 'w:val'))
  return {
    kind: 'table',
    rows,
    colWidthsMm,
    border: effectiveBorders ?? {},
    ...(cellPaddingMm !== undefined ? { cellPaddingMm } : {}),
    ...(jc ? { align: jc } : {}),
    widthMm,
  }
}

export type { IRBlock, IRImage, IRTextBox, IRUnsupported }
