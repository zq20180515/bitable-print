/**
 * 模板存储层 —— 决策 D-1 的落地（PRD F6 / 附录 D）。
 *
 * 存储介质：多维表格内自动创建的 `_打印模板_` 表，一条记录 = 一个模板，
 * 模板正文以 JSON 字符串存在 `模板配置` 字段里（见 data-source.ts 的 TemplateRow）。
 * 为什么不用 localStorage：F6-07 —— 换电脑/清缓存即丢，只能做 UI 偏好缓存。
 *
 * 这一层只依赖 `DataSource` 接口，**不 import 任何 SDK**：
 * 于是模板管理的全部逻辑（过滤、重命名、复制、迁移、导入导出）都能在 Node 下被单测，
 * 也不需要在测试里伪造飞书 iframe。
 *
 * 三个容易踩的坑，都在这里一次性处理掉：
 * 1) 模板必须按 `目标数据表ID` 过滤（F6-00）——用 ID 不用表名，改名不影响、删表能识别（F6-12）。
 * 2) 复制到别的数据表时字段绑定可能整体失效（F6-10）——rebindDoc 会先按 fieldId、
 *    再按字段名重新绑定，实在绑不上就退化成"未绑定占位符"，交给编辑器按 F2-17 显式提示。
 * 3) 解析模板 JSON 必须区分三种失败：JSON 损坏（E-14）/ 版本过高（E-15）/ 结构非法（BP-4），
 *    前两者文案与处理完全不同，混成一句"模板损坏"会被用户投诉。
 */

import { DEFAULT_PAGE_SETUP, SCHEMA_VERSION, emptyTemplate } from './types'
import type { AnyElement, InlineNode, MarginMm, PageSetup, PaperKey, TemplateDoc, TemplateKind } from './types'
import type { DataSource, FieldMeta, TemplateRow, TemplateWritePayload } from './data-source'
// `round1` 的规范实现在 `components/editor/round.ts`（B 批收口：此前全项目 5 份副本、
// 且不是同一种行为，详见那个文件的文件头）。这里只是引用它，不再自带一份。
import { round1 } from '../components/editor/round'

// ============================================================
// 基础工具
// ============================================================

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

function isRecordArray(v: unknown): v is unknown[] {
  return Array.isArray(v)
}

function numOr(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}

/**
 * 字段名归一化：去首尾空格、统一全角括号为半角、去掉所有空格、转小写。
 * 依据 F3-13 对占位符匹配的容错要求——Word 里复制粘贴出来的字段名经常带全角括号与空格。
 */
function normFieldName(name: string): string {
  return name
    .trim()
    .replace(/（/g, '(')
    .replace(/）/g, ')')
    .replace(/\s+/g, '')
    .toLowerCase()
}

/** 深拷贝模板文档。doc 是纯 JSON 结构，走 JSON 往返最省事，也顺带验证"可序列化"这一前提 */
function cloneDoc(doc: TemplateDoc): TemplateDoc {
  return JSON.parse(JSON.stringify(doc)) as TemplateDoc
}

/** 文档里所有元素（三个版式区拍平），供绑定扫描 / 重绑共用 */
function elementsOf(doc: TemplateDoc): AnyElement[] {
  return [...doc.bands.header, ...doc.bands.loop.elements, ...doc.bands.footer]
}

function nodesOf(el: AnyElement): InlineNode[][] {
  if (el.kind === 'text') return [el.nodes]
  if (el.kind === 'table') return el.rows.map((r) => r.cells.flatMap((c) => c.nodes))
  return []
}

// ============================================================
// 纸张展示串
// ============================================================

/** 生成"纸张"字段的展示串：A4 纵向 / A5 横向 / 自定义 210×297mm 纵向 */
export function buildPaperLabel(pageSetup: PageSetup): string {
  const dir = pageSetup.orientation === 'landscape' ? '横向' : '纵向'
  // 自定义尺寸必须带上实际毫米数，否则列表里两张"自定义 纵向"完全分不出来
  if (pageSetup.paper === 'custom') {
    return `自定义 ${round1(pageSetup.widthMm)}×${round1(pageSetup.heightMm)}mm ${dir}`
  }
  return `${pageSetup.paper} ${dir}`
}

// ============================================================
// 序列化 / 反序列化 / 版本迁移
// ============================================================

export function serializeDoc(doc: TemplateDoc): string {
  // 紧凑输出：模板会写进单元格，500KB 上限（E-16）下不该为缩进浪费字节
  return JSON.stringify(doc)
}

