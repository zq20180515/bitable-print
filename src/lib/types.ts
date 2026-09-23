/**
 * BitablePrint 领域模型（唯一事实来源 / single source of truth）
 *
 * 设计原则：
 * 1) 所有尺寸一律用 **毫米(mm)** 存储与计算，仅在写 DOM 样式时换算为 px。避免单位混用导致的排版漂移。
 * 2) 文档结构采用 **band（版式区）+ 循环** 模型：每页重复区 / 循环区 / 表尾区。
 * 3) 模板可完整序列化为 JSON（schemaVersion 用于向上迁移）。
 */

// ============================================================
// 1. 页面设置
// ============================================================

export type PaperKey =
  | 'A4'
  | 'A5'
  | 'A3'
  | 'Letter'
  // 常见标签 / 热敏纸（快递面单、货架签、价签等）
  | 'label100x150'
  | 'label100x180'
  | 'label80x60'
  | 'label70x50'
  | 'label60x40'
  | 'label40x30'
  | 'custom'
export type Orientation = 'portrait' | 'landscape'

/** 纸张标准尺寸（纵向，单位 mm）。custom 由用户自行输入 */
export const PAPER_MM: Record<Exclude<PaperKey, 'custom'>, { w: number; h: number }> = {
  A4: { w: 210, h: 297 },
  A5: { w: 148, h: 210 },
  A3: { w: 297, h: 420 },
  Letter: { w: 215.9, h: 279.4 },
  label100x150: { w: 100, h: 150 },
  label100x180: { w: 100, h: 180 },
  label80x60: { w: 80, h: 60 },
  label70x50: { w: 70, h: 50 },
  label60x40: { w: 60, h: 40 },
  label40x30: { w: 40, h: 30 },
}

/**
 * 纸张预设的分组清单，供 UI 直接渲染下拉。
 * 分成"标准纸张 / 标签面单"两组，是因为这两类的用途与页边距习惯完全不同
 * （标签纸通常边距很小甚至为 0），放一个列表里会让用户误选。
 */
export const PAPER_PRESETS: Array<{
  key: PaperKey
  label: string
  group: '标准纸张' | '标签 / 面单'
  wMm?: number
  hMm?: number
}> = [
  { key: 'A4', label: 'A4（210×297）', group: '标准纸张' },
  { key: 'A5', label: 'A5（148×210）', group: '标准纸张' },
  { key: 'A3', label: 'A3（297×420）', group: '标准纸张' },
  { key: 'Letter', label: 'Letter（216×279）', group: '标准纸张' },
  { key: 'label100x150', label: '100×150 热敏面单', group: '标签 / 面单' },
  { key: 'label100x180', label: '100×180 热敏面单', group: '标签 / 面单' },
  { key: 'label80x60', label: '80×60 货架签', group: '标签 / 面单' },
  { key: 'label70x50', label: '70×50 价签', group: '标签 / 面单' },
  { key: 'label60x40', label: '60×40 小标签', group: '标签 / 面单' },
  { key: 'label40x30', label: '40×30 微型标签', group: '标签 / 面单' },
  { key: 'custom', label: '自定义尺寸…', group: '标签 / 面单' },
]

export interface MarginMm {
  top: number
  right: number
  bottom: number
  left: number
}

export interface PageSetup {
  /**
   * **允许把元素拖出页面**（2026-09-23 真机反馈第 10 条）。
   *
   * 用户原话：「页面左下角有个"拖出表格"的选项，点击后无法正常使用，将这个开关移动到
   * 页面属性和页面右键菜单中，**勾选后允许拖出页面，取消勾选则不允许拖出页面**」。
   *
   * 缺省（false/undefined）= **不允许**：拖到版心边缘就停住。
   * 为什么这样定默认值：越界元素在打印时会被裁掉（纸外的东西印不出来），
   * 而"不小心拖出去半个"是排版里最容易发生、又最难自己发现的错。
   * 老模板里已经越界的元素不受影响（只是不许再往**外**拖），检查条照旧会报越界。
   */
  allowOutOfPage?: boolean
  paper: PaperKey
  /** 纵向时的纸张宽（mm）；横向时渲染器会自动交换宽高，此处始终存纵向原值 */
  widthMm: number
  heightMm: number
  orientation: Orientation
  margin: MarginMm
  /** 页眉区距上边缘（mm）——仅作版式参考，v1 不渲染页眉内容 */
  headerMm: number
  /** 页脚区距下边缘（mm） */
  footerMm: number
  // ------------------------------------------------------------------
  // 以下几项**只影响编辑期的画布**，不参与打印输出。
  // 放在 PageSetup 里而不是用户偏好里：网格间距是"这个模板"的排版基准，
  // 换台机器打开同一模板应该看到同样的网格，否则对不齐的锅会算到插件头上。
  // 全部可选 —— 老模板没有这些字段时按 DEFAULT 兜底，不需要 schema 迁移。
  // ------------------------------------------------------------------
  /** 网格间距（mm）。默认 5 */
  gridMm?: number
  /** 画布是否显示网格。默认 true */
  showGrid?: boolean
  /** 拖拽/缩放是否吸附到网格。默认 true */
  snapToGrid?: boolean
}

