/**
 * 渲染上下文与渲染产物的公共类型。
 *
 * 为什么把上下文单独抽出来：
 * 渲染/分页是**纯计算**，它不应该知道飞书 SDK 的存在。附件图片的 URL 10 分钟过期、
 * 下载要控并发（PRD 0.3 / F4-22~F4-26），这些都属于"取数"阶段的责任。
 * 因此渲染器只接受**已经解析好的图片**（ResolvedImage），把网络问题挡在渲染之外。
 * 这样带来两个好处：
 *   1) 渲染层可以在 Node 里单测（`__selftest.mts`），不必起浏览器；
 *   2) "重新取 URL" 的时序（BP-6）只在一个地方实现，不会散落到渲染代码里。
 */

import type { MarginMm } from '../lib/types'
import type { FieldMeta } from '../lib/data-source'
import { formatDateTime } from '../lib/field-types'

// ============================================================
// 图片
// ============================================================

/**
 * 已解析好的附件图片。
 * url 一律是**可直接写进 <img src> 的地址**（blob: / data: / 临时下载链接）。
 */
export interface ResolvedImage {
  token: string
  name: string
  url: string
  /** 原图像素宽，用于等比缩放与"原图尺寸"模式 */
  widthPx: number
  /** 原图像素高 */
  heightPx: number
  mime?: string
}

/** images Map 的键。统一在这里生成，避免各处手拼字符串拼错 */
export function imageKey(recordId: string, fieldId: string): string {
  return `${recordId}::${fieldId}`
}

// ============================================================
// 渲染上下文
// ============================================================

export interface RenderContext {
  /** 字段元信息（与界面列序一致） */
  fields: FieldMeta[]
  /** fieldId -> meta，渲染时 O(1) 取类型 */
  fieldMap: Map<string, FieldMeta>
  /**
   * 附件图片：key = `imageKey(recordId, fieldId)`。
   * 渲染器只读这个 Map，**不发任何网络请求**。
   */
  images: Map<string, ResolvedImage[]>
  /** 系统变量 ${当前日期} 的值，形如 2026-09-14 */
  today: string
  /**
   * 系统变量 ${打印时间} 的值，形如 2026-09-15 14:03（**本地时区**）。
   * 由 pipeline 在进入渲染时取一次后固定：同一个文档里绝不能出现两个打印时间。
   */
  printTime?: string
  /** 数据总条数（系统变量） */
  totalRows: number
  /** 记录模板批量排布：default = 每条记录从新页开始；continuous = 记录连续排布 */
  batchLayout?: 'default' | 'continuous'
  /** 视图模板：每 N 条强制分页。null / undefined = 不限制 */
  perPageN?: number | null
}

/** 造一个最小可用的上下文（预览兜底 / 单测） */
export function emptyRenderContext(over: Partial<RenderContext> = {}): RenderContext {
  const fields = over.fields ?? []
  return {
    fields,
    fieldMap: over.fieldMap ?? new Map(fields.map((f) => [f.id, f])),
    images: over.images ?? new Map(),
    today: over.today ?? formatDateTime(Date.now()),
    // 与 today 同样在上下文构造时定值（本地时区，和 formatDateTime 的既有约定一致）
    printTime: over.printTime ?? formatDateTime(Date.now(), 'YYYY-MM-DD HH:mm'),
    totalRows: over.totalRows ?? 0,
    batchLayout: over.batchLayout,
    perPageN: over.perPageN,
  }
}

// ============================================================
// 警告（对应 PRD 的"模板检查"提示条与异常清单）
// ============================================================

