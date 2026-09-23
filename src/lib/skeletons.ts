/**
 * 空白模板骨架库。
 *
 * 设计原则：
 * 1. **结构优先，字段尽力绑定**。骨架给的是版式（标题 / 信息区 / 明细表 / 签字区），
 *    里面的字段占位符按"候选名"去当前数据表里找字段；找不到就留成**未绑定**并保留期望的字段名，
 *    由编辑器照常提示、用户改绑。绝不因为"表里没有这个字段"就不生成那一格 —— 那会让单据缺项。
 * 2. **y 用累加值、h 给估算值**。这是循环区版式的约定：`y` 既是排序键也是排内偏移，
 *    `h` 给数字时才推进排版游标（`h: 'auto'` 不推进）。估算函数见 `lineMm` / `rowMm`。
 * 3. **不写 `fieldTypeSnapshot`**。按 PRD F2.3.1 的记录，该字段目前只有 Word 导入路径会写，
 *    编辑器手动插入不写；骨架不掺进来，避免再多出一个写入方。
 */

import type { FieldMeta } from './data-source'
import {
  DEFAULT_ATTACH_CONFIG,
  DEFAULT_PAGE_SETUP,
  DEFAULT_TEXT_STYLE,
  PT_TO_MM,
  SCHEMA_VERSION,
  emptyTemplate,
  newId,
} from './types'
import type {
  AnyElement,
  HLineElement,
  InlineNode,
  PageSetup,
  TableCell,
  TableElement,
  TableRow,
  TemplateDoc,
  TemplateKind,
  TextElement,
  TextStyle,
} from './types'

// ============================================================
// 基础工具
// ============================================================

/** 版心宽度（mm），由页面设置算出，不写死 */
export function contentWidthMm(pageSetup: PageSetup = DEFAULT_PAGE_SETUP): number {
  return Math.max(20, pageSetup.widthMm - pageSetup.margin.left - pageSetup.margin.right)
}

/** 单行文本高度（mm） */
export function lineMm(fontSizePt: number, lineHeight = DEFAULT_TEXT_STYLE.lineHeight): number {
  return r2(fontSizePt * lineHeight * PT_TO_MM)
}

/** 表格单行高度（mm）：文字行高 + 上下内边距 + 边框余量 */
export function rowMm(fontSizePt: number, paddingMm = 1.5): number {
  return r2(lineMm(fontSizePt, 1.4) + paddingMm * 2 + 0.4)
}

function r2(n: number): number {
  return Math.round(n * 100) / 100
}

function txt(text: string, style?: TextStyle): InlineNode {
  return style ? { type: 'text', text, style } : { type: 'text', text }
}

/** 字段占位符：`candidates` 按优先级匹配字段名；都不中则留未绑定但保留期望名 */
interface Placeholder {
  cands: string[]
  fallback: string
}

function ph(cands: string[] | string, fallback?: string): Placeholder {
  const list = Array.isArray(cands) ? cands : [cands]
  return { cands: list, fallback: fallback ?? list[0] }
}

const SYS = {
  rowNo: 'rowNo',
  pageNo: 'pageNo',
  pageCount: 'pageCount',
  today: 'today',
  totalRows: 'totalRows',
} as const

function norm(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/[\s_\-·:：()（）[\]【】/\\]/g, '')
}

/** 字段名归一化匹配：先全等，再双向包含（后者兜住「产品名称」↔「名称」这类差异） */
function matchField(fields: readonly FieldMeta[], cands: readonly string[]): FieldMeta | null {
  const exact = new Map(fields.map((f) => [norm(f.name), f]))
  for (const c of cands) {
    const hit = exact.get(norm(c))
    if (hit) return hit
  }
  for (const c of cands) {
    const n = norm(c)
    if (!n) continue
    const hit = fields.find((f) => {
      const fn = norm(f.name)
      return fn.includes(n) || n.includes(fn)
    })
    if (hit) return hit
  }
  return null
}

function node(p: Placeholder, fields: readonly FieldMeta[]): InlineNode {
  const f = matchField(fields, p.cands)
  return { type: 'field', fieldId: f?.id ?? null, fieldName: f?.name ?? p.fallback }
}

