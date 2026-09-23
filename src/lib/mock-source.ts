/**
 * 本地 Mock 数据源。
 *
 * 用途：让插件在**飞书 iframe 之外**也能完整跑通（开发调试、渲染引擎自测、给非飞书环境演示）。
 * 通过 URL 参数 `?mock=1` 启用，或当 SDK 握手失败时自动降级（可选）。
 *
 * 注意：mock 数据里的字段类型刻意覆盖了全部常见类型（含附件、人员、多选、公式等），
 * 这样字段渲染矩阵可以在一屏内被目视验证。
 */

import { FT } from './field-types'
import { TEMPLATE_TABLE_NAME, TPL_FIELD, drainPages } from './data-source'
import type {
  DataSource,
  FieldMeta,
  FetchRecordsOptions,
  FetchRecordsResult,
  RecordItem,
  TableContext,
  TableMeta,
  TemplateRow,
  TemplateWritePayload,
  ViewMeta,
} from './data-source'
import type { TemplateKind } from './types'
import type { FieldOrderSource } from './data-source'
import { buildSkeleton, skeletonsFor } from './skeletons'

const MOCK_TABLE_ID = 'tbl_mock_main'
const MOCK_TPL_TABLE_ID = 'tbl_mock_tpl'
const MOCK_VIEW_ID = 'viw_mock_grid'

// ============================================================
// 字段定义：覆盖 PRD 附录 A 的主要类型
// ============================================================

export const MOCK_FIELDS: FieldMeta[] = [
  { id: 'fld_no', name: '单据编号', type: FT.AutoNumber, isPrimary: true },
  { id: 'fld_title', name: '产品名称', type: FT.Text },
  { id: 'fld_spec', name: '规格型号', type: FT.Text },
  { id: 'fld_qty', name: '数量', type: FT.Number },
  { id: 'fld_price', name: '单价', type: FT.Currency },
  { id: 'fld_amount', name: '金额', type: FT.Formula },
  { id: 'fld_date', name: '交货日期', type: FT.DateTime },
  { id: 'fld_status', name: '状态', type: FT.SingleSelect },
  { id: 'fld_tags', name: '工艺标签', type: FT.MultiSelect },
  { id: 'fld_owner', name: '负责人', type: FT.User },
  { id: 'fld_done', name: '已验收', type: FT.Checkbox },
  { id: 'fld_rate', name: '质量评分', type: FT.Rating },
  { id: 'fld_prog', name: '生产进度', type: FT.Progress },
  { id: 'fld_phone', name: '联系电话', type: FT.Phone },
  { id: 'fld_mail', name: '联系邮箱', type: FT.Email },
  { id: 'fld_url', name: '资料链接', type: FT.Url },
  { id: 'fld_loc', name: '存放位置', type: FT.Location },
  { id: 'fld_rel', name: '关联订单', type: FT.SingleLink },
  { id: 'fld_photo', name: '产品照片', type: FT.Attachment },
  { id: 'fld_created', name: '创建时间', type: FT.CreatedTime },
]

const STATUS = ['待生产', '生产中', '已完工', '已发货']
const TAGS = ['灌装', '包装', '灭菌', '质检']
const OWNERS = ['张大帅', '李敏', '王强', '赵磊']

