/**
 * 数据源抽象层。
 *
 * 为什么要这层抽象（而不是直接调 SDK）：
 * 1) 插件必须在**飞书 iframe 之外**也能完整跑起来，否则渲染/分页/Word 解析这些纯前端逻辑
 *    在本地根本没法调试，每次改一行都要回到飞书里手点。
 * 2) SDK 有一批"文档与实际不符"的行为（getTableById 返回 Promise、getFieldMetaList 无序、
 *    附件 URL 10 分钟过期等），把这些坑集中在一个文件里，其余代码保持干净。
 * 3) M0 探针要探测未公开能力，需要一个统一入口拿到底层 table 对象。
 */

import type { TemplateKind } from './types'

// ============================================================
// 元数据类型
// ============================================================

export interface FieldMeta {
  id: string
  name: string
  /** FieldType 数值（见 field-types.ts 的 FT） */
  type: number
  /** 字段属性（单/多选选项、日期格式、数字精度等），结构随类型而变 */
  property?: unknown
  /** 是否为主字段（索引列） */
  isPrimary?: boolean
}

export interface TableMeta {
  id: string
  name: string
}

export interface ViewMeta {
  id: string
  name: string
  /** 视图类型；不同版本取值可能不同，仅作展示 */
  type?: number
}

export interface RecordItem {
  recordId: string
  /** fieldId → 单元格原始值 */
  fields: Record<string, unknown>
  /**
   * fieldId → **飞书界面上显示的那串文本**（2026-09-24 第四批第 3 条的根本解）。
   *
   * ⚠️ **是旁路，不是替代**：`fields` 里的原始值一个字不动（附件、图片那些还要用它），
   * 渲染时**优先**读这里；这里没有的字段，才回落本地格式化（`renderCellValue`）。
   * 这样"飞书显示什么就打印什么"与"快"两个目标可以同时满足：
   * 只对公式 / 查找引用这类"自己算不准"的字段去取，其余照旧走本地。
   */
  cellStrings?: Record<string, string>
}

export interface TableContext {
  baseName: string
  tableId: string
  tableName: string
  viewId?: string
  viewName?: string
}

// ============================================================
// 拉取记录
// ============================================================

export interface FetchRecordsOptions {
  tableId: string
  /** 传入则按该视图取数（视图自身的筛选/排序生效） */
  viewId?: string
  /**
   * 单页大小。
   * ⚠️ SDK 硬限制：`getRecordsByPage` 的 pageSize **最大 200**，传更大会报错或静默截断。
   * 因此这里默认 200，而不是"越大越快"。
   */
  pageSize?: number
  /** 硬上限保护，默认 20000；到量即停止并标记 truncated */
  maxRecords?: number
  onProgress?: (loaded: number, total: number | null) => void
  signal?: AbortSignal
}

export interface FetchRecordsResult {
  records: RecordItem[]
  /** 未知时为 null */
  total: number | null
  /** 因 maxRecords 或取消而提前终止 */
  truncated: boolean
  /** 中途失败时的错误信息（已加载部分仍可返回） */
  error?: string
  /**
   * 记录顺序是从哪来的（只在传了 viewId 时才有值）：
   *   · `view`    —— SDK 直接给的"视图可见记录顺序"，与界面一致（最准）
   *   · `sort`    —— 读视图排序配置后本地排的（退一步）
   *   · `default` —— 视图没有可读的排序，按表格默认顺序（**UI 必须如实告知用户**，不许静默）
   */
  orderSource?: RecordOrderSource
}

/** 见 FetchRecordsResult.orderSource */
export type RecordOrderSource = 'view' | 'sort' | 'default'

/**
 * 「**字段**顺序」的来源，与 `RecordOrderSource` 对称（2026-09-19）。
 *
 * 为什么字段也要回报来源：`table.getFieldMetaList()` 的顺序**不可信**（SDK 事实），
 * 只有 `view.getFieldMetaList()` 才与界面列序一致。而这套调用在**真机上可能失败** ——
 * 一旦失败就会静默退回表级顺序，于是勾选列表的行标签取错字段
 * （用户原话："原表前四个字段分别是 序号、日期、提交人、登记仓，
 * 但勾选列表中实际显示的是 序号、**是否工厂分析用**，而且顺序也是乱的"）。
 *
 * 记录顺序早就有一条 `orderNote` 如实告知用户；字段顺序当时只打了 `console.warn` ——
 * **控制台不是用户看得见的地方**，所以这里补上对称的那一半。
 */
