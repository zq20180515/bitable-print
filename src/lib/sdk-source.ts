/**
 * 飞书多维表格 SDK 适配层。
 *
 * 为什么所有 SDK 调用都集中在这里：
 * 1) SDK 有一批"类型定义与运行时不一致"的行为（下面每处都标了 ⚠️）。
 *    把这批坑锁在一个文件里，其余代码可以用干净的领域模型工作。
 * 2) 插件必须在飞书 iframe 之外也能跑（mock 模式），所以 SDK 用**动态 import** 加载，
 *    避免非飞书环境在模块初始化阶段就抛错。
 *
 * ⚠️ 已确认的 SDK 事实（写代码前请勿凭直觉改）：
 * - `getTableById()` 类型定义看着像同步，实际返回 `Promise<ITable>`，必须 await。
 * - `table.getFieldMetaList()` **返回无序**。要拿到与界面一致的列顺序，必须走 `view.getFieldMetaList()`。
 * - `getRecordsByPage` 的 `pageSize` **最大 200**，不是"越大越好"。
 * - `getRecordsByIds` 单次上限 **1000** 条。
 * - `getCellAttachmentUrls` 返回的链接 **10 分钟过期**，且 SDK 内部已按 5 个 token 一组切片。
 * - 单选写值：`table.setRecords/addRecords` 的值类型是 `IOpenCellValue`，单选那一支是
 *   **`{ id, text }` 对象**，**裸字符串会被静默丢弃**（不报错、单元格空白）。
 *   ⇒ 模板表的单选列一律走 `selectCell()`：先备好选项、再写 `{id, text}`。
 *   （旧的规避方式是"模板表全用文本字段"，但用户手动把列改成了单选，文本写值就全丢了 ——
 *    用户原话："有部分模板的类型不在了…因为后续新增的模板没有写入类型"。见 selectCell。）
 * - `base.addTable({name, fields})` 虽然类型要求 `fields`，但**实际不支持配置字段**；
 *   且新建的表**自带一个空白文本列**，需要"征用"它而不是删了重建。
 * - `table.getFieldById(fieldId)` 拿到的字段对象上才有 `getOptions/addOption`（**table 本身没有**）。
 */

import type {
  DataSource,
  FieldMeta,
  FieldOrderSource,
  FetchRecordsOptions,
  FetchRecordsResult,
  RecordItem,
  RecordOrderSource,
  TableContext,
  TableMeta,
  TemplateRow,
  TemplateWritePayload,
  ViewMeta,
} from './data-source'
import { TEMPLATE_TABLE_NAME, TPL_FIELD, drainPages } from './data-source'
import { FT, renderCellValue } from './field-types'
import type { TemplateKind } from './types'

/** 插件未运行在飞书环境 / 未打开多维表格时的专用错误，用于上层映射成 E-01、E-03 */
export class NotInFeishuError extends Error {
  constructor(message = '当前不在飞书多维表格环境中') {
    super(message)
    this.name = 'NotInFeishuError'
  }
}

/** SDK 调用失败的统一包装，带上原始信息便于反馈 */
export class SdkCallError extends Error {
  readonly scope: string
  constructor(scope: string, cause: unknown) {
    const raw = cause instanceof Error ? cause.message : String(cause)
    super(`${scope} 失败：${raw}`)
    this.name = 'SdkCallError'
    this.scope = scope
  }
}

/** 「模板类型」这一列的**选项文案**。
 *
 * 为什么要单独抽出来（而不是在写值处直接写中文字面量）：写入时用的选项名必须与
 * **读取时的判据**逐字一致，否则会出现"写的是「记录模板」、读的是「记录模板 」"这种
 * 差一个空格就永远判错的问题。写和读共用这一份。
 */
const KIND_TEXT: Record<TemplateKind, string> = { record: '记录模板', view: '视图模板' }

/**
 * 「更新时间」列的日期格式：**精确到分**（用户要求）。
 *
 * 取值来自 SDK 的 `DateFormatter.DATE_TIME_WITH_HYPHEN = "yyyy-MM-dd HH:mm"` ——
 * `DateFormatter` 里**没有**更细的分钟级以外的中间档，这个就是"到分"的那一档
 * （其余是纯日期 / 纯月日 / 月日年 等）。
 */
const UPDATED_AT_FORMAT = 'yyyy-MM-dd HH:mm'

/** 模板表字段规格：`options` 只对单选有意义（空数组 = 选项随写入按需补，见 selectCell） */
interface TplFieldSpec {
  name: string
  type: number
  /** 单选字段的预置选项；空数组表示"选项随写入按需补" */
  options?: string[]
  /** 其余类型的字段属性（如日期列的 `dateFormat`）。与 `options` 合并后一起传给 addField */
  property?: Record<string, unknown>
}

/**
 * 模板表需要哪些字段。
 *
 * ⚠️ 2026-09-20（本日第二批）：`模板类型` / `纸张` / `目标数据表*` 改成**单选**，
 *    `更新时间` 改成**日期**（用户要求，同时也各修一个真 bug）。
 *
 * 背景：这张表一直被人**手动改列类型**（用户原话："我原先认为全是文本字段不好看，
 * 就将模板类型改为了单选字段"），而代码这边只会写文本 —— 单选列的文本写值会被**静默丢弃**，
 * 于是新模板的类型一列全是空的，插件读回来只能当"视图模板"，
 * 用户看到的就是"**记录类型的表不在了**"。
 *
 * ⇒ 现在主动建成"该有的类型"，并按各自类型对应的**正式形态**写值（见 `selectCell` / `toFields`）。
 *   规则只有一条：**值怎么写由列的**真实类型**决定**（用户会随时手改这张表）。
 *   · `模板类型` 的选项是封闭的（就两种），建列时一次备好；
 *   · `纸张` / `目标数据表` / `目标数据表ID` 的选项是"用过的取值"（枚举不完），
 *     ⇒ 建成不带选项的单选，写值时按需补一个上去。这反而比文本列更好用：可以直接筛。
 *   · `创建人` 用飞书**自带的「创建人」字段**（1003）：它由飞书自己填、且**不可写**。
 *     这正是这一列该有的语义 —— 插件不必（也不该）去猜是谁建的。读出来是 `[{id, name}]`。
 *   · `更新时间` 是**日期列**（精确到分），写**毫秒数**；列表按它倒序。
 */
const TPL_FIELDS: TplFieldSpec[] = [
  { name: TPL_FIELD.name, type: FT.Text },
  { name: TPL_FIELD.kind, type: FT.SingleSelect, options: [KIND_TEXT.record, KIND_TEXT.view] },
  { name: TPL_FIELD.targetTableName, type: FT.SingleSelect, options: [] },
  { name: TPL_FIELD.targetTableId, type: FT.SingleSelect, options: [] },
  { name: TPL_FIELD.doc, type: FT.Text },
  { name: TPL_FIELD.paper, type: FT.SingleSelect, options: [] },
  { name: TPL_FIELD.createdBy, type: FT.CreatedUser },
  { name: TPL_FIELD.updatedAt, type: FT.DateTime, property: { dateFormat: UPDATED_AT_FORMAT } },
]

/** 模板表里一个字段的落点：id 用于写值，type 决定"这个值该怎么写 / 怎么读" */
interface TplField {
  id: string
  type: number
}