export type RenderWarningKind =
  /** 占位符绑定的字段已被删除（E-13，阻断级，预览前需修正） */
  | 'field-missing'
  /** 占位符未绑定字段（BP-4 校验项） */
  | 'field-unbound'
  /** 元素包围盒超出纸张可打印区域（E-44，提示级） */
  | 'element-overflow'
  /** 图片加载失败（E-32） */
  | 'image-failed'
  /** 有效 DPI 低于阈值（E-38） */
  | 'image-low-dpi'
  /** 表格总宽超出版心，已按比例压缩（E-45） */
  | 'table-compressed'
  /** 单行内容高于一整页，被迫溢出（E-41） */
  | 'row-split'
  /** 单元格文本过长被截断（E-12） */
  | 'text-truncated'
  /**
   * 二维码 / 条形码内容有问题（含非 ASCII 字符、超出容量上限、条码过密）。
   *
   * 这是**单条记录的**问题而不是模板问题：同一个条码元素绑到不同记录上，
   * 有的内容能编码、有的不能，所以必须按记录分别列出才能定位到行。
   */
  | 'code-invalid'
  /**
   * 表格声明了 `rowsFromRecords`（多记录并进一张大表），但它不是循环区里的唯一元素。
   *
   * 属于**模板结构问题**：此时该表格与其它循环元素的相对位置无法定义，
   * 所以退回"按记录重复"的原有行为，并告知用户去改模板，而不是静默产出怪结果。
   */
  | 'loop-table-conflict'
  /**
   * 某一行里的单元格数（含 colspan 展开）超过了表格定义的列数。
   *
   * 属于**模板结构问题**：多出的单元格在 `table-layout:fixed` 下分不到宽度，
   * 会被压成 0 宽 —— 空着时看不见，填了内容就会和相邻格重叠。
   * 同一条问题在每一页/每条记录上都成立，所以按模板级去重（每个元素每种文案报一次）。
   */
  | 'table-column-mismatch'
  /**
   * 元素被摆在**版心之外**（`y` 或 `y+h` 超过版心高）。
   *
   * 版心 = 纸张减去页边距，**这才是真正印得出来的范围**；画布上纸张比版心大，
   * 所以作者可以把元素拖到版心下方（越界由画布的斜纹遮罩与检查条提示，见 F2-14）。
   *
   * 属于**模板结构问题**，但它以前的后果特别坏：分页时判断"放不下"→ 开新页 →
   * 仍按那个越界的 y 落块 ⇒ 块在纸外 ⇒ **元素静默消失，还白多一页**。
   * 现在改成"**钳回页内 + 明确告警**"（PRD F2-30：默认跨页更安全，**不丢数据**）。
   */
  | 'out-of-bounds'

export interface RenderWarning {
  kind: RenderWarningKind
  message: string
  /** 0 基页码 */
  pageIndex?: number
  elementId?: string
  recordId?: string
}

// ============================================================
// 分页产物
// ============================================================

/**
 * 已经定位好的块。坐标一律 **mm，相对版心左上角**（不是纸张左上角）。
 * html 只包含块内部内容，定位由 html.ts 统一包裹，避免两处各写一套偏移。
 */
export interface PlacedBlock {
  elementId: string
  kind: string
  xMm: number
  yMm: number
  wMm: number
  hMm: number
  /**
   * 作者**显式设定**的盒子高度（mm）；`h:'auto'` 时为 0。
   *
   * 为什么要带到这一层：`hMm` 已经被 `max(盒子高, 实测内容高)` 撑过，
   * 从它身上**看不出"作者有没有指定高度"**。而打印侧要对图片类元素区分对待
   * （显式高度 ⇒ 写死 `height`；否则 ⇒ `min-height`），所以必须单独带一份原始值。
   */
  boxHMm: number
  html: string
}

export interface PageModel {
  index: number
  /** 本页包含的记录下标区间（含头不含尾）；纯表头页 / 纯表尾页为空区间 */
  recordRange: [number, number]
  /** 已定位好的块（mm，相对版心左上角） */
  blocks: PlacedBlock[]
}

export interface RenderedDoc {
  pages: PageModel[]
  /** 完整 HTML 字符串：预览与打印**共用同一份**，这是 1:1 保真的保证 */
  html: string
  pageWidthMm: number
  pageHeightMm: number
  marginMm: MarginMm
  warnings: RenderWarning[]
}

/**
 * 模板级问题：同一处问题不管打印多少条记录，对用户都只是"模板有 1 个毛病"，
 * 所以去重时**不区分记录**。
 * 其余（图片加载失败 / 清晰度不足 / 单行溢出）是"某条记录的具体数据出的问题"，
 * 必须按记录分别列出，否则用户的失败清单没法定位到行。
 */
const TEMPLATE_LEVEL_WARNINGS: ReadonlySet<RenderWarningKind> = new Set<RenderWarningKind>([
  'field-missing',
  'field-unbound',
  'element-overflow',
  'table-compressed',
  'text-truncated',
  'loop-table-conflict',
  'table-column-mismatch',
  // 元素被摆到版心之外：**模板结构问题**，每条记录/每一页都会重现同一条，按模板级去重
  'out-of-bounds',
])

/** 把警告按语义去重，避免同一个问题在几十页里刷屏 */
export function dedupeWarnings(list: RenderWarning[]): RenderWarning[] {
  const seen = new Set<string>()
  const out: RenderWarning[] = []
  for (const w of list) {
    const key = TEMPLATE_LEVEL_WARNINGS.has(w.kind)
      ? `${w.kind}|${w.elementId ?? ''}|${w.message}`
      : `${w.kind}|${w.elementId ?? ''}|${w.recordId ?? ''}|${w.message}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(w)
  }
  return out
}