/**
 * 模板 JSON 的建议上限，超过时提示（E-16 / F6-05）。
 *
 * ⚠️ **2026-09-21 查证：这个上限从没被检查过** —— 它和下面的 `docJsonBytes()` 全项目
 *    没有任何调用方。也就是说 **F6-05「写入前大小检查」这条需求没接线**：
 *    度量工具是齐的，但保存路径（`serializeDoc` → `createTemplateRow`）没有调用它。
 *
 * ⇒ 清死导出时**特意留着这两个**，而不是当死代码删掉：它们是目前这条缺口**唯一的痕迹**，
 *   删了就再没人知道 F6-05 差这一步。要做的时候在 `createTemplate` / `saveTemplate`
 *   里判一次即可（超限走 E-16 的阻断提示，UI 侧已有提示位）。
 */
export const TEMPLATE_SIZE_WARN_BYTES = 500 * 1024

/** 估算 JSON 字节数（UTF-8）——用于 F6-05 的"写入前大小检查"（⚠️ 尚未接线，见上） */
export function docJsonBytes(json: string): number {
  // eslint-disable-next-line no-restricted-globals
  const enc = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null
  if (enc) return enc.encode(json).length
  return json.length // 极端环境兜底：按字符数估
}

export type DocParseKind =
  /** 解析并通过校验 */
  | 'ok'
  /** JSON 本身坏了（E-14） */
  | 'corrupt'
  /** schemaVersion 高于插件支持（E-15） */
  | 'tooNew'
  /** JSON 合法但结构不符合模板模型（BP-4 阻断项） */
  | 'invalid'

export interface DocParseResult {
  doc: TemplateDoc | null
  error?: string
  kind: DocParseKind
  /** 发生过向上迁移时记录原始版本号（F2-43） */
  migratedFrom?: number
}

type Migration = (doc: TemplateDoc) => TemplateDoc

/**
 * 版本迁移表：key = 源版本，值 = 从该版本升到 key+1 的迁移函数。
 *
 * 扩展点（唯一）：将来把 SCHEMA_VERSION 抬到 2 时，
 * 在这里加一条 `[1]: (d) => 处理函数` 即可（处理函数返回补齐了新字段的文档），
 * 不需要改 deserializeDoc —— migrate() 会按版本逐个套用。
 * v1 是首个版本，表为空，于是走兜底分支（只补默认值 + 抬版本号）。
 */
const MIGRATIONS: Record<number, Migration> = {}

/** 向上迁移：逐版本套用迁移函数；没有脚本的版本只抬版本号（结构缺失值已由 coerceDoc 补齐） */
export function migrate(doc: TemplateDoc, from: number, to: number): TemplateDoc {
  let cur = doc
  for (let v = from; v < to; v += 1) {
    const step = MIGRATIONS[v]
    // 复制一份再改，避免污染调用方持有的对象
    cur = step ? step(cur) : { ...cur, schemaVersion: v + 1 }
  }
  return { ...cur, schemaVersion: to }
}

/** 把合法但不完整的 JSON 补齐成完整的 TemplateDoc（缺字段即补默认值，对应 F6-04 的容错思路） */
function coerceDoc(raw: Record<string, unknown>): TemplateDoc {
  const ps = isPlainObject(raw.pageSetup) ? raw.pageSetup : {}
  const margin = isPlainObject(ps.margin) ? (ps.margin as unknown as Partial<MarginMm>) : {}
  const pageSetup: PageSetup = {
    paper: (typeof ps.paper === 'string' ? ps.paper : DEFAULT_PAGE_SETUP.paper) as PaperKey,
    widthMm: numOr(ps.widthMm, DEFAULT_PAGE_SETUP.widthMm),
    heightMm: numOr(ps.heightMm, DEFAULT_PAGE_SETUP.heightMm),
    orientation: ps.orientation === 'landscape' ? 'landscape' : 'portrait',
    margin: {
      top: numOr(margin.top, DEFAULT_PAGE_SETUP.margin.top),
      right: numOr(margin.right, DEFAULT_PAGE_SETUP.margin.right),
      bottom: numOr(margin.bottom, DEFAULT_PAGE_SETUP.margin.bottom),
      left: numOr(margin.left, DEFAULT_PAGE_SETUP.margin.left),
    },
    headerMm: numOr(ps.headerMm, DEFAULT_PAGE_SETUP.headerMm),
    footerMm: numOr(ps.footerMm, DEFAULT_PAGE_SETUP.footerMm),
  }

  const bands = isPlainObject(raw.bands) ? raw.bands : {}
  const loop = isPlainObject(bands.loop) ? bands.loop : {}
  return {
    schemaVersion: SCHEMA_VERSION,
    pageSetup,
    bands: {
      header: isRecordArray(bands.header) ? (bands.header as AnyElement[]) : [],
      loop: {
        elements: isRecordArray(loop.elements) ? (loop.elements as AnyElement[]) : [],
        offsetMm: numOr(loop.offsetMm, 0),
      },
      footer: isRecordArray(bands.footer) ? (bands.footer as AnyElement[]) : [],
    },
  }
}

