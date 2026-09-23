/**
 * HTML 生成（**纯函数，不碰 DOM**，可在 Node 里单测）。
 *
 * 关键设计：预览与打印**共用同一份 HTML**（PRD F5-01 的"1:1 还原"就是靠这个保证的）。
 * 如果预览走 React 组件、打印走拼字符串，两边迟早会漂移，所以这里只产出一种产物。
 *
 * 三条硬约束（都是踩过坑的）：
 * 1) 所有样式**内联**：打印 iframe 里不保证能加载外部 CSS，`<link>` 在部分沙箱里直接静默失败。
 * 2) 所有数值必须过 `finite()`：无头环境/离屏容器里 getBoundingClientRect 全 0，
 *    一旦把 NaN 写进 style，整页样式会被浏览器整条丢弃（不是只丢那一个属性）。
 * 3) 中文必须指定完整字体栈：只写 `sans-serif` 会让 Windows 打印出宋体，中英混排非常难看。
 */

import { resolveCellEdges } from '../components/editor/table-actions'
/*
 * ⚠️ 格内子元素的尺寸口径（`w` = 占格宽百分比、`h` = 固定盒高）**不再从
 *    `components/editor/cell-child` 引** —— 那条"渲染层 → 编辑器层"的跨层引用已于
 *    2026-09-23 收口到 `lib/cell-geometry.ts`（见下面那处 import 的说明）。
 *    上面 `resolveCellEdges` 这一处跨层引用**暂时保留**（挪它成本大于收益），
 *    但方向是同一个毛病：渲染引擎不该依赖 UI 层。
 */
import type {
  AnyElement,
  AttachmentPrintConfig,
  BarcodeElement,
  CodeSource,
  InlineNode,
  InlineSysVar,
  PageSetup,
  QrCodeElement,
  TableCell,
  TableElement,
  TextStyle,
} from '../lib/types'
import {
  DEFAULT_PRINT_TIME_FORMAT,
  DEFAULT_TODAY_FORMAT,
  finite,
  mmToPx,
  pageRenderSize,
  ptToMm,
  pxToMm,
} from '../lib/types'
import type { RecordItem } from '../lib/data-source'
import { fieldMeta, formatDateTime, isImageAttachment, isVectorImage, renderCellValue } from '../lib/field-types'
/*
 * 格内子元素的尺寸口径 —— 与画布（`components/editor/cell-child.ts`）**共用同一份实现**。
 * 下沉到 `lib/` 就是为了让渲染引擎可以引用它，而不必反向 import UI 层。
 */
import { childBoxWidthMm, childHeightMm, childWidthPct } from '../lib/cell-geometry'
import type { PageModel, RenderContext, RenderWarning, ResolvedImage } from './context'
import { imageKey } from './context'
import { barcodeSvg, isCode128Encodable, qrCodeSvg, QR_MAX_BYTES, utf8ByteLength } from './code-elements'

// ============================================================
// 常量
// ============================================================

/**
 * 中文优先的字体栈。
 * 不写 Serif 兜底，因为 Windows 下中文 sans-serif 会落到宋体；
 * 明确列出雅黑 / 苹方 / 思源黑体，保证与编辑器画布所见一致。
 */
export const FONT_STACK =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Hiragino Sans GB', " +
  "'Microsoft YaHei UI', 'Microsoft YaHei', 'Source Han Sans SC', 'Noto Sans CJK SC', " +
  "'WenQuanYi Micro Hei', 'Heiti SC', sans-serif"

const DEFAULT_COLOR = '#1f2329'
const MUTED_COLOR = '#8f959e'
const DEFAULT_FONT_PT = 10.5
const DEFAULT_LINE_HEIGHT = 1.5

/** 单元格文本渲染上限（E-12：超过 10000 字截断） */
const MAX_TEXT_LEN = 10000

/** 页码/总页数占位令牌。用 Unicode 私用区，避免与用户数据里的文本撞车 */
const TOK_PAGE_NO = '\uE000BPPAGE\uE000'
const TOK_PAGE_COUNT = '\uE000BPCOUNT\uE000'
/** 供自测断言使用 */
export const PAGE_TOKENS = { pageNo: TOK_PAGE_NO, pageCount: TOK_PAGE_COUNT } as const

/**
 * 把页码令牌替换成具体数字。**所有**替换都必须走这里（最终产物 + 测量占位），
 * 否则"渲染时写什么"和"测量时按什么量"会各自实现一遍，迟早漂移。
 */
export function replacePageTokens(html: string, pageNo: string, pageCount: string): string {
  return html.split(TOK_PAGE_NO).join(pageNo).split(TOK_PAGE_COUNT).join(pageCount)
}

/**
 * **测量专用**的页码占位（两位数字）。
 *
 * 为什么测量要单独换一次：令牌是 8/9 个私用区字符（`pageNo` 8 个、`pageCount` 9 个），
 * 在窄框里必然折行，而它最终只会被替换成
 * 一两个数字 —— 于是"量到的高度"比"实际渲染的高度"多一整行。用户给的真实模板就是
 * 34mm 窄框 + 「第 X 页 / 共 Y 页」，实测多算了 5.55mm（一个行高），贴近分页边界时会把
 * 内容挤到下一页。所以测量前必须先把令牌换成**与最终数字等宽**的占位。
 *
 * 为什么是**两位**：数字在项目的中文字体栈下等宽，两位覆盖 ≤99 页（打印文档的绝大多数）。
 * 超过 99 页时占位比真实值窄一个数字（≈1.9mm），只有在**恰好卡在折行边界**时才会差一行 ——
 * 这是"测量发生在页数算出来之前"这一事实决定的固有边界，不额外补偿：
 * 为它放大占位反而会把"偶发的少一行"换成"稳定多一行"，把最常见的情况做坏。
 *
 * 注意：占位只进 `measureBlocks` 的入参，**最终产物仍然走令牌 + 逐页替换**（见 buildDocumentHtml），
 * 所以宽框模板（令牌本来就不折行）的产物逐字节不变。
 */
export const MEASURE_PAGE_PLACEHOLDER = '88'

/**
 * 页面安全余量（mm）。
 * 浏览器按 CSS 分页时会有亚像素取整：section 高度**恰好**等于可打印高度时，
 * 有相当概率把 1px 挤到下一页，产出"每隔一页一张白纸"的经典 bug。
 * 因此页面高度统一收 0.2mm —— 视觉上完全不可见，但能稳住分页。
 */
const PAGE_SAFETY_MM = 0.2

// ============================================================
// 基础工具
// ============================================================

/** HTML 文本转义。字段值里出现 `<` `&` 是常态（尤其公式字段），不转义会直接把 DOM 搞坏 */
export function escapeHtml(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;',
  )
}

/** 属性值转义（比文本多一条：不能含双引号，否则 style 属性会被截断） */
function attr(s: unknown): string {
  return escapeHtml(s)
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000
}

/** mm → CSS px（保留 3 位小数，避免出现 793.7007874015748px 这种噪声） */
function px(mm: number): string {
  return `${round3(finite(mmToPx(finite(mm))))}px`
}

/** pt → CSS px */
function pxPt(pt: number): string {
  return px(ptToMm(finite(pt, DEFAULT_FONT_PT)))
}

// ============================================================
// 文本样式
// ============================================================

/** 文本框通用布局声明：保留换行、允许长词断行 */
const TEXT_FLOW = 'white-space:pre-wrap;word-break:break-word;overflow-wrap:anywhere'

function textCss(style: TextStyle | undefined, over: string[] = []): string {
  const s = style ?? {}
  const parts: string[] = []
  const family = s.fontFamily && s.fontFamily !== 'system' ? String(s.fontFamily) : FONT_STACK
  parts.push(`font-family:${family}`)
  parts.push(`font-size:${pxPt(s.fontSizePt ?? DEFAULT_FONT_PT)}`)
  if (s.bold) parts.push('font-weight:700')
  if (s.italic) parts.push('font-style:italic')
  const deco: string[] = []
  if (s.underline) deco.push('underline')
  if (s.strike) deco.push('line-through')
  if (deco.length) parts.push(`text-decoration:${deco.join(' ')}`)
  parts.push(`color:${s.color ?? DEFAULT_COLOR}`)
  if (s.background) parts.push(`background:${s.background}`)
  parts.push(`text-align:${s.align ?? 'left'}`)
  if (typeof s.lineHeightPt === 'number') parts.push(`line-height:${pxPt(s.lineHeightPt)}`)
  else parts.push(`line-height:${finite(s.lineHeight, DEFAULT_LINE_HEIGHT)}`)
  if (typeof s.spaceBeforePt === 'number') parts.push(`margin-top:${pxPt(s.spaceBeforePt)}`)
  if (typeof s.spaceAfterPt === 'number') parts.push(`margin-bottom:${pxPt(s.spaceAfterPt)}`)
  if (typeof s.indentLeftMm === 'number') parts.push(`padding-left:${px(s.indentLeftMm)}`)
  if (typeof s.indentRightMm === 'number') parts.push(`padding-right:${px(s.indentRightMm)}`)
  if (typeof s.indentFirstLineMm === 'number') parts.push(`text-indent:${px(s.indentFirstLineMm)}`)
  return parts.concat(over).join(';')
}

function vAlignCss(v: string | undefined): string {
  return v === 'middle' ? 'vertical-align:middle' : v === 'bottom' ? 'vertical-align:bottom' : 'vertical-align:top'
}