/** 网格相关默认值（画布与吸附共用，避免两边各写一份魔法数字） */
export const DEFAULT_GRID = {
  gridMm: 5,
  showGrid: true,
  snapToGrid: true,
} as const

/** 网格间距的候选档位（mm） */
export const GRID_STEPS_MM = [1, 2, 2.5, 5, 10] as const

/**
 * 页边距快捷档（mm）。
 *
 * 2026-09-18 用户提问催生："**打印范围应该强制和纸张大小一致，纸张大小设置多少，
 * 打印范围就是多少才对。**"
 *
 * 技术事实：可打印范围 = **版心** = 纸张 − 页边距（`contentBoxSize`），
 * 所以"打印范围 = 整张纸"**本来就能做到，把四个边距都设成 0 即可** ——
 * 但界面上只有四个数字输入框 + 一个"四面相同"按钮，**没有人会想到这条等价关系**。
 * ⇒ 把最常用的四档做成胶囊，**0 那一档直接叫"整张纸"**，一眼就知道怎么得到它。
 *
 * ⚠️ 0 边距的物理提醒：绝大多数打印机有 3–5mm 的**硬件不可打印边**，
 * 铺满整张纸时最外圈可能被机器裁掉。写进 hint，让用户自己决定。
 */
export const MARGIN_PRESETS: Array<{ mm: number; label: string; hint: string }> = [
  {
    mm: 0,
    label: '整张纸（0）',
    hint: '版心 = 纸张：画布上任何位置都能打印。注意打印机通常有 3–5mm 硬件不可打印边，最外圈可能被裁掉',
  },
  { mm: 5, label: '窄（5mm）', hint: '边距小、能放的内容多' },
  { mm: 10, label: '常规（10mm）', hint: '常用档' },
  { mm: 20, label: '宽松（20mm）', hint: '留白多，适合正式文档' },
]

export const DEFAULT_PAGE_SETUP: PageSetup = {
  paper: 'A4',
  widthMm: 210,
  heightMm: 297,
  orientation: 'portrait',
  /**
   * 默认页边距。
   *
   * ⚠️ **20 → 12mm**（2026-09-19 用户要求："默认的页边距太大了，可以适当缩小些"）。
   *
   * 20mm 四周在 A4 上要吃掉 40mm 的版心高（257/297 = 87%），对"清单/台账"这类
   * 本来就内容密集的用途浪费太多空间；12mm 更接近常见单据的习惯，
   * 同时仍给打印机 3–5mm 的硬件不可打印边留足余量。
   *
   * 只影响**新建**模板：已有模板的 margin 是随模板存下来的，不会被改动。
   */
  margin: { top: 12, right: 12, bottom: 12, left: 12 },
  headerMm: 12,
  footerMm: 12,
}

/** 页面实际渲染宽高（已应用横竖方向） */
export function pageRenderSize(p: PageSetup): { w: number; h: number } {
  const w = p.paper === 'custom' ? p.widthMm : PAPER_MM[p.paper].w
  const h = p.paper === 'custom' ? p.heightMm : PAPER_MM[p.paper].h
  return p.orientation === 'landscape' ? { w: h, h: w } : { w, h }
}

/** 版心尺寸（扣除页边距后可用于排版的区域） */
export function contentBoxSize(p: PageSetup): { w: number; h: number } {
  const r = pageRenderSize(p)
  return {
    w: Math.max(0, r.w - p.margin.left - p.margin.right),
    h: Math.max(0, r.h - p.margin.top - p.margin.bottom),
  }
}

// ============================================================
// 2. 模板种类（对标官方「排版打印」）
// ============================================================

/**
 * record = 记录模板：引用单行记录的数据，一条记录成一份文档（单据类）
 * view   = 视图模板：引用多行记录的数据，一份文档含多条记录（清单类）
 */
export type TemplateKind = 'record' | 'view'

/** 记录模板的批量排布方式（对标官方批量模式） */
export type BatchLayout =
  /** 默认模式：按模板定义尺寸逐份向下排列，一份文件一张纸 */
  | 'default'
  /** 连续模式：多份内容连续排布，多个文件共用一张纸（省纸） */
  | 'continuous'

/** 视图模板的排布约束 */
export interface ViewLayout {
  /** 每 N 条记录强制分页；null = 不限（按内容自动换页） */
  perPageN: number | null
}

// ============================================================
// 3. 文本与样式
// ============================================================

export type Align = 'left' | 'center' | 'right' | 'justify'
export type VAlign = 'top' | 'middle' | 'bottom'