/** 结构校验 + 归一化。deserializeDoc 与导入流程共用（保证".bptpl.json 里的单模板"也能走同一套规则） */
export function normalizeDoc(raw: unknown): DocParseResult {
  if (!isPlainObject(raw)) {
    return { doc: null, kind: 'invalid', error: '模板结构不合法：根节点不是对象' }
  }
  const ver = raw.schemaVersion
  if (typeof ver !== 'number' || !Number.isInteger(ver) || ver < 1) {
    // 文案面向用户（导入 / 粘贴都会透出这一句），所以带上"你可能拿错数据了"这层含义，
    // 而不是只甩一个内部字段名。检查顺序与 kind 不动。
    return {
      doc: null,
      kind: 'invalid',
      error: '这份数据里没有模板版本号（schemaVersion），可能不是本插件导出的模板内容',
    }
  }
  // E-15 / F2-42：版本过高必须**拒绝**，不能猜着打开——高版本可能有插件不认识的元素
  if (ver > SCHEMA_VERSION) {
    return {
      doc: null,
      kind: 'tooNew',
      error: `该模板由更高版本插件创建（v${ver}），请升级插件`,
    }
  }
  if (!isPlainObject(raw.pageSetup)) {
    return { doc: null, kind: 'invalid', error: '模板结构不合法：缺少页面设置' }
  }
  const bands = raw.bands
  if (!isPlainObject(bands)) {
    return { doc: null, kind: 'invalid', error: '模板结构不合法：缺少版式区定义' }
  }
  if (!isPlainObject(bands.loop) || !isRecordArray((bands.loop as Record<string, unknown>).elements)) {
    return { doc: null, kind: 'invalid', error: '模板结构不合法：循环区缺少 elements' }
  }
  if (!isRecordArray(bands.header) || !isRecordArray(bands.footer)) {
    return { doc: null, kind: 'invalid', error: '模板结构不合法：页眉区/表尾区必须是数组' }
  }

  let doc = coerceDoc(raw)
  let migratedFrom: number | undefined
  if (ver < SCHEMA_VERSION) {
    doc = migrate(doc, ver, SCHEMA_VERSION) // F2-43：低于当前版本自动向上迁移
    migratedFrom = ver
  }
  return { doc, kind: 'ok', migratedFrom }
}

/**
 * 解析模板 JSON。
 * 注意 `json` 收 unknown：值可能来自单元格（string）也可能来自已解析的导入包（object），
 * 收窄成 string 会迫使调用方到处写 instanceof 判断。
 */
export function deserializeDoc(json: unknown): DocParseResult {
  if (typeof json !== 'string' || json.trim() === '') {
    return { doc: null, kind: 'corrupt', error: '模板配置为空' }
  }
  let raw: unknown
  try {
    raw = JSON.parse(json)
  } catch {
    return { doc: null, kind: 'corrupt', error: '模板文件已损坏或被修改，无法解析' } // E-14
  }
  return normalizeDoc(raw)
}

// ============================================================
// 字段绑定扫描 / 重绑（F6-10、F2-17、E-13）
// ============================================================

/** 任意持有字段绑定的节点（InlineField / FieldBlockElement / AttachElement 结构一致） */
export interface FieldBinding {
  fieldId: string | null
  fieldName: string
}

export interface BindingChange {
  fieldName: string
  fromFieldId: string | null
  toFieldId: string | null
  kind: 'rebound' | 'unbound'
}

export interface BindingReport {
  /** 绑定在新表里依然有效 */
  kept: number
  /** 原 fieldId 失效但存在同名字段，已改绑 */
  rebound: number
  /** 新表里既没有 ID 也没有同名字段 → 退化为未绑定占位符 */
  unbound: number
  /** 本来就没绑定的占位符（未变，不计入上面三项） */
  alreadyUnbound: number
  details: BindingChange[]
}
/**
 * 让文档的字段绑定适配另一张数据表的字段集合（原地修改，返回变更报告）。
 *
 * 匹配顺序：**先 ID 后名称**。
 * - ID 命中：最可靠（同一张表内复制/另存为的场景）。
 * - 名称命中：跨表复制的常见情形——两张表都有"产品名称"列，但 fieldId 不同。
 *   不做这一步的话，"把模板复制到已有同名列的新表"会得到一整页红色失效占位符。
 * - 都不命中：`fieldId = null` 保留 `fieldName`，渲染与编辑器按 F2-17 显示"⚠ 字段不存在：xxx"。
 *   宁可显式失效也不静默丢值。
 */