/**
 * 行内节点（`<span>`）专用样式。
 *
 * 刻意**不再重复** font-family / text-align / 行距 / 缩进：
 * 这些属性外层块容器已经声明过，span 会自然继承，而内联元素本来就忽略
 * text-align 与 margin。重复声明会把 HTML 体积放大好几倍
 * （整条中文字体栈约 300 字符，一页几十个 span 很快就上兆）。
 */
function inlineCss(style: TextStyle | undefined): string {
  const s = style ?? {}
  const parts: string[] = []
  if (s.fontFamily && s.fontFamily !== 'system') parts.push(`font-family:${s.fontFamily}`)
  parts.push(`font-size:${pxPt(s.fontSizePt ?? DEFAULT_FONT_PT)}`)
  if (s.bold) parts.push('font-weight:700')
  if (s.italic) parts.push('font-style:italic')
  const deco: string[] = []
  if (s.underline) deco.push('underline')
  if (s.strike) deco.push('line-through')
  if (deco.length) parts.push(`text-decoration:${deco.join(' ')}`)
  if (s.color) parts.push(`color:${s.color}`)
  if (s.background) parts.push(`background:${s.background}`)
  if (typeof s.lineHeightPt === 'number') parts.push(`line-height:${pxPt(s.lineHeightPt)}`)
  else if (typeof s.lineHeight === 'number') parts.push(`line-height:${finite(s.lineHeight, DEFAULT_LINE_HEIGHT)}`)
  return parts.join(';')
}

// ============================================================
// 行内节点
// ============================================================

export interface RenderScope {
  /** 当前记录；模板里循环区外的字段取首行值，因此这里可能传首条记录 */
  record: RecordItem | null
  /** 记录在打印范围内的 0 基下标（系统变量 ${行号} 用） */
  recordIndex: number
  /** 该内容块可用的宽度（mm） */
  widthMm: number
  /** 该内容块可用的高度（mm）；未知时不作为约束（附件"适配单元格"用） */
  heightMm?: number
  /** 用于警告定位 */
  elementId?: string
}

function clippedText(s: string, scope: RenderScope, warnings: RenderWarning[]): string {
  if (s.length <= MAX_TEXT_LEN) return s
  warnings.push({
    kind: 'text-truncated',
    message: `单元格内容超过 ${MAX_TEXT_LEN} 字，已截断显示（E-12）`,
    elementId: scope.elementId,
    recordId: scope.record?.recordId,
  })
  return `${s.slice(0, MAX_TEXT_LEN)}…`
}

/** 求值单个字段占位符。失效/未绑定**必须显式告警**（E-13：禁止静默丢值） */
function resolveField(fieldId: string | null, fieldName: string, scope: RenderScope, ctx: RenderContext, warnings: RenderWarning[]): string {
  if (!fieldId) {
    warnings.push({
      kind: 'field-unbound',
      message: `占位符「${fieldName || '未命名'}」未绑定字段，将渲染为空`,
      elementId: scope.elementId,
      recordId: scope.record?.recordId,
    })
    return ''
  }
  const meta = ctx.fieldMap.get(fieldId)
  if (!meta) {
    warnings.push({
      kind: 'field-missing',
      message: `字段「${fieldName || fieldId}」不存在（可能已被删除），将渲染为空`,
      elementId: scope.elementId,
      recordId: scope.record?.recordId,
    })
    return ''
  }
  if (!scope.record) return ''
  return clippedText(renderCellValue(scope.record.fields[fieldId], meta.type), scope, warnings)
}

/**
 * 时间类系统变量（`today` / `printTime`）的取值。
 *
 * 不指定 `format` 时**直接返回原始串**，而不是"解析回时间戳、再按默认格式重排一遍"：
 * 原始串本来就是用默认格式生成的（`today` = DEFAULT_TODAY_FORMAT，
 * `printTime` = DEFAULT_PRINT_TIME_FORMAT），重排只是白绕一圈，还会引入两类风险
 * （日期串按 UTC 解析在负时区差一天、'YYYY-MM-DD HH:mm' 这种空格分隔写法不是标准 ISO）。
 * 与默认格式比对而不是硬编码，是为了"默认值在哪"与契约里的常量同源。
 *
 * 指定了 `format` 才需要回到时间戳：把空格换成分隔符 `T`（否则部分引擎解析不了），
 * 只有日期没有时间时补 `T00:00` 强制按**本地时间**解析（纯日期串 JS 会按 UTC 解析）。
 * 解析不出来（模板被手改过、传进来一个不是日期的串）就原样返回 —— 绝不抛错、绝不报警告。
 */
function resolveTimeVar(raw: string, format: string | undefined, defaultFormat: string): string {
  const fmt = typeof format === 'string' && format.trim() !== '' ? format.trim() : defaultFormat
  if (fmt === defaultFormat) return raw
  if (!raw) return ''
  const iso = raw.includes(' ') ? raw.replace(' ', 'T') : `${raw}T00:00`
  const ms = Date.parse(iso)
  return Number.isFinite(ms) ? formatDateTime(ms, fmt) : raw
}

/**
 * 系统变量 → 文本。
 *
 * 契约只在**用得到的**分支上读取 `format` / `hideTotal`：出现在别的变量上时自然被忽略，
 * 不需要额外的校验或警告 —— 模板会被复制粘贴、也会被手改，为此报错只会制造噪音。
 */
function resolveSysVar(node: InlineSysVar, scope: RenderScope, ctx: RenderContext): string {
  switch (node.key) {
    case 'rowNo':
      return String(scope.recordIndex + 1)
    case 'today':
      return resolveTimeVar(ctx.today, node.format, DEFAULT_TODAY_FORMAT)
    // 打印时间在进入渲染时**取一次就固定**（见 pipeline），否则跨分钟翻页时同一篇
    // 文档会出现两个时间，用户会以为打错了。
    case 'printTime':
      return resolveTimeVar(ctx.printTime ?? '', node.format, DEFAULT_PRINT_TIME_FORMAT)
    case 'totalRows':
      return String(ctx.totalRows)
    case 'pageNo':
      return TOK_PAGE_NO
    case 'pageCount':
      return TOK_PAGE_COUNT
    // 合并形态：页码与总页数拼成一句，`hideTotal` 时省略"共 N 页"。
    // 两个数字都用**渲染期已有的令牌**，不在这里自己算页数 —— 页数要到分页结果
    // 出来才知道，令牌由 buildDocumentHtml 逐页替换（见 TOK_PAGE_NO 注释）。
    case 'pageOfTotal':
      return node.hideTotal === true
        ? `第 ${TOK_PAGE_NO} 页`
        : `第 ${TOK_PAGE_NO} 页 / 共 ${TOK_PAGE_COUNT} 页`
    default:
      return ''
  }
}

/** 行内节点 → HTML。所有用户可见文本一律 escapeHtml */
export function renderInline(
  nodes: InlineNode[] | undefined,
  scope: RenderScope,
  ctx: RenderContext,
  warnings: RenderWarning[],
): string {
  if (!nodes || nodes.length === 0) return ''
  let out = ''
  for (const n of nodes) {
    switch (n.type) {
      case 'text':
        out += `<span style="${attr(inlineCss(n.style))}">${escapeHtml(n.text)}</span>`
        break
      case 'field':
        out += `<span style="${attr(inlineCss(n.style))}">${escapeHtml(
          resolveField(n.fieldId, n.fieldName, scope, ctx, warnings),
        )}</span>`
        break
      case 'sysvar':
        out += `<span style="${attr(inlineCss(n.style))}">${escapeHtml(resolveSysVar(n, scope, ctx))}</span>`
        break
      case 'br':
        out += '<br>'
        break
      default:
        break
    }
  }
  return out
}

// ============================================================
// 附件图片排版（PRD F4.3）
// ============================================================

export interface AttachmentItem {
  token: string
  name: string
  /** 已解析到的可访问地址；缺省表示加载失败 → 渲染占位框（F4-24） */
  url?: string
  mime?: string
  /** 原图像素尺寸，用于等比换算与 DPI 校验 */
  widthPx?: number
  heightPx?: number
}

export interface AttachmentLayoutResult {
  html: string
  /** 内容高度（mm），调用方可直接用于测量校验 */
  heightMm: number
  warnings: RenderWarning[]
}

interface FlowItem {
  /** 占位宽（mm），仅用于分行 */
  wMm: number
  /** 含文件名行高在内的总高（mm） */
  hMm: number
  html: string
}

const NAME_LINE_PT = 7
const NAME_LINE_FACTOR = 1.5

function nameLineHeightMm(): number {
  return ptToMm(NAME_LINE_PT * NAME_LINE_FACTOR)
}

/**
 * 把一组附件排成 HTML。
 *
 * 硬约束（F4-14）：**等比缩放，绝不拉伸**。所有尺寸都从原图宽高比推出，
 * 任何模式下都只允许"整体缩小"这一个操作，从代码结构上杜绝变形。
 */