export interface TextStyle {
  fontFamily?: string
  /** 字号，单位 pt */
  fontSizePt?: number
  bold?: boolean
  italic?: boolean
  underline?: boolean
  strike?: boolean
  color?: string
  /** 背景色（单元格底纹等） */
  background?: string
  align?: Align
  vAlign?: VAlign
  /** 倍数行距，如 1.5；与 lineHeightPt 互斥，优先 lineHeightPt */
  lineHeight?: number
  /** 固定行距，单位 pt */
  lineHeightPt?: number
  spaceBeforePt?: number
  spaceAfterPt?: number
  /** 左右缩进，单位 mm */
  indentLeftMm?: number
  indentRightMm?: number
  /** 首行缩进，单位 mm */
  indentFirstLineMm?: number
}

export const DEFAULT_TEXT_STYLE: Required<
  Pick<TextStyle, 'fontFamily' | 'fontSizePt' | 'color' | 'align' | 'lineHeight'>
> = {
  fontFamily: 'system',
  fontSizePt: 10.5,
  color: '#1f2329',
  align: 'left',
  lineHeight: 1.5,
}

// ============================================================
// 4. 行内节点（文本块内部的可变内容）
// ============================================================

export interface InlineText {
  type: 'text'
  text: string
  style?: TextStyle
}

/** 字段占位符（行内） */
export interface InlineField {
  type: 'field'
  /** 绑定的字段 ID；null 表示未绑定（需在模板校验时提示） */
  fieldId: string | null
  /** 插入时的字段名，仅用于展示与 Fallback */
  fieldName: string
  /** 绑定时字段的类型快照，便于无元数据时降级渲染 */
  fieldTypeSnapshot?: number
  /** 该占位符的独立样式覆写 */
  style?: TextStyle
}

/**
 * 系统变量（行号 / 页码 / 总页数 / 当前日期 / 数据总条数 / 打印时间 / 页码含总页数）
 *
 * `pageOfTotal` 是新增的**合并形态**：用户提出「页码和页数可以合并在一起，可以单独设置是否显示总页数」。
 * 与 `pageNo` / `pageCount` 并存而不是替换 —— 后两者已有模板在用，且拆开显示仍然有人要。
 */
export type SysVarKey = 'rowNo' | 'pageNo' | 'pageCount' | 'today' | 'totalRows' | 'printTime' | 'pageOfTotal'

export interface InlineSysVar {
  type: 'sysvar'
  key: SysVarKey
  style?: TextStyle
  /**
   * 时间类变量（`today` / `printTime`）的显示格式，记号见 `formatDateTime`。
   * 留空则用该变量自己的默认格式（`today` = `YYYY-MM-DD`，`printTime` = `YYYY-MM-DD HH:mm`）。
   * 非时间类变量上出现该字段应当被忽略（不要报错，模板可能被复制粘贴过）。
   */
  format?: string
  /**
   * **仅 `pageOfTotal` 生效**：为 `true` 时只输出「第 X 页」，不输出「共 N 页」。
   * 默认（undefined / false）输出「第 X 页 / 共 N 页」。
   */
  hideTotal?: boolean
}

/**
 * 时间类系统变量的**候选格式**（供 UI 渲染下拉）。
 *
 * 为什么不把格式自由化：用户要的是"能选到合适的"，不是"自己拼一个格式化串"。
 * 给几个覆盖真实场景的档位，比给一个空输入框更不容易出错。
 * 需要新档位就加在这里 —— 底层 `formatDateTime` 已支持这些记号。
 */
export const TIME_FORMAT_PRESETS: ReadonlyArray<{ label: string; value: string }> = [
  { label: '2026-09-16', value: 'YYYY-MM-DD' },
  { label: '2026/09/16', value: 'YYYY/MM/DD' },
  { label: '2026年09月16日', value: 'YYYY年MM月DD日' },
  { label: '09-16', value: 'MM-DD' },
  { label: '2026-09-16 21:30', value: 'YYYY-MM-DD HH:mm' },
  { label: '2026-09-16 21:30:45', value: 'YYYY-MM-DD HH:mm:ss' },
  { label: '21:30', value: 'HH:mm' },
  { label: '2026-09-16 周三', value: 'YYYY-MM-DD ddd' },
  { label: '2026-09-16 星期三', value: 'YYYY-MM-DD dddd' },
]

/** `today` 的默认格式（与既有行为一致，不要改） */
export const DEFAULT_TODAY_FORMAT = 'YYYY-MM-DD'
/** `printTime` 的默认格式（与既有行为一致，不要改） */
export const DEFAULT_PRINT_TIME_FORMAT = 'YYYY-MM-DD HH:mm'

export interface InlineBreak {
  type: 'br'
}

export type InlineNode = InlineText | InlineField | InlineSysVar | InlineBreak

// ============================================================
// 5. 元素
// ============================================================

export type ElementKind =
  | 'text'
  | 'table'
  | 'image'
  | 'hline'
  | 'pagebreak'
  | 'fieldBlock'
  | 'attach'
  | 'qrcode'
  | 'barcode'