/** 默认空白列的候选名（新建表自带的那一列） */
const DEFAULT_COLUMN_NAMES = [
  '文本',
  '多行文本',
  '空白',
  'Text',
  'Column 1',
  'Column 0',
  '字段 1',
]

export interface SdkRefs {
  bitable: any
}

/**
 * 「当前停留记录」的来源诊断。
 *
 * 为什么需要它：目前只有**事件载荷里有 recordId** 是被实测证实的；
 * `getSelection()` 能不能读到 recordId **从未被证实**（早先 P2 那次返回 null，但当时确实没选中行，
 * 也不能反证）。所以必须让下一次真机实测能一眼看出"这条记录到底是从哪条路来的"。
 */
export interface SelectionDiag {
  source: 'event' | 'getSelection' | 'none'
  recordId: string | null
  /** 解析时读到的当前活动表 id（拿不到为 null） */
  tableId: string | null
}

/** 最近一次构造的 SDK 数据源（插件生命周期内只有一个实例） */
let lastSdkSource: SdkDataSource | null = null

/**
 * 探针面板专用：主动跑一次解析，回报"记录 id 是从哪条路来的"。
 *
 * 为什么走模块级函数而不是让面板自己 new 一个：探针面板只拿到 `base`（ProbeEnv），
 * 不持有 DataSource 实例；而诊断这件事不该逼着 App 的接线多出一个字段。
 */
export async function probeSelectionSource(): Promise<SelectionDiag> {
  if (!lastSdkSource) return { source: 'none', recordId: null, tableId: null }
  return lastSdkSource.describeSelectionSource()
}

export class SdkDataSource implements DataSource {
  readonly kind = 'sdk' as const

  private sdk: SdkRefs | null = null

  /**
   * 可选的 SDK 引用注入（**测试用**，不传就照旧走 `init()` 里的 `import(...)`）。
   *
   * 为什么必须留这个缝：`orderRecordsByView` 本身有 12 条单测，但那些测的是**纯函数**；
   * 而"`fetchRecords` 到底有没有在拿完记录之后调它"（= `this.orderByView(...)` 那一行）
   * 在 Node 侧**一条断言都盖不到** —— 实测：把那一行删掉，916 项照样全绿。
   * 本机没有飞书宿主、`?mock=1` 又不经过这条链路，所以"接线"只能靠注入假宿主来观测。
   * 手法与 `render/pipeline.ts` 的 `measureHost` 注入一致：**依赖从参数进来，测试可替换**。
   */
  constructor(injected?: SdkRefs) {
    if (injected) this.sdk = injected
  }
  /** 缓存：表名 → tableId，避免每次都打 getTableMetaList（内部对每张表都要发一次请求，慢） */
  private tableNameCache = new Map<string, string>()
  /** 缓存模板表的字段名 → {id, type}。type 是必需的：同一个值在文本列和单选列里写法不同 */
  private tplFieldCache: Map<string, TplField> | null = null
  /** 缓存单选字段的「选项名 → 选项 id」。我们自己维护这份选项表，所以缓存不会过期 */
  private optCache = new Map<string, Map<string, string>>()
  /** 当前用户 id（open_id）；`undefined` = 还没问过，`null` = 问过但拿不到（别反复问） */
  private userId: string | null | undefined = undefined

  /**
   * 最近一次 `onSelectionChange` 载荷里的选中态。
   *
   * 为什么把事件缓存当**首选**来源：`{ data: { tableId, viewId, recordId, fieldId, baseId } }`
   * 这种载荷里**确实有 recordId**（用户实测），而 `base.getSelection()` 能不能读到 recordId
   * 至今没有被证实过。若只依赖 getSelection，插件可能在"信息明明有"的情况下一直返回 null，
   * 用户就会一直看到"没读到你在多维表格里停留的那条记录"。
   */
  private selCache: { tableId?: string; viewId?: string; recordId?: string; fieldId?: string } | null = null

  // ============================================================
  // 初始化
  // ============================================================

  async init(): Promise<void> {
    if (!this.sdk) {
      try {
        const mod = await import('@lark-base-open/js-sdk')
        this.sdk = { bitable: (mod as any).bitable }
      } catch (e) {
        throw new NotInFeishuError(`加载飞书 SDK 失败：${e instanceof Error ? e.message : String(e)}`)
      }
    }
    if (!this.sdk?.bitable) {
      throw new NotInFeishuError()
    }
    // 握手：拿不到当前表就说明不在多维表格上下文里（对应 E-01 / E-03）
    try {
      await this.sdk.bitable.base.getActiveTable()
    } catch (e) {
      throw new NotInFeishuError(
        `与飞书通信失败，请关闭插件后重新打开。${e instanceof Error ? `（${e.message}）` : ''}`,
      )
    }

    // 订阅选中变化，缓存最近一次载荷（见 selCache 的注释：事件是唯一被证实的来源）。
    // 只订阅一次、**不取消** —— 取消会让 getActiveRecordId() 永久失去首选来源。
    // 订阅失败不阻断初始化：取值会退回到 getSelection。
    try {
      if (typeof this.base?.onSelectionChange === 'function') {
        this.base.onSelectionChange((ev: any) => {
          // 载荷形状实测是 { data: { ... } }，但也见过扁平形态，两种都认
          const d = ev?.data ?? ev
          if (!d || typeof d !== 'object') return
          this.selCache = {
            tableId: asId(d.tableId),
            viewId: asId(d.viewId),
            // recordId 为空表示"取消了选中"，要一并清掉，否则会一直回放上一条旧记录
            recordId: asId(d.recordId),
            fieldId: asId(d.fieldId),
          }
          /**
           * ⚠️ **同一事件还要通知上层去重载**（2026-09-19 用户反馈后补）。
           *
           * 原来这里写完 `selCache` 就结束了 —— 于是插件**永远绑死在打开时的那张表**：
           * 用户切到表 B、勾了记录、点"读取左表勾选"，只会拿到
           * "已勾选 0 条（N 条不在当前已加载的记录里，已忽略）"。
           * 用户原话："**不会依据用户实际选择的数据进行切换**，这个有办法解决吗？"
           *
           * 复用**这一个**订阅（而不是再订阅一次）：`onSelectionChange` 只该有一份监听 ——
           * 两处各订一次的话，将来"取消订阅"的语义会变得没法推理。
           */
          for (const cb of this.ctxListeners) {
            try {
              cb()
            } catch (err) {
              console.warn('[BitablePrint] 数据表变化回调抛错（不影响选中缓存）：', err)
            }
          }
        })
      }
    } catch (e) {
      console.warn('[BitablePrint] 订阅选中变化失败，将退回 getSelection 取值：', e)
    }

    lastSdkSource = this
  }

  private get base(): any {
    if (!this.sdk) throw new NotInFeishuError()
    return this.sdk.bitable.base
  }

  private async table(tableId: string): Promise<any> {
    try {
      return await this.base.getTableById(tableId)
    } catch (e) {
      throw new SdkCallError('获取数据表', e)
    }
  }

  // ============================================================
  // 上下文
  // ============================================================