// ============================================================
// 版式游标：按"累加 y + 数字 h"推进
// ============================================================

class Cursor {
  readonly elements: AnyElement[] = []
  y = 0
  /**
   * ⚠️ 这里**不能**写成 `constructor(readonly widthMm: number) {}`（TS 参数属性）。
   *
   * 2026-09-18 实测：Node 的 `--experimental-strip-types`（strip-only 模式）**不支持参数属性**，
   * 会直接抛 `SyntaxError [ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX]` ⇒ **任何 Node 层自测只要
   * 间接 import 到本文件就整个加载失败**（表现为"某个模块在 Node 下加载不了"，极难定位）。
   * tsc 与 vite 都能过，所以这个坑只在测试层暴露。
   * ⇒ 拆成"显式字段 + 构造函数里赋值"，语义完全等价，但 strip-types 能过。
   */
  readonly widthMm: number
  constructor(widthMm: number) {
    this.widthMm = widthMm
  }

  private put(el: AnyElement, h: number): void {
    el.y = r2(this.y)
    this.elements.push(el)
    this.y = r2(this.y + h)
  }

  /** 空出一段垂直间距 */
  gap(mm: number): void {
    this.y = r2(this.y + Math.max(0, mm))
  }

  text(nodes: InlineNode[], opts: { w?: number; x?: number; lines?: number; style?: TextStyle } = {}): void {
    const style: TextStyle = { ...DEFAULT_TEXT_STYLE, ...opts.style }
    const lines = Math.max(1, opts.lines ?? 1)
    const h = r2(lineMm(style.fontSizePt ?? 10.5, style.lineHeight ?? 1.5) * lines + 0.6)
    const el: TextElement = {
      id: newId('el'),
      kind: 'text',
      x: opts.x ?? 0,
      y: 0,
      w: r2(opts.w ?? this.widthMm),
      // ⚠️ 显式给数字高度，**不要 'auto'**。
      // 'auto' 在浏览器里走 DOM 实测，而我推进游标用的是估算值 —— 两者一旦不一致，
      // 后面的元素就会压上来或留缝。给数字则渲染器直接采用该值、跳过测量，
      // 几何完全确定（Node 自测与浏览器所见一致）。代价是内容若超出预估行数会溢出，
      // 因此骨架里的文本都是可控的短文本，行数由 `lines` 显式声明。
      h,
      style,
      nodes,
    }
    this.put(el, h)
  }

  hline(opts: { x?: number; w?: number; thicknessPt?: number; color?: string } = {}): void {
    const el: HLineElement = {
      id: newId('el'),
      kind: 'hline',
      x: opts.x ?? 0,
      y: 0,
      w: r2(opts.w ?? this.widthMm),
      // 与编辑器保持一致：hline 用 h: 1（曾用 0，会在"无测量"环境下被兜底成 8mm）
      h: 1,
      thicknessPt: opts.thicknessPt ?? 0.75,
      color: opts.color ?? '#1f2329',
    }
    this.put(el, 1)
  }

  table(
    colWidthsMm: number[],
    rows: TableRow[],
    opts: {
      repeatHeader?: boolean
      fontSizePt?: number
      paddingMm?: number
      x?: number
      /**
       * 视图模板专用：循环区里的**唯一**表格把多条记录铺成一张连续大表。
       * 只允许清单/台账类骨架打开；单据类（一条记录一份）绝不能开 ——
       * 打开但不满足"循环区唯一元素"时渲染器会出 loop-table-conflict 警告。
       */
      rowsFromRecords?: boolean
    } = {},
  ): void {
    const fontSizePt = opts.fontSizePt ?? DEFAULT_TEXT_STYLE.fontSizePt
    const total = colWidthsMm.reduce((a, b) => a + b, 0)
    const el: TableElement = {
      id: newId('el'),
      kind: 'table',
      x: opts.x ?? 0,
      y: 0,
      w: r2(total),
      h: 'auto',
      colWidthsMm: colWidthsMm.map(r2),
      border: { mode: 'all', widthPt: 0.75, color: '#8f959e' },
      repeatHeader: opts.repeatHeader ?? true,
      cellPaddingMm: opts.paddingMm ?? 1.5,
      // 只在显式开启时写入：其余骨架（尤其单据类）的 JSON 保持原样，不给 schema 添噪音
      ...(opts.rowsFromRecords ? { rowsFromRecords: true } : {}),
      rows,
    }
    const headerRows = rows.filter((r) => r.isHeader).length
    const bodyRows = rows.length - headerRows
    this.put(el, r2(rowMm(fontSizePt, opts.paddingMm ?? 1.5) * (headerRows + bodyRows)))
  }