export function layoutAttachmentGroup(
  items: AttachmentItem[],
  config: AttachmentPrintConfig,
  containerWidthMm: number,
  scope: RenderScope,
): AttachmentLayoutResult {
  const warnings: RenderWarning[] = []
  const W = Math.max(0, finite(containerWidthMm))
  if (config.mode === 'none' || W <= 0 || items.length === 0) {
    return { html: '', heightMm: 0, warnings }
  }

  /**
   * **仅打印附件名称**（2026-09-18 用户要求新增的档位）。
   *
   * 用户原话："对于附件字段，打印策略有点模糊，应该优化下当前的设置，
   * 增加仅打印附件名称的功能。"
   *
   * 实现上**一行一个文件名**（不挤成一行用「、」连起来）：
   * 这样高度就是 `行数 × 行高`，**可预测**；挤一行的话换行位置取决于字体与容器宽度，
   * 高度估不准就会把下面的元素压住（这正是本项目最反复踩的那类坑）。
   *
   * 不下载图片 —— 调用方那边也有一条对应的短路（见 `lib/attachment.ts` 与
   * `useWizardState` 的 allSkip），两处必须同时认这个档位，否则会白下载一堆图。
   */
  if (config.mode === 'nameOnly') {
    const names = items.map((it) => (config.fileNameWithExt === false ? stripExt(it.name) : it.name))
    const lineH = nameLineHeightMm()
    const body = names
      .map(
        (nm) =>
          `<div style="width:100%;font-family:${attr(FONT_STACK)};font-size:${pxPt(NAME_LINE_PT)};line-height:${NAME_LINE_FACTOR};color:${MUTED_COLOR};${TEXT_FLOW}">${escapeHtml(
            nm,
          )}</div>`,
      )
      .join('')
    return { html: body, heightMm: Math.max(lineH, names.length * lineH), warnings }
  }

  const gapX = Math.max(0, finite(config.gapXMm, 2))
  const gapY = Math.max(0, finite(config.gapYMm, 2))
  const showName = !!config.showFileName
  const nameH = showName ? nameLineHeightMm() : 0
  const align = config.align ?? 'left'

  const flow: FlowItem[] = []
  const fileLines: string[] = []

  for (const it of items) {
    const image = isImageAttachment(it.name, it.mime)
    if (!image) {
      // F4-03 / F4-10：非图片附件按文件名文本处理；"仅打印图片"时静默跳过
      if (config.mode === 'all') {
        const nm = config.fileNameWithExt === false ? stripExt(it.name) : it.name
        fileLines.push(nm)
      }
      continue
    }
    // F4-27：不嵌图、只导出文件名的逃生舱
    if (config.textOnlyFallback || !it.url) {
      if (config.textOnlyFallback) {
        const nm = config.fileNameWithExt === false ? stripExt(it.name) : it.name
        fileLines.push(nm)
        continue
      }
      // F4-24：加载失败 → 占位框 + 文件名
      const pw = Math.min(W, 40)
      const ph = pw * 0.72 + nameH
      const box = `<div style="position:absolute;left:0;top:0;width:${px(pw)};height:${px(pw * 0.72)};border:${px(0.3)} dashed #d0d3d9;background:#fafbfc;box-sizing:border-box;color:${MUTED_COLOR};font-family:${attr(
        FONT_STACK,
      )};font-size:${pxPt(7)};display:flex;align-items:center;justify-content:center;padding:${px(1)};">图片加载失败</div>`
      const nmLine = showName
        ? `<div style="position:absolute;left:0;top:${px(pw * 0.72)};width:${px(pw)};font-family:${attr(
            FONT_STACK,
          )};font-size:${pxPt(NAME_LINE_PT)};line-height:${NAME_LINE_FACTOR};color:${MUTED_COLOR};text-align:center;${TEXT_FLOW}">${escapeHtml(
            it.name,
          )}</div>`
        : ''
      flow.push({ wMm: pw, hMm: ph, html: box + nmLine })
      warnings.push({
        kind: 'image-failed',
        message: `图片「${it.name}」加载失败，已渲染占位框`,
        elementId: scope.elementId,
        recordId: scope.record?.recordId,
      })
      continue
    }

    // ---- 尺寸计算：全部由原图比例推导 ----
    const wPx = finite(it.widthPx, 0)
    const hPx = finite(it.heightPx, 0)
    const ratio = wPx > 0 && hPx > 0 ? hPx / wPx : 0.75
    let wMm: number
    let hMm: number
    switch (config.sizeMode) {
      case 'fixedBox': {
        /**
         * **固定宽高**（2026-09-20 用户新增）：框由元素自己的 w×h 决定，图片按 `fit` 放进去。
         * 与 `fixedHeight`（只定高、宽按比例）的区别就在这里：**宽也由框说了算**。
         * 尺寸直接取容器（= 元素框宽）与 `scope.heightMm`（= 元素框高）。
         */
        wMm = W
        hMm = Math.max(1, finite(scope.heightMm, finite(config.fixedHeightMm, 40)))
        break
      }
      case 'fixedHeight': {
        hMm = Math.max(1, finite(config.fixedHeightMm, 40))
        wMm = ratio > 0 ? hMm / ratio : hMm
        break
      }
      case 'fitCell':
      case 'original':
      default: {
        // 原图尺寸 = 按 CSS 像素 → mm 的等比尺寸（与浏览器直接渲染 <img> 一致）
        wMm = wPx > 0 ? pxToMm(wPx) : Math.min(W, 40)
        hMm = wMm * ratio
        break
      }
    }
    // 约束一：绝不能超过容器宽度（F4-14：超出容器时按较小比例缩放）
    let scale = 1
    if (wMm > W) scale = Math.min(scale, W / wMm)
    // 约束二：适配单元格时同时受容器高度约束（F4-20 双向约束，取较小比例）
    const cellH = scope.heightMm
    const wantFitCell = config.fitCell || config.sizeMode === 'fitCell'
    /**
     * 真的被容器压小了没有 —— 压小了要**说出来**（2026-09-18 用户要求）：
     * "自动把尺寸压缩到和单元格一致就行，**同时提醒已经被压缩**。"
     *
     * 为什么要提醒而不是默默压：用户拿到的图上尺寸与他选的原图尺寸对不上，
     * 不吭声就是"两件不一样的事长成一个样子"（判据 30）。提醒里带上压缩后的实际高度，
     * 他就能立刻判断"这个大小我能不能接受"。
     */
    let shrunkToCell = false
    if (wantFitCell && typeof cellH === 'number' && cellH > 0 && hMm * scale > cellH + 0.05) {
      scale = Math.min(scale, cellH / hMm)
      shrunkToCell = true
    }
    wMm = Math.max(1, wMm * scale)
    hMm = Math.max(1, hMm * scale)
    if (shrunkToCell) {
      warnings.push({
        kind: 'element-overflow',
        message: `「${it.name}」原尺寸放不进容器，已自动压缩到 ${Math.round(hMm * 10) / 10}mm 高（等比缩放，不变形）。想要原尺寸请在属性面板关掉「适配单元格」`,
      })
    }

    // F4-21：有效 DPI 校验（矢量图不参与）
    if (!isVectorImage(it.name, it.mime) && wPx > 0) {
      const dpi = wPx / (wMm / 25.4)
      if (dpi < finite(config.minDpi, 150)) {
        warnings.push({
          kind: 'image-low-dpi',
          message: `图片「${it.name}」清晰度可能不足（有效 DPI ≈ ${Math.round(dpi)}），建议减小尺寸或减少每行张数`,
          elementId: scope.elementId,
          recordId: scope.record?.recordId,
        })
      }
    }

    const nmLine = showName
      ? `<div style="position:absolute;left:0;top:${px(hMm)};width:${px(wMm)};font-family:${attr(
          FONT_STACK,
        )};font-size:${pxPt(NAME_LINE_PT)};line-height:${NAME_LINE_FACTOR};color:${MUTED_COLOR};text-align:center;${TEXT_FLOW}">${escapeHtml(
          config.fileNameWithExt === false ? stripExt(it.name) : it.name,
        )}</div>`
      : ''
    const img = `<img src="${attr(it.url)}" style="position:absolute;left:0;top:0;width:${px(
      wMm,
    )};height:${px(hMm)};object-fit:${config.sizeMode === 'fixedBox' && (config.fit === 'cover' || config.fit === 'fill') ? config.fit : 'contain'};">`
    flow.push({ wMm, hMm: hMm + nameH, html: img + nmLine })
  }

  // ---- 非图片附件：逐个换行的文件名文本（F4-10） ----
  for (const nm of fileLines) {
    flow.push({
      wMm: W,
      hMm: nameLineHeightMm(),
      html: `<div style="position:absolute;left:0;top:0;width:${px(W)};font-family:${attr(
        FONT_STACK,
      )};font-size:${pxPt(NAME_LINE_PT + 2)};line-height:${NAME_LINE_FACTOR};color:${MUTED_COLOR};text-align:${align};${TEXT_FLOW}">${escapeHtml(
        nm,
      )}</div>`,
    })
  }

  if (flow.length === 0) return { html: '', heightMm: 0, warnings }

  // ---- 分行：wrap = 每张独占一行；inline = 容器宽度内依次排列，放不下换行 ----
  const maxPerRow = config.flow === 'wrap' ? 1 : config.maxPerRow && config.maxPerRow > 0 ? Math.min(8, Math.floor(config.maxPerRow)) : null
  const rows: FlowItem[][] = []
  let cur: FlowItem[] = []
  let curW = 0
  for (const it of flow) {
    const limit = maxPerRow ?? Number.POSITIVE_INFINITY
    const nextW = cur.length === 0 ? it.wMm : curW + gapX + it.wMm
    if (cur.length > 0 && (cur.length >= limit || nextW > W + 1e-6)) {
      rows.push(cur)
      cur = []
      curW = 0
    }
    const w = cur.length === 0 ? it.wMm : curW + gapX + it.wMm
    cur.push(it)
    curW = w
  }
  if (cur.length > 0) rows.push(cur)

  let y = 0
  let html = ''
  for (const r of rows) {
    const rowH = Math.max(...r.map((i) => i.hMm))
    const usedW = r.reduce((s, i) => s + i.wMm, 0) + gapX * (r.length - 1)
    const x0 = align === 'center' ? Math.max(0, (W - usedW) / 2) : align === 'right' ? Math.max(0, W - usedW) : 0
    let x = x0
    for (const it of r) {
      html += `<div style="position:absolute;left:${px(x)};top:${px(y)};width:${px(it.wMm)};height:${px(
        it.hMm,
      )};">${it.html}</div>`
      x += it.wMm + gapX
    }
    y += rowH + gapY
  }
  const heightMm = Math.max(0, y - gapY)

  const container = `<div style="position:relative;width:${px(W)};height:${px(heightMm)};">${html}</div>`
  return { html: container, heightMm, warnings }
}