  async getContext(): Promise<TableContext> {
    try {
      const table = await this.base.getActiveTable()
      const tableId: string = table.id ?? (await table.getMeta()).id
      const tableName: string = await table.getName()

      let viewId: string | undefined
      let viewName: string | undefined
      try {
        const view = await this.base.getActiveView()
        viewId = view?.id
        viewName = await view.getName()
      } catch {
        // 某些容器（如详情插件）没有"当前视图"概念，忽略即可
      }

      /**
       * ⚠️ **`getActiveView()` 失败时必须改问 `getSelection()`**（2026-09-19 真机定位）。
       *
       * 这条兜底**本来只写在 `App.tsx` 的 `getProbeEnv` 里**（注释原话：
       * "某些容器里 `getActiveView()` 会失败…但 `base.getSelection()` 是能拿到 viewId 的（P2 已验证）"），
       * 而**数据源这条主路没有**。后果是真机上整个插件悄悄降级，而且降得很安静：
       *   · `listFields(tableId, undefined)` 直接跳过视图分支 ⇒ 字段顺序退回**表级（无序）**
       *     ⇒ 勾选列表的行标签取错字段（用户截图里是"组装/团购 / — / 6958717869776"，
       *        而他表里前两列明明是 序号、日期）；
       *   · `fetchRecords({ viewId: undefined })` 跳过视图重排 ⇒ 记录按**页序**列出；
       *     更糟的是**「视图筛选」会静默变成「整表」**（不传 viewId 就不带视图筛选）。
       * 两件事合起来就是用户反复报的"**顺序还是不对**"。
       *
       * 而探针 P5/P8 当年是 `ok` 的 —— 因为探针走的是 `getProbeEnv` 那条**有兜底**的路。
       * 同一条知识放在两处、只用了一处，于是"探针说没问题、插件里全是问题"。
       * ⇒ 兜底收进 `getContext()`（"当前上下文"的唯一定义处），两个消费者一起受益。
       */
      if (!viewId) {
        try {
          const sel: any = await this.base.getSelection?.()
          const id = asId(sel?.viewId) ?? asId(sel?.data?.viewId)
          if (id) {
            viewId = id
            // 名字尽力补一个；拿不到就留空（名字只用于展示，不该再拖垮这次调用）
            try {
              const views = await table.getViewList()
              viewName = (views ?? []).find((v: any) => v.id === id)?.name ?? undefined
            } catch {
              /* 留空即可 */
            }
          }
        } catch {
          /* 连 selection 都拿不到：下游会如实回报 default / table，界面上会说出来 */
        }
      }

      let baseName = ''
      try {
        // Base 名称并非所有容器都暴露，拿不到就留空，不要因此中断初始化
        const t = this.base.getActiveTable
        void t
        baseName = ''
      } catch {
        baseName = ''
      }

      return { baseName, tableId, tableName, viewId, viewName }
    } catch (e) {
      if (e instanceof NotInFeishuError) throw e
      throw new SdkCallError('读取当前表上下文', e)
    }
  }

  // ============================================================
  // 表与视图
  // ============================================================

  async listTables(): Promise<TableMeta[]> {
    try {
      const metas = await this.base.getTableMetaList()
      const out: TableMeta[] = (metas ?? []).map((m: any) => ({ id: m.id, name: m.name }))
      this.tableNameCache = new Map(out.map((t) => [t.name, t.id]))
      return out
    } catch (e) {
      throw new SdkCallError('读取数据表列表', e)
    }
  }

  async listViews(tableId: string): Promise<ViewMeta[]> {
    try {
      const table = await this.table(tableId)
      const views = await table.getViewList()
      const out: ViewMeta[] = []
      for (const v of views ?? []) {
        let name = v.id
        try {
          name = await v.getName()
        } catch {
          /* 拿不到名字就退回 id，不中断 */
        }
        out.push({ id: v.id, name })
      }
      return out
    } catch (e) {
      throw new SdkCallError('读取视图列表', e)
    }
  }

  /**
   * 取某个视图对象（`getViewList()` 的成员，带 getFieldMetaList / getVisibleRecordIdList 等）。
   * 拿不到返回 null，**不抛错** —— 调用方据此降级。
   */
  private async viewOf(table: any, viewId: string): Promise<any | null> {
    try {
      const views = await table.getViewList()
      return (views ?? []).find((v: any) => v.id === viewId) ?? null
    } catch {
      return null
    }
  }

  /**
   * ⚠️ 关键：传入 viewId 时用 `view.getFieldMetaList()`，这样字段顺序与界面列序一致。
   * 直接用 `table.getFieldMetaList()` 拿到的顺序是不可信的。
   */

  /**
   * 订阅"用户换了数据表 / 视图"（见 `DataSource.onContextChange` 的长注释）。
   *
   * 它和上面的 `selCache` 共用**同一个** SDK 事件 —— 事件里那个 for 循环就是触发点。
   */
  private readonly ctxListeners = new Set<() => void>()

  onContextChange(cb: () => void): () => void {
    this.ctxListeners.add(cb)
    return () => {
      this.ctxListeners.delete(cb)
    }
  }

  /**
   * 上一次 `listFields` 实际用的顺序来源。`null` = 还没读过。
   *
   * 为什么要存下来而不是返回：见 `DataSource.lastFieldOrder` 的注释。
   * 判据只有一个地方定义：**能不能拿到视图对象并成功调用 `view.getFieldMetaList()`**。
   */
  private fieldOrder: FieldOrderSource | null = null

  lastFieldOrder(): FieldOrderSource | null {
    return this.fieldOrder
  }

  async listFields(tableId: string, viewId?: string): Promise<FieldMeta[]> {
    try {
      const table = await this.table(tableId)

      if (viewId) {
        const view = await this.viewOf(table, viewId)
        if (view) {
          try {
            const metas = await view.getFieldMetaList()
            this.fieldOrder = 'view'
            return normalizeFieldMetas(metas)
          } catch (e) {
            /**
             * ⚠️ 降级**不许再静默**（2026-09-18 真机反馈）。
             *
             * 走到这里意味着"视图级字段序"读不到，只能退回 `table.getFieldMetaList()` ——
             * 而**表级顺序是无序的**（本文件头部已写死这条 SDK 事实）。
             * 后果非常具体：勾选列表的行标签取"视图前两个字段"（`label-fields.ts`），
             * 表级无序 ⇒ 取到的可能是"是否工厂分析用"而不是"日期/提交人"。
             * 用户原话："原表前四个字段分别是 序号、日期、提交人、登记仓，
             * 但勾选列表中实际显示的是 序号、是否工厂分析用，而且顺序也是乱的"。
             *
             * ⚠️ 2026-09-19 又补了一层：**光打 console 不算"不静默"** ——
             * 控制台不是用户看得见的地方。现在同时把来源记进 `this.fieldOrder`，
             * 由 App 读出来变成界面上的一句提示（与 `orderNote` 对称）。
             *
             * ⚠️ 这里**故意不写** `this.fieldOrder = 'table'`：视图级失败后代码会往下
             * 走到 `table.getFieldMetaList()`，那里有一处**唯一**的写入点。
             * 同一个事实写两遍的后果我实测过：把降级分支那行删掉，断言**照样全绿**
             * —— 一条永远不会红的断言等于没有。所以只留一处。
             */
            console.warn(
              '[BitablePrint] 视图级字段序读不到，已降级为表级顺序（**该顺序不可信**，勾选列表的行标签可能取错字段）：',
              e,
            )
          }
        }
      }

      const metas = await table.getFieldMetaList()
      /**
       * ⚠️ **这里是 `fieldOrder` 唯一的写入点**（'view' 在成功分支里早返回了）。
       *
       * 三个到达此处的理由都指向同一个结论 —— 这份字段顺序**不是视图级**：
       *   · 没传 viewId（用户在打印"全部"，本来就没有视图列序可言）；
       *   · 传了但视图对象找不到（`viewOf` 返回 null）；
       *   · 传了、视图也在，但 `view.getFieldMetaList()` 抛错（真机上真会发生）。
       * 界面据此提示"行标签可能不是你在表格里看到的前两列"。
       *
       * 别再在失败分支里补一句同名赋值：实测过，那会让对应的断言**永远绿**。
       */
      this.fieldOrder = 'table'
      return normalizeFieldMetas(metas)
    } catch (e) {
      throw new SdkCallError('读取字段列表', e)
    }
  }