  element(el: AnyElement, h: number): void {
    this.put(el, h)
  }
}

// ---------------- 单元格 / 行 构造器 ----------------

function cell(nodes: InlineNode[], opts: { colspan?: number; style?: TextStyle } = {}): TableCell {
  return {
    id: newId('cell'),
    colspan: opts.colspan ?? 1,
    rowspan: 1,
    nodes,
    ...(opts.style ? { style: opts.style } : {}),
  }
}

function row(cells: TableCell[], isHeader = false): TableRow {
  return { id: newId('row'), cells, isHeader }
}

/** 标签单元格：浅底、居中 */
function label(text: string, bg = '#f5f6f7'): TableCell {
  return cell([txt(text)], { style: { background: bg, align: 'center' } })
}

/** 值单元格：绑定字段（或未绑定占位符） */
function value(p: Placeholder, fields: readonly FieldMeta[]): TableCell {
  return cell([node(p, fields)])
}

/** 空数据行（明细表用） */
function blankRow(cols: number): TableRow {
  return row(Array.from({ length: cols }, () => cell([])))
}

/** 签字区：一行文字 + 下划线占位 */
function signatureLine(items: string[]): InlineNode[] {
  const out: InlineNode[] = []
  items.forEach((labelText, i) => {
    if (i > 0) out.push(txt('　　'))
    out.push(txt(`${labelText}：`))
    out.push(txt('＿＿＿＿＿＿'))
  })
  return out
}

// ============================================================
// 骨架定义
// ============================================================

export interface SkeletonDef {
  key: string
  name: string
  kind: TemplateKind
  /** 一句话说明 */
  desc: string
  build(fields: FieldMeta[]): TemplateDoc
}

/** 统一的页面设置：骨架一律 A4 纵向、20mm 页边距 */
function baseDoc(kind: TemplateKind): TemplateDoc {
  const doc = emptyTemplate(kind)
  doc.pageSetup = { ...DEFAULT_PAGE_SETUP, margin: { ...DEFAULT_PAGE_SETUP.margin } }
  return doc
}

/**
 * 表头区（每页重复区）的**最小高度**，mm。
 *
 * ⚠️ 真机反馈 2026-09-23 第 11 条：「整个表格，**表头区几乎没有任何空间**，且三个分区的范围也不明显」。
 * 病根就在这里：表头区为空时 `headerHeightMm` 是 0 ⇒ `offsetMm` 是 0 ⇒ 循环区从版心最顶上开始，
 * 表头区在画布上是一块**零高度**的区域（连那条细标签条都画不出来 —— 带太矮塞不下一条 18px 的条）。
 *
 * 12mm ≈ Word 默认"页眉到正文"的距离，与 `emptyTemplate()` 给空模板的 15mm 同一口径。
 *
 * ⚠️ **下限放在生成侧（本文件），不要放进 `computeBandLayout`**：
 *    老模板的 `offsetMm` 是随模板存下来的，一改就**把别人排好的版式整体下移**；
 *    而这里的 `assemble` 只服务"从骨架新建模板"，所以只影响新模板，风险为零。
 *    （Word 导入那条路有它自己的组装逻辑，不走这里。）
 */
const MIN_HEADER_BAND_MM = 12