/** 生成 N 条确定性 mock 记录（同样的 N 得到同样的数据，便于回归测试） */
export function buildMockRecords(n: number): RecordItem[] {
  const out: RecordItem[] = []
  // 固定基准时间，避免每次运行数据都变
  const base = Date.UTC(2026, 0, 5, 9, 0, 0)
  for (let i = 0; i < n; i++) {
    const i1 = i + 1
    const qty = ((i * 7) % 40) + 3
    const price = 12.5 + ((i * 13) % 90)
    out.push({
      recordId: `rec_mock_${String(i1).padStart(3, '0')}`,
      fields: {
        fld_no: i1,
        // ⚠️ 第 51 条（i === 50）**刻意让「视图第 2 列」为空**。
        //
        // 为什么必须动 mock：需求③ 里有半句是"空值要显式显示成「—」"，
        // 而这一条**只有在数据里真的存在空格子时才能被 DOM 层断言压到** ——
        // 之前的实测是：把 `return text || EMPTY_CELL` 改成 `return text`（等于把空值占位整个去掉），
        // range-picker 73 条**全绿**，而 DOM 里那一行已经变成 `{"main":"51","sub":""}`。
        // 纯函数层的单测守住了 `displayCellText` 本身，却守不住"DOM 有没有用它"。
        //
        // 为什么选第 51 条而不是第 5 条：`buildMockRecords(6)` / `(5)` 被 lib 与 render 的
        // 自测用来数**精确条数**（如「文本 contains 薇诺娜」= 6、「endsWith 50g」= 2），
        // 动前 6 条会连带改掉那些与本次无关的读数。第 51 条在后面，谁都数不到它。
        fld_title: i === 50 ? '' : `薇诺娜舒敏保湿特护霜 ${50 + (i % 5) * 10}g`,
        fld_spec: `${['BTN-A', 'BTN-B', 'BTN-C'][i % 3]}-${1000 + i}`,
        fld_qty: qty,
        fld_price: Math.round(price * 100) / 100,
        fld_amount: Math.round(qty * price * 100) / 100,
        fld_date: base + i * 86400000 * 2,
        fld_status: { id: `opt_st_${i % 4}`, text: STATUS[i % 4] },
        fld_tags:
          i % 3 === 0
            ? [
                { id: 'opt_tg_0', text: TAGS[0] },
                { id: 'opt_tg_2', text: TAGS[2] },
              ]
            : [{ id: `opt_tg_${i % 4}`, text: TAGS[i % 4] }],
        fld_owner: { id: `ou_${i % 4}`, name: OWNERS[i % 4] },
        fld_done: i % 3 === 0,
        fld_rate: (i % 5) + 1,
        fld_prog: (i % 10) / 10,
        fld_phone: `138${String(10000000 + i * 137).slice(0, 8)}`,
        fld_mail: `user${i % 5}@btn.com`,
        fld_url: { text: '规格文件', link: `https://example.com/spec/${i1}` },
        fld_loc: `A区-${(i % 6) + 1}排-${(i % 8) + 1}号架`,
        fld_rel: { text: `订单 SO-2026-${String(i1).padStart(4, '0')}` },
        // 附件：用内联 SVG data URL 模拟图片，避免依赖网络
        //
        // ⚠️ 第 51 条（i === 50）**刻意给空数组**，和上面的 `fld_title` 同一个理由，
        // 但目标不同：③ 那三条 DOM 断言（B15/B16/B17）要观测的是"**视图第 2 列**是空格子"。
        // 只把 `fld_title` 留空的话，"第 2 列"到底是不是它，取决于 mock 的字段顺序 ——
        // 一旦把附件列挪到第 2 位（这正是 ⑧ 的变异 M1），副格就不再是空的那一列，
        // 那三条会**假红**（实测：`_r4-8-m1-oldb4.txt` 里 B15/B16/B17 一起红）。
        // 顺手把这一条的附件也给空，于是**无论第 2 列是这两列中的哪一列**，
        // 第 51 条都是"第 2 列没有值"的那一条 —— 断言测的就回到产品行为上了。
        fld_photo: i === 50
          ? []
          : [1, 2].slice(0, (i % 3) + 1).map((k) => ({
              name: `photo_${i1}_${k}.png`,
              size: 40_000 + i * 100,
              type: 'image/png',
              token: `mocktok_${i1}_${k}`,
              timeStamp: base,
            })),
        fld_created: base - 86400000 * 10,
      },
    })
  }
  return out
}