  // ============================================================
  // 记录读取
  // ============================================================

  async fetchRecords(opts: FetchRecordsOptions): Promise<FetchRecordsResult> {
    const table = await this.table(opts.tableId)

    // 不传 viewId（= 打印"全部"）时没有"视图顺序"可言，走原来的分页路径
    if (!opts.viewId) {
      return drainPages(
        async (pageToken, pageSize) => {
          const r = await table.getRecordsByPage({ pageSize, pageToken })
          return {
            records: (r?.records ?? []).map((x: any) => ({
              recordId: x.recordId,
              fields: x.fields ?? {},
            })),
            pageToken: r?.pageToken,
            hasMore: Boolean(r?.hasMore),
            total: typeof r?.total === 'number' ? r.total : undefined,
          }
        },
        opts,
      )
    }

    const view = (await this.viewOf(table, opts.viewId)) as ViewLike | null

    /**
     * ⚠️ **先取"视图顺序"，再按它取数**（2026-09-19 修"记录乱序/取错"）。
     *
     * 老写法是"先分页取满 maxRecords 条，再按视图顺序重排" ——
     * 顺序对了，**但"取哪一批"是错的**：`maxRecords` 截断切的是**页序**
     * （`getRecordsByPage` 的返回顺序），于是表一大，
     * 用户看到/打印的既不是"视图里的前 N 条"，集合本身也是随机的，
     * 而 `orderSource` 还会如实报成 `view` —— **看起来一切正常**。
     */
    const order = await visibleOrderOf(view)

    const fetchPage = async (
      pageToken: string | undefined,
      pageSize: number,
    ): Promise<{ records: RecordItem[]; pageToken?: string; hasMore: boolean }> => {
      const r = await table.getRecordsByPage({
        pageSize,
        pageToken,
        ...(view ? { viewId: opts.viewId } : {}),
      })
      return {
        records: (r?.records ?? []).map((x: any) => ({
          recordId: x.recordId,
          fields: x.fields ?? {},
        })),
        pageToken: r?.pageToken,
        hasMore: Boolean(r?.hasMore),
      }
    }

    if (order.length > 0) return fetchInViewOrder(order, opts, fetchPage)

    // 拿不到视图顺序 ⇒ 退回分页 + 重排，并**如实回报来源**（不许假装有序）
    const res = await drainPages(fetchPage, opts)
    const ordered = await orderRecordsByView(view, res.records)
    return { ...res, records: ordered.records, orderSource: ordered.source }
  }

  /** ⚠️ `getRecordsByIds` 单次上限 1000 条，这里按 1000 分批 */
  async fetchRecordsByIds(tableId: string, recordIds: string[]): Promise<RecordItem[]> {
    if (recordIds.length === 0) return []
    try {
      const table = await this.table(tableId)
      const out: RecordItem[] = []
      for (let i = 0; i < recordIds.length; i += 1000) {
        const chunk = recordIds.slice(i, i + 1000)
        const res = await table.getRecordsByIds(chunk)
        const list = Array.isArray(res) ? res : []
        /**
         * ⚠️ **`getRecordsByIds` 返回的项里没有 `recordId`**（2026-09-19 真机实测：
         * `Object.keys(item)` 只有 `['fields']`；`getRecordsByPage` 才有 `['recordId','fields']`）。
         * 所以这里**按下标与请求的 id 对齐**，并保留 `r.recordId ?? r.id` 作为兼容路径。
         *
         * 为什么不能想当然写成 `r.recordId`：那会让每条记录的 id 变成 `undefined` ——
         * 界面照样显示（只渲染字段值），但**任何按 id 匹配的功能全废**。
         * 这个坑我已经在 `fetchInViewOrder` 的注释里写过一次，别再犯。
         *
         * 下标对齐的前提是"返回条数 == 请求条数"。长度不一致时（有人被删/越权）**不敢按下标猜**，
         * 只收有真 id 的那些 —— 少几条总比错几条强。
         */
        const alignedByIndex = list.length === chunk.length
        for (let k = 0; k < list.length; k += 1) {
          const r = list[k] as { recordId?: unknown; id?: unknown; fields?: unknown }
          const id = asId(r?.recordId) ?? asId(r?.id) ?? (alignedByIndex ? chunk[k] : undefined)
          if (!id) continue
          out.push({ recordId: id, fields: (r?.fields as RecordItem['fields']) ?? {} })
        }
      }
      return out
    } catch (e) {
      throw new SdkCallError('按 ID 读取记录', e)
    }
  }

  /**
   * 读取"当前选中/聚焦"的那条记录。
   *
   * ⚠️ 实测事实（别再凭直觉改）：
   * - **勾选整行前面的复选框不会触发任何事件**（onSelectionChange 计数不动），
   *   所以"用户勾选了哪几行"永远拿不到，最多只能拿到"光标所在的那一行"。
   * - `onSelectionChange` 的载荷里**确实有 recordId**；`getSelection()` 里有没有至今未证实。
   *   因此取值顺序是：**事件缓存 → getSelection → null**（见 resolveSelection）。
   *
   * 失败 / 未选中一律返回 null，**绝不抛错**（调用方据此静默降级为空勾选，不能把向导卡死）。
   */
  async getActiveRecordId(): Promise<string | null> {
    try {
      return (await this.resolveSelection()).recordId
    } catch {
      return null
    }
  }

  /** 只读诊断：现在会走哪条路取"当前停留记录"（探针面板显示用，也可用于真机实测取证） */
  async describeSelectionSource(): Promise<SelectionDiag> {
    try {
      return await this.resolveSelection()
    } catch {
      return { source: 'none', recordId: null, tableId: null }
    }
  }

  /**
   * 解析"当前停留记录"，并说明来源。顺序：事件缓存 → getSelection → 都没有。
   *
   * 事件缓存必须先过"表一致"这道关：用户切了数据表以后，缓存里还是**旧表**的 recordId，
   * 那属于错数据 —— 比拿不到更糟。只有当缓存的 tableId 与当前活动表一致时才采信；
   * 极端情况下连当前活动表 id 都读不出来（少见容器）才退化为"信缓存"。
   */
  private async resolveSelection(): Promise<SelectionDiag> {
    const activeTableId = await this.activeTableIdSafe()

    const cached = this.selCache
    if (cached?.recordId) {
      const sameTable = activeTableId === null || cached.tableId === activeTableId
      if (sameTable) {
        return { source: 'event', recordId: cached.recordId, tableId: activeTableId ?? cached.tableId ?? null }
      }
    }

    try {
      const sel: any = await this.base?.getSelection?.()
      // 不同版本可能把字段包在 data 里，两种形态都认
      const id = asId(sel?.recordId) ?? asId(sel?.data?.recordId)
      if (id) return { source: 'getSelection', recordId: id, tableId: activeTableId }
    } catch {
      /* 落到下面返回 none */
    }

    return { source: 'none', recordId: null, tableId: activeTableId }
  }