/**
 * 组装模板。
 *
 * `headerHeightMm` 必须由调用方传**每页重复区的 Cursor 累计高度**（即 `head.y`）。
 *
 * ⚠️ 这里踩过一个真 bug：早先是用 `hOf(el)` 逐元素累加来算的，而 `hOf` 对
 * `h: 'auto'` 的元素返回 0 —— 表格全是 `'auto'`，于是列头表格的高度被当成 0，
 * 循环区起始位置偏小，**画布上列头表格与循环区表格直接叠在一起**。
 * 导出侧用的是 DOM 实测高度所以看不出问题，但画布才是用户看和拖的地方 ——
 * 属于典型的"导出对、所见错"。改用 Cursor 累计值（它本来就是我推进版式用的估算）。
 */
function assemble(
  doc: TemplateDoc,
  loop: AnyElement[],
  header: AnyElement[] = [],
  footer: AnyElement[] = [],
  headerHeightMm = 0,
): TemplateDoc {
  return {
    ...doc,
    schemaVersion: SCHEMA_VERSION,
    bands: {
      header,
      /*
       * loop.offsetMm = 每页重复区的高度，让循环区从它下面开始（渲染器也会取 max 兜底）。
       * 下限见 MIN_HEADER_BAND_MM 的注释 —— 它保证"表头区"在画布上是一块**看得见、拖得进**的地方。
       */
      loop: { elements: loop, offsetMm: r2(Math.max(headerHeightMm, MIN_HEADER_BAND_MM)) },
      footer,
    },
  }
}

/** 每页重复区高度：优先用 Cursor 的累计值，兜底才逐元素估（且表格按一行算） */
function headerHeightOf(cursor: Cursor): number {
  return r2(cursor.y)
}

// ------------------------------------------------------------

function buildDocGeneral(fields: FieldMeta[]): TemplateDoc {
  const W = contentWidthMm()
  const c = new Cursor(W)

  c.text([txt('单　据')], { style: { fontSizePt: 18, bold: true, align: 'center', lineHeight: 1.3 } })
  c.gap(2)
  c.hline({ thicknessPt: 1.2 })
  c.gap(3)

  const cw = [22, 63, 22, 63]
  c.table(
    cw,
    [
      row([label('单　号'), value(ph(['单号', '编号', '单据号']), fields), label('日　期'), value(ph(['日期', '单据日期']), fields)]),
      row([label('经办人'), value(ph(['经办人', '制单人', '提交人']), fields), label('部　门'), value(ph(['部门', '所属部门']), fields)]),
      row([
        label('摘　要'),
        cell([node(ph(['摘要', '备注', '说明']), fields)], { colspan: 3 }),
      ]),
    ],
    { repeatHeader: false },
  )

  c.gap(6)
  c.text([txt('备注：')])
  c.gap(2)
  c.text([txt('　')])
  c.text([txt('　')])
  c.gap(4)
  c.text(signatureLine(['经办人', '审核', '日期']))

  return assemble(baseDoc('record'), c.elements)
}

/** 出入库单据共用主体，只有文案与字段候选不同 */
function buildStockDoc(
  fields: FieldMeta[],
  opts: {
    title: string
    codeCands: string[]
    partyLabel: string
    partyCands: string[]
    dateCands: string[]
    placeLabel: string
    placeCands: string[]
    personLabel: string
    personCands: string[]
    qtyCands: string[]
    signs: string[]
  },
): TemplateDoc {
  const W = contentWidthMm()
  const c = new Cursor(W)

  c.text([txt(opts.title)], { style: { fontSizePt: 18, bold: true, align: 'center', lineHeight: 1.3 } })
  c.gap(1)
  c.text(
    [
      txt('单号：'),
      node(ph(opts.codeCands), fields),
      txt('　　　日期：'),
      node(ph(opts.dateCands), fields),
    ],
    { style: { fontSizePt: 10, align: 'center' } },
  )
  c.gap(1)
  c.hline({ thicknessPt: 1.2 })
  c.gap(3)

  c.table(
    [22, 63, 22, 63],
    [
      row([
        label(opts.partyLabel),
        value(ph(opts.partyCands), fields),
        label(opts.placeLabel),
        value(ph(opts.placeCands), fields),
      ]),
      row([
        label(opts.personLabel),
        value(ph(opts.personCands), fields),
        label('联系电话'),
        value(ph(['联系电话', '电话', '手机']), fields),
      ]),
    ],
    { repeatHeader: false },
  )

  c.gap(4)
  // 明细表：表头 + 4 个空行，表头每页重复
  const detail = [40, 42, 34, 18, 16, 20]
  c.table(
    detail,
    [
      row(
        [label('序号', '#eff0f1'), label('名称', '#eff0f1'), label('规格型号', '#eff0f1'), label('单位', '#eff0f1'), label('数量', '#eff0f1'), label('备注', '#eff0f1')].map(
          (x) => ({ ...x, style: { ...x.style, align: 'center' } }),
        ),
        true,
      ),
      blankRow(6),
      blankRow(6),
      blankRow(6),
      blankRow(6),
      row([
        cell([txt('合计')], { colspan: 4, style: { align: 'center', background: '#f5f6f7' } }),
        cell([node(ph(opts.qtyCands), fields)], { style: { align: 'center' } }),
        cell([]),
      ]),
    ],
    { repeatHeader: true },
  )

  c.gap(8)
  c.text(signatureLine(opts.signs))

  return assemble(baseDoc('record'), c.elements)
}