/** 所有元素共用的定位与样式基础字段。坐标相对所在版式区的左上角，单位 mm */
export interface ElementBase {
  id: string
  kind: ElementKind
  /** 距版心左边界，mm */
  x: number
  /** 距上一元素/版心顶部，mm。循环区内的元素按 y 排序后顺序流式排布 */
  y: number
  /** 宽，mm */
  w: number
  /** 高，mm；为 'auto' 时由内容测量决定（仅循环区内支持） */
  h: number | 'auto'
  style?: TextStyle
  locked?: boolean
}

/** 文本段落（可含行内字段占位符） */
export interface TextElement extends ElementBase {
  kind: 'text'
  nodes: InlineNode[]
}

/** 独立的字段块：整块就是一个字段值，适合大号标题、图片字段等 */
export interface FieldBlockElement extends ElementBase {
  kind: 'fieldBlock'
  fieldId: string | null
  fieldName: string
  /** 前缀/后缀文字，如 "金额：¥" + 值 + " 元" */
  prefix?: string
  suffix?: string
}

export interface TableBorderStyle {
  /** none = 无边框；all = 全框线；outer = 仅外框；horizontal = 仅横线 */
  mode: 'none' | 'all' | 'outer' | 'horizontal'
  widthPt: number
  color: string
}

/**
 * 单元格的**单边边框**（2026-09-22，用户规格 八："任意单元格的上 / 下 / 左 / 右单条边显隐"）。
 *
 * 语义是**覆盖整表设置**，三态：
 *   · `undefined` = 跟随整表（`TableElement.border.mode`）—— 老模板没有这个字段，行为完全不变；
 *   · `true`      = **这一条边要画**（哪怕整表是 `none`，也能给某一格单独加一条线）；
 *   · `false`     = **这一条边不画**（哪怕整表是 `all`，也能把某格的线抹掉）。
 *
 * `widthPt` / `color` 同样只在"这一格真的要画线"时生效，缺省沿用整表的值。
 * 最终"四条边各画不画"由 `table-actions` 的 `resolveCellEdges()` 统一算 ——
 * 画布与打印必须读同一份结果，否则会出现"画布上有线、打印出来没有"。
 */
export interface CellBorders {
  top?: boolean
  right?: boolean
  bottom?: boolean
  left?: boolean
  widthPt?: number
  color?: string
}

export interface TableCell {
  id: string
  /** 单边边框覆盖；缺省（老模板）完全跟随整表 */
  borders?: CellBorders
  /** 跨列数，默认 1 */
  colspan: number
  /** 跨行数，默认 1 */
  rowspan: number
  /** 单元格内容：行内节点数组；与 attachment 互斥 */
  nodes: InlineNode[]
  /**
   * 单元格里**驻留的块级元素**（2026-09-22，用户规格 六"单元格作为素材容器"）。
   *
   * 规格原文："画布上所有元素（文本、图片、条码、二维码、形状等）都可以拖拽进入任意单元格……
   * 成为单元格的子内容，**按单元格对齐方式排布**"。
   *
   * ── 为什么需要它（而不是继续把元素"化"成行内节点）────────────────────
   * 在此之前，"拖元素进格子"只支持**文本与字段块**（转成 `nodes` 里的行内节点），
   * 图片 / 条码 / 二维码这些**块级元素结构上装不进去**，只能拒绝并提示。
   * 于是"表格里放一张产品图或一个二维码"这件事在插件里做不到 —— 而清单类模板到处是这种格子。
   *
   * ── 三条约定（由动作层保证，不在类型上硬编码）────────────────────
   *   ① **一格最多一个块级子元素**（`children.length <= 1`）：规格说"默认放一个主元素"；
   *      真要叠放就得先定义层叠规则，而"图片叠二维码"在任何实际模板里都没有意义。
   *      放第二个时**替换**第一个（并明确提示），不是静默叠加。
   *   ② 子元素**不参与版式计算**（它不占循环区的高度、也不进 `analyzeTemplate` 的越界判定）：
   *      它跟着所在的格子走。
   *   ③ 渲染顺序：**先子元素、后 `nodes`** —— "图片在上、说明文字在下"是这类格子的通行排版。
   *   ④ ⚠️ **子元素的 `w` / `h` 与自由层同名字段含义不同**（2026-09-22 真机反馈第 3 条后定的）：
   *
   *      | 字段 | 自由层（版式区里） | 格内子元素 |
   *      | --- | --- | --- |
   *      | `w` | 宽度，mm | **占单元格内容宽度的百分比**（默认 100 = 撑满） |
   *      | `h` | 高度，mm / `'auto'` | **一样**：数字 = 固定高度（img 按 `fit` 适配这个盒子），`'auto'` = 由内容决定 |
   *      | `x` / `y` | 版心内坐标，mm | **无意义**（子元素在单元格里走文字流，位置由单元格决定） |
   *
   *      为什么 `w` 用百分比而不是 mm：子元素在单元格里是**流式排版**（`display:block`），
   *      它的高度会撑起这一行 —— 若改成"格内绝对定位 + mm 尺寸"，单元格高度是自适应的，
   *      就没人给出高度，格子会塌掉。所以位置只能交给文字流，用户能调的是"占多宽"和"多高"。
   *      **跨边界时必须换算**：进格子 → `normalizeChildInCell`；取出到画布 → `normalizeChildOutOfCell`
   *      （见 `cell-child.ts`）。两个渲染端（画布 `Canvas.tsx` / 打印 `render/html.ts`）都要认这条。
   */
  children?: AnyElement[]
  /** 附件图片单元格的打印配置；非空时该单元格走图片渲染分支 */
  attachment?: AttachmentPrintConfig
  style?: TextStyle
  /** 单元格内边距，mm */
  paddingMm?: number
}