export type FieldOrderSource = 'view' | 'table'

// ============================================================
// 模板表存储
// ============================================================

/** 模板表内部的字段名常量（建表与读写共用，避免拼错） */
export const TPL_FIELD = {
  name: '模板名',
  kind: '模板类型',
  targetTableName: '目标数据表',
  targetTableId: '目标数据表ID',
  doc: '模板配置',
  paper: '纸张',
  createdBy: '创建人',
  updatedAt: '更新时间',
} as const

export const TEMPLATE_TABLE_NAME = '_打印模板_'

export interface TemplateRow {
  recordId: string
  name: string
  kind: TemplateKind
  targetTableName: string
  targetTableId: string
  docJson: string
  paper: string
  createdBy?: string
  updatedAt?: number
}

export interface TemplateWritePayload {
  name: string
  kind: TemplateKind
  targetTableName: string
  targetTableId: string
  docJson: string
  paper: string
}

// ============================================================
// 数据源接口
// ============================================================

export interface AttachmentTokenRef {
  recordId: string
  fieldId: string
  /** 附件 token 列表 */
  tokens: string[]
}

export interface DataSource {
  readonly kind: 'sdk' | 'mock'

  /**
   * 订阅"用户换了数据表 / 视图"（2026-09-19 用户反馈）。
   *
   * 用户原话："如果在数据表 A 中打开插件，那么插件就**一直绑定死数据表 A** 了。
   * 如果用户切换到数据表 B、勾选了记录、选择读取勾选的记录，那么系统就会提示
   * '已勾选 0 条（2 条不在当前已加载的记录里，已忽略）'。
   * **不会依据用户实际选择的数据进行切换**，这个有办法解决吗？"
   *
   * 根因：`ctx`（tableId / viewId / tableName）只在插件启动时取一次，之后再没更新过。
   * 解决：SDK 的 `base.onSelectionChange` 就是"选中的表/视图/记录变了"的信号 ——
   * 收到就重新取 context 并重载字段与记录。
   *
   * 返回**退订函数**。本方法是**可选**的：mock 数据源没有"活动表"这个概念，
   * 不实现即可（`App` 侧用可选调用）。
   */
  onContextChange?(cb: () => void): () => void

  /** 初始化并握手；失败要抛错，由上层转成 E-03 */
  init(): Promise<void>

  /** 当前表上下文（表名/视图名）。未打开多维表格时应抛错 → E-01 */
  getContext(): Promise<TableContext>

  listTables(): Promise<TableMeta[]>
  listViews(tableId: string): Promise<ViewMeta[]>

  /**
   * 读取字段列表。
   * **必须传入 viewId 才能拿到与界面一致的列顺序** —— table.getFieldMetaList() 返回无序。
   */
  listFields(tableId: string, viewId?: string): Promise<FieldMeta[]>

  /**
   * 上一次 `listFields` **实际用的是哪一级顺序**（`'view'` 视图级 = 与界面一致；
   * `'table'` 表级 = **顺序不可信**）。
   *
   * 为什么不塞进 `listFields` 的返回值：那会把签名连同所有调用方一起改动，
   * 而这份信息只有"要提示用户"的那一处需要。也**不做成必选方法** ——
   * mock 数据源没有"视图列序"这个概念，返回 `null` 就是"不适用"，UI 因此不提示。
   */
  lastFieldOrder?(): FieldOrderSource | null

  fetchRecords(opts: FetchRecordsOptions): Promise<FetchRecordsResult>

  /** 按 recordId 精确读取单条记录（记录模板 + 批量模式用） */
  fetchRecordsByIds(tableId: string, recordIds: string[]): Promise<RecordItem[]>