  /** 当前活动表 id；拿不到返回 null（不抛错） */
  private async activeTableIdSafe(): Promise<string | null> {
    try {
      const table = await this.base.getActiveTable()
      const id = asId(table?.id) ?? asId((await table?.getMeta?.())?.id)
      return id ?? null
    } catch {
      return null
    }
  }

  /**
   * ⚠️ 返回的链接 **10 分钟过期**。上层必须在进入预览/打印前重新调用本方法，
   * 绝不能复用编辑阶段的链接。
   */
  async getAttachmentUrls(
    tableId: string,
    recordId: string,
    fieldId: string,
    tokens: string[],
  ): Promise<string[]> {
    if (tokens.length === 0) return []
    try {
      const table = await this.table(tableId)
      // SDK 内部已按 5 个 token 一组切片，这里不需要自己切
      const urls = await table.getCellAttachmentUrls(tokens, fieldId, recordId)
      return urls ?? []
    } catch (e) {
      throw new SdkCallError('获取附件链接', e)
    }
  }

  // ============================================================
  // 模板表
  // ============================================================

  /**
   * 找到或创建 `_打印模板_` 表，并保证字段齐全。
   *
   * ⚠️ `addTable({name, fields})` 的 `fields` 参数**实际不生效**，必须建完表再逐个 addField。
   * ⚠️ 新建表**自带一个空白文本列**，要"征用"它作为第一列（模板名），
   *    而不是先删再建 —— 那样会改变列顺序、且多一次请求。
   */
  async ensureTemplateTable(): Promise<string> {
    // 1) 找现有表（先查缓存，缓存未命中再拉一次表元信息）
    let tableId = this.tableNameCache.get(TEMPLATE_TABLE_NAME)
    if (!tableId) {
      const metas = await this.base.getTableMetaList()
      const hit = (metas ?? []).find((m: any) => m.name === TEMPLATE_TABLE_NAME)
      if (hit) {
        tableId = hit.id
        this.tableNameCache.set(TEMPLATE_TABLE_NAME, hit.id)
      }
    }

    // 2) 不存在就创建
    if (!tableId) {
      try {
        const res = await this.base.addTable({ name: TEMPLATE_TABLE_NAME, fields: [] } as any)
        tableId = res?.tableId
      } catch (e) {
        throw new SdkCallError('创建模板表', e)
      }
      if (!tableId) throw new SdkCallError('创建模板表', new Error('未返回 tableId'))
      this.tableNameCache.set(TEMPLATE_TABLE_NAME, tableId)
    }

    // 3) 保证字段齐全
    await this.ensureTemplateFields(tableId)
    return tableId
  }

  /** 补齐模板表缺失的字段；返回字段名 → {id, type} 映射 */
  private async ensureTemplateFields(tableId: string): Promise<Map<string, TplField>> {
    const table = await this.table(tableId)
    const metas = normalizeFieldMetas(await table.getFieldMetaList())

    const byName = new Map<string, FieldMeta>()
    for (const m of metas) byName.set(m.name, m)

    // 3.1 征用默认空白列作为「模板名」
    let nameField = byName.get(TPL_FIELD.name)
    if (!nameField) {
      const fallbackCol = metas.find(
        (m) => m.isPrimary || DEFAULT_COLUMN_NAMES.includes(m.name),
      )
      if (fallbackCol) {
        try {
          await table.setField(fallbackCol.id, { name: TPL_FIELD.name, type: 1 })
          nameField = { ...fallbackCol, name: TPL_FIELD.name, type: 1 }
        } catch {
          // 征用失败（例如被引用/被锁定）→ 退化为新建字段
        }
      }
    }

    // 3.2 逐个补齐其余字段
    const existing = new Map<string, FieldMeta>()
    for (const m of normalizeFieldMetas(await table.getFieldMetaList())) existing.set(m.name, m)
    if (nameField) existing.set(TPL_FIELD.name, nameField)

    for (const want of TPL_FIELDS) {
      if (existing.has(want.name)) continue
      try {
        /**
         * ⚠️ 单选字段必须**在建列的那一刻就把选项带上**（`property.options`）。
         * 晚一步补的话，第一次写值时会先命中"选项不存在" ⇒ 多一次 `addOption` 往返，
         * 而中途失败就会退化成"写不进去"（正是用户在模板类型那一列看到的现象）。
         *
         * ⚠️ `property` 是**合并**出来的，不是覆盖：日期列要 `dateFormat`、单选列要 `options`，
         * 而它们**可能是同一个字段**（现在不是，但将来加字段时很容易踩）。
         * 两条都为空时**整块不传** —— 传 `options: []` 在部分宿主上会被判非法。
         */
        const property: Record<string, unknown> = { ...(want.property ?? {}) }
        if (want.options && want.options.length > 0) {
          property.options = want.options.map((name) => ({ name }))
        }
        const config: Record<string, unknown> = { name: want.name, type: want.type }
        if (Object.keys(property).length > 0) config.property = property
        const fid = await table.addField(config as any)
        existing.set(want.name, { id: String(fid), name: want.name, type: want.type })
      } catch (e) {
        // 单个字段建不出来不应该让整个插件不可用；但必须让上层知道（对应 E-18）
        console.warn(`[BitablePrint] 创建模板表字段「${want.name}」失败：`, e)
      }
    }

    const map = new Map<string, TplField>()
    for (const [name, meta] of existing) map.set(name, { id: meta.id, type: meta.type })

    // 「目标数据表ID」缺失会让模板作用域失效，属于致命问题，要显式抛出
    if (!map.has(TPL_FIELD.targetTableId) && !map.has(TPL_FIELD.doc)) {
      throw new SdkCallError('初始化模板表', new Error('关键字段缺失（目标数据表ID / 模板配置）'))
    }

    this.tplFieldCache = map
    return map
  }

  private async tplFields(tableId: string): Promise<Map<string, TplField>> {
    if (this.tplFieldCache) return this.tplFieldCache
    return this.ensureTemplateFields(tableId)
  }