function stripExt(name: string): string {
  const i = name.lastIndexOf('.')
  return i > 0 ? name.slice(0, i) : name
}

// ============================================================
// 固定图片（ImageElement）
// ============================================================

/**
 * 固定图片 → `<img>`。
 *
 * `fit` 有**三种状态**，必须分开处理，因为它们对老模板的产物影响完全不同：
 *
 * 1) **缺省**（老模板 / `h:'auto'`）：`width:100%;height:auto` —— 按元素宽度等比铺满，
 *    高度由图片自身的宽高比决定。这是历史行为，**一个字节都不能变**：
 *    元素框高在这条路径上不参与约束，否则所有老模板里的图片都会突然缩水。
 * 2) **`contain`**：完整显示。图片盒子 = 元素框（w × h），图片在框**内**等比缩放，
 *    不够的地方留白边，永远不溢出、也永远不把框撑大。
 * 3) **`cover`**：裁剪填满。同一套盒子，超出框的部分裁掉。
 *
 * 两条实现约束（都是这里最容易做错的地方）：
 *
 * · **盒高必须写成显式 px，不能写 `height:100%`。**
 *   外层 `.bp-el` 用的是 `min-height`（见 buildDocumentHtml 的注释：内容比盒子高时
 *   要让它撑开而不是溢出去压住下一个元素）。百分比高度在一个 `height:auto` 的父元素上
 *   会解析成 `auto`，框就约束不住 —— 那正是"图片糊出框外"的成因。
 *   写成 `px(框高)` 之后，约束是**布局期就确定**的，与父元素怎么定高无关。
 *
 * · **宽度始终 100%**：框宽就是元素宽（`.bp-el` 的 width），所以图片盒子与元素框逐边相等，
 *   这与编辑器画布 1:1（画布是 `.bp-el-image{width:100%;height:100%}` + `object-fit`），
 *   保住了 PRD F5-01「预览所见即打印所得」。
 *
 * `contain` 会把小于框的图**放大**到贴近框（object-fit 的固有语义，画布同理），
 * 这是"框内等比缩放"的自然读法：框是权威，图去适配框。
 */
function renderImage(el: Extract<AnyElement, { kind: 'image' }>, scope: RenderScope): string {
  const src = attr(el.dataUrl)
  const boxH = explicitHeightMm(scope)
  // 没有确定的框高（h:'auto'）时"框内"无从谈起 —— 退回缺省形态，不猜一个高度。
  // 非 contain/cover 的取值（含老模板的 undefined）同样走这条路径，保证产物不变。
  /*
   * `natural`（原尺寸）在元素这条路上就是 **`h: 'auto'`** ⇒ `height:auto`（下面第一个分支）。
   * 其余三种（fill/contain/cover）直接进 `object-fit`。
   * ⚠️ 不认识的取值一律退回 `contain`（老模板没有这个字段时的默认行为，不能改）。
   */
  if (boxH === null || (el.fit !== 'contain' && el.fit !== 'cover' && el.fit !== 'fill')) {
    const fit = el.fit === 'cover' || el.fit === 'fill' ? el.fit : 'contain'
    return `<img src="${src}" style="width:100%;height:auto;display:block;object-fit:${fit};">`
  }
  return `<img src="${src}" style="width:100%;height:${px(boxH)};display:block;object-fit:${el.fit};">`
}

// ============================================================
// 元素渲染
// ============================================================

export interface RenderElementResult {
  html: string
  warnings: RenderWarning[]
}

/** 表格表头是否每页重复。undefined 视为 true（有表头行就该重复，这是用户默认预期） */
export function tableRepeatHeader(el: TableElement): boolean {
  const hasHeader = el.rows.some((r) => r.isHeader)
  return hasHeader && el.repeatHeader !== false
}

/** 前部连续的表头行数量（表头行必须连续出现在数组开头） */
export function tableHeaderRowCount(el: TableElement): number {
  let n = 0
  while (n < el.rows.length && el.rows[n].isHeader) n++
  return n
}

// ============================================================
// 二维码 / 条形码
// 编码与 SVG 生成都在 code-elements.ts（纯函数，Node 可单测）；
// 这里只负责"取值 → 尺寸 → 告警"，并且**绝不允许静默留白**。
// ============================================================

/** 原文行占用的高度（mm），与码元素留位联动，避免原文压到下一个元素上 */
const CODE_CAPTION_MM = 3
/** 条形码未显式给高度时的默认高（mm） */
const BARCODE_FALLBACK_H_MM = 15
/** 超过这个字符数的条码会密到扫不出来（提示级，仍然渲染） */
const BARCODE_MAX_CHARS = 30

interface CodeValueResult {
  value: string
  /** 取不到值时的原因，写进占位框那句人话里 */
  reason: string
}

/**
 * 解析码的内容来源（字段动态取值 / 用户固定内容）。
 *
 * 与 resolveField 的区别在于**空值必须给说法**：码元素整块就是个图形，
 * 渲染成空白时用户只看到"这里啥都没有"，而真实原因可能是没绑字段、字段被删，
 * 或者只是这一行的字段是空的 —— 三者处理方式完全不同。
 */
function resolveCodeValue(
  source: CodeSource | undefined,
  label: string,
  scope: RenderScope,
  ctx: RenderContext,
  warnings: RenderWarning[],
): CodeValueResult {
  if (!source) return { value: '', reason: '未设置内容来源' }

  if (source.kind === 'static') {
    const v = typeof source.value === 'string' ? source.value : ''
    if (v.trim() === '') {
      warnings.push({
        kind: 'field-unbound',
        message: `${label}没有填写内容，将渲染为占位框`,
        elementId: scope.elementId,
      })
      return { value: '', reason: '未填写内容' }
    }
    return { value: v, reason: '' }
  }

  const name = source.fieldName || source.fieldId || '未命名'
  if (!source.fieldId) {
    warnings.push({
      kind: 'field-unbound',
      message: `${label}未绑定字段，将渲染为占位框`,
      elementId: scope.elementId,
      recordId: scope.record?.recordId,
    })
    return { value: '', reason: '未绑定字段' }
  }
  const meta = ctx.fieldMap.get(source.fieldId)
  if (!meta) {
    warnings.push({
      kind: 'field-missing',
      message: `字段「${name}」不存在（可能已被删除），${label}将渲染为占位框`,
      elementId: scope.elementId,
      recordId: scope.record?.recordId,
    })
    return { value: '', reason: '字段已失效' }
  }
  // 循环区外的码取首行值；一条记录都没有属于正常状态（不是模板毛病），不刷警告
  if (!scope.record) return { value: '', reason: '暂无数据' }
  const v = renderCellValue(scope.record.fields[source.fieldId], meta.type)
  if (v.trim() === '') {
    // 字段绑定没问题、模板也没毛病，只是**这一条记录恰好没填** —— 属于数据级问题，
    // 因此用记录级的 code-invalid 而不是模板级的 field-missing：
    // field-missing 会进向导的阻断红条（"字段不存在（可能已被删除）"），
    // 文案与事实不符，用户会去查字段是不是被删了；而且模板级去重会把它压成一条，
    // 多行空值根本定位不到是哪一行。
    warnings.push({
      kind: 'code-invalid',
      message: `字段「${name}」在本条记录中为空，${label}将渲染为占位框`,
      elementId: scope.elementId,
      recordId: scope.record.recordId,
    })
    return { value: '', reason: '字段值为空' }
  }
  return { value: v, reason: '' }
}

/** 空内容 / 编码失败时的占位框：浅灰虚线 + 一句原因 */
function codePlaceholderHtml(label: string, reason: string): string {
  const caption = reason ? `${label}：${reason}` : label
  return (
    `<div data-code-ph="1" style="width:100%;height:100%;min-height:${px(10)};box-sizing:border-box;` +
    `border:${px(0.3)} dashed #d0d3d9;background:#fafbfc;display:flex;align-items:center;justify-content:center;` +
    `padding:${px(1)};text-align:center;font-family:${attr(FONT_STACK)};font-size:${pxPt(7)};color:${MUTED_COLOR};` +
    `${TEXT_FLOW}">${escapeHtml(caption)}</div>`
  )
}