export function rebindDoc(doc: TemplateDoc, fields: FieldMeta[]): BindingReport {
  const byId = new Map<string, FieldMeta>()
  const byName = new Map<string, FieldMeta>()
  for (const f of fields) {
    byId.set(f.id, f)
    const key = normFieldName(f.name)
    // 重名字段只认第一个（与 F3-19 的占位符匹配策略保持一致）
    if (key && !byName.has(key)) byName.set(key, f)
  }

  const report: BindingReport = { kept: 0, rebound: 0, unbound: 0, alreadyUnbound: 0, details: [] }

  const fix = (holder: FieldBinding): void => {
    const fromId = holder.fieldId
    if (fromId && byId.has(fromId)) {
      report.kept += 1
      return
    }
    const key = holder.fieldName ? normFieldName(holder.fieldName) : ''
    const hit = key ? byName.get(key) : undefined
    if (hit) {
      holder.fieldId = hit.id
      report.rebound += 1
      report.details.push({ fieldName: holder.fieldName, fromFieldId: fromId, toFieldId: hit.id, kind: 'rebound' })
      return
    }
    if (fromId === null) {
      // 本来就是未绑定，不属于"这次复制造成的失效"
      report.alreadyUnbound += 1
      return
    }
    holder.fieldId = null
    report.unbound += 1
    report.details.push({ fieldName: holder.fieldName, fromFieldId: fromId, toFieldId: null, kind: 'unbound' })
  }

  for (const el of elementsOf(doc)) {
    for (const group of nodesOf(el)) {
      for (const n of group) {
        if (n.type === 'field') fix(n)
      }
    }
    if (el.kind === 'fieldBlock' || el.kind === 'attach') fix(el)
  }
  return report
}

// ============================================================
// 列表项 / 存储层
// ============================================================

/** TemplateRecord 的落地形态：解析失败的模板仍然要出现在列表里（F2-35），所以额外带出错误信息 */
export interface TemplateListItem {
  recordId: string
  name: string
  kind: TemplateKind
  targetTableName: string
  targetTableId: string
  /** 解析失败时回退为空白模板，保证 UI 不会拿到 null 崩掉 */
  doc: TemplateDoc
  paperLabel: string
  createdBy?: string
  updatedAt?: number
  /** 配置损坏时为原因文案（E-14 / E-15） */
  docError?: string
  /** 配置损坏时保留原文，便于"导出备份"或人工修复 */
  rawDocJson?: string
}

export interface CreateTemplateInput {
  name: string
  kind: TemplateKind
  targetTableId: string
  targetTableName: string
  /** 不传则按 kind 生成空白模板（F2-36 / BP-2 第 5 步） */
  doc?: TemplateDoc
}

export interface CopyToTableResult {
  recordId: string
  name: string
  /** 目标是另一张表时才有意义的字段绑定调整情况（F6-10） */
  bindings: BindingReport
  /** 目标表在 listTables 里找不到（可能已被删除，F6-12） */
  targetTableMissing: boolean
}

function normalizeKind(k: unknown): TemplateKind {
  return k === 'record' ? 'record' : 'view'
}

/**
 * 模板存储层。
 * 用它接 `DataSource`，可以直接换 mock / SDK 实现，不改变任何调用方代码。
 */
export class TemplateStore {
  private readonly ds: DataSource
  private tableIdCache: string | null = null

  constructor(ds: DataSource) {
    this.ds = ds
  }

  /** ensureTemplateTable 在 SDK 侧是"找表、没有就建表"，每次列表都调会白跑一趟，所以缓存 */
  private async tableId(): Promise<string> {
    if (!this.tableIdCache) this.tableIdCache = await this.ds.ensureTemplateTable()
    return this.tableIdCache
  }

  /** 用户手动删了模板表（E-17）时调用，下次访问自动重建 */
  invalidate(): void {
    this.tableIdCache = null
  }

  /** 模板表本身的 tableId，供 P7 的"模板保存在…工作表中"说明文案使用 */
  async templateTableId(): Promise<string> {
    return this.tableId()
  }

  // ---------------- 读 ----------------