export interface TableRow {
  id: string
  cells: TableCell[]
  /** 是否为表头行（在 Word 导入中对应 w:tblHeader） */
  isHeader?: boolean
  /** 固定行高，mm；undefined = 自适应 */
  heightMm?: number
  /** 整行不跨页（对应 break-inside: avoid） */
  keepTogether?: boolean
}

export interface TableElement extends ElementBase {
  kind: 'table'
  /** 各列宽度，mm。总宽应为元素 w（超出时按比例压缩，见 E-45） */
  colWidthsMm: number[]
  rows: TableRow[]
  border: TableBorderStyle
  /** 表头行是否每页重复（仅循环区外/表格内部生效） */
  repeatHeader?: boolean
  /**
   * 第一列是不是**标题列**（2026-09-23 真机反馈第 5 条）。
   *
   * ⚠️ 这一位是**推翻旧决定**加回来的，理由必须写清楚（旧决定见 `setHeaderStylePatch` 上方那段注释）：
   *
   * 旧决定是"列的标题身份**由样式表达**，不加标记位"——理由是"列不存在跨页重复，加一个没人读的位
   * 只会变成第二个真相源"。那个理由在**只有行**的时候成立。
   *
   * 但真机一上手就暴露了它的死穴：**角格 (第 1 行第 1 列) 同时属于标题行与标题列**。
   * 于是"从角格的样式反推第一列是不是标题列"永远分不清这两种情况：
   *   · 用户只勾了「设置标题行」 ⇒ 角格有标题样式 ⇒ 被读成"标题列也开着"；
   *   · 用户取消「设置标题行」 ⇒ 角格样式被清 ⇒ 明明还勾着「设置标题列」却读成没勾。
   * 这就是反馈里那句「点击设置标题行则会连着标题列一起取消或者勾选」的根子。
   *
   * ⇒ 样式仍然负责**长什么样**（加粗/居中/底纹，跟着格子走、插列删列天然正确），
   *    而"**是不是**标题列"由这一位负责。两者不再互相冒充。
   */
  headerCol?: boolean
  /** 单元格默认内边距，mm */
  cellPaddingMm?: number
  /**
   * 视图模板专用：把**多条记录各铺一行**并进同一张表，而不是每条记录各出一张小表。
   *
   * 清单/台账类模板的主场景。缺省（false/undefined）= 现有行为（循环区按记录重复，
   * 表格随之被实例化 N 次，各带一份表头），保持向后兼容、不影响 schema 迁移。
   *
   * 生效条件：该表格位于 `bands.loop`，且是循环区里的**唯一元素** ——
   * 否则它与其它循环元素的相对位置无法定义。违反时出警告，不静默产出怪结果。
   *
   * 分页不需要新逻辑：表格超页时按行拆分、每页重复表头（F2-29）已经支持。
   */
  rowsFromRecords?: boolean
}

export interface ImageElement extends ElementBase {
  kind: 'image'
  /** 内嵌图片（固定图片，如公司 logo）。模板 JSON 内联存储，单张 ≤300KB */
  dataUrl: string
  fit?: ImageFill
}

export interface HLineElement extends ElementBase {
  kind: 'hline'
  thicknessPt: number
  color: string
}

export interface PageBreakElement extends ElementBase {
  kind: 'pagebreak'
}

/** 附件字段块（图片打印的主载体） */
export interface AttachElement extends ElementBase {
  kind: 'attach'
  fieldId: string | null
  fieldName: string
  config: AttachmentPrintConfig
}

export type AnyElement =
  | TextElement
  | FieldBlockElement
  | TableElement
  | ImageElement
  | HLineElement
  | PageBreakElement
  | AttachElement
  | QrCodeElement
  | BarcodeElement

// ============================================================
// 5.1 二维码 / 条形码
// ============================================================

/**
 * 码的内容来源。两种模式都支持，因为实际用途明显分成两类：
 *   · `field`  —— 每条记录一个码（产品追溯码、批次码），打印时逐条变化
 *   · `static` —— 全篇同一个码（固定网址、公司官网、设备铭牌），用户现场输入
 */
export type CodeSource =
  | {
      kind: 'field'
      /** 绑定的字段；null 表示未绑定（模板检查会提示） */
      fieldId: string | null
      /** 插入时的字段名，仅用于展示与 fallback */
      fieldName: string
    }
  | {
      kind: 'static'
      /** 用户直接输入的固定内容 */
      value: string
    }