function buildAcceptance(fields: FieldMeta[]): TemplateDoc {
  const W = contentWidthMm()
  const c = new Cursor(W)

  c.text([txt('验 收 单')], { style: { fontSizePt: 18, bold: true, align: 'center', lineHeight: 1.3 } })
  c.gap(2)
  c.hline({ thicknessPt: 1.2 })
  c.gap(3)

  c.table(
    [22, 63, 22, 63],
    [
      row([
        label('验收单号'),
        value(ph(['验收单号', '单号', '编号']), fields),
        label('验收日期'),
        value(ph(['验收日期', '日期']), fields),
      ]),
      row([
        label('供应商'),
        value(ph(['供应商', '厂商', '供货单位']), fields),
        label('验收人'),
        value(ph(['验收人', '检验员']), fields),
      ]),
      row([
        label('关联单据'),
        value(ph(['关联单据', '采购单号', '订单号']), fields),
        label('到货批次'),
        value(ph(['批次', '批号', '产品批号']), fields),
      ]),
    ],
    { repeatHeader: false },
  )

  c.gap(4)
  const detail = [16, 40, 34, 16, 18, 46]
  c.table(
    detail,
    [
      row(
        ['序号', '物料名称', '规格型号', '单位', '数量', '验收情况'].map((t) =>
          label(t, '#eff0f1'),
        ),
        true,
      ),
      blankRow(6),
      blankRow(6),
      blankRow(6),
      blankRow(6),
    ],
    { repeatHeader: true },
  )

  c.gap(5)
  c.text([txt('验收结论：'), node(ph(['验收结论', '结论', '验收结果']), fields)])
  c.gap(2)
  c.text([txt('不合格处理意见：')])
  c.text([txt('　')])
  c.gap(6)
  c.text(signatureLine(['验收人', '审核', '日期']))

  return assemble(baseDoc('record'), c.elements)
}

function buildRequisition(fields: FieldMeta[]): TemplateDoc {
  const W = contentWidthMm()
  const c = new Cursor(W)

  c.text([txt('领 料 单')], { style: { fontSizePt: 18, bold: true, align: 'center', lineHeight: 1.3 } })
  c.gap(1)
  c.text(
    [txt('单号：'), node(ph(['领料单号', '单号', '编号']), fields), txt('　　　日期：'), node(ph(['日期', '领料日期']), fields)],
    { style: { fontSizePt: 10, align: 'center' } },
  )
  c.gap(1)
  c.hline({ thicknessPt: 1.2 })
  c.gap(3)

  c.table(
    [22, 63, 22, 63],
    [
      row([
        label('领用部门'),
        value(ph(['领用部门', '部门', '使用部门']), fields),
        label('领料人'),
        value(ph(['领料人', '领用人', '申请人']), fields),
      ]),
      row([
        label('用　途'),
        value(ph(['用途', '领用用途', '说明']), fields),
        label('发料仓库'),
        value(ph(['仓库', '发料仓库', '库房']), fields),
      ]),
    ],
    { repeatHeader: false },
  )

  c.gap(4)
  const detail = [40, 40, 30, 16, 18, 26]
  c.table(
    detail,
    [
      row(
        ['物料编码', '物料名称', '规格型号', '单位', '数量', '备注'].map((t) => label(t, '#eff0f1')),
        true,
      ),
      blankRow(6),
      blankRow(6),
      blankRow(6),
      blankRow(6),
      row([
        cell([txt('合计')], { colspan: 3, style: { align: 'center', background: '#f5f6f7' } }),
        cell([]),
        cell([node(ph(['数量', '领用数量', '合计数量']), fields)], { style: { align: 'center' } }),
        cell([]),
      ]),
    ],
    { repeatHeader: true },
  )

  c.gap(8)
  c.text(signatureLine(['领料人', '发料人', '审批']))

  return assemble(baseDoc('record'), c.elements)
}