/** 元素高度（mm）：'auto' 时返回 null，由调用方决定兜底值 */
function explicitHeightMm(scope: RenderScope): number | null {
  return typeof scope.heightMm === 'number' && scope.heightMm > 0 ? scope.heightMm : null
}

function renderQrCode(el: QrCodeElement, scope: RenderScope, ctx: RenderContext, warnings: RenderWarning[]): RenderElementResult {
  const { value, reason } = resolveCodeValue(el.source, '二维码', scope, ctx, warnings)
  if (value === '') return { html: codePlaceholderHtml('二维码', reason), warnings }

  const bytes = utf8ByteLength(value)
  if (bytes > QR_MAX_BYTES) {
    warnings.push({
      kind: 'code-invalid',
      message: `二维码内容 ${bytes} 字节，超出容量上限（${QR_MAX_BYTES} 字节），已改为占位框`,
      elementId: scope.elementId,
      recordId: scope.record?.recordId,
    })
    return { html: codePlaceholderHtml('二维码', '内容过长'), warnings }
  }

  const w = Math.max(0, finite(scope.widthMm))
  const h = explicitHeightMm(scope) ?? w
  // 二维码必须是正方形，且要给原文行留出位置，否则原文会溢出元素盒子压到下方元素
  const sizeMm = Math.max(4, Math.min(w, h) - (el.showText ? CODE_CAPTION_MM : 0))
  const svg = qrCodeSvg(value, {
    sizeMm,
    ecLevel: el.ecLevel,
    foreground: el.foreground,
    background: el.background,
  })
  if (svg === '') {
    warnings.push({
      kind: 'code-invalid',
      message: '二维码内容无法编码（可能超出容量上限），已改为占位框',
      elementId: scope.elementId,
      recordId: scope.record?.recordId,
    })
    return { html: codePlaceholderHtml('二维码', '编码失败'), warnings }
  }

  const caption = el.showText
    ? `<div style="font-family:${attr(FONT_STACK)};font-size:${pxPt(6)};line-height:1.2;color:${attr(
        el.foreground ?? DEFAULT_COLOR,
      )};${TEXT_FLOW}">${escapeHtml(value)}</div>`
    : ''
  // line-height:0 消掉行内元素自带的基线空隙（否则码下方会莫名多出 3~4px，影响测量）
  return { html: `<div style="width:100%;text-align:center;line-height:0;">${svg}${caption}</div>`, warnings }
}

function renderBarcode(el: BarcodeElement, scope: RenderScope, ctx: RenderContext, warnings: RenderWarning[]): RenderElementResult {
  const { value, reason } = resolveCodeValue(el.source, '条形码', scope, ctx, warnings)
  if (value === '') return { html: codePlaceholderHtml('条形码', reason), warnings }

  // Code 128 编不了非 ASCII。这里必须拦住并告警：出一个扫不出东西的空码，
  // 用户要拿到打印现场才会发现，代价比多一条警告大得多。
  if (!isCode128Encodable(value)) {
    warnings.push({
      kind: 'code-invalid',
      message: '条形码只支持 ASCII 可见字符，当前内容含中文等非 ASCII 字符无法编码（建议改用二维码）',
      elementId: scope.elementId,
      recordId: scope.record?.recordId,
    })
    return { html: codePlaceholderHtml('条形码', '内容含非 ASCII 字符'), warnings }
  }
  if (value.length > BARCODE_MAX_CHARS) {
    warnings.push({
      kind: 'code-invalid',
      message: `条形码内容有 ${value.length} 个字符，条宽会密到难以扫描，建议精简内容或改用二维码`,
      elementId: scope.elementId,
      recordId: scope.record?.recordId,
    })
    // 仍然渲染：长编号确实有真实场景，只要用户接受可读性下降
  }

  const w = Math.max(0, finite(scope.widthMm))
  const h = explicitHeightMm(scope) ?? BARCODE_FALLBACK_H_MM
  const svg = barcodeSvg(value, {
    widthMm: w,
    heightMm: h,
    // 与二维码一致：必须显式开才显示原文，避免不同来源的元素默认值打架
    showText: el.showText === true,
    foreground: el.foreground,
    background: el.background,
  })
  if (svg === '') return { html: codePlaceholderHtml('条形码', '编码失败'), warnings }
  return { html: `<div style="width:100%;line-height:0;">${svg}</div>`, warnings }
}

/** 单元格里的附件配置要挂在哪个字段上：优先附件类型字段，其次第一个已绑定字段 */
function resolveCellAttachmentFieldId(cell: TableCell, ctx: RenderContext): string | null {
  let fallback: string | null = null
  for (const n of cell.nodes ?? []) {
    if (n.type !== 'field' || !n.fieldId) continue
    const meta = ctx.fieldMap.get(n.fieldId)
    if (meta && meta.type === 17) return n.fieldId
    if (!fallback) fallback = n.fieldId
  }
  return fallback
}

function attachmentItemsFor(fieldId: string | null, scope: RenderScope, ctx: RenderContext): AttachmentItem[] {
  if (!fieldId || !scope.record) return []
  const resolved = ctx.images.get(imageKey(scope.record.recordId, fieldId))
  if (resolved && resolved.length > 0) {
    return resolved.map((r: ResolvedImage) => ({
      token: r.token,
      name: r.name,
      url: r.url,
      mime: r.mime,
      widthPx: r.widthPx,
      heightPx: r.heightPx,
    }))
  }
  // 没解析到 URL：仍然把附件名列出来，走"加载失败占位框"分支，避免整块消失得莫名其妙
  const raw = scope.record.fields[fieldId]
  if (!Array.isArray(raw)) return []
  return raw.map((v) => {
    const o = (v ?? {}) as { name?: unknown; type?: unknown; token?: unknown }
    return {
      token: typeof o.token === 'string' ? o.token : '',
      name: typeof o.name === 'string' ? o.name : '附件',
      mime: typeof o.type === 'string' ? o.type : undefined,
    }
  })
}

function renderCellContent(
  cell: TableCell,
  scope: RenderScope,
  ctx: RenderContext,
  warnings: RenderWarning[],
  /**
   * 这一格**内容区**的宽度（mm）= 列宽（含 colspan）− 左右内边距。
   *
   * ⚠️ 必须由调用方传进来，**不能**从 `scope.widthMm` 推 —— 那是**表格**的宽度
   * （`pipeline.ts` 的 `scopeOfRecord` 给的就是表宽）。而格内子元素的宽度百分比、
   * 附件/图片的"适配容器"、二维码的边长，全都以**格子**为容器算。
   * 拿表宽当容器就会出现（2026-09-23 真机反馈第 1 / 2 条）：
   *   · 一张附件图横向撑满整张表、竖向按比例长到覆盖整个页面；
   *   · 二维码被画成表宽那么大，溢出格子后被裁掉 ⇒ 用户看到的是"完全不显示"。
   */
  cellWidthMm: number,
): string {
  /*
   * ⚠️ 单元格里的**块级子元素**（`TableCell.children`，规格 六）必须在这里渲染 ——
   *    2026-09-22 真机反馈时才发现：`children` 只在画布上画了，**打印端整块被忽略**
   *    ⇒ 画布上看得见的图片/二维码，打印/预览里什么都没有。
   *    直接复用 `renderElement`（元素级渲染器），各 kind 的分支只有一份实现。
   *    顺序与画布一致：**先子元素、后 nodes**（图片在上、说明文字在下）。
   */
  const childHtml = (cell.children ?? [])
    .map((child) => {
      /*
       * ⚠️ 每个子元素单独造一个 scope：把 `widthMm` / `heightMm` 换成**它在格子里的实际尺寸**。
       *
       * `renderElement` 的每个分支都是从 scope 推导尺寸的：`renderImage` 取 `widthMm`、
       * `layoutAttachmentGroup` 拿 `widthMm` 当容器宽、`renderQrCode` / `renderBarcode`
       * 用 `widthMm` / `heightMm` 定码的大小。自由层那边由 `pipeline.buildBlocks` 填
       * "元素自己的 w×h"；格内就得填"格内口径的 w×h"—— 两边**语义相同、来源不同**。
       * 少了这一步，格内的东西就会按表的尺寸渲染（就是上面签名注释里那两个症状）。
       */
      const childScope: RenderScope = {
        ...scope,
        widthMm: childBoxWidthMm(child, cellWidthMm),
        // 格内没有"固定行高"这回事（行高由内容撑），所以不给高度 —— 高度约束在格内不适用
        heightMm: childHeightMm(child) ?? undefined,
      }
      const r = renderElement(child, childScope, ctx)
      warnings.push(...r.warnings)
      /*
       * 外层盒子承载 `w`（占格宽百分比）与 `h`（固定盒高）—— 与画布**同一套口径**
       * （types.ts 的 TableCell.children 第 ④ 条）。
       *
       * 为什么宽度得由这一层定：`renderElement` 产出的内容一律是 `width:100%`
       * （见 `renderImage`），它撑满的是**这个盒子**，不是单元格 —— 少一层盒子，
       * 用户在面板里把"占格宽"调成 50% 时，打印出来还是 100%。
       */
      /*
       * ⚠️ 这里**直接拼样式串**，不要过 `attr()` —— 它是**转义器**（内部就是 `escapeHtml`），
       *    不是"样式对象序列化器"。传对象进去会得到 `style="[object Object]"`
       *    ⇒ 浏览器整条丢弃 ⇒ 产物里**不报错**，只是"改动看起来没生效"。
       *    （第一版就是这么写的：`w=50` 在画布上生效、打印出来还是 100%，差一点就漏出去。）
       *    数值都来自 `childWidthPct` / `childHeightMm`：它们已经把 NaN / 越界夹掉了。
       */
      const boxH = childHeightMm(child)
      const boxStyle =
        `width:${round3(childWidthPct(child))}%;` + (boxH != null ? `height:${px(boxH)};overflow:hidden;` : '')
      return `<div style="${boxStyle}">${r.html}</div>`
    })
    .join('')
  if (cell.attachment) {
    if (cell.attachment.mode === 'none') {
      // F4-08：选择"不打印附件"时该字段输出空。
      // 但单元格里可能有其它内容（如"照片："这种前缀文字），只摘掉附件字段本身，不动其余节点。
      const fid = resolveCellAttachmentFieldId(cell, ctx)
      const kept = (cell.nodes ?? []).filter((n) => !(n.type === 'field' && n.fieldId === fid))
      return childHtml + renderInline(kept, scope, ctx, warnings)
    }
    const fieldId = resolveCellAttachmentFieldId(cell, ctx)
    const items = attachmentItemsFor(fieldId, scope, ctx)
    /*
     * 附件容器 = **这一格**的宽度（不是表宽）。同时把 `heightMm` 清掉：
     * 格内行高由内容撑，拿"表高"去约束高度会把整格的图压成一条缝。
     * 于是格内附件的口径是"**宽度适配格子、高度等比**" —— 正是用户对
     * 「自适应单元格」的预期（2026-09-23 真机反馈第 1 条）。
     */
    const res = layoutAttachmentGroup(items, cell.attachment, cellWidthMm, {
      ...scope,
      widthMm: cellWidthMm,
      heightMm: undefined,
    })
    warnings.push(...res.warnings)
    return childHtml + res.html
  }
  return childHtml + renderInline(cell.nodes, scope, ctx, warnings)
}