  /**
   * 读取多维表格中"当前选中/聚焦"的那条记录 id（拿不到返回 null）。
   * 注意：飞书只对"单元格聚焦 / 切换数据表"发事件，**对勾选整行不发**，
   * 所以这里只能拿到"客户端当前所在的那一行"，拿不到"用户勾选了哪几行"。
   *
   * 可选方法：拿不到实现时不报错，UI 静默保持空勾选。
   */
  getActiveRecordId?(): Promise<string | null>

  /**
   * 获取附件临时下载链接。
   * ⚠️ 有效期仅 10 分钟；SDK 内部按 5 个 token 一组自动切片。
   */
  getAttachmentUrls(tableId: string, recordId: string, fieldId: string, tokens: string[]): Promise<string[]>

  /**
   * ⚠️ **飞书自己格式化的「显示文本」** —— 2026-09-24 第四批第 3 条的根本解。
   *
   * 用户原话：「应该是**多维表格里显示什么就打印什么**，如果只修复时间，
   * 那以后其他公式是不是需要重新改」。这个判断是对的：我们自己在 `renderCellValue` 里
   * 按字段类型猜"该怎么显示"，**永远追不上飞书**（公式的结果类型在 API 里根本拿不到，
   * 只能靠值的形状猜，于是每遇到一种新公式就要再补一次）。
   *
   * SDK 的 `table.getCellString(fieldId, recordId)` 返回的就是界面上那串文本 ⇒ 拿它最准。
   *
   * ⚠️ **但它必须逐格异步调用**（没有批量版）⇒ **只对"自己算不准"的字段用**：
   * 公式（`FT.Formula`）、查找引用、自动编号这类；文本/数字/日期/选项/人员/附件
   * 继续走本地格式化（快，而且本来就准）。
   * 可选方法：mock 数据源没有这个概念，不实现即可。
   */
  getCellString?(tableId: string, recordId: string, fieldId: string): Promise<string>

  // ---- 模板表 ----
  /** 找到或创建 _打印模板_ 表，返回 tableId */
  ensureTemplateTable(): Promise<string>
  listTemplateRows(tableId: string): Promise<TemplateRow[]>
  createTemplateRow(tableId: string, payload: TemplateWritePayload): Promise<string>
  updateTemplateRow(tableId: string, recordId: string, payload: TemplateWritePayload): Promise<void>
  deleteTemplateRows(tableId: string, recordIds: string[]): Promise<void>

  /**
   * M0 探针专用：拿到 SDK 的原始 ITable 对象以探测未公开能力。
   * mock 实现返回 null。
   */
  rawTable(tableId: string): Promise<unknown | null>
}

// ============================================================
// 工具：分页拉取的通用骨架（SDK 与 mock 共用同一套翻页/取消/进度逻辑）
// ============================================================

export interface PageFetcher {
  /** 拉取一页；返回 null 表示没有更多数据 */
  (
    pageToken: string | undefined,
    pageSize: number,
  ): Promise<{ records: RecordItem[]; pageToken?: string; hasMore: boolean; total?: number } | null>
}

export async function drainPages(fetcher: PageFetcher, opts: FetchRecordsOptions): Promise<FetchRecordsResult> {
  // SDK 硬限制 pageSize ≤ 200
  const pageSize = Math.min(opts.pageSize ?? 200, 200)
  const maxRecords = opts.maxRecords ?? 20000
  const records: RecordItem[] = []
  let pageToken: string | undefined
  let truncated = false
  let error: string | undefined
  let total: number | null = null

  // 首屏先给一次进度，避免"点了没反应"
  opts.onProgress?.(0, null)

  for (;;) {
    if (opts.signal?.aborted) {
      truncated = true
      break
    }
    let page: Awaited<ReturnType<PageFetcher>>
    try {
      page = await fetcher(pageToken, pageSize)
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
      // 已加载的数据保留可用（对应 E-08：不整体回滚）
      break
    }
    if (!page || page.records.length === 0) break

    if (typeof page.total === 'number') total = page.total
    records.push(...page.records)
    opts.onProgress?.(records.length, total)

    if (records.length >= maxRecords) {
      truncated = true
      break
    }
    if (!page.hasMore || !page.pageToken) break
    pageToken = page.pageToken
  }

  return { records, total, truncated, error }
}