/** 二维码 */
export interface QrCodeElement extends ElementBase {
  kind: 'qrcode'
  source: CodeSource
  /** 纠错等级。默认 'M'（约 15% 容错，通用场景够用且不浪费容量） */
  ecLevel?: 'L' | 'M' | 'Q' | 'H'
  /** 码下方是否显示原文（便于人工核对） */
  showText?: boolean
  /** 前景色（模块色）。默认 #000000 */
  foreground?: string
  /** 背景色。默认 #ffffff */
  background?: string
}

/**
 * 条形码。
 *
 * v1 只做 Code128：它覆盖全部 128 个 ASCII 字符（数字、字母、常用符号），
 * 不需要像 EAN-13 那样校验位数与前置规则，是"用户随便填个编号就能出码"的最稳选择。
 */
export interface BarcodeElement extends ElementBase {
  kind: 'barcode'
  source: CodeSource
  format?: 'code128'
  /** 码下方是否显示原文 */
  showText?: boolean
  foreground?: string
  background?: string
}

// ============================================================
// 6. 附件图片打印配置（对应 PRD F4.2 / F4.3）
// ============================================================

/**
 * 附件打印策略。
 *
 * · `none`      = 不打印附件
 * · `imageOnly` = 仅打印图片（文件名不出）
 * · `nameOnly`  = **仅打印附件名称**（不出图、不下载）
 * · `all`       = 图片 + 文件名
 *
 * `nameOnly` 是 2026-09-18 用户要求新增的：
 * "对于附件字段，打印策略有点模糊，应该优化下当前的设置，**增加仅打印附件名称的功能**。"
 *
 * 与 `textOnlyFallback`（F4-27 逃生舱）的区别很重要，别合并两者：
 *   · `textOnlyFallback` 是**临时降级**（大表/弱网时"这次先别嵌图"），语义是"退而求其次"；
 *   · `nameOnly` 是用户**主动选择的打印策略**（例如只想要一张"附件清单"），语义是"这就是我要的"。
 * 表现上两者都不嵌图，但前者在界面上是"逃生舱"，后者是正常档位。
 */
export type AttachmentMode = 'none' | 'imageOnly' | 'nameOnly' | 'all'

/** 原图尺寸 / 固定高度（宽度按比例）/ 适配单元格 / **固定宽高（用元素框的 w×h）** */
export type AttachmentSizeMode = 'original' | 'fixedHeight' | 'fitCell' | 'fixedBox'

/**
 * 「固定宽高」时，图片怎么放进这个框（2026-09-20 用户指定）。
 *
 * ⚠️ **刻意复用 `ImageElement.fit` 那套值**（`contain` / `cover`），不另造一套枚举 ——
 * "图片怎么适配一个框"在全项目只能有一个概念，否则画布、打印、属性面板三处早晚各说各话。
 *
 *   · `contain` = **等比缩放留白**（`object-fit:contain`）——整图可见，空出来的那一边留白。**默认**。
 *   · `cover`   = **等比缩放填满**（`object-fit:cover`）——等比放大到铺满，超出的部分裁掉。
 *
 * ⚠️ 用户原话里还有第三种「**裁切**」。它与 `cover` 在 CSS 里极可能是同一件事
 * （都是"铺满 + 超出裁掉"），所以我**先不编一个值为它**——
 * 详见交付说明里问的那一句。缺省（含所有老模板）走 `contain`，不改任何现有产出。
 */
export type AttachmentFit = ImageFill

/**
 * 图片放进一个框的**四种**方式（2026-09-22，用户规格 七）。
 *
 * 规格原文："把图片放入单元格时（或在右侧属性面板切换），提供 4 种模式……打印渲染端按同一模式渲染"：
 *   · `fill`   铺满变形   —— 拉伸铺满、不保持宽高比（`object-fit: fill`）
 *   · `contain` 保持比例留白 —— 整图可见，空出来的那一边留白
 *   · `natural` 原尺寸     —— 按图片原始尺寸，**撑大**容器
 *   · `cover`  自动裁剪   —— 等比铺满，超出的部分居中裁掉
 *
 * ⚠️ 四种方式**不是同一个维度上的四个值**：`natural` 改变的是"框"（高度变 auto / 单元格按原图撑高），
 *    另外三种改变的是"图怎么放进框"。所以存储上不能只用一个字段表达 ——
 *    见 `imageFillPatch()` / `imageFillModeOf()` 这对映射函数。把它们放在这里（而不是 UI 层）的理由：
 *    **画布、打印、属性面板三处必须读同一份映射**，否则早晚各说各话。
 */
export type ImageFill = 'fill' | 'contain' | 'natural' | 'cover'

/**
 * 退出「原尺寸」时补的高度（mm）。
 * 用户可以随后拖边框改它 —— 这里只需要一个**非 auto** 的起点，
 * 否则 `h` 还留在 `'auto'`，`imageFillModeOf` 读回来仍是 `natural`，UI 会当场弹回原尺寸档。
 */
export const EXIT_NATURAL_H_MM = 40