function buildInspection(fields: FieldMeta[]): TemplateDoc {
  const W = contentWidthMm()
  const c = new Cursor(W)

  c.text([txt('巡 检 记 录')], { style: { fontSizePt: 18, bold: true, align: 'center', lineHeight: 1.3 } })
  c.gap(1)
  c.text(
    [txt('编号：'), node(ph(['编号', '巡检编号', '单号']), fields), txt('　　　日期：'), node(ph(['日期', '巡检日期']), fields)],
    { style: { fontSizePt: 10, align: 'center' } },
  )
  c.gap(1)
  c.hline({ thicknessPt: 1.2 })
  c.gap(3)

  c.table(
    [22, 63, 22, 63],
    [
      row([
        label('巡检区域'),
        value(ph(['巡检区域', '区域', '位置']), fields),
        label('巡检人'),
        value(ph(['巡检人', '检查人', '提交人']), fields),
      ]),
      row([
        label('班　次'),
        value(ph(['班次', '班组']), fields),
        label('设备编号'),
        value(ph(['设备编号', '设备', '编号']), fields),
      ]),
    ],
    { repeatHeader: false },
  )

  c.gap(4)
  const detail = [16, 44, 46, 24, 40]
  c.table(
    detail,
    [
      row(['序号', '检查项目', '检查标准', '结果', '备注'].map((t) => label(t, '#eff0f1')), true),
      blankRow(5),
      blankRow(5),
      blankRow(5),
      blankRow(5),
      blankRow(5),
      blankRow(5),
    ],
    { repeatHeader: true },
  )

  c.gap(5)
  c.text([txt('异常情况描述：')])
  c.text([txt('　')])
  c.text([txt('　')])
  c.gap(2)
  c.text([txt('处理措施：')])
  c.text([txt('　')])
  c.gap(6)
  c.text(signatureLine(['巡检人', '复核', '日期']))

  return assemble(baseDoc('record'), c.elements)
}

/** 视图模板：通用清单 */
function buildListGeneral(fields: FieldMeta[]): TemplateDoc {
  const W = contentWidthMm()

  // 每页重复区：文档标题 + 列头（列头放在这里，才能每页都出现）
  const head = new Cursor(W)
  head.text([txt('明 细 清 单')], { style: { fontSizePt: 16, bold: true, align: 'center', lineHeight: 1.3 } })
  head.gap(1)
  head.text([txt('打印日期：'), { type: 'sysvar', key: SYS.today }], {
    style: { fontSizePt: 9, align: 'right' },
  })
  head.gap(1)

  const cols = [16, 44, 40, 20, 24, 26]
  head.table(
    cols,
    [row(['序号', '名称', '规格型号', '单位', '数量', '备注'].map((t) => label(t, '#eff0f1')), true)],
    { repeatHeader: false },
  )

  // 循环区：每条记录一行，**多条记录并进同一张连续表**（rowsFromRecords）。
  // 循环区里只有这一个元素，是开启该开关的硬前提（否则渲染器会出 loop-table-conflict 警告）。
  const body = new Cursor(W)
  body.table(
    cols,
    [
      row([
        cell([{ type: 'sysvar', key: SYS.rowNo }], { style: { align: 'center' } }),
        cell([node(ph(['名称', '产品名称', '物料名称']), fields)]),
        cell([node(ph(['规格型号', '规格', '型号']), fields)]),
        cell([node(ph(['单位', '计量单位']), fields)], { style: { align: 'center' } }),
        cell([node(ph(['数量', '入库数量', '领用数量']), fields)], { style: { align: 'right' } }),
        cell([node(ph(['备注']), fields)]),
      ]),
    ],
    { repeatHeader: false, rowsFromRecords: true },
  )

  // 表尾：仅最后一页
  const foot = new Cursor(W)
  foot.text([txt('合计条数：'), { type: 'sysvar', key: SYS.totalRows }], { style: { fontSizePt: 10 } })
  foot.gap(2)
  foot.text(
    [txt('第 '), { type: 'sysvar', key: SYS.pageNo }, txt(' 页 / 共 '), { type: 'sysvar', key: SYS.pageCount }, txt(' 页')],
    { style: { fontSizePt: 9, align: 'right' } },
  )

  return assemble(baseDoc('view'), body.elements, head.elements, foot.elements, headerHeightOf(head))
}