  async listTemplateRows(tableId: string): Promise<TemplateRow[]> {
    try {
      const table = await this.table(tableId)
      const fids = await this.tplFields(tableId)
      const rows: TemplateRow[] = []

      let pageToken: string | undefined
      for (;;) {
        const res = await table.getRecordsByPage({ pageSize: 200, pageToken })
        for (const r of res?.records ?? []) {
          const f = r.fields ?? {}
          const find = (logicalName: string): TplField | undefined => fids.get(logicalName)

          /**
           * ⚠️ **按列的"真实类型"渲染，而不是一律当文本**（2026-09-20 第二批）。
           *
           * 这一列的取值形状随类型而变，而且**用户会自己改列类型**（已经发生过两次）：
           *   · 文本     → `'记录模板'` / `[{type:'text',text:'入库单'}]`
           *   · 单选     → `{ id, text }`
           *   · 创建人   → `[{ id, name }]`   ← 旧的 `asPlainText` 在这里只会读出**空串**
           *     （它只认 `.text`，而人员对象上只有 `.name`）⇒「创建人」列在插件里永远是空的。
           *   · 日期     → 毫秒数
           * ⇒ 直接复用 `renderCellValue`（全项目**唯一**的"单元格 → 可读文本"实现，
           *   它已经把这些形状都盖住了），不在本文件里再维护一份近似逻辑。
           */
          const get = (logicalName: string): string => {
            const fd = find(logicalName)
            if (!fd) return ''
            return renderCellValue(f[fd.id], fd.type)
          }
          /**
           * 「更新时间」走**原始文本**而不是渲染结果：我们自己写的是 ISO 字符串，
           * 用户若把它改成日期列则是毫秒数 —— `parseMaybeDate` 两种都认，且能保住毫秒精度。
           * 换成 `renderCellValue` 的话，日期列会被格式化成 `YYYY-MM-DD`，
           * 同一天建的模板就排不出先后了（列表是按它倒序的）。
           */
          const updatedField = find(TPL_FIELD.updatedAt)
          rows.push({
            recordId: r.recordId,
            name: get(TPL_FIELD.name),
            // 读回时用同一个真相：空值/未知一律当视图模板（旧数据里确实有空值，见 KIND_TEXT 的注释）
            kind: (get(TPL_FIELD.kind) === KIND_TEXT.record ? 'record' : 'view') as TemplateRow['kind'],
            targetTableName: get(TPL_FIELD.targetTableName),
            targetTableId: get(TPL_FIELD.targetTableId),
            docJson: get(TPL_FIELD.doc),
            paper: get(TPL_FIELD.paper),
            createdBy: get(TPL_FIELD.createdBy) || undefined,
            updatedAt: parseMaybeDate(updatedField ? asPlainText(f[updatedField.id]) : ''),
          })
        }
        if (!res?.hasMore || !res?.pageToken) break
        pageToken = res.pageToken
      }
      return rows
    } catch (e) {
      if (e instanceof SdkCallError) throw e
      throw new SdkCallError('读取模板列表', e)
    }
  }

  async createTemplateRow(tableId: string, payload: TemplateWritePayload): Promise<string> {
    try {
      const table = await this.table(tableId)
      const fids = await this.tplFields(tableId)
      const res = await table.addRecords([{ fields: await this.toFields(table, fids, payload) }])
      const recordId = res?.[0]
      if (!recordId) throw new Error('未返回 recordId')
      return String(recordId)
    } catch (e) {
      throw new SdkCallError('保存模板', e)
    }
  }

  async updateTemplateRow(tableId: string, recordId: string, payload: TemplateWritePayload): Promise<void> {
    try {
      const table = await this.table(tableId)
      const fids = await this.tplFields(tableId)
      await table.setRecords([{ recordId, fields: await this.toFields(table, fids, payload) }])
    } catch (e) {
      throw new SdkCallError('更新模板', e)
    }
  }

  async deleteTemplateRows(tableId: string, recordIds: string[]): Promise<void> {
    if (recordIds.length === 0) return
    try {
      const table = await this.table(tableId)
      await table.deleteRecords(recordIds)
    } catch (e) {
      throw new SdkCallError('删除模板', e)
    }
  }

  /**
   * 「选项名」→ 单选字段真正接受的单元格值 `{ id, text }`。
   *
   * ⚠️ **为什么不能直接写字符串**（这就是用户报"后续新增的模板没有写入类型"的正解）：
   * `table.setRecords/addRecords` 的字段值类型是 `IOpenCellValue`，而单选那一支是
   * **`{ id, text }` 对象**，不是裸字符串。裸字符串会被宿主**静默丢弃**
   * （不报错、单元格空白）⇒ 模板类型列一直是空的，插件读回来只能当"视图模板"，
   * 用户看到的就是"记录类型的表不在了"。
   *
   * 选项不存在时先 `addOption` 补一个再重读（`addOption` 只回字段 id、不回选项 id）——
   * 纸张的选项是"用过的纸"，枚举不完，只能边写边补。选项表按 fieldId 缓存。
   *
   * 拿不到选项时**退回裸字符串**：那正是**文本列**要的形式（老表就是文本列），
   * 也是改动前的行为，不会比原来更糟。所以这里故意**不抛错**。
   */
  private async selectCell(table: any, fieldId: string, name: string): Promise<unknown> {
    try {
      const field = await table.getFieldById(fieldId)
      // ⚠️ `getOptions` 在 **field 对象**上，`table` 上没有；文本列也没有 ⇒ 原样返回字符串
      if (typeof field?.getOptions !== 'function') return name

      let cache = this.optCache.get(fieldId)
      if (!cache) {
        cache = new Map()
        this.optCache.set(fieldId, cache)
      }
      const buckets = cache
      const refresh = async (): Promise<void> => {
        for (const o of ((await field.getOptions()) ?? []) as Array<{ id?: unknown; name?: unknown }>) {
          if (o && typeof o.name === 'string' && o.id !== undefined) buckets.set(o.name, String(o.id))
        }
      }

      if (!buckets.has(name)) await refresh()
      if (!buckets.has(name)) {
        await field.addOption?.(name)
        await refresh()
      }
      const id = buckets.get(name)
      if (id) return { id, text: name }
    } catch (e) {
      console.warn('[BitablePrint] 解析单选字段的选项失败，退回裸字符串写入（单选列会丢值）：', e)
    }
    return name
  }

  /**
   * 当前用户 id（open_id）。拿不到返回 null —— **绝不猜一个值往表里写**。
   * 只在「创建人」列被用户改成了**人员**类型时才会被调用（见 toFields），所以正常情况下零开销。
   */
  private async currentUserId(): Promise<string | null> {
    if (this.userId !== undefined) return this.userId
    try {
      const bridge = this.sdk?.bitable?.bridge
      const id = await bridge?.getUserId?.()
      this.userId = typeof id === 'string' && id.length > 0 ? id : null
    } catch {
      this.userId = null
    }
    return this.userId
  }