  /**
   * 列出**属于指定数据表**的模板（F6-00 / F6-09）。
   * 用 targetTableId 而非表名做主键，所以用户重命名数据表不会让模板失联（F6-12）。
   * 默认按更新时间倒序：最近改过的模板最可能是用户要的那一个。
   */
  async listTemplates(targetTableId: string): Promise<TemplateListItem[]> {
    const rows = await this.ds.listTemplateRows(await this.tableId())
    return rows
      .filter((r) => r.targetTableId === targetTableId)
      .map(toListItem)
      .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
  }

  /** 列出本多维表格内的全部模板：P7 模板管理、以及 BP-2.1 的"从已有模板复制"入口需要 */
  async listAllTemplates(): Promise<TemplateListItem[]> {
    const rows = await this.ds.listTemplateRows(await this.tableId())
    return rows.map(toListItem).sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
  }

  async getTemplate(recordId: string): Promise<TemplateListItem | null> {
    const row = await this.findRowOrNull(recordId)
    return row ? toListItem(row) : null
  }

  // ---------------- 写 ----------------

  /**
   * 取一个**本表内不重复**的模板名（2026-09-18 飞书真机反馈后补）。
   *
   * 用户原话："画布模板名称没有做同名校验，导致会将模板存为一模一样的名字。"
   * 以前只有"另存为副本"查了重（见下面的 `uniqueCopyName`），而它管的是**副本**命名；
   * 用户手输的名字——新建 / 重命名 / 编辑器内改名 / 独立窗口保存回传的 `res.name`——
   * **全都直写**。四个写入入口，只有一处有校验。
   *
   * 为什么收口在 **store 层**而不是 UI：改名入口有三个（向导的 prompt、编辑器内的 `onRename`、
   * 独立窗口回传的 `name`），只改 UI 一定漏掉一个。
   *
   * 撞名策略：**自动加 ` (2)` / ` (3)` 后缀**，与既有的 `uniqueCopyName` 同风格。
   * 为什么是"加后缀"而不是"拒绝"：拒绝需要把错误一路送到用户眼前，而现在
   * `useWizardState.renameTemplate` 是被 `void w.renameTemplate(...)` 调用的，异常会被 `void` 吞掉
   * ⇒ 用户看到的是"点了没反应"，比"名字多了个后缀"更糟。加后缀后**列表里当场就能看到实际名字**。
   *
   * @param exceptId 自己改名时要排除自己，否则永远判定为撞名
   */
  private async uniqueName(targetTableId: string, base: string, exceptId?: string): Promise<string> {
    const wanted = (base ?? '').trim() || '未命名模板'
    const used = new Set(
      (await this.listTemplates(targetTableId)).filter((t) => t.recordId !== exceptId).map((t) => t.name),
    )
    if (!used.has(wanted)) return wanted
    for (let i = 2; i < 100; i += 1) {
      const cand = `${wanted} (${i})`
      if (!used.has(cand)) return cand
    }
    return `${wanted} (${Date.now()})`
  }

  async createTemplate(input: CreateTemplateInput): Promise<string> {
    const doc = input.doc ?? emptyTemplate(input.kind)
    return this.ds.createTemplateRow(await this.tableId(), {
      name: await this.uniqueName(input.targetTableId, input.name),
      kind: input.kind,
      targetTableName: input.targetTableName,
      targetTableId: input.targetTableId,
      docJson: serializeDoc(doc),
      paper: buildPaperLabel(doc.pageSetup),
    })
  }

  /**
   * upsert：带 recordId 就更新，否则新建并返回新 recordId。
   * （SDK 侧没有"按 recordId 更新"的原子接口，必须整条覆盖，所以这里要求传完整记录。）
   */
  async saveTemplate(rec: {
    recordId?: string
    name: string
    kind: TemplateKind
    targetTableId: string
    targetTableName: string
    doc: TemplateDoc
  }): Promise<string> {
    if (rec.recordId) {
      await this.ds.updateTemplateRow(await this.tableId(), rec.recordId, {
        // 独立窗口保存回传的 `res.name` 也走这里 ⇒ 必须查重（见 uniqueName 的注释）
        name: await this.uniqueName(rec.targetTableId, rec.name, rec.recordId),
        kind: rec.kind,
        targetTableName: rec.targetTableName,
        targetTableId: rec.targetTableId,
        docJson: serializeDoc(rec.doc),
        paper: buildPaperLabel(rec.doc.pageSetup),
      })
      return rec.recordId
    }
    return this.createTemplate(rec)
  }