/** 视图模板：巡检台账（一张表列多条记录） */
function buildInspectionLog(fields: FieldMeta[]): TemplateDoc {
  const W = contentWidthMm()

  const head = new Cursor(W)
  head.text([txt('巡 检 台 账')], { style: { fontSizePt: 16, bold: true, align: 'center', lineHeight: 1.3 } })
  head.gap(1)
  head.text([txt('打印日期：'), { type: 'sysvar', key: SYS.today }], { style: { fontSizePt: 9, align: 'right' } })
  head.gap(1)
  head.table(
    [16, 34, 30, 22, 24, 44],
    [row(['序号', '巡检区域', '检查项目', '结果', '巡检人', '备注'].map((t) => label(t, '#eff0f1')), true)],
    { repeatHeader: false },
  )

  // 循环区：一条记录一行，多条记录并进同一张连续表（列头在每页重复区，见 head）
  const body = new Cursor(W)
  body.table(
    [16, 34, 30, 22, 24, 44],
    [
      row([
        cell([{ type: 'sysvar', key: SYS.rowNo }], { style: { align: 'center' } }),
        cell([node(ph(['巡检区域', '区域', '位置']), fields)]),
        cell([node(ph(['检查项目', '项目']), fields)]),
        cell([node(ph(['结果', '检查结果', '状态']), fields)], { style: { align: 'center' } }),
        cell([node(ph(['巡检人', '检查人', '提交人']), fields)], { style: { align: 'center' } }),
        cell([node(ph(['备注', '说明']), fields)]),
      ]),
    ],
    { repeatHeader: false, rowsFromRecords: true },
  )

  const foot = new Cursor(W)
  foot.text([txt('共 '), { type: 'sysvar', key: SYS.totalRows }, txt(' 条记录')], { style: { fontSizePt: 10 } })
  foot.gap(2)
  foot.text(
    [txt('第 '), { type: 'sysvar', key: SYS.pageNo }, txt(' 页 / 共 '), { type: 'sysvar', key: SYS.pageCount }, txt(' 页')],
    { style: { fontSizePt: 9, align: 'right' } },
  )

  return assemble(baseDoc('view'), body.elements, head.elements, foot.elements, headerHeightOf(head))
}

// ============================================================
// 注册表
// ============================================================