/**
 * UI 四选一 → 要写进文档的字段（元素用 `fit`/`h`，附件格用 `sizeMode`/`fit`）。
 *
 * ⚠️ `currentH` 不是可选的装饰：**从"原尺寸"切到别的档**时必须同时把 `h` 从 `'auto'` 改成一个具体值，
 *    否则读回来还是 `natural`（`imageFillModeOf` 判的就是 `h === 'auto'`），
 *    用户会看到"点了没反应"。
 */
export function imageFillPatch(
  mode: ImageFill,
  kind: 'image' | 'attachment',
  currentH?: number | 'auto',
): { fit?: AttachmentFit; h?: 'auto' | number; sizeMode?: AttachmentSizeMode } {
  if (mode === 'natural') {
    // 原尺寸：元素把高度交给图片自己撑（渲染端 `height:auto`）；附件格用 original
    return kind === 'image' ? { fit: 'contain', h: 'auto' } : { sizeMode: 'original' }
  }
  const exitAuto = kind === 'image' && currentH === 'auto' ? { h: EXIT_NATURAL_H_MM } : null
  return kind === 'image' ? { fit: mode, ...exitAuto } : { fit: mode, sizeMode: 'fitCell' }
}

/** 反向：当前文档状态 → UI 该高亮哪一档（读不出来时退回 `contain`，与默认一致） */
export function imageFillModeOf(
  src: { fit?: string; h?: number | 'auto'; sizeMode?: AttachmentSizeMode },
  kind: 'image' | 'attachment',
): ImageFill {
  if (kind === 'attachment' && src.sizeMode === 'original') return 'natural'
  if (kind === 'image' && src.h === 'auto') return 'natural'
  if (src.fit === 'fill' || src.fit === 'cover') return src.fit
  return 'contain'
}

export type AttachmentFlow = 'inline' | 'wrap'

export interface AttachmentPrintConfig {
  mode: AttachmentMode
  sizeMode: AttachmentSizeMode
  /** sizeMode = fixedHeight 时生效，mm */
  fixedHeightMm?: number
  /**
   * sizeMode = fixedBox 时生效：图片怎么放进"元素框"（w×h）。
   *
   * 缺省 = `contain`（等比缩放留白）。**老模板没有这个字段 ⇒ 走缺省**，
   * 所以加它不需要 schema 迁移，也不会改变任何现有产出的渲染。
   */
  fit?: AttachmentFit
  align: 'left' | 'center' | 'right'
  /** inline = 并排（放不下自动换行）；wrap = 每张独占一行 */
  flow: AttachmentFlow
  /** 每行最多图片数，1–8；null = 按容器宽度自动 */
  maxPerRow: number | null
  gapXMm: number
  gapYMm: number
  /**
   * 自适应单元格大小：单图时按单元格宽高双向约束。
   *
   * ⚠️ **默认值已改为 `true`**（2026-09-18 用户拍板）：
   * "自动把尺寸压缩到和单元格一致就行，**同时提醒已经被压缩**。"
   *
   * 以前默认 `false` ⇒ 一张按原图尺寸渲染的附件会把单元格/版心撑破，
   * 渲染层只能报"打印时会被裁剪"—— 用户拿到的是**被裁掉一半的图**。
   * 现在默认等比缩到装得下：**内容不丢**，且渲染时会明确告警"已压缩到框内"。
   * 想保留原始尺寸（宁可溢出）的，在属性面板关掉这一项即可。
   */
  fitCell?: boolean
  /** 在每张图片下方显示文件名 */
  showFileName?: boolean
  /** 文件名是否含扩展名 */
  fileNameWithExt?: boolean
  /** 单张图片体积上限（MB），超出跳过 */
  maxFileSizeMb: number
  /** 有效 DPI 低于该值时给出清晰度警告 */
  minDpi: number
  /** 只导出文件名、不嵌图（大表/弱网逃生舱，对应 F4-27） */
  textOnlyFallback?: boolean
}

export const DEFAULT_ATTACH_CONFIG: AttachmentPrintConfig = {
  mode: 'imageOnly',
  sizeMode: 'original',
  align: 'center',
  flow: 'inline',
  maxPerRow: null,
  gapXMm: 2,
  gapYMm: 2,
  // ⚠️ 默认 true（2026-09-18 用户拍板："自动压缩到和单元格一致，同时提醒已被压缩"）。
  // 详见 `fitCell` 字段的注释 —— 默认 false 时附件会把容器撑破，用户拿到的是被裁掉一半的图。
  fitCell: true,
  showFileName: false,
  fileNameWithExt: true,
  maxFileSizeMb: 10,
  minDpi: 150,
  textOnlyFallback: false,
}

// ============================================================
// 7. 模板文档
// ============================================================

/** 循环区：其中的内容按数据行重复渲染 */
export interface LoopBand {
  /** 循环区内的元素（按 y 排序后顺序排布） */
  elements: AnyElement[]
  /** 循环区之前固定渲染的内容高度，mm（用于定位） */
  offsetMm: number
}