  /** 重命名（F2-38）。存量字段一并带回，避免整条覆盖时把其他列清空 */
  async renameTemplate(recordId: string, name: string): Promise<void> {
    const row = await this.findRow(recordId)
    // 撞名 ⇒ 加 ` (2)` 后缀（不静默重复，见 uniqueName 的注释）
    const finalName = await this.uniqueName(row.targetTableId, name, recordId)
    await this.ds.updateTemplateRow(await this.tableId(), recordId, payloadOf(row, finalName))
  }

  /** 另存为副本（F2-37）：同表内复制，字段绑定天然有效 */
  async duplicateTemplate(recordId: string, newName?: string): Promise<string> {
    const row = await this.findRow(recordId)
    const name = newName ?? (await this.uniqueCopyName(row.targetTableId, row.name))
    // 显式给了 newName 时同样要查重（以前这条路径也直写）
    const finalName = await this.uniqueName(row.targetTableId, name)
    return this.ds.createTemplateRow(await this.tableId(), payloadOf(row, finalName))
  }

  /**
   * 复制到另一张数据表（F6-10）。
   *
   * 为什么不改原模板的 targetTableId：原表的使用者还在用，改作用域等于把别人的模板偷走。
   * 字段绑定按 rebindDoc 处理，绑定不上的部分会退化为未绑定占位符并写进返回值，
   * 由 UI 在进入编辑器时提示（F2-17 / E-13）。
   *
   * 返回结构比"裸 recordId"多带了绑定报告与"目标表是否存在"——
   * 这两条都是 UI 必须告知用户的信息，否则用户会以为复制是"无损"的。
   */
  async copyToTable(
    recordId: string,
    targetTableId: string,
    targetTableName?: string,
  ): Promise<CopyToTableResult> {
    const row = await this.findRow(recordId)
    const parsed = deserializeDoc(row.docJson)
    if (!parsed.doc) {
      throw new Error(`模板配置无法解析，不能复制：${parsed.error ?? '未知原因'}`)
    }
    const doc = cloneDoc(parsed.doc)
    const bindings = await this.rebind(doc, targetTableId)
    const resolved = await this.resolveTableName(targetTableId, targetTableName)
    const name = await this.uniqueCopyName(targetTableId, row.name)
    const newId = await this.ds.createTemplateRow(await this.tableId(), {
      name,
      kind: normalizeKind(row.kind),
      targetTableName: resolved.name,
      targetTableId,
      docJson: serializeDoc(doc),
      paper: buildPaperLabel(doc.pageSetup),
    })
    return { recordId: newId, name, bindings, targetTableMissing: resolved.missing }
  }

  /** 删除（F2-39）。空数组直接返回，避免 SDK 收到空请求 */
  async deleteTemplates(recordIds: string[]): Promise<void> {
    if (recordIds.length === 0) return
    await this.ds.deleteTemplateRows(await this.tableId(), recordIds)
  }

  /**
   * 从 `.bptpl.json` 导入（F2-41）。
   *
   * 失败粒度刻意分两层：
   * - 整个文件不可用（JSON 坏了 / 版本过高 / 不是模板包）→ 抛 TemplateImportError，
   *   由 UI 走 E-14/E-15 的阻断提示（一个都别写进表，避免半截数据）。
   * - 单条模板有问题 → 记进 errors 跳过，其余照常导入；整包导入时不该因为一条坏数据全废。
   */
  async importTemplatePackage(
    json: string,
    opts: TemplateImportOptions = {},
  ): Promise<ImportPackageResult> {
    const { entries, errors } = parseTemplatePackage(json)
    const tableId = await this.tableId()
    const imported: ImportedTemplate[] = []

    for (let i = 0; i < entries.length; i += 1) {
      const entry = entries[i]
      const parsedDoc = entry.parse.doc
      if (!parsedDoc) continue // parseTemplatePackage 已把失败项放进 errors
      const doc = cloneDoc(parsedDoc)
      const kind = normalizeKind(entry.kind)
      const targetTableId = opts.targetTableId ?? entry.targetTableId ?? ''
      const warnings: string[] = []

      if (entry.parse.migratedFrom !== undefined) {
        warnings.push(`模板来自 v${entry.parse.migratedFrom}，已自动迁移到 v${SCHEMA_VERSION}`)
      }

      let targetTableName = entry.targetTableName ?? ''
      if (opts.targetTableId) {
        const resolved = await this.resolveTableName(opts.targetTableId, opts.targetTableName ?? targetTableName)
        targetTableName = resolved.name
      }

      // 导入到别的数据表 → 字段绑定必须重绑，否则整页占位符失效（复用 F6-10 的同一套逻辑）
      let bindings: BindingReport | undefined
      if (opts.targetTableId && opts.targetTableId !== entry.targetTableId) {
        bindings = await this.rebind(doc, opts.targetTableId)
        if (bindings.unbound > 0) {
          warnings.push(`${bindings.unbound} 个字段占位符在新表中不存在，已转为未绑定占位符`)
        }
      } else if (!targetTableId) {
        warnings.push('模板未绑定数据表，请在编辑器中确认目标表')
      }

      const name = entry.name || `导入的模板 ${i + 1}`
      const recordId = await this.ds.createTemplateRow(tableId, {
        name,
        kind,
        targetTableName,
        targetTableId,
        docJson: serializeDoc(doc),
        paper: buildPaperLabel(doc.pageSetup),
      })
      imported.push({ recordId, name, kind, bindings, warnings })
    }

    return { templates: imported, errors }
  }