  /**
   * 组装写入字段。
   *
   * 值怎么写**由列的真实类型决定** —— 用户会手改这张表的列类型，我们拦不住也不该拦：
   *   · 文本列：写字符串（老表一直是文本列）；
   *   · 单选列：写 `{id, text}`，选项不存在就先补（见 selectCell）；
   *   · 日期列：写**毫秒数**（不是 ISO 字符串 —— 写错形状这列就空了）；
   *   · 「创建人」自动字段（1003）：**飞书自己填**，写它反而会被拒/丢弃 ⇒ 不写；
   *   · 「创建人」是**人员**列（11）：写 `[{ id: 当前用户 }]`，飞书会把 id 解析成人名显示 ⇒ 能写就写；
   *   · 「创建人」是文本列：我们手上只有 open_id，写进去是一串没人看得懂的字符，
   *     **比留空更糟** ⇒ 不写（用户在表格里手动改成「创建人」或「人员」即可，见回复说明）。
   */
  private async toFields(
    table: any,
    fids: Map<string, TplField>,
    payload: TemplateWritePayload,
  ): Promise<Record<string, unknown>> {
    const out: Record<string, unknown> = {}
    const put = (logicalName: string, value: unknown): void => {
      const f = fids.get(logicalName)
      if (f && value !== undefined) out[f.id] = value
    }
    /** 单选列：先解析选项再写。字段不存在/类型不认识时 selectCell 会退回字符串 */
    const putSelect = async (logicalName: string, name: string): Promise<void> => {
      const f = fids.get(logicalName)
      if (f) out[f.id] = await this.selectCell(table, f.id, name)
    }

    put(TPL_FIELD.name, payload.name)
    put(TPL_FIELD.doc, payload.docJson)

    // 模板类型 / 纸张 / 目标数据表(名+ID)：都是单选题，写的是"选项名"
    // （写 KIND_TEXT 里的文案，读回来的判据也是它 —— 同一个真相，见 KIND_TEXT 的注释）
    await putSelect(TPL_FIELD.kind, KIND_TEXT[payload.kind] ?? KIND_TEXT.view)
    if (payload.paper) await putSelect(TPL_FIELD.paper, payload.paper)
    if (payload.targetTableName) await putSelect(TPL_FIELD.targetTableName, payload.targetTableName)
    if (payload.targetTableId) await putSelect(TPL_FIELD.targetTableId, payload.targetTableId)

    /**
     * ⚠️ 「更新时间」必须**按列的真实类型**选写法（2026-09-20 第二批）：
     *   · 日期列（我们现在建的就是它）：写**毫秒数**。
     *     `IOpenTimestamp = number` —— 往日期列写 ISO 字符串会被丢掉或解析失败，
     *     这一列就会一直是空的（而这列是列表倒序的唯一依据）。
     *   · 文本列（老表，用户自己改之前的样子）：仍写 ISO 字符串（改动前就是这个行为）。
     * 早先这里是无条件写 ISO 字符串的 —— 那正是"把列改成日期之后时间就不见了"的原因。
     */
    const updatedField = fids.get(TPL_FIELD.updatedAt)
    if (updatedField) {
      out[updatedField.id] =
        updatedField.type === FT.DateTime ? Date.now() : new Date().toISOString()
    }

    const creator = fids.get(TPL_FIELD.createdBy)
    if (creator?.type === FT.User) {
      const uid = await this.currentUserId()
      if (uid) out[creator.id] = [{ id: uid }]
    }
    return out
  }

  // ============================================================
  // 探针支持
  // ============================================================

  async rawTable(tableId: string): Promise<unknown | null> {
    try {
      return await this.table(tableId)
    } catch {
      return null
    }
  }

  /** 给探针用：暴露 base / bridge / ui 原始对象 */
  async rawModules(): Promise<{ base: any; bridge: any; ui: any } | null> {
    if (!this.sdk) return null
    const b = this.sdk.bitable
    return { base: b.base, bridge: b.bridge, ui: b.ui }
  }
}

// ============================================================
// 辅助
// ============================================================

/** 把可能的 id 值收敛成"非空字符串"或 undefined（选中态里的 id 都可能是 null / 空串） */
function asId(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined
}

/** SDK 字段元信息 → 领域模型 */
function normalizeFieldMetas(metas: unknown): FieldMeta[] {
  // 参数标成 unknown 而不是 any[]：`view.getFieldMetaList()` 在 ViewLike 里是 unknown
  // （假视图要能塞进来），这里顺手把"没拿到 / 拿到个不是数组的东西"一并兜住。
  const list = Array.isArray(metas) ? (metas as any[]) : []
  return list.map((m) => ({
    id: String(m.id),
    name: String(m.name ?? ''),
    type: Number(m.type ?? 0),
    property: m.property,
    isPrimary: Boolean(m.isPrimary),
  }))
}

/**
 * 视图对象里**本模块用到的**那几个方法。用结构化类型而不是 SDK 的 `IView`：
 * 这样单测可以塞一个假视图进来，把三级降级逐条钉死 ——
 * 本机没有飞书宿主，这是第 ① 项在这台机器上**唯一能拿到的证据**。
 */
export interface ViewLike {
  getVisibleRecordIdList?(): Promise<unknown>
  getSortInfo?(): Promise<unknown>
  getFieldMetaList?(): Promise<unknown>
}

/**
 * 按**当前视图的顺序**重排记录。三级降级，每一级都**如实回报**来源
 * （拿不到就说拿不到，绝不假装有序）：
 *   ① `view.getVisibleRecordIdList()` —— SDK 直接给的"视图可见记录 id，按视图顺序"，最准（含手动拖拽的行序）；
 *   ② `view.getSortInfo()`            —— 拿不到 id 列表就退一步读排序配置，在本地排；
 *   ③ 都没有 → `default`（表格默认顺序），由 UI 明确告知用户（见 useWizardState 的 orderNote）。
 *
 * 为什么提成模块级导出：它是"记录顺序"这件事的唯一落点，必须能被单测直接钉住。
 * `view` 为 null（视图对象取不到）等价于第 ③ 级 —— 同样如实回报 `default`。
 */
export async function orderRecordsByView(
  view: ViewLike | null,
  records: RecordItem[],
): Promise<{ records: RecordItem[]; source: RecordOrderSource }> {
  // 没有记录就没有"顺序"可言：不去打扰宿主，也不给用户挂一条无意义的排序说明。
  if (records.length === 0) return { records, source: 'view' }
  if (!view) return { records, source: 'default' }

  // ① 视图直接给出"可见记录的顺序"
  // ⚠️ 用 `visibleOrderOf` 而不是在这里自己再写一遍"什么算有效" ——
  // 两处判据一旦漂移，就会出现"顺序按 A、取数按 B"这种最难查的分歧。
  const order = await visibleOrderOf(view)
  if (order.length > 0) return { records: sortByOrder(records, order), source: 'view' }

  // ② 读视图排序配置，本地排
  try {
    const sortInfo: unknown = await view.getSortInfo?.()
    if (Array.isArray(sortInfo) && sortInfo.length > 0) {
      const typeOf = new Map<string, number>()
      for (const m of normalizeFieldMetas(await view.getFieldMetaList?.())) typeOf.set(m.id, m.type)
      return { records: sortBySortInfo(records, sortInfo, typeOf), source: 'sort' }
    }
  } catch (e) {
    console.warn('[BitablePrint] 读取视图排序配置失败，按表格默认顺序列出：', e)
  }

  return { records, source: 'default' }
}

/**
 * 读"视图可见记录的顺序"（`view.getVisibleRecordIdList()`）。
 *
 * 抽成模块级是因为它有**两个**调用方（`orderRecordsByView` 与 `fetchByVisibleOrder` 的上游），
 * 而且"拿到什么算有效"这件事必须只有一处定义 —— 两边判据一旦漂移，
 * 就会出现"顺序按 A、取数按 B"这种最难查的分歧。
 *
 * 返回 `[]` 表示"拿不到"（方法不存在 / 抛错 / 返回空 / 不是数组），**不抛错**。
 * SDK 签名是 `(string | undefined)[]`，所以 `undefined` 项要滤掉。
 */
export async function visibleOrderOf(view: ViewLike | null): Promise<string[]> {
  if (!view?.getVisibleRecordIdList) return []
  try {
    const ids: unknown = await view.getVisibleRecordIdList()
    return (Array.isArray(ids) ? ids : []).filter(
      (x): x is string => typeof x === 'string' && x.length > 0,
    )
  } catch (e) {
    console.warn('[BitablePrint] 读取视图可见记录顺序失败：', e)
    return []
  }
}