/**
 * 「第 i 行渲染什么」——把**行序**与**行的来源**解耦。
 *
 * 存在两种行序：
 * - 逐记录重复（默认）：行序 = 模板 `rows` 的下标，所有行共用同一个 scope；
 * - 多记录并成一张大表（`rowsFromRecords`）：行序是"虚拟行序"，
 *   同一行可能来自模板的不同行、不同记录（见 `renderLoopTableRows`）。
 *
 * 两种行序必须共用**同一套**列宽压缩 / 边框 / 表头重复逻辑，
 * 否则"第二页没表头"这类问题会在新增的行序里悄悄复活。
 */
interface TableRowRef {
  /** 模板 `el.rows` 里的下标 */
  rowIndex: number
  /** 渲染该行（含单元格内容）时使用的 scope */
  scope: RenderScope
}

/**
 * 列宽和超出元素宽度多少，才算"真的超宽"（mm）。
 *
 * 取值理由（不是拍脑袋定的 0.5）：
 * · **噪声上限**：`colWidthsMm` 由编辑器按 0.01mm / 由 `setColWidthPatch` 按 0.1mm 取整，
 *   `w` 又等于"取整后的和再取整"，所以每一列最多带 0.005mm 误差、`w` 再带 0.05mm。
 *   按列数 C 累计，最坏 ≈ C×0.005 + 0.05：3 列 0.065mm、30 列 0.2mm。
 *   0.5mm 是 30 列最坏噪声的 **2.5 倍**，留足余量。
 * · **可见上限**：0.5mm 在 96dpi 下约 1.9px，肉眼不可见；压缩后每列只窄 0.33%，
 *   排版上等同于没变。也就是说**低于这个阈值的压缩，用户本来就看不出差别**，
 *   却要为此弹一条"超出版心宽度"（带指责意味）的提示 —— 一份正常的模板一打开就自带噪音。
 * · 与同文件的 `BOX_OVERFLOW_WARN_MM` 同量级、同理由（都是"这个尺度以下算取整噪声"）。
 *   刻意不复用那个常量：两者的语义不同，共用一个名字会让以后调其中一个的人误伤另一个。
 *
 * 注意：**压缩本身不受这个阈值影响** —— 只要 `sum > w` 就照旧按比例压缩（那是对的做法，
 * 不压缩就会真的溢出元素框）。这里只决定"要不要打扰用户"。
 */
const TABLE_COMPRESS_WARN_MM = 0.5

/**
 * 表格 HTML 的公共骨架。
 *
 * `startRow/endRow` 用于**按行拆分后的片段**：
 * - startRow === 0 时，片段自带原始表头行；
 * - startRow > 0 且 repeatHeader 时，片段会**克隆一份表头行**（F2-29 硬要求）。
 */