  // ---------------- 内部 ----------------

  private async findRowOrNull(recordId: string): Promise<TemplateRow | null> {
    const rows = await this.ds.listTemplateRows(await this.tableId())
    return rows.find((r) => r.recordId === recordId) ?? null
  }

  private async findRow(recordId: string): Promise<TemplateRow> {
    const row = await this.findRowOrNull(recordId)
    // F2-39：模板被他人删除后，保存要报"模板已不存在"，由 UI 引导"另存为新模板"
    if (!row) throw new Error('模板已不存在，可能已被删除，请另存为新模板')
    return row
  }

  private async rebind(doc: TemplateDoc, targetTableId: string): Promise<BindingReport> {
    let fields: FieldMeta[] = []
    try {
      fields = await this.ds.listFields(targetTableId)
    } catch {
      // 目标表读不到字段（无权限 / 已删除）→ 全部视为未绑定，比抛错让整个复制失败更合理
      fields = []
    }
    return rebindDoc(doc, fields)
  }

  private async resolveTableName(
    targetTableId: string,
    fallbackName?: string,
  ): Promise<{ name: string; missing: boolean }> {
    try {
      const tables = await this.ds.listTables()
      const hit = tables.find((t) => t.id === targetTableId)
      if (hit) return { name: hit.name, missing: false }
    } catch {
      /* 读不到表列表：按 fallback 处理 */
    }
    // 目标表不在列表里 → 可能已被删除（F6-12）。仍然允许复制，但要让调用方标记出来
    return { name: fallbackName ?? targetTableId, missing: true }
  }

  /** 生成"原名 副本"；已存在则追加序号，避免列表里出现两张一字不差的卡片 */
  private async uniqueCopyName(targetTableId: string, baseName: string): Promise<string> {
    const existing = new Set((await this.listTemplates(targetTableId)).map((t) => t.name))
    const first = `${baseName} 副本`
    if (!existing.has(first)) return first
    for (let i = 2; i < 100; i += 1) {
      const candidate = `${baseName} 副本 ${i}`
      if (!existing.has(candidate)) return candidate
    }
    return `${first} ${Date.now()}`
  }
}

function payloadOf(row: TemplateRow, name: string): TemplateWritePayload {
  return {
    name,
    kind: normalizeKind(row.kind),
    targetTableName: row.targetTableName,
    targetTableId: row.targetTableId,
    docJson: row.docJson,
    paper: row.paper,
  }
}

function toListItem(row: TemplateRow): TemplateListItem {
  const parsed = deserializeDoc(row.docJson)
  const doc = parsed.doc ?? emptyTemplate(normalizeKind(row.kind))
  return {
    recordId: row.recordId,
    name: row.name,
    kind: normalizeKind(row.kind),
    targetTableName: row.targetTableName,
    targetTableId: row.targetTableId,
    doc,
    // 纸张列是"便于列表展示"的冗余字段（F6-01）；缺失时用文档里的页面设置兜底
    paperLabel: row.paper || buildPaperLabel(doc.pageSetup),
    createdBy: row.createdBy,
    updatedAt: row.updatedAt,
    docError: parsed.error,
    rawDocJson: parsed.error ? row.docJson : undefined,
  }
}

// ============================================================
// .bptpl.json 导入导出（F2-40 / F2-41）
// ============================================================

export const PACKAGE_FORMAT = 'bitableprint.template-package'
export const PACKAGE_FORMAT_VERSION = 1

export interface TemplatePackageEntry {
  name: string
  kind: TemplateKind
  targetTableName: string
  targetTableId: string
  paper: string
  doc: TemplateDoc
}