export const SKELETONS: SkeletonDef[] = [
  {
    key: 'blank-record',
    name: '空白（记录模板）',
    kind: 'record',
    desc: '完全空白，从零排版',
    build: () => baseDoc('record'),
  },
  {
    key: 'doc-general',
    name: '通用单据',
    kind: 'record',
    desc: '标题 + 单号/日期/经办人 + 摘要 + 签字区',
    build: buildDocGeneral,
  },
  {
    key: 'doc-inbound',
    name: '入库单',
    kind: 'record',
    desc: '供应商/仓库 + 明细表（名称·规格·单位·数量）+ 合计 + 签字',
    build: (fields) =>
      buildStockDoc(fields, {
        title: '入 库 单',
        codeCands: ['入库单号', '单号', '编号'],
        partyLabel: '供应商',
        partyCands: ['供应商', '供货单位', '厂商'],
        dateCands: ['入库日期', '日期'],
        placeLabel: '入库仓库',
        placeCands: ['仓库', '入库仓库', '库房'],
        personLabel: '经办人',
        personCands: ['经办人', '收货人', '仓管员'],
        qtyCands: ['数量', '入库数量', '合计数量'],
        signs: ['仓管员', '送货人', '日期'],
      }),
  },
  {
    key: 'doc-outbound',
    name: '出库单',
    kind: 'record',
    desc: '领用方/出库仓库 + 明细表 + 合计 + 签字',
    build: (fields) =>
      buildStockDoc(fields, {
        title: '出 库 单',
        codeCands: ['出库单号', '单号', '编号'],
        partyLabel: '领用部门',
        partyCands: ['领用部门', '部门', '客户'],
        dateCands: ['出库日期', '日期'],
        placeLabel: '出库仓库',
        placeCands: ['仓库', '出库仓库', '库房'],
        personLabel: '发料人',
        personCands: ['经办人', '发料人', '仓管员'],
        qtyCands: ['数量', '出库数量', '合计数量'],
        signs: ['领用人', '发料人', '日期'],
      }),
  },
  {
    key: 'doc-acceptance',
    name: '验收单',
    kind: 'record',
    desc: '供应商/批次 + 明细表（含验收情况）+ 验收结论 + 签字',
    build: buildAcceptance,
  },
  {
    key: 'doc-requisition',
    name: '领料单',
    kind: 'record',
    desc: '领用部门/用途 + 明细表（编码·名称·规格）+ 合计 + 签字',
    build: buildRequisition,
  },
  {
    key: 'doc-inspection',
    name: '巡检记录',
    kind: 'record',
    desc: '巡检区域/班次 + 检查项表（项目·标准·结果）+ 异常与措施 + 签字',
    build: buildInspection,
  },
  {
    key: 'blank-view',
    name: '空白（视图模板）',
    kind: 'view',
    desc: '完全空白，从零排版',
    build: () => baseDoc('view'),
  },
  {
    key: 'list-general',
    name: '通用清单',
    kind: 'view',
    desc: '每页重复标题与列头，逐条列出，底部带合计与页码',
    build: buildListGeneral,
  },
  {
    key: 'list-inspection',
    name: '巡检台账',
    kind: 'view',
    desc: '按区域/项目列出多条巡检记录，每页重复列头',
    build: buildInspectionLog,
  },
]

export function skeletonsFor(kind: TemplateKind): SkeletonDef[] {
  return SKELETONS.filter((s) => s.kind === kind)
}

export function findSkeleton(key: string): SkeletonDef | undefined {
  return SKELETONS.find((s) => s.key === key)
}

/** 构建骨架。未知 key 回退到对应类型的空白模板，绝不抛错打断创建流程 */
export function buildSkeleton(key: string, fields: readonly FieldMeta[], kindHint?: TemplateKind): TemplateDoc {
  const def = findSkeleton(key)
  if (!def) return baseDoc(kindHint ?? 'record')
  return def.build([...fields])
}

/** 统计骨架里有多少占位符没能绑定到当前表的字段（用于创建时提示） */
export function countUnbound(doc: TemplateDoc): { total: number; unbound: number } {
  let total = 0
  let unbound = 0
  const visitNodes = (nodes: InlineNode[] | undefined): void => {
    for (const n of nodes ?? []) {
      if (n.type === 'field') {
        total++
        if (!n.fieldId) unbound++
      }
    }
  }
  const visit = (els: AnyElement[]): void => {
    for (const el of els) {
      if (el.kind === 'text') visitNodes(el.nodes)
      else if (el.kind === 'table') for (const r of el.rows) for (const cc of r.cells) visitNodes(cc.nodes)
    }
  }
  visit(doc.bands.header)
  visit(doc.bands.loop.elements)
  visit(doc.bands.footer)
  return { total, unbound }
}

// 保留：附件块骨架后续会用到（避免引入未使用告警，这里显式引用一次）
void DEFAULT_ATTACH_CONFIG