export interface TemplateBands {
  /** 每页重复区（页眉区）：绝对定位，每页克隆 */
  header: AnyElement[]
  /** 循环区（视图模板的主体 / 记录模板的主内容） */
  loop: LoopBand
  /**
   * 表尾区（页脚区）：**每页重复**。
   *
   * ⚠️ 2026-09-23 第二次反馈第 2 条改掉了它的老语义（原来是"仅最后一页渲染"）。
   * 用户原话：「表头区和表尾区，按我的理解是，这两个区域的元素，应该在每页纸的表头和表尾重复，
   * 但现在只有表头区的元素会出现在每页纸的开头，表尾区的元素只会出现在最后一页」——
   * 这个理解是对的（Word 的页眉页脚就是每页都出、页码/签字栏这类内容也确实每页都需要）。
   * ⇒ 现在与表头区**对称**：都在 `layout.ts` 的 `startPage()` 里克隆一份。
   */
  footer: AnyElement[]
  /**
   * 表头区是否启用（缺省 = 启用）。
   *
   * 关掉后该区元素**不参与打印**，但**画布上仍然显示、仍可编辑** ——
   * 一关就从画布上抹掉的话，用户就没法把元素先摆好再决定要不要了。
   */
  headerEnabled?: boolean
  /** 表尾区是否启用（缺省 = 启用）。语义同 `headerEnabled`。 */
  footerEnabled?: boolean
}

export interface TemplateDoc {
  /** 模板结构版本号，用于导入时向上迁移 */
  schemaVersion: number
  pageSetup: PageSetup
  bands: TemplateBands
}

export const SCHEMA_VERSION = 1

export function emptyTemplate(kind: TemplateKind): TemplateDoc {
  return {
    schemaVersion: SCHEMA_VERSION,
    pageSetup: { ...DEFAULT_PAGE_SETUP, margin: { ...DEFAULT_PAGE_SETUP.margin } },
    bands: {
      header: [],
      // 视图模板自动生成循环区骨架（F2-14e）；记录模板同样使用 loop 区，只是不重复
      /*
       * ⚠️ 真机反馈（2026-09-22）：「表头表尾区默认留一点空间，大概相当于 Word 文档中的页眉页脚」。
       * 原来是 0 ⇒ 空表的"表头区"高度为 0，用户既看不见也拖不进去。
       * 15mm 约等于 Word 默认页眉到版心的距离。（骨架模板会用**真实表头内容高度**覆盖它 ✓）
       */
      loop: { elements: [], offsetMm: 15 },
      footer: [],
    },
  }
}

// ============================================================
// 8. 模板记录（存储在多维表格的 _打印模板_ 表中）
// ============================================================

/** 与 _打印模板_ 表的字段一一对应 */
export interface TemplateRecord {
  /** 模板表记录的 recordId */
  recordId: string
  name: string
  kind: TemplateKind
  /** 目标数据表名（仅作展示） */
  targetTableName: string
  /** 目标数据表 ID（真正的主键，改名不影响） */
  targetTableId: string
  /** 模板文档 JSON */
  doc: TemplateDoc
  /** 纸张展示串，如 "A4 纵向" */
  paperLabel: string
  createdBy?: string
  updatedAt?: number
}

// ============================================================
// 9. 单位换算
// ============================================================

/** 1mm = 96/25.4 px（CSS 参考像素） */
export const MM_TO_PX = 96 / 25.4
/** 1pt = 1/72 inch → mm */
export const PT_TO_MM = 25.4 / 72
// ⛔ `MM_TO_PT`（1mm → pt）2026-09-21 删：它的唯一使用者是 `mmToPt()`，而那个函数全项目没人调。
//    要 mm→pt 时用 `1 / PT_TO_MM` 即可，别再加一个只会漂移方向的常量。
/** twips（1/1440 inch）→ mm，用于 DOCX 解析 */
export const TWIPS_TO_MM = 25.4 / 1440
/** EMU（1/914400 inch）→ px，用于 DOCX 图片尺寸 */
export const EMU_TO_PX = 1 / 9525
/** 半磅 → pt，用于 DOCX 字号 (w:sz) */
export const HALF_PT_TO_PT = 0.5

export function mmToPx(mm: number): number {
  return mm * MM_TO_PX
}

export function pxToMm(px: number): number {
  return px / MM_TO_PX
}

export function ptToMm(pt: number): number {
  return pt * PT_TO_MM
}
/** 安全数值：任何参与 CSS 计算的数字都过一遍，避免 NaN 污染样式（见 skill 的 NaN 隐患） */
export function finite(n: number | undefined | null, fallback = 0): number {
  return typeof n === 'number' && Number.isFinite(n) ? n : fallback
}

// ============================================================
// 10. 元素工厂（供编辑器与导入器共用）
// ============================================================

let _seq = 0
export function newId(prefix = 'el'): string {
  _seq += 1
  return `${prefix}_${Date.now().toString(36)}_${_seq.toString(36)}`
}