export interface TemplatePackage {
  format: typeof PACKAGE_FORMAT
  formatVersion: number
  /** 导出时间（ISO），仅作信息，不参与校验 */
  exportedAt: string
  appVersion?: string
  templates: TemplatePackageEntry[]
}

/** 导出为 `.bptpl.json`。只含模板定义，**不含任何业务数据**（F6-08 隐私红线 / F2-40） */
export function exportTemplatePackage(
  recs: TemplateListItem | TemplateListItem[],
  opts: { appVersion?: string } = {},
): string {
  const list = Array.isArray(recs) ? recs : [recs]
  const pkg: TemplatePackage = {
    format: PACKAGE_FORMAT,
    formatVersion: PACKAGE_FORMAT_VERSION,
    exportedAt: new Date().toISOString(),
    appVersion: opts.appVersion,
    templates: list.map((r) => ({
      name: r.name,
      kind: r.kind,
      targetTableName: r.targetTableName,
      targetTableId: r.targetTableId,
      paper: r.paperLabel || buildPaperLabel(r.doc.pageSetup),
      doc: r.doc,
    })),
  }
  return JSON.stringify(pkg, null, 2)
}

/** 导入失败：整个文件级别的问题（E-14 / E-15），会直接抛给 UI 走阻断提示 */
export class TemplateImportError extends Error {
  readonly kind: DocParseKind
  constructor(kind: DocParseKind, message: string) {
    super(message)
    this.name = 'TemplateImportError'
    this.kind = kind
  }
}

export interface TemplateImportOptions {
  /** 导入到哪张数据表；传当前表 ID 即等同于"复制到当前数据表"（F6-10），会触发字段重绑 */
  targetTableId?: string
  targetTableName?: string
}

export interface ImportedTemplate {
  recordId: string
  name: string
  kind: TemplateKind
  /** 仅当导入到指定表（或原目标表不同）时才有值 */
  bindings?: BindingReport
  /** 非致命问题：版本迁移、目标表已删除等，UI 可展开提示 */
  warnings: string[]
}

export interface ImportPackageResult {
  templates: ImportedTemplate[]
  /** 单条模板失败的原因；其他条目照常导入，不整体回滚 */
  errors: Array<{ index: number; name?: string; message: string }>
}

/** 从任意 JSON 里取出待导入的条目：兼容整包（.bptpl.json）与单个模板定义两种形态 */
function readPackageEntries(parsed: unknown): { entries: Array<Partial<TemplatePackageEntry>>; single: boolean } {
  if (isPlainObject(parsed) && parsed.format === PACKAGE_FORMAT) {
    const fv = numOr(parsed.formatVersion, 0)
    if (fv > PACKAGE_FORMAT_VERSION) {
      throw new TemplateImportError('tooNew', `模板包由更高版本插件导出（v${fv}），请升级插件`)
    }
    if (!isRecordArray(parsed.templates)) {
      throw new TemplateImportError('invalid', '模板包结构不合法：缺少 templates 数组')
    }
    return { entries: parsed.templates as Array<Partial<TemplatePackageEntry>>, single: false }
  }
  // 兼容"直接导入一个模板 JSON"：用户很可能手滑导出了单模板而不是整包
  if (isPlainObject(parsed) && 'schemaVersion' in parsed) {
    return { entries: [{ doc: parsed as unknown as TemplateDoc }], single: true }
  }
  throw new TemplateImportError('invalid', '模板包结构不合法：既不是模板包也不是模板定义')
}

/**
 * 解析 `.bptpl.json`（不写库，纯解析，便于 UI 先做"导入预览"）。
 * 整个文件不可用 → 抛 TemplateImportError（阻断）；单条模板有问题 → 收进 errors，其余照常导入。
 */
export function parseTemplatePackage(json: string): {
  entries: Array<Partial<TemplatePackageEntry> & { parse: DocParseResult }>
  errors: ImportPackageResult['errors']
} {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    throw new TemplateImportError('corrupt', '模板文件已损坏或被修改，无法解析') // E-14
  }
  const { entries } = readPackageEntries(parsed)
  const out: Array<Partial<TemplatePackageEntry> & { parse: DocParseResult }> = []
  const errors: ImportPackageResult['errors'] = []
  entries.forEach((e, i) => {
    const parse = normalizeDoc(e.doc)
    if (!parse.doc) {
      errors.push({ index: i, name: e.name, message: parse.error ?? '模板结构不合法' })
      return
    }
    out.push({ ...e, parse })
  })
  return { entries: out, errors }
}

// ============================================================
// 便捷工厂
// ============================================================

export function createTemplateStore(ds: DataSource): TemplateStore {
  return new TemplateStore(ds)
}