function buildTableHtml(
  el: TableElement,
  /** 列宽 / 边框 / 告警定位用的 scope（行内单元格用各自的行 scope，见 refAt） */
  scope: RenderScope,
  /** 本次行序的总行数（默认 = 模板行数；合并大表 = 表头 + 数据行 × 记录数） */
  total: number,
  headerCount: number,
  repeat: boolean,
  startRow: number,
  endRow: number,
  /** 第 i 行（0 基，虚拟行序）→ 模板行 + scope；返回 null 表示该行不存在 */
  refAt: (i: number) => TableRowRef | null,
  ctx: RenderContext,
): RenderElementResult {
  const warnings: RenderWarning[] = []
  const from = Math.max(0, Math.min(startRow, total))
  const to = Math.max(from, Math.min(endRow, total))

  // ---- 列宽：总和超出元素宽度时按比例压缩（E-45） ----
  const targetW = Math.max(0, finite(scope.widthMm))
  const src = el.colWidthsMm && el.colWidthsMm.length > 0 ? el.colWidthsMm.map((v) => finite(v, 0)) : null
  const colCount = src ? src.length : Math.max(1, ...el.rows.map((r) => r.cells.length), 1)
  const sum = src ? src.reduce((s, v) => s + v, 0) : 0
  let widths: number[]
  if (src && sum > 0) {
    if (sum > targetW + 1e-6) {
      // 压缩：与告警分开判 —— 差 0.04mm 也要压（否则真的溢出元素框），但不值得打扰用户
      const k = targetW / sum
      widths = src.map((v) => v * k)
      if (sum - targetW > TABLE_COMPRESS_WARN_MM) {
        warnings.push({
          kind: 'table-compressed',
          message: `表格列宽总和（${round3(sum)}mm）超出版心宽度，已按比例压缩到 ${round3(targetW)}mm`,
          elementId: el.id,
        })
      }
    } else {
      widths = src
    }
  } else {
    widths = new Array(colCount).fill(colCount > 0 ? targetW / colCount : 0)
  }

  const paddingMm = Math.max(0, finite(el.cellPaddingMm, 1))
  const borderW = Math.max(0.05, finite(el.border?.widthPt, 0.5))
  const borderColor = el.border?.color ?? '#d0d3d9'
  const borderPx = `${round3((borderW * 96) / 72)}px`
  const mode = el.border?.mode ?? 'all'

  const tableBorder =
    mode === 'outer'
      ? `border:${borderPx} solid ${borderColor};`
      : mode === 'none'
        ? 'border:none;'
        : 'border:none;'
  const cellBorder =
    mode === 'all'
      ? `border:${borderPx} solid ${borderColor};`
      : mode === 'horizontal'
        ? `border:none;border-bottom:${borderPx} solid ${borderColor};`
        : 'border:none;'

  const colgroup = `<colgroup>${widths.map((w) => `<col style="width:${px(w)};">`).join('')}</colgroup>`

  const renderRow = (ri: number): string => {
    const ref = refAt(ri)
    if (!ref) return ''
    const row = el.rows[ref.rowIndex]
    if (!row) return ''
    // ---- F2-35：行内单元格数 ≠ 列数必须显性化，不许静默产出坏表 ----
    //
    // 多出的单元格在 `table-layout:fixed` + 只有 N 个 <col> 的表格里**分不到宽度**，
    // 浏览器会把它们压成 0 宽：空着时肉眼看不出，一旦填了内容就会溢到相邻格上互相压。
    // 这不是能靠渲染层补救的事（"5 格里哪几格该多宽"没有正确答案，替作者补宽等于偷偷改结构），
    // 所以只报出来、并告诉用户去哪儿改。
    //
    // 用 colspan 求和而不是 cells.length：跨列的单元格本身占多列，
    // 3 个 cell（其中一个 colspan=2）实际占 4 列，那才是会溢出的那一种。
    const occupied = row.cells.reduce((s, c) => s + Math.max(1, Math.floor(finite(c.colspan, 1))), 0)
    if (occupied > colCount) {
      warnings.push({
        kind: 'table-column-mismatch',
        message:
          `表格第 ${ref.rowIndex + 1} 行有 ${occupied} 个单元格，但表格只定义了 ${colCount} 列：` +
          `多出的 ${occupied - colCount} 个单元格宽度会被压成 0，填入内容后会与相邻单元格重叠。` +
          `请在编辑器里删掉这一行多余的单元格。`,
        elementId: el.id,
      })
    }
    // 单元格内容用**该行自己的** scope：合并大表里同一张表的每一行可能属于不同记录
    const rowScope = ref.scope
    const rowH = typeof row.heightMm === 'number' && row.heightMm > 0 ? `height:${px(row.heightMm)};` : ''
    /*
     * 单边边框（规格 八）：**只有当这一格自己写过 `borders` 时**才逐边输出 CSS。
     * ⚠️ 老模板（没有 `borders`）继续走 `cellBorder` 这一个字符串 ⇒ **产出的 HTML 逐字不变**，
     *    不会惊动任何现有的渲染断言。
     * ⚠️ `colCursor` 是**按数组顺序累加 colspan** 推出来的列号：跨行合并（rowspan）覆盖的行里，
     *    这一行的第一个格子未必在第 0 列 —— 那种情况下 `outer` 的"是否最左列"判定会偏。
     *    影响面很窄（只有"显式覆盖过 + outer 模式 + 上方有 rowspan"三者同时成立时），
     *    先在这里写明，不假装它能算准。
     */
    let colCursor = 0
    const cells = row.cells
      .map((cell) => {
        const span = cell.colspan > 1 ? ` colspan="${Math.floor(cell.colspan)}"` : ''
        const rspan = cell.rowspan > 1 ? ` rowspan="${Math.floor(cell.rowspan)}"` : ''
        const padMm = Math.max(0, finite(cell.paddingMm, paddingMm))
        /*
         * 该格**内容区**宽度 = 从 `colCursor` 起、跨 `colspan` 列的列宽之和 − 左右内边距。
         *
         * ⚠️ 必须从 `colCursor` 累加，**不要**拿"数组下标"当列号：跨列合并的格子在
         * `row.cells` 里只是一个元素，数组下标 ≠ 网格列号（`table-actions.ts` 的
         * `cellWidthMm` 已经为同一个理由写过一次）。越界时按 0 累加，
         * 退化成"很窄"而不是 NaN —— 那种模板本来就命中 `table-column-mismatch` 告警。
         */
        const cellSpan = Math.max(1, Math.floor(finite(cell.colspan, 1)))
        let cellW = 0
        for (let k = 0; k < cellSpan; k++) cellW += widths[colCursor + k] ?? 0
        const inner = renderCellContent(cell, rowScope, ctx, warnings, Math.max(1, cellW - padMm * 2))
        const bg = cell.style?.background ? `background:${cell.style.background};` : ''
        const cw = (cell.borders?.widthPt ?? borderW)
        const cc = cell.borders?.color ?? borderColor
        const cpx = `${round3((Math.max(0.05, cw) * 96) / 72)}px`
        const edges = resolveCellEdges(mode, cell.borders, {
          row: ref.rowIndex,
          rows: el.rows.length,
          col: colCursor,
          cols: colCount,
        })
        const edgeCss = cell.borders
          ? `border-top:${edges.top ? `${cpx} solid ${cc}` : 'none'};` +
            `border-right:${edges.right ? `${cpx} solid ${cc}` : 'none'};` +
            `border-bottom:${edges.bottom ? `${cpx} solid ${cc}` : 'none'};` +
            `border-left:${edges.left ? `${cpx} solid ${cc}` : 'none'};`
          : cellBorder
        colCursor += Math.max(1, Math.floor(finite(cell.colspan, 1)))
        return `<td${span}${rspan} style="${attr(
          `${edgeCss}${rowH}${bg}padding:${px(padMm)};box-sizing:border-box;${vAlignCss(cell.style?.vAlign)}` +
            `;font-family:${FONT_STACK};font-size:${pxPt(cell.style?.fontSizePt ?? DEFAULT_FONT_PT)}` +
            `;color:${cell.style?.color ?? DEFAULT_COLOR};line-height:${cell.style?.lineHeight ?? DEFAULT_LINE_HEIGHT}` +
            `;text-align:${cell.style?.align ?? 'left'};${TEXT_FLOW}`,
        )}">${inner}</td>`
      })
      .join('')
    const rowStyle = typeof row.heightMm === 'number' && row.heightMm > 0 ? ` style="height:${px(row.heightMm)};"` : ''
    return `<tr${rowStyle}>${cells}</tr>`
  }

  // 表头行的呈现规则：
  //  - 片段从第 0 行开始 → 自带原始表头行（可能只带一部分）；
  //  - 片段从中间开始 → repeatHeader 时克隆一份完整表头行（F2-29）。
  const headCount = from === 0 ? Math.min(to, headerCount) : repeat ? headerCount : 0
  const headHtml =
    headCount > 0
      ? `<thead style="display:table-header-group;">${Array.from({ length: headCount }, (_, i) => renderRow(i)).join('')}</thead>`
      : ''
  const bodyFrom = from === 0 ? Math.max(headerCount, from) : from
  const bodyTo = to
  const bodyHtml =
    bodyTo > bodyFrom
      ? `<tbody>${Array.from({ length: bodyTo - bodyFrom }, (_, i) => renderRow(bodyFrom + i)).join('')}</tbody>`
      : ''

  const html =
    `<table style="border-collapse:collapse;table-layout:fixed;width:${px(targetW)};${tableBorder}">` +
    colgroup +
    headHtml +
    bodyHtml +
    '</table>'
  return { html, warnings }
}

/**
 * 单张表格 → HTML（逐记录重复时用）。
 * 行序 = 模板 `rows` 的下标；`startRow/endRow` 是**按行拆分后的片段**区间。
 */
export function renderTableRows(
  el: TableElement,
  startRow: number,
  endRow: number,
  scope: RenderScope,
  ctx: RenderContext,
): RenderElementResult {
  return buildTableHtml(
    el,
    scope,
    el.rows.length,
    tableHeaderRowCount(el),
    tableRepeatHeader(el),
    startRow,
    endRow,
    // 行序 = 模板行下标；所有行共用同一个 scope（逐记录重复的语义）
    (i) => (el.rows[i] ? { rowIndex: i, scope } : null),
    ctx,
  )
}

// ============================================================
// 多记录并成一张大表（TableElement.rowsFromRecords）
// ============================================================

/**
 * 合并大表的行展开计划：一份表头 + 每条记录各一遍数据行。
 *
 * 为什么要有"计划"这一层：分页（`splitTable`）按**行号区间**切片段，
 * 而测量要按行读高度，两者都必须知道"虚拟第 i 行是哪条记录的第几行"。
 * 把换算集中在这里，分页与测量才不会各算一套。
 */
export interface LoopTablePlan {
  /** 表头行数（模板前部的 isHeader 行，只出现一次） */
  headerCount: number
  /** 模板数据行数（非表头行，每条记录各渲染一遍） */
  bodyCount: number
  /** 记录数 */
  recordCount: number
  /** 虚拟总行数 = 表头行数 + 模板数据行数 × 记录数 */
  totalRows: number
}

export function planLoopTable(el: TableElement, recordCount: number): LoopTablePlan {
  const headerCount = tableHeaderRowCount(el)
  const bodyCount = Math.max(0, el.rows.length - headerCount)
  const n = Math.max(0, Math.floor(recordCount))
  return { headerCount, bodyCount, recordCount: n, totalRows: headerCount + bodyCount * n }
}

/**
 * 多记录合并表 → HTML。
 *
 * 行序（虚拟行序，与测量出的 `rowHeightsMm` 一一对应）：
 *   [0, headerCount)                    → 模板表头行，**只渲染一次**
 *   headerCount + d (d = 0..bodyCount*N) → 模板第 headerCount + d%bodyCount 行，用第 floor(d/bodyCount) 条记录的 scope
 *
 * 表头行用**首条记录**的 scope（与"循环区外的占位符取首行值"同一条约定，F2-16）。
 * 分页复用 `buildTableHtml` 的既有规则：片段从中间开始时按 `repeatHeader` 克隆表头（F2-29）。
 */
export function renderLoopTableRows(
  el: TableElement,
  plan: LoopTablePlan,
  startRow: number,
  endRow: number,
  /** 第 recordIndex 条记录渲染时用的 scope；调用方保证 0 ≤ recordIndex < plan.recordCount */
  scopeOfRecord: (recordIndex: number) => RenderScope,
  ctx: RenderContext,
): RenderElementResult {
  const headerScope = scopeOfRecord(0)
  return buildTableHtml(
    el,
    headerScope,
    plan.totalRows,
    plan.headerCount,
    tableRepeatHeader(el),
    startRow,
    endRow,
    (i) => {
      if (i < plan.headerCount) return { rowIndex: i, scope: headerScope }
      if (plan.bodyCount <= 0) return null
      const d = i - plan.headerCount
      const rec = Math.floor(d / plan.bodyCount)
      if (rec < 0 || rec >= plan.recordCount) return null
      return { rowIndex: plan.headerCount + (d % plan.bodyCount), scope: scopeOfRecord(rec) }
    },
    ctx,
  )
}