/**
 * **按视图顺序取数**：顺序与"取哪一批"同源，且**保留真 recordId**。
 *
 * 为什么是"分页取 + 按视图顺序筛 + 拿够就停"，而不是"按 id 取"：
 *
 * ⚠️ 真机实测（2026-09-19，就是靠这条把一个大 bug 钉死的）：
 *   `table.getRecordsByIds(ids)` 返回的每一项**只有 `fields`，没有 `recordId`**
 *   （`Object.keys(item) === ['fields']`；而 `getRecordsByPage` 返回的是 `['recordId','fields']`）。
 *   我一开始把这条路径写成"按 id 取数"，于是 `records` 里每条的 `recordId` 全是 `undefined` ——
 *   **列表照样显示正常**（列表只渲染字段值），但凡按 id 匹配的功能全废：
 *   「读取左表勾选」筛不进任何记录、「读取光标所在行」永远找不到那条。
 *   用户看到的正是"两根按钮都读不到"。
 *
 * ⇒ 现在：分页走 `getRecordsByPage({ viewId })`（有真 id），
 *   只收"在视图顺序前 N 条里"的记录，收齐就提前停。
 *   顺序由 `sortByOrder` 按 `order` 排定；`maxRecords` 截断切的是**视图顺序**而不是页序。
 *
 * 抽成模块级 + 依赖注入 `fetchPage`，是为了让单测能塞假表把这几条逐条钉死。
 */
export async function fetchInViewOrder(
  order: string[],
  opts: {
    pageSize?: number
    maxRecords?: number
    onProgress?: (loaded: number, total: number | null) => void
    signal?: AbortSignal
  },
  fetchPage: (
    pageToken: string | undefined,
    pageSize: number,
  ) => Promise<{ records: RecordItem[]; pageToken?: string; hasMore: boolean } | null>,
): Promise<FetchRecordsResult> {
  // SDK 硬限制 pageSize ≤ 200
  const pageSize = Math.min(opts.pageSize ?? 200, 200)
  const wantIds = order.slice(0, Math.max(0, opts.maxRecords ?? 20000))
  const want = new Set(wantIds)
  const collected = new Map<string, RecordItem>()
  let pageToken: string | undefined
  let error: string | undefined
  /** 页面上到底看见过多少条记录 —— 只用来判"看见了却没匹配上"这种异常（见收尾处） */
  let seen = 0

  // 首屏先给一次进度，避免"点了没反应"
  opts.onProgress?.(0, order.length)

  for (;;) {
    if (opts.signal?.aborted) break
    let page: Awaited<ReturnType<typeof fetchPage>>
    try {
      page = await fetchPage(pageToken, pageSize)
    } catch (e) {
      // 已加载的数据保留可用（对应 E-08：不整体回滚）
      error = e instanceof Error ? e.message : String(e)
      break
    }
    const list = page?.records ?? []
    if (list.length === 0) break
    seen += list.length

    for (const r of list) {
      // ⚠️ 只认**有 id** 的记录：没 id 的没法被任何 id 匹配，收进来只会污染列表
      if (r.recordId && want.has(r.recordId) && !collected.has(r.recordId)) collected.set(r.recordId, r)
    }
    opts.onProgress?.(collected.size, order.length)

    // 要的都在手上了 ⇒ 提前停，不再往下翻
    if (collected.size >= wantIds.length) break
    if (!page?.hasMore || !page?.pageToken) break
    pageToken = page.pageToken
  }

  /**
   * ⚠️ **"看见了记录却一条都没匹配上"必须出声**（2026-09-19）。
   *
   * 这条分支正对应我刚踩的那个真机坑：宿主返回的记录**没有 recordId** ⇒
   * 全被上面的 `want.has()` 滤掉 ⇒ 界面拿到空列表。
   * 静默给空列表是最坏的结果（用户只会说"读不到"，我们什么都查不到）；
   * 所以这里宁可报一句明确的错，把"是哪一层坏了"直接写出来。
   */
  if (!error && collected.size === 0 && seen > 0 && wantIds.length > 0) {
    error = '宿主要回来的记录缺少 id，一条都没能匹配上（这属于接口异常，请反馈）。'
  }

  const records = wantIds.map((id) => collected.get(id)).filter((r): r is RecordItem => !!r)
  return {
    records,
    /** 报"视图可见条数"：它就是"这次范围里一共有多少条"，比页序 total 更贴切 */
    total: order.length,
    truncated: order.length > wantIds.length,
    ...(error ? { error } : {}),
    orderSource: 'view',
  }
}

/**
 * 按给定的 id 顺序重排记录（视图顺序）。
 * 没出现在列表里的记录保持相对顺序、并在最后 —— `Array.prototype.sort` 在 ES2019+ 稳定，
 * 所以直接拿"排名"当排序键就够了。
 */
export function sortByOrder(records: RecordItem[], order: string[]): RecordItem[] {
  const rank = new Map(order.map((id, i) => [id, i]))
  return [...records].sort(
    (a, b) => (rank.get(a.recordId) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.recordId) ?? Number.MAX_SAFE_INTEGER),
  )
}

/**
 * 按视图的排序配置本地排序（`ISortInfo[]`，数组顺序即优先级）。
 *
 * 只有在"读不到视图记录顺序"时才会走到这里，所以刻意保持简单：
 * 两边都像数字就按数字比，否则按文本比；空值一律排最后（与飞书一致）。
 */
export function sortBySortInfo(
  records: RecordItem[],
  sortInfo: Array<{ fieldId: string; desc: boolean }>,
  typeOf: Map<string, number>,
): RecordItem[] {
  const cmp = (a: RecordItem, b: RecordItem): number => {
    for (const s of sortInfo) {
      if (!s || typeof s.fieldId !== 'string') continue
      const type = typeOf.get(s.fieldId)
      const av = renderCellValue(a.fields[s.fieldId], type).trim()
      const bv = renderCellValue(b.fields[s.fieldId], type).trim()
      if (av === bv) continue
      if (av === '') return 1
      if (bv === '') return -1
      const an = Number(av)
      const bn = Number(bv)
      const c = Number.isFinite(an) && Number.isFinite(bn) ? an - bn : av.localeCompare(bv)
      if (c !== 0) return s.desc ? -c : c
    }
    return 0
  }
  return [...records].sort(cmp)
}

/**
 * 单元格值 → 纯文本。
 * 模板表里我们只写文本，但用户可能手动改过字段类型，所以这里做宽容处理。
 */
function asPlainText(v: unknown): string {
  if (v === null || v === undefined) return ''
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  if (Array.isArray(v)) {
    return v
      .map((x) => {
        if (x && typeof x === 'object' && 'text' in (x as object)) return String((x as any).text ?? '')
        return typeof x === 'string' ? x : ''
      })
      .filter(Boolean)
      .join('')
  }
  if (typeof v === 'object') {
    const o = v as any
    if (typeof o.text === 'string') return o.text
    if (typeof o.name === 'string') return o.name
    try {
      return JSON.stringify(v)
    } catch {
      return ''
    }
  }
  return String(v)
}

/** 更新时间可能是 ISO 字符串（我们自己写的）或毫秒时间戳（用户改成了日期字段），两种都要认 */
function parseMaybeDate(v: string): number | undefined {
  if (!v) return undefined
  const asNum = Number(v)
  if (Number.isFinite(asNum) && asNum > 1e11) return asNum
  const t = Date.parse(v)
  return Number.isFinite(t) ? t : undefined
}

/** 判断某个错误是否属于"不在飞书环境"，供上层决定是否降级到 mock */
export function isNotInFeishu(e: unknown): boolean {
  return e instanceof NotInFeishuError || (e instanceof Error && e.name === 'NotInFeishuError')
}