/** 生成一张确定性的占位图（SVG data URL），供 mock 图片渲染使用 */
export function mockImageDataUrl(token: string, label: string, w = 320, h = 240): string {
  // 用 token 派生一个稳定的色相，让不同图片看起来不同
  let hash = 0
  for (let i = 0; i < token.length; i++) hash = (hash * 31 + token.charCodeAt(i)) % 360
  const hue = hash
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
<rect width="${w}" height="${h}" fill="hsl(${hue},42%,86%)"/>
<rect x="8" y="8" width="${w - 16}" height="${h - 16}" fill="none" stroke="hsl(${hue},45%,58%)" stroke-width="1.5" stroke-dasharray="6 4"/>
<circle cx="${w / 2}" cy="${h / 2 - 14}" r="26" fill="hsl(${hue},45%,68%)"/>
<text x="${w / 2}" y="${h / 2 + 36}" text-anchor="middle" font-family="sans-serif" font-size="15" fill="#333">${escapeXml(label)}</text>
</svg>`
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
}

function escapeXml(s: string): string {
  return s.replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c] as string)
}

// ============================================================
// MockDataSource
// ============================================================

export class MockDataSource implements DataSource {
  readonly kind = 'mock' as const

  private records: RecordItem[]
  /** 模板表的内存存储（模拟 _打印模板_ 表） */
  private tplRows: Array<TemplateRow & { _seq: number }> = []
  private tplSeq = 0

  constructor(recordCount = 60) {
    this.records = buildMockRecords(recordCount)
    this.seedTemplates(seedTemplateCount())
  }

  /**
   * 预置几个模板（只在 URL 带 `?tpl=N` 时）。
   *
   * 文档用**真实骨架**（`skeletonsFor` + `buildSkeleton`）而不是手搓 JSON ——
   * mock 里的模板必须是"能过校验、能预览"的，否则测出来的就是假象。
   * 最后一条刻意写成坏 JSON：`配置异常` 角标与它的卡片高度差也要能被看到。
   */
  private seedTemplates(count: number): void {
    for (let i = 0; i < count; i += 1) {
      this.tplSeq += 1
      const kind: TemplateKind = i % 3 === 2 ? 'view' : 'record'
      const skel = skeletonsFor(kind)[0]
      const broken = i === count - 1 && count >= 3
      this.tplRows.push({
        _seq: this.tplSeq,
        recordId: `rec_tpl_${String(this.tplSeq).padStart(3, '0')}`,
        name: SEED_NAMES[i % SEED_NAMES.length] ?? `模板 ${this.tplSeq}`,
        kind,
        targetTableName: '产品清单',
        targetTableId: MOCK_TABLE_ID,
        docJson: broken
          ? '{ 这不是合法 JSON'
          : JSON.stringify(skel ? buildSkeleton(skel.key, MOCK_FIELDS, kind) : {}),
        // 留空 ⇒ 走 `buildPaperLabel(doc.pageSetup)`，与真机同一条路径
        paper: '',
        createdBy: '本地开发者',
        updatedAt: Date.now() - i * 7 * 3600_000,
      })
    }
  }

  async init(): Promise<void> {
    /* mock 无需握手 */
  }

  async getContext(): Promise<TableContext> {
    return {
      baseName: '（本地 Mock）生产管理',
      tableId: MOCK_TABLE_ID,
      tableName: '产品清单',
      viewId: MOCK_VIEW_ID,
      viewName: '全部产品',
    }
  }

  async listTables(): Promise<TableMeta[]> {
    return [
      { id: MOCK_TABLE_ID, name: '产品清单' },
      { id: MOCK_TPL_TABLE_ID, name: TEMPLATE_TABLE_NAME },
    ]
  }

  async listViews(): Promise<ViewMeta[]> {
    return [{ id: MOCK_VIEW_ID, name: '全部产品' }]
  }

  async listFields(): Promise<FieldMeta[]> {
    return MOCK_FIELDS.map((f) => ({ ...f }))
  }

  /**
   * mock 没有"视图列序"这个概念 ⇒ 默认 `null`（不适用，UI 不提示）。
   * 带 `?fieldOrder=table` 时假装降级，用来在本地复现"行标签可能取错字段"那条提示。
   */
  lastFieldOrder(): FieldOrderSource | null {
    return fakeFieldOrderDegraded() ? 'table' : null
  }

  async fetchRecords(opts: FetchRecordsOptions): Promise<FetchRecordsResult> {
    void opts.tableId
    void opts.viewId
    const pageSize = opts.pageSize ?? 500
    let cursor = 0
    // 走真实的 drainPages 骨架，保证与 SDK 实现共享同一套翻页/取消逻辑
    return drainPages(async (_token, size) => {
      if (cursor >= this.records.length) return null
      const slice = this.records.slice(cursor, cursor + size)
      cursor += size
      // 模拟网络延迟，让进度反馈有东西可显示
      await delay(includeDelay() ? 120 : 0)
      return { records: slice, hasMore: cursor < this.records.length, pageToken: String(cursor) }
    }, { ...opts, pageSize })
  }

  async fetchRecordsByIds(tableId: string, recordIds: string[]): Promise<RecordItem[]> {
    void tableId
    const set = new Set(recordIds)
    return this.records.filter((r) => set.has(r.recordId))
  }

  /**
   * 读取"当前选中记录"。
   *
   * ⚠️ **这是为了可测**：本地 mock 没有"光标"这个概念，飞书里这个值由
   * `base.getSelection().recordId` 决定。这里固定返回**第 3 条**记录，
   * 保证 mock 模式与 e2e 冒烟能走通"自动带入当前记录 → 预勾选 → 直接预览"的完整新增流程。
   * （确定性：同样的记录集每次运行结果一致，不会让回归测试随机飘。）
   */
  async getActiveRecordId(): Promise<string | null> {
    return this.records[2]?.recordId ?? null
  }

  async getAttachmentUrls(_tableId: string, recordId: string, fieldId: string, tokens: string[]): Promise<string[]> {
    void _tableId
    void fieldId
    return tokens.map((t) => mockImageDataUrl(t, `${recordId}\n${t}`))
  }

  // ---- 模板表 ----

  async ensureTemplateTable(): Promise<string> {
    return MOCK_TPL_TABLE_ID
  }

  async listTemplateRows(tableId: string): Promise<TemplateRow[]> {
    void tableId
    return this.tplRows.map(({ _seq, ...r }) => ({ ...r }))
  }

  async createTemplateRow(tableId: string, payload: TemplateWritePayload): Promise<string> {
    void tableId
    this.tplSeq += 1
    const recordId = `rec_tpl_${String(this.tplSeq).padStart(3, '0')}`
    this.tplRows.push({
      _seq: this.tplSeq,
      recordId,
      name: payload.name,
      kind: payload.kind as TemplateKind,
      targetTableName: payload.targetTableName,
      targetTableId: payload.targetTableId,
      docJson: payload.docJson,
      paper: payload.paper,
      createdBy: '本地开发者',
      updatedAt: Date.now(),
    })
    return recordId
  }

  async updateTemplateRow(tableId: string, recordId: string, payload: TemplateWritePayload): Promise<void> {
    void tableId
    const row = this.tplRows.find((r) => r.recordId === recordId)
    if (!row) throw new Error(`模板不存在：${recordId}`)
    Object.assign(row, {
      name: payload.name,
      kind: payload.kind,
      targetTableName: payload.targetTableName,
      targetTableId: payload.targetTableId,
      docJson: payload.docJson,
      paper: payload.paper,
      updatedAt: Date.now(),
    })
  }

  async deleteTemplateRows(tableId: string, recordIds: string[]): Promise<void> {
    void tableId
    const set = new Set(recordIds)
    this.tplRows = this.tplRows.filter((r) => !set.has(r.recordId))
  }

  async rawTable(): Promise<unknown | null> {
    return null
  }
}

// ============================================================

function delay(ms: number): Promise<void> {
  return ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve()
}

function includeDelay(): boolean {
  if (typeof location === 'undefined') return false
  return new URLSearchParams(location.search).get('slow') === '1'
}

/** 判断是否应该使用 mock：URL 带 ?mock=1 */
export function shouldUseMock(): boolean {
  if (typeof location === 'undefined') return false
  return new URLSearchParams(location.search).get('mock') === '1'
}

/**
 * 让 mock **假装**"视图级字段序读不到"（`?mock=1&fieldOrder=table`）。
 *
 * 为什么需要：`lastFieldOrder()` 返回 `'table'` 时界面要弹一句
 * "列表里的行标签可能不是你在表格里看到的前两列" —— 那条提示**只在真机上、
 * 且 SDK 恰好降级时才出现**，本地根本复现不了，于是"改完有没有生效"只能靠想象。
 * 这个开关把它变成可复现的（与 `?tpl=N` 同一类测试装置）。
 *
 * 默认返回 `null` = "不适用"：mock 数据源**没有视图**这个概念，
 * 说它"字段序不可信"是**假警报**，会平白吓到本地开发者。
 */
function fakeFieldOrderDegraded(): boolean {
  if (typeof location === 'undefined') return false
  return new URLSearchParams(location.search).get('fieldOrder') === 'table'
}

// ============================================================
// 可选：起步就带几个模板（`?mock=1&tpl=4`）
// ============================================================

/**
 * 让 mock 数据源**起步就带 N 个模板**。
 *
 * 为什么要有这个开关：mock 默认一个模板都没有 ⇒ 「模板列表」那一屏
 * （卡片一排几个、多高、角标清不清楚）在本地与 e2e 里**从来渲染不到**，
 * 于是这类纯视觉问题只能靠真机截图才发现，改完也没法自己复核。
 * 加上它之后，几何探针能把模板列表真正跑起来。
 *
 * 默认（不带 `tpl`）仍然是 **0 个模板**，既有断言与"空态"分支都不受影响。
 * 名字刻意长短不一、两种类型混排、时间各不相同 —— 卡片布局的边界要靠这些才压得出来。
 */
function seedTemplateCount(): number {
  if (typeof location === 'undefined') return 0
  const raw = new URLSearchParams(location.search).get('tpl')
  const n = Number(raw)
  return Number.isInteger(n) && n > 0 && n <= 20 ? n : 0
}

/** 种子模板名：第 2 条故意很长（卡片名会换行），其余短，用来压两列布局的边界 */
const SEED_NAMES = [
  '入库单',
  '产品验收记录表（含抽检结果与附件）',
  '领料单',
  '设备日常巡检记录',
  '员工工牌',
  '出库复核单',
]

// ⛔ 这里原来有 `MOCK_IDS`（把 mock 的几个 id 聚成一个对象，方便测试引用）。
//    2026-09-21 清死导出时删掉：没有任何地方引用它。
//    ⚠️ 测试若要用这些 id，直接引上面的 `MOCK_TABLE_ID` / `MOCK_TPL_TABLE_ID` / `MOCK_VIEW_ID`
//    这三个常量即可（它们都还在、也都在用）—— 不要再加一层聚合，那只会多一个"看起来是 API
//    其实没人用"的导出。