/** 单个元素 → HTML（不含定位信息，定位由 buildDocumentHtml 统一包裹） */
export function renderElement(el: AnyElement, scope: RenderScope, ctx: RenderContext): RenderElementResult {
  const warnings: RenderWarning[] = []
  const sc: RenderScope = { ...scope, elementId: el.id }
  switch (el.kind) {
    case 'text': {
      const flow = `<div style="${attr(textCss(el.style, [TEXT_FLOW]))}">${renderInline(el.nodes, sc, ctx, warnings)}</div>`
      return { html: flow, warnings }
    }
    case 'fieldBlock': {
      const val = resolveField(el.fieldId, el.fieldName, sc, ctx, warnings)
      const flow = `<div style="${attr(textCss(el.style, [TEXT_FLOW]))}">${escapeHtml(el.prefix ?? '')}${escapeHtml(
        val,
      )}${escapeHtml(el.suffix ?? '')}</div>`
      return { html: flow, warnings }
    }
    case 'table': {
      const res = renderTableRows(el, 0, el.rows.length, sc, ctx)
      return { html: res.html, warnings: res.warnings }
    }
    case 'image':
      return { html: renderImage(el, sc), warnings }
    case 'hline': {
      const w = Math.max(0.05, finite(el.thicknessPt, 0.75))
      const html = `<div style="height:0;border-top:${round3((w * 96) / 72)}px solid ${el.color ?? '#1f2329'};"></div>`
      return { html, warnings }
    }
    case 'pagebreak':
      // 分页符本身不产出可见内容，只影响分页（由 layout 处理）
      return { html: '', warnings }
    case 'attach': {
      const items = attachmentItemsFor(el.fieldId, sc, ctx)
      const res = layoutAttachmentGroup(items, el.config, sc.widthMm, sc)
      return { html: res.html, warnings: res.warnings }
    }
    case 'qrcode':
      return renderQrCode(el, sc, ctx, warnings)
    case 'barcode':
      return renderBarcode(el, sc, ctx, warnings)
    default:
      return { html: '', warnings }
  }
}

// ============================================================
// 文档拼装
// ============================================================

export interface HtmlOptions {
  title?: string
  /**
   * 预览模式：屏幕上看的时候给每页加纸张阴影与灰底。
   * 打印（@media print）时会自动关掉，因此**预览与打印共用同一份 HTML**。
   */
  forPreview?: boolean
  /** 额外注入的 CSS（预览缩放等），仅用于展示，不影响打印几何 */
  extraCss?: string
}

/**
 * `@page` 规则。
 *
 * ⚠️ **边距必须为 0**（2026-09-18 飞书真机反馈后修正）。
 *
 * 原来的写法把用户的页边距（默认 20mm）也写进了 `@page`。后果不是"更准确"，
 * 而是**给浏览器腾出了画页眉页脚的地方**：浏览器把默认页眉（文档标题 + 日期 + 页码）
 * 与页脚（页面 URL）**画在页边距区里**，于是打印出来凭空多出：
 *   顶部 `2026/9/18 19:44、空白（视图模板）1·打印预览`
 *   底部 `https://xxx.feishu.cn/base/...`
 * 用户原话："我的模板中并没有这些内容，预览界面也没有这些内容，打印的时候凭空多出来了。"
 *
 * 更糟的是它还**双算了边距**：`<section>` 被放进"纸张原点内缩 20mm"的页面区里，
 * 而块坐标里又加了一遍 `m.left / m.top`（见下面 `left/top` 的算法）⇒
 * 打印会比预览整体右下各偏 20mm、右/下页边距被吃掉（预览走屏幕媒体、`@page` 不生效，所以只有打印偏）。
 *
 * ⇒ 归零之后：浏览器没有边距区可画 ⇒ 页眉页脚消失；坐标体系只剩一套（块自己带 `m.left/top`）
 * ⇒ **预览什么样，打印就什么样**。页边距由我们自己在块坐标里补，不再依赖 `@page`。
 * ⇒ 配套：`<section>` 的高度必须改成**整纸高**（`renderH` 那一行），否则页面下部分会被裁掉。
 */
function pageCss(pageSetup: PageSetup): string {
  const size = pageRenderSize(pageSetup)
  return `@page { size: ${round3(size.w)}mm ${round3(size.h)}mm; margin: 0; }`
}

/**
 * PageModel[] + PageSetup + RenderContext → 完整 HTML 文档字符串。
 *
 * 页码在分页完成后才确定，而重复区（表头）的 HTML 是跨页克隆的同一份，
 * 因此页码用私用区令牌写入，最后**逐页替换**（见 TOK_PAGE_NO）。
 */
export function buildDocumentHtml(
  pages: PageModel[],
  pageSetup: PageSetup,
  ctx: RenderContext,
  opts: HtmlOptions = {},
): string {
  const size = pageRenderSize(pageSetup)
  const m = pageSetup.margin
  const contentW = Math.max(0, size.w - finite(m?.left) - finite(m?.right))
  const contentH = Math.max(0, size.h - finite(m?.top) - finite(m?.bottom))
  /**
   * ⚠️ `@page` 边距归零之后，这一页必须撑到**整张纸**（见 pageCss 的注释）。
   *
   * 块坐标是"纸张原点 + 页边距 + 作者 y"（下面 `left/top` 那一行），所以最低的块可以到
   * `m.top + contentH = 纸高 − m.bottom` —— 这个值**大于** `contentH`。
   * 若页面盒仍按 `contentH` 收高，`.`bp-page` 的 `overflow:hidden` 会把底部内容裁掉。
   */
  const renderH = Math.max(0, size.h - PAGE_SAFETY_MM)
  const totalPages = pages.length

  const sections = pages
    .map((pg, i) => {
      const blocks = pg.blocks
        .map((b) => {
          const left = finite(m?.left) + finite(b.xMm)
          const top = finite(m?.top) + finite(b.yMm)
          // 表格片段用 auto 高度：片段高度是按实测量出来的，写死高度反而可能裁掉最后一行
          //
          // 其它元素用 **min-height** 而不是 height：hMm 是"这个块实际占用的高度"
          // （= max(作者设定的盒子高, 实测内容高)，见 pipeline 的 boxHMm）。
          // 写成 min-height，内容万一还是比它高，浏览器会把盒子撑开而不是让文字溢出去压住
          // 下面那个元素 —— 打印时"叠字"正是这么来的。内容装得下时 min-height 与 height 等价，
          // 因此正常模板的产物逐字节不变。
          /**
           * ⚠️ **但"图片类"元素要写死高度**（2026-09-20 用户反馈后改）。
           *
           * 用户原话："附件类字段、二维码元素都无法通过鼠标拖动调整大小，特别是高度…
           * 即使是修改元素的属性高度，高度降低，**但其在画布中的大小还是不变**。"
           *
           * 根因：整个模型里 `h: number` 的语义是**下限**（`pipeline.boxHMm` 的注释写着
           * "盒子高只作下限"，量出来比盒子高就撑大 `hMm`）—— 画布与打印**都**这么干，
           * 所以两边一致地忽略"固定高度"。对**文字块**这是对的（换行撑高，写死会叠字）；
           * 但**有固有尺寸的内容**（图片/附件/二维码/条码）是另一回事：
           * 它们本来就该"缩放到框里"，高度必须由框说了算。
           *
           * ⇒ 只对图片类、且**作者显式设过高度**（`boxHMm > 0`）的块写 `height` + 裁掉溢出。
           *   这样实测高度自然等于盒子高，`pipeline` 的 `max()` 取到同一个数 ⇒
           *   **分页逻辑一行都不用动**（这是本次刻意挑的改法：不动管道就没有分页风险）。
           *   文字块、表格、`h:'auto'` 的元素一律走原路径，产物不变。
           */
          const picLike =
            b.kind === 'attach' || b.kind === 'qrcode' || b.kind === 'barcode' || b.kind === 'image'
          const heightCss =
            b.kind === 'table'
              ? ''
              : picLike && b.boxHMm > 0
                ? `height:${px(b.boxHMm)};overflow:hidden;`
                : b.hMm > 0
                  ? `min-height:${px(b.hMm)};`
                  : ''
          return (
            `<div class="bp-el bp-el-${attr(b.kind)}" data-el="${attr(b.elementId)}" ` +
            `style="position:absolute;left:${px(left)};top:${px(top)};width:${px(b.wMm)};${heightCss}">` +
            `${b.html}</div>`
          )
        })
        .join('')
      const section = `<section class="bp-page" data-page="${i + 1}" style="width:${px(size.w)};height:${px(renderH)};">${blocks}</section>`
      // 逐页替换页码令牌
      return replacePageTokens(section, String(i + 1), String(totalPages))
    })
    .join('')

  const title = escapeHtml(opts.title ?? '打印预览')

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
${pageCss(pageSetup)}
html,body{margin:0;padding:0;background:#fff;}
body{font-family:${FONT_STACK};color:${DEFAULT_COLOR};-webkit-print-color-adjust:exact;print-color-adjust:exact;}
.bp-page{position:relative;overflow:hidden;background:#fff;box-sizing:border-box;}
.bp-page + .bp-page{break-before:page;page-break-before:always;}
.bp-el{box-sizing:border-box;}
.bp-el table{border-collapse:collapse;}
.bp-el img{display:block;}
${opts.forPreview ? `.bp-page{box-shadow:0 2px 10px rgba(31,35,41,.18);margin:0 auto 16px;}` : ''}
${opts.extraCss ?? ''}
@media print{
  html,body{background:#fff;}
  .bp-page{box-shadow:none;margin:0;}
}
</style>
</head>
<body>${sections}</body>
</html>`
}

/** 供需要复用上下文宽度的调用方（pipeline）使用 */
export function contentBoxOf(pageSetup: PageSetup): { w: number; h: number } {
  const size = pageRenderSize(pageSetup)
  return {
    w: Math.max(0, size.w - finite(pageSetup.margin?.left) - finite(pageSetup.margin?.right)),
    h: Math.max(0, size.h - finite(pageSetup.margin?.top) - finite(pageSetup.margin?.bottom)),
  }
}
