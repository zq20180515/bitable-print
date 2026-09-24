/**
 * 四步向导的状态编排（PRD BP-1 主流程）。
 *
 * 这一层是"接线层"：把数据源（DataSource）、模板存储（TemplateStore）、附件流水线、
 * 渲染引擎（renderDocument / printDocument）串成一条可用的流程。
 * 它本身不实现任何算法，只负责**顺序与时机** —— 而时机恰恰是 PRD 里最容易出错的部分：
 *
 *   · F4-23：进预览/打印前**必须重新获取附件链接**（10 分钟过期），不能复用编辑阶段的
 *   · BP-6：先取图片 → 再渲染 → 再分页 → 再输出，顺序颠倒会得到错误结果
 *   · F5-01：预览与打印**共用同一份 HTML**，否则保真度无法保证
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  DataSource,
  FieldMeta,
  FieldOrderSource,
  RecordItem,
  RecordOrderSource,
  TableContext,
} from '../../lib/data-source'
import { pickLabelFields, recordLabelText } from './label-fields'
import { appliedLabel, chainFailureText, outcomeHint, readSelectionChain } from './record-selection'
import type { SelectionOutcome } from './record-selection'
import type { AttachmentPrintConfig, TemplateDoc, TemplateKind } from '../../lib/types'
import { DEFAULT_ATTACH_CONFIG, emptyTemplate } from '../../lib/types'
import type { AttachElement, TableElement } from '../../lib/types'
import { createTemplateStore, exportTemplatePackage } from '../../lib/template-store'
import type { CreateTemplateInput, TemplateListItem } from '../../lib/template-store'
// ⛔ 这里原来有 `lib/filter` 的三条导入（FilterSet / applyFilter+validateFilterSet / FilterIssue）。
//    2026-09-21 用户要求**直接移除「筛选条件」功能**（他原话："用户完全可以在新视图里，
//    手动筛选需要打印的内容"）⇒ 连同这套引擎（`src/lib/filter.ts`）一起删掉。
//    ⚠️ 别连带删掉下面的 `fieldMap` —— 它现在只服务排版引擎（runRender 传进去用），
//       名字看着像筛选的残留，其实不是。
import { resolveAttachmentImages, releaseAttachmentCache } from '../../lib/attachment'
/* ⚠️ 与编辑器预览**共用同一份预取实现**（见它的文件头注释：两条链各写一套就会分叉） */
import { fillCellStrings } from '../../lib/cell-strings'
import type { ImageFailure, ImageWarning, ResolveStats } from '../../lib/attachment'
import { renderDocument } from '../../render/pipeline'
import type { RenderWarning, RenderedDoc } from '../../render/context'
import { printDocument, saveHtmlFile } from '../../render/print'
// 文件名里的时间戳复用这一份格式化（不要另写一份 YYYYMMDDHHmmss）
import { formatDateTime } from '../../lib/field-types'
import type { ExportResult } from '../../render/print'
// 新建模板也直接展开全屏画布：这个调用必须在点击处理里同步发（需要用户激活）
import { requestEditorFullscreen } from '../editor/EditorOverlay'

/** 单次批量上限，对齐官方批量模式（PRD F1-07 / F5-11A） */
export const MAX_MANUAL = 50

export type WizardStep = 0 | 1 | 2 | 3
export type RangeMode = 'all' | 'view' | 'manual'

export type Phase = 'idle' | 'images' | 'layout' | 'ready' | 'error'

export interface RenderState {
  phase: Phase
  done: number
  total: number
  doc: RenderedDoc | null
  error: string | null
  imageFailures: ImageFailure[]
  imageWarnings: ImageWarning[]
  imageStats: ResolveStats | null
}

export interface OutputState {
  phase: 'idle' | 'working' | 'done' | 'error'
  message: string | null
  result: ExportResult | null
  /** 导出 PDF 时展示的操作引导（浏览器无法静默生成 PDF） */
  guidance: string | null
}

export interface UseWizardArgs {
  ds: DataSource
  ctx: TableContext | null
  fields: FieldMeta[]
  /** App 已经拉到的记录，作为首屏数据，避免白屏 */
  initialRecords: RecordItem[]
  /** `initialRecords` 的顺序来源（App 那次 fetchRecords 的结论），用于"拿不到视图排序就明说" */
  recordOrder?: RecordOrderSource
  /**
   * **字段**顺序的来源（App 那次 listFields 的结论），用于"拿不到视图列序就明说"。
   * 与 `recordOrder` 同一个道理：读不到视图级就只能退回表级，而表级顺序**不可信**
   * （勾选列表的行标签会取错字段）。以前这条只打 `console.warn` —— 用户看不见。
   */
  fieldOrder?: FieldOrderSource | null
  templateTableId: string | null
}

/**
 * 编辑器当前编辑的是"哪一份" —— 名字、类型，以及**改名该改谁**。
 *
 * 为什么必须把这三件事收成**一个对象**（2026-09-20 用户报的串名 bug）：
 * 它们在 `Wizard.tsx` 里原本是**三段各写各的表达式**，而这三段必须用同一个判据
 * （"这次是新建，还是改已有模板"）。判据一分叉就出三种看起来毫不相干的症状：
 *   · 标题 `w.active?.name ?? w.pendingNew?.name` —— **active 优先** ⇒ 新建模板 B 时显示 A；
 *   · 改名 `if (w.active) renameTemplate(w.active.recordId, name)` —— 也是 active 优先
 *     ⇒ 在新模板上改名**把上一个模板改掉了**（比标题错严重：这是改错数据）；
 *   · 落库 `commitEditor` 里是 pendingNew 优先（那次修对了）⇒ 存下来的确实是 B。
 * 用户原话："我在画布中编辑了模板 A 并保存，再创建另一份模板 B…打开左上角都显示 A，
 * 但如果不去修改它，直接点完成名字却是正常的 B。" —— 三个判据两种口径，就是它。
 *
 * ⚠️ 所以判据**只留一处**：`pendingNew` 优先（与 `commitEditor` 同源，见那里的长注释）。
 *   界面只做展示，不许再自己拼一遍 `active ?? pendingNew`。
 */
export interface EditorTarget {
  name: string
  kind: TemplateKind
  /** 改名。新建时只改"待落库的名字"（行还没建呢），已有模板才真的写库 */
  rename(name: string): void
}

const EMPTY_RENDER: RenderState = {
  phase: 'idle',
  done: 0,
  total: 0,
  doc: null,
  error: null,
  imageFailures: [],
  imageWarnings: [],
  imageStats: null,
}

export function useWizardState({
  ds,
  ctx,
  fields,
  initialRecords,
  recordOrder,
  fieldOrder,
  templateTableId,
}: UseWizardArgs) {
  const store = useMemo(() => createTemplateStore(ds), [ds])
  const targetTableId = ctx?.tableId ?? ''
  const targetTableName = ctx?.tableName ?? ''

  // ---------- 流程状态 ----------
  const [step, setStep] = useState<WizardStep>(0)
  const [kind, setKindState] = useState<TemplateKind>('view')
  const [rangeMode, setRangeMode] = useState<RangeMode>('view')
  const [manualIds, setManualIds] = useState<OrderedIds>(() => new OrderedIds())
  const [batchLayout, setBatchLayout] = useState<'default' | 'continuous'>('default')
  const [perPageN, setPerPageN] = useState<number | null>(null)

  /**
   * 真正交给排版引擎的「每 N 条」。
   *
   * ⚠️ **记录模板只在「连续模式」下才认它**（2026-09-21 用户要求恢复"每页打几条"）。
   *
   * 用户原话："我之前如果选择了多条数据、再选择记录模板打印的话，在预览界面
   * **可以选择一页打印多少条数据**，现在怎么只有连续模式和默认模式了。"
   *
   * 查证：这条路上原来写的是 `kind === 'view' ? perPageN : null` —— 记录模板被**无条件丢掉**，
   * 所以就算界面给了控件也照样不起作用（**两处都堵着**：UI 不渲染、这里不传递）。
   * 为什么现在**只**在连续模式下认：
   *   · 默认模式（一页一份）：`render/layout.ts` 在每条记录前都 `breakPage()` ⇒
   *     每页恒为 1 条，`perPageN`（≥1）**永远不会被触发** ⇒ 传下去只会造成"改了没反应"；
   *   · 连续模式（多份内容连续排布、共用一张纸）：`perPageN` 正是"每页几条"的主控项。
   *
   * ⚠️ 这个判据**必须与 `StepPreview` 里的 `showPerPage` 完全一致**。
   * 一处给控件、另一处不认 = 用户点了没反应，比"不显示控件"更坏。
   * 两处都是"记录模板看 batchLayout、视图模板一律给"；视图模板那边的
   * "合并大表不认"由引擎自己处理（见 pipeline.ts 的 buildMergedLoopTableBlock 注释）。
   */
  const layoutPerPageN = kind === 'view' ? perPageN : batchLayout === 'continuous' ? perPageN : null
  /** 「当前表里停留的那一条」的同步结果，用于给用户一行可验证的反馈 */
  const [activeHint, setActiveHint] = useState<{ ok: boolean; text: string } | null>(null)
  /** 勾选区自己的反馈（按行数勾选 / 读取左表勾选的结论），与 activeHint 分开渲染 */
  const [pickerHint, setPickerHint] = useState<{ ok: boolean; text: string } | null>(null)
  /**
   * 向导级的操作反馈，**渲染在底部操作栏里**（2026-09-19）。
   *
   * 为什么必须单独有一份：用户对"独立窗口打不开"给的正解是
   * "**建议直接留在（模板列表）这个界面，底部给点提示就行**"——
   * 而那段提示（以及"新模板到底建没建成"的结论）原本写进了 `pickerHint`，
   * `pickerHint` **只在第①步的手动勾选卡片里渲染**。
   * 于是用户点完「创建并编辑」看到的是：界面没变、**一句提示都没有**，
   * 只能自己猜发生了什么。这正是本项目最忌讳的"静默失败"。
   */
  const [tplHint, setTplHint] = useState<{ ok: boolean; text: string } | null>(null)
  /**
   * 「读取左表选中行」到底走到了哪一步。
   *   unknown → 还没试过；grid → 能读左表勾选；picker → 只能走官方选择器；none → 都不行，退回光标那一行
   * 一旦判成 none 就不再重复等 6 秒 —— 否则用户每点一次都要干等一轮超时。
   */
  const [selectCapability, setSelectCapability] = useState<'unknown' | 'grid' | 'picker' | 'none'>('unknown')
  /** 自动带入只做一次：之后用户的手动勾选 / 清空不再被自动流程覆盖 */
  const activeSyncedRef = useRef(false)

  /**
   * ⛔ 这里原来有两个"改类型"的入口：`setKind`（连打印范围一起改）和 `setKindOnly`（只改类型）。
   * **2026-09-21 双双删除**，因为**一个调用方都没有了**，而且留着它们等于留下第二个真相：
   *
   *   · `setKind` 的唯一调用方是第①步那张红色阻断卡上的「改成视图模板」按钮 ——
   *     那张卡已被用户要求整体删除；
   *   · `setKindOnly` 的调用点是"骨架建完 / 编辑器保存后让类型跟随" ——
   *     这件事现在由 `loadTemplates(preferId)` **统一做**（它在选中之后一并同步 `kind`，
   *     见那里的注释）。同一个状态两处写，先后顺序还会决定谁赢，迟早漂移。
   *
   * ⇒ 现在 `kind` 只有**两个**写入路径，都遵循同一口径「**类型由所选的模板决定**」：
   *     ① `selectTemplate(id)` —— 用户点了某张卡片；
   *     ② `loadTemplates(preferId?)` —— 列表重新读回来（含自动选中第一条、刚保存的那条）。
   *
   * ⚠️ **随之消失的是"切类型顺手改打印范围"那条副作用**（原来：记录模板→手动勾选、
   *    视图模板→视图筛选）。它的本意是好的（用户实测反馈：在多维表格里勾了记录、
   *    打印却把整张视图都打了），但**类型已经不再由用户直接切换**，那条副作用没有触发点了。
   *    ⇒ 打印范围现在**完全由用户在第①步自己选**，插件不再替他改 —— 这反而更干净
   *      （本项目最忌讳的就是静默覆盖用户刚做过的选择）。
   *    ⇒ 若将来要恢复"按类型给默认范围"，**别恢复这两个函数**：放在 `rangeMode` 的初值
   *      或"第一次选中模板"那一次转移里，且必须只在用户**没有明确选过**时才生效。
   */

  // ---------- 记录 ----------
  const [records, setRecords] = useState<RecordItem[]>(initialRecords)
  const [loadingRecords, setLoadingRecords] = useState(false)
  const [recordError, setRecordError] = useState<string | null>(null)
  /**
   * 记录顺序的**实事求是说明**：拿不到视图排序时必须告诉用户列表是按什么排的，
   * 不能静默（用户原话："没太理解读取的记录是按什么顺序排列的"）。
   */
  const [orderNote, setOrderNote] = useState<string | null>(() => orderNoteOf(recordOrder))
  /**
   * 字段顺序读不到时的说明（2026-09-19）。
   *
   * 与 `orderNote` 对称：两者都是"读不到视图级 ⇒ 只能给个不可信的替代"，
   * 都必须让用户看见。区别是记录顺序由本 hook 自己重拉，字段顺序是 App 拉的，
   * 所以这里直接用 prop 派生，不设 state（没有"重拉"要跟进）。
   */
  const fieldOrderNote = fieldOrderNoteOf(fieldOrder)
  /**
   * 连"当前视图 id"都没拿到时的说明（2026-09-19）。
   *
   * 为什么必须说：`fetchRecords({ viewId: undefined })` 不只是"没排序" ——
   * **视图自身的筛选也没了**，于是用户明明选着「视图筛选」，实际拿的是**整表**。
   * 这种"看起来在工作、其实换了数据集"的降级最危险：份数、标签、顺序三样一起错，
   * 而界面上一个字都不提示。所以只要有上下文却没 viewId，就把这件事摆出来。
   * （真机上这条本来必然触发 —— `getContext` 缺了 `getSelection` 兜底；
   * 兜底补上之后它只在**两条路都失败**的极端容器里出现，那时它正好是最该说的话。）
   */
  const viewlessNote = ctx && !ctx.viewId ? VIEWLESS_NOTE : null
  const loadedModeRef = useRef<RangeMode | null>(null)

  // ---------- 模板 ----------
  const [templates, setTemplates] = useState<TemplateListItem[]>([])
  const [loadingTemplates, setLoadingTemplates] = useState(false)
  const [templateError, setTemplateError] = useState<string | null>(null)
  const [activeId, setActiveId] = useState<string | null>(null)

  // ---------- 编辑器 ----------
  const [editorDoc, setEditorDoc] = useState<TemplateDoc | null>(null)
  /**
   * 「新建模板 → 直接全屏编辑」时**待落库**的模板名与类型（2026-09-20）。
   *
   * 为什么要有它：这条路上模板还**不存在**（`active` 是 null），
   * 而 `commitEditor` 原来只处理"更新已有模板"。
   * 之所以不在打开编辑器时就落库（老做法就是那样的），是因为**用户可能中途取消** ——
   * 那样会在列表里留下一个他从没要过的空白模板（用户报过的原话）。
   * ⇒ 保持"惰性落库"：先把名字/类型挂在这里，**点完成才建**。
   */
  const [pendingNew, setPendingNew] = useState<{ name: string; kind: TemplateKind } | null>(null)
  const [editorDirty, setEditorDirty] = useState(false)

  // ---------- 渲染与输出 ----------
  const [render, setRender] = useState<RenderState>(EMPTY_RENDER)
  const [output, setOutput] = useState<OutputState>({ phase: 'idle', message: null, result: null, guidance: null })

  const abortRef = useRef<AbortController | null>(null)
  /**
   * **已经成功渲出来的那一份**是按哪套版式渲的（`"<batchLayout>|<perPageN>"`）。
   *
   * 空串 = 手上这份 doc 与当前版式不符（或还没渲过）⇒ 预览页应该重渲。
   * 只认"渲成了"才写的值 —— 用它取代过去那句"`phase === 'ready'` 就当已渲好"，
   * 后者在"渲染飞行中用户又切了版式"时会给出**假结论**，导致预览永久空白。
   */
  const renderedForRef = useRef('')

  const active = useMemo(() => templates.find((t) => t.recordId === activeId) ?? null, [templates, activeId])
  /** 当前实际生效的模板文档：编辑器里改过就用改过的 */
  const doc = editorDoc ?? active?.doc ?? null

  // ============================================================
  // 记录集合
  // ============================================================

  /** 按范围模式重新拉数。'all' 不传 viewId；其余按当前视图取 */
  const loadRecords = useCallback(
    async (mode: RangeMode) => {
      if (!ctx) return
      setLoadingRecords(true)
      setRecordError(null)
      try {
        const res = await ds.fetchRecords({
          tableId: ctx.tableId,
          ...(mode === 'all' ? {} : { viewId: ctx.viewId }),
          pageSize: 200,
          maxRecords: 5000,
        })
        setRecords(res.records)
        setOrderNote(orderNoteOf(res.orderSource))
        if (res.error) setRecordError(res.error)
        else if (res.truncated) setRecordError(`数据量较大，仅加载前 ${res.records.length} 条`)
        loadedModeRef.current = mode
      } catch (e) {
        setRecordError(e instanceof Error ? e.message : String(e))
      } finally {
        setLoadingRecords(false)
      }
    },
    [ctx, ds],
  )

  // 首屏记录：
  // ⚠️ 这里踩过一个真 bug —— `useState(initialRecords)` **只在首次渲染取值**，
  // 之后 App 异步拉回数据把 prop 更新了，state 依然是空数组，于是"下一步"永远禁用、
  // 整个流程走不下去（深链 ?tab=wizard 直接打开向导时 100% 复现）。
  // 所以不能只依赖 prop：没有外部数据时必须自己拉一次。
  useEffect(() => {
    if (!ctx) return
    if (loadedModeRef.current !== null) return
    if (initialRecords.length > 0) {
      loadedModeRef.current = 'view'
      setRecords(initialRecords)
      return
    }
    void loadRecords(rangeMode)
  }, [ctx, initialRecords, rangeMode, loadRecords])

  // 范围在"全部"与"视图"之间切换时取的是不同数据集，需要重新拉
  useEffect(() => {
    if (!ctx) return
    const need = rangeMode === 'all' ? 'all' : 'view'
    if (loadedModeRef.current !== null && loadedModeRef.current !== need) void loadRecords(rangeMode)
  }, [rangeMode, ctx, loadRecords])

  /**
   * 范围内的记录 —— **全流程唯一的"要打印哪些记录"**（2026-09-21 起）。
   *
   *   · 全部     ⇒ 本页读到的全部记录；
   *   · 视图筛选 ⇒ 多维表格**视图自己**筛出来的结果（`fetchRecords` 带 viewId 拿到的就是那份）；
   *   · 手动勾选 ⇒ 已带入的那些，**顺序即打印顺序**（见 `manualIds` 的注释）。
   *
   * ⚠️ 原来这里还有第二道"插件侧自定义筛选"：`scopedRecords = applyFilter(scopedRecords, …)`。
   *    用户 2026-09-21 要求移除该功能后两者**恒等** ⇒ 合并成一个名字。
   *    刻意不保留两个同义的出口：本项目吃过"同一个东西两个读法"的亏 ——
   *    迟早有人对着其中一个下断言，而另一个早就变了。
   */
  const scopedRecords = useMemo(() => {
    if (rangeMode !== 'manual') return records
    const byId = new Map(records.map((r) => [r.recordId, r]))
    return manualIds.ids.map((id) => byId.get(id)).filter(Boolean) as RecordItem[]
  }, [rangeMode, records, manualIds])

  const fieldMap = useMemo(() => new Map(fields.map((f) => [f.id, f])), [fields])

  // ============================================================
  // 「当前表里停留的那一条」→ 自动带入手动勾选
  // ============================================================

  /**
   * 读取多维表格里"当前停留的那一条"记录并预勾选。
   *
   * 能做到的极限为什么只是"一条"：飞书只对**单元格聚焦 / 切换数据表**暴露选中态，
   * **对勾选整行的复选框不发任何事件**（已实测，onSelectionChange 计数不增长）。
   * 所以"跟随左表多选"做不到，"读取光标所在记录"做得到 —— 后者就是这里要用的那一半。
   *
   * `mode='auto'`：不覆盖用户已有勾选；读不到就**完全静默**（用户在表里没点过行是很正常的状态）。
   * `mode='manual'`：用户主动点了「读取当前选中记录」，无论成败都给一行反馈。
   */
  const syncActiveRecord = useCallback(
    async (mode: 'auto' | 'manual', prefix = ''): Promise<string | null> => {
      const getActive = ds.getActiveRecordId?.bind(ds)
      if (!getActive) {
        if (mode === 'manual') {
          setActiveHint({ ok: false, text: `${prefix}当前数据源不支持读取表内选中记录，请直接在下面勾选。` })
        }
        return null
      }

      let id: string | null = null
      try {
        id = await getActive()
      } catch {
        id = null
      }

      const rec = id ? records.find((r) => r.recordId === id) : undefined
      if (!id || !rec) {
        if (mode === 'manual') {
          /**
           * ⚠️ **两种情况必须分开说**（2026-09-19）。
           *
           * 原来只有一句"没读到…（可能还没点过任何单元格，**或它不在下面的列表里**）"——
           * 括号里那半句是**猜测**，而这两件事的排查方向完全相反：
           *   · 没拿到 id        ⇒ 是"飞书的选中态读不到"（宿主能力问题）；
           *   · 拿到了但不在列表 ⇒ 是"我们这份记录集里没有它"（视图/筛选/上限问题）。
           * 用户报"读取光标所在行也失败"时，这一句话里看不出是哪种，只能靠猜。
           * ⇒ 现在把**事实**摆出来（连 id 前 8 位一起），让下一次反馈自带答案。
           */
          setActiveHint({
            ok: false,
            text: id
              ? `${prefix}读到了光标所在的那条记录（${id.slice(0, 8)}…），但它不在当前已加载的 ${records.length} 条里 —— 检查一下打印范围/视图筛选是不是把它排除了。`
              : `${prefix}没读到你在多维表格里停留的那条记录（飞书没有把选中态给插件）。可以先在表格里点一下某个单元格再试，或直接在下面按行数勾选。`,
          })
        }
        return null
      }

      setManualIds((prev) => {
        if (prev.has(id)) return prev
        if (mode === 'auto' && prev.ids.length > 0) return prev
        return prev.toggle(id, MAX_MANUAL)
      })
      const label = activeRecordLabel(rec, fields)
      setActiveHint({
        ok: true,
        text:
          mode === 'auto'
            ? `已自动选中你在多维表格里停留的那一条记录（${label}）`
            : `${prefix}已改为读取光标所在的那一行（${label}）。`,
      })
      return id
    },
    [ds, records, fields],
  )

  /**
   * 勾选列表用哪两个字段做行标签：**当前视图的前两个字段**（固定，见 label-fields.ts）。
   * 放在这里算，是为了让**列表与搜索框用同一个数组** —— 分开算很容易出现"看得到但搜不到"。
   */
  const labelFields = useMemo(() => pickLabelFields(fields), [fields])

  /** 把一批 recordId 落到勾选里（过滤掉不在当前数据集里的、并按上限截断），并说明去掉了多少 */
  const applyPickedIds = useCallback(
    (ids: string[], sourceLabel: string) => {
      const known = new Set(records.map((r) => r.recordId))
      const kept = ids.filter((id) => known.has(id))
      const missing = ids.length - kept.length
      const clamped = kept.length > MAX_MANUAL
      const finalIds = kept.slice(0, MAX_MANUAL)
      setManualIds(new OrderedIds(finalIds))

      const notes: string[] = []
      if (missing > 0) notes.push(`${missing} 条不在当前已加载的记录里，已忽略`)
      if (clamped) notes.push(`单次最多 ${MAX_MANUAL} 条，超出的已忽略`)
      /**
       * ⚠️ `ok` 不能无条件为 true（2026-09-14 起就没对过，本轮修）。
       *
       * `kept === 0` 而 `ids.length > 0` 是**真出事了**（一条都没对上），
       * 那时还标成绿色"已勾选 0 条"就是在报喜不报忧 ——
       * 用户看到绿字只会以为"操作成功了，只是没勾上"，根本不会去追原因。
       * 判据：**留下了记录才算成功**，一条没留下就是失败（文案里已经带着原因）。
       */
      const ok = finalIds.length > 0
      setActiveHint({
        ok,
        text: `${sourceLabel}，已勾选 ${finalIds.length} 条${notes.length > 0 ? `（${notes.join('；')}）` : ''}。`,
      })
    },
    [records],
  )

  /**
   * 用户主动点「读取左表勾选」。
   *
   * 三级降级，每一步都**如实**告诉用户走到了哪一级（读不到就说不支持，不假装支持）：
   *   ① 表格视图的 getSelectedRecordIdList —— 直接读"已被选中的行"，不弹窗，体验最好
   *   ② bitable.ui.selectRecordIdList —— 飞书官方的记录选择器
   *   ③ 上面都不行 → 退回既有的"读取光标所在的那一条"，并说明能力边界
   */
  const readSelectedRecords = useCallback(async (): Promise<void> => {
    if (!ctx) {
      setActiveHint({ ok: false, text: '还没拿到当前数据表的上下文，读不到选中行。' })
      return
    }
    // 进行中的文案由降级链自己发（`onStage`）—— 它才知道"现在在第几级"。
    // 两级都不可用时最坏要等 6+6 秒，这段时间界面必须一直在说话，不能静默。

    const late = (o: SelectionOutcome): void => {
      // 用户可能在官方选择器里多挑了一会儿：晚到的结果照样收下，别让他白选
      if (o.status === 'ok') applyPickedIds(o.ids, '已读取你在多维表格里选中的记录')
    }

    /** 走到降级那一步时，把"为什么没读到多选"带上，别让用户只看到一句"已读取光标所在行" */
    let prefix = ''

    if (selectCapability !== 'none') {
      let table: unknown = null
      try {
        table = await ds.rawTable(ctx.tableId)
      } catch {
        table = null
      }
      // 降级链（① 表格视图已选中的行 → ② 官方记录选择器）本身在 record-selection.ts 里，
      // 这样"① 不可用时会自动走 ②"这条路径才断言得到。
      const chain = await readSelectionChain(table, (await rawModulesOf(ds))?.ui, ctx.tableId, ctx.viewId, {
        onLate: late,
        // 每一级开始前先说话：用户能看出"在试第一级 → 第一级不行、在试第二级"，而不是点了没反应
        onStage: (_stage, text) => setActiveHint({ ok: false, text }),
      })
      if (chain.level !== 'none') {
        setSelectCapability(chain.level)
        if (chain.outcome.status === 'ok') {
          applyPickedIds(chain.outcome.ids, appliedLabel(chain.level, chain.skipped))
        } else {
          setActiveHint(outcomeHint(chain.outcome))
        }
        return
      }
      setSelectCapability('none')
      prefix = chainFailureText(chain)
    } else {
      prefix = '当前环境（飞书版本或数据源）没有提供「读取左表勾选」的接口（已实测）。'
    }

    // ③ 降级：读取光标所在的那一条（沿用既有实现，失败时会自己给出提示）
    await syncActiveRecord('manual', prefix ? `${prefix} ` : '')
  }, [ctx, ds, selectCapability, applyPickedIds, syncActiveRecord])

  /** 按行数勾选前 N 条。超上限**明确告知**，不静默截断。 */
  const selectFirstN = useCallback((ids: string[], n: number): void => {
    if (!Number.isFinite(n) || Math.floor(n) < 1) {
      setPickerHint({ ok: false, text: '请输入 1 以上的整数行数。' })
      return
    }
    const want = Math.floor(n)
    const take = ids.slice(0, Math.min(want, MAX_MANUAL))
    setManualIds(new OrderedIds(take))
    if (want > MAX_MANUAL) {
      setPickerHint({
        ok: false,
        text: `单次最多 ${MAX_MANUAL} 条（与飞书官方批量模式一致），你要的 ${want} 条已按前 ${MAX_MANUAL} 条勾选；想打更多请在表格的视图里先把范围缩小。`,
      })
      return
    }
    if (take.length < want) {
      setPickerHint({
        ok: false,
        text: `当前列表里只有 ${take.length} 条可勾选（少于你要的 ${want} 条），已全部勾上。`,
      })
      return
    }
    setPickerHint({ ok: true, text: `已勾选前 ${take.length} 条。` })
  }, [])

  // 范围一旦落到「手动勾选」就尝试带入当前记录（含切到记录模板的那一次）。
  // 只自动做一次：等 records 真正到位再动手，避免数据没加载完就误判"读不到"。
  // 离开手动勾选时重置，这样"下次再进来"仍会自动带入；但同一次会话里用户点了「清空」
  // 不会被自动流程重新勾上（那是最烦人的一类"自作聪明"）。
  useEffect(() => {
    if (rangeMode !== 'manual') {
      activeSyncedRef.current = false
      setActiveHint(null)
      setPickerHint(null)
      return
    }
    if (activeSyncedRef.current) return
    if (records.length === 0) return
    activeSyncedRef.current = true
    void syncActiveRecord('auto')
  }, [rangeMode, records.length, syncActiveRecord])

  // ============================================================
  // 模板列表
  // ============================================================

  /**
   * `activeId` 的镜像。
   *
   * 为什么需要它：`loadTemplates` 要在**异步取完列表之后**决定"选中谁"，
   * 而它是个 `useCallback`，闭包里读到的 `activeId` 可能是陈旧的
   * （`setActiveId` 用的是函数式更新就是为了绕开这一点）。
   * 用一个 effect 维护的 ref 既拿到最新值，又不用把 `activeId` 塞进依赖
   * （那会让每次选中都重建 `loadTemplates`，进而让下面那个 useEffect 反复触发 —— 会打转）。
   */
  const activeIdRef = useRef<string | null>(null)
  useEffect(() => {
    activeIdRef.current = activeId
  }, [activeId])

  /**
   * 重新读取模板列表，并把"选中谁"与"向导类型"一并落到正确的位置。
   *
   * @param preferId 指定这一轮要选中的模板（刚保存 / 刚复制出来的那一条）。
   *   不传 = 沿用当前选中；当前选中已经不在列表里（被删了）才退回第一条。
   *
   * ⚠️ **必须同时同步 `kind`**（2026-09-21 修的连带 bug）。
   * 向导的设计口径是"**类型由所选的模板决定**"（见 StepTemplate 里那段注释：
   * 第一步已经不再问类型了）。可这个函数原来只 `setActiveId`、**没同步 kind** ——
   * 于是"加载完自动选中第一条"这条路上，`kind` 还停在初始默认值 `view`：
   *   · 第①步「预计产出」会显示"一份多页文档"，而选中的其实是记录模板 ⇒ **说错话**；
   *   · 第③步（预览）会按 `view` 渲染排版控件 —— 记录模板配视图的「每页记录数」，
   *     反过来视图模板连"每 N 条"都不给 ⇒ 用户看到的控件是**错的**。
   * 以前这条路径没暴露，是因为第②步还能手动切类型；那个开关删掉之后就只剩这个同步点了。
   */
  const loadTemplates = useCallback(
    async (preferId?: string) => {
      if (!targetTableId) return
      setLoadingTemplates(true)
      setTemplateError(null)
      try {
        // 模板作用域绑定到具体数据表（决策 D-1 / F6-00）
        const list = await store.listTemplates(targetTableId)
        setTemplates(list)
        const wanted = preferId ?? activeIdRef.current
        const nextId = wanted && list.some((t) => t.recordId === wanted) ? wanted : (list[0]?.recordId ?? null)
        setActiveId(nextId)
        // 类型跟随所选模板（口径见函数头注释）。找不到模板时不动 kind —— 不猜。
        const next = list.find((t) => t.recordId === nextId)
        if (next) setKindState(next.kind)
      } catch (e) {
        setTemplateError(e instanceof Error ? e.message : String(e))
      } finally {
        setLoadingTemplates(false)
      }
    },
    [store, targetTableId],
  )

  useEffect(() => {
    if (templateTableId) void loadTemplates()
  }, [templateTableId, loadTemplates])

  const createTemplate = useCallback(
    async (name: string, k: TemplateKind = kind) => {
      const input: CreateTemplateInput = {
        name: name.trim() || '未命名模板',
        kind: k,
        targetTableId,
        targetTableName,
        // F2-14e / F2-14f：视图模板自动生成循环区骨架，记录模板不生成
        doc: undefined,
      }
      const recordId = await store.createTemplate(input)
      // 选中落到刚建的那一条（连类型一起同步）—— 见 loadTemplates 的 preferId 说明
      await loadTemplates(recordId)
      return recordId
    },
    [store, kind, targetTableId, targetTableName, loadTemplates],
  )

  const renameTemplate = useCallback(
    async (recordId: string, name: string) => {
      await store.renameTemplate(recordId, name)
      await loadTemplates()
    },
    [store, loadTemplates],
  )

  const duplicateTemplate = useCallback(
    async (recordId: string, newName?: string) => {
      const id = await store.duplicateTemplate(recordId, newName)
      // 同上：选中落到复制出来的那一条
      await loadTemplates(id)
      return id
    },
    [store, loadTemplates],
  )

  const deleteTemplates = useCallback(
    async (ids: string[]) => {
      await store.deleteTemplates(ids)
      await loadTemplates()
    },
    [store, loadTemplates],
  )

  const copyToTable = useCallback(
    async (recordId: string, toTableId: string, toTableName: string) => {
      const res = await store.copyToTable(recordId, toTableId, toTableName)
      if (toTableId === targetTableId) await loadTemplates()
      return res
    },
    [store, loadTemplates, targetTableId],
  )

  // ============================================================
  // 编辑器
  // ============================================================

  const openEditor = useCallback(() => {
    if (!active) return
    // 编辑已有模板 ⇒ 不存在"待新建"这回事（不清掉的话保存时会误建一份新的）
    setPendingNew(null)
    setEditorDoc(cloneDoc(active.doc))
    setEditorDirty(false)
  }, [active])

  /**
   * 打开指定模板的编辑器。
   * 不能写成 `selectTemplate(id)` 再 `openEditor()` —— setState 是异步的，
   * openEditor 里读到的 active 还是**上一个**模板，用户会看到"点 A 编辑却打开了 B"。
   */
  const openEditorFor = useCallback(
    (recordId: string) => {
      setActiveId(recordId)
      const target = templates.find((t) => t.recordId === recordId)
      if (!target) return
      setPendingNew(null)
      setEditorDoc(cloneDoc(target.doc))
      setEditorDirty(false)
    },
    [templates],
  )

  const openBlankEditor = useCallback(
    (k: TemplateKind) => {
      /**
       * "空白画布"也是一份**还没落库的新模板** ⇒ 必须挂上 `pendingNew`。
       *
       * 不清不挂的后果与那个串名 bug 是同一类：编辑器开着、却既不是"新建"也不是"改已有"，
       * 于是标题不知道该显示什么、改名不知道该改谁、点完成还会去覆盖列表第一条。
       * 让每个打开编辑器的入口都**明确表态**，`editorTarget` 才有唯一解。
       */
      setPendingNew({ name: '未命名模板', kind: k })
      setEditorDoc(emptyTemplate(k))
      setEditorDirty(false)
    },
    [],
  )

  /** 编辑器里的改动先留在内存（editorDoc），用户点"完成"时才落库 */
  const changeEditorDoc = useCallback((next: TemplateDoc) => {
    setEditorDoc(next)
    setEditorDirty(true)
  }, [])

  /**
   * 落库编辑器里的改动。
   *
   * ⚠️ **返回值是"存成了没有"，不是装饰**（2026-09-21 补）：
   * 全屏容器要在 `await` 它**之后**才退出全屏 —— 而它以前返回 `void`，
   * 调用方写 `() => void commitEditor()`，`await` 一个返回 undefined 的箭头函数**等于没等**：
   * 浏览器先退全屏、浮层按"没在真全屏"切回插件内的**内联小画布**，
   * 落库还在路上 —— 用户看到的就是"点完成先缩回侧边栏，然后才跳模板列表"。
   *
   * ⇒ 现在返回 `{ ok }`：`ok === false` 时**不许关编辑器**（留在原地让用户重试），
   *   由容器把 `message` 显示出来。
   *
   * ⚠️ 顺带补了"更新已有模板"那条路的错误处理：它以前**完全没有 try/catch** ——
   *   `store.saveTemplate` 抛错（无权限 / 模板被他人删了）会变成一个 unhandled rejection，
   *   而编辑器停在原地、界面上一个字都没有（提示写在向导底栏，被浮层盖住了）。属于最坏的失败方式。
   */
  const commitEditor = useCallback(async (): Promise<{ ok: boolean; message?: string }> => {
    if (!editorDoc) {
      setEditorDoc(null)
      setEditorDirty(false)
      return { ok: true }
    }
    /**
     * ⚠️ **必须先判 `pendingNew`（"这是新建"的明确意图），再判 `active`**（2026-09-20 修的真 bug）。
     *
     * 用户报的现象："新建模板的时候，新建的模板会**直接替换掉原有模板列表中的第一个表**，
     * 不会新增一个表出来"，同时"选模板界面只有视图类型的表，记录类型的表不在了"。
     *
     * 根因（两个症状同一个原因）：`active` 会因为**加载模板后自动选中第一条**
     * （见 loadTemplates 里的 `setActiveId(list[0]?.recordId ?? null)`）而**几乎总是非空**。
     * 我先判 `active` ⇒ 走"更新"分支 ⇒ 把**第一条模板覆盖掉**；
     * 若被覆盖的原本是记录模板，它的类型也随之变成视图 ⇒ 连着几次就"记录模板全没了"。
     *
     * ⇒ 判据改成**按意图**：`pendingNew` 存在就是"新建"（`createAndEdit` 才会设它，
     *   而 `openEditor` / `openEditorFor` 会清掉它）⇒ 与 `active` 是否恰好有值无关。
     */
    if (pendingNew) {
      let newId: string
      try {
        newId = await store.createTemplate({
          name: pendingNew.name,
          kind: pendingNew.kind,
          targetTableId,
          targetTableName,
          doc: editorDoc,
        })
      } catch (e) {
        const message = `模板没能存下来：${e instanceof Error ? e.message : String(e)}`
        // 向导底栏那份提示**被浮层盖着看不见**，所以必须同时回传给容器；底栏那份留着不冲突
        setTplHint({ ok: false, text: message })
        return { ok: false, message }
      }
      setPendingNew(null)
      setEditorDoc(null)
      setEditorDirty(false)
      /**
       * **把选中落到刚建好的那一条，并让类型跟着它走**（2026-09-21 用户要求）。
       *
       * 用户原话："不论编辑还是新建模板，保存后跳回模板选择界面，
       * **默认选中刚才新增/修改的那个模板**。"
       *
       * 为什么必须显式指定：`loadTemplates()` 的策略是"**沿用旧选中**"——
       * 对"新建"来说旧选中就是**上一个模板**，于是用户一回来看到的还是别人的卡片。
       * ⚠️ 这里**不再单独调 `setKindOnly`**：`loadTemplates(preferId)` 会在选中之后
       * 一并同步 `kind`（口径："类型由所选的模板决定"）。同一件事写两遍，
       * 迟早有一处漂移 —— 而且两处都在改 `kind`，先后顺序还会决定谁赢。
       */
      await loadTemplates(newId)
      return { ok: true }
    }
    // 既不是新建、又没有可更新的模板 ⇒ 状态不对（编辑器开着却不知道该存成什么）。如实清掉
    if (!active) {
      setEditorDoc(null)
      setEditorDirty(false)
      return { ok: true }
    }
    const savedId = active.recordId
    const savedKind = active.kind
    try {
      await store.saveTemplate({
        recordId: savedId,
        name: active.name,
        kind: savedKind,
        targetTableId,
        targetTableName,
        doc: editorDoc,
      })
    } catch (e) {
      const message = `模板没能更新：${e instanceof Error ? e.message : String(e)}`
      setTplHint({ ok: false, text: message })
      return { ok: false, message }
    }
    setEditorDoc(null)
    setEditorDirty(false)
    /**
     * 改的可能是"当前没选中的那条"（比如从卡片菜单进的编辑器）⇒ 同样把选中落回它。
     * 同上一处：`kind` 由 `loadTemplates(preferId)` 一并同步，这里不再单独设。
     */
    await loadTemplates(savedId)
    return { ok: true }
  }, [editorDoc, active, pendingNew, store, targetTableId, targetTableName, loadTemplates])

  const cancelEditor = useCallback(() => {
    // 取消 = 什么都没建（这正是"惰性落库"要保住的性质）
    setPendingNew(null)
    setEditorDoc(null)
    setEditorDirty(false)
  }, [])

  /**
   * 「编辑器在编辑谁」的**唯一**判据 —— 名字 / 类型 / 改名目标三合一，供 `Wizard.tsx` 直接消费。
   *
   * 判据与 `commitEditor` **同源**：`pendingNew` 优先，其次才是 `active`。
   * 详见 `EditorTarget` 的注释（用户报的"新建 B 却显示 A 的名字"就出在这里）。
   */
  const editorTarget = useMemo<EditorTarget | null>(() => {
    if (!editorDoc) return null
    if (pendingNew) {
      return {
        name: pendingNew.name,
        kind: pendingNew.kind,
        // 行还没建 ⇒ 改名只改"待建的那份"。写库要等用户点「完成」（保持惰性落库）
        rename: (name: string) =>
          setPendingNew((cur) => (cur ? { ...cur, name: name.trim() || cur.name } : cur)),
      }
    }
    if (!active) {
      // 既不是新建、又没选中任何模板：编辑器开着但不知道在编谁（异常态，如实返回空名字）
      return { name: '', kind, rename: () => {} }
    }
    const recordId = active.recordId
    return {
      name: active.name,
      kind: active.kind,
      rename: (name: string) => void renameTemplate(recordId, name),
    }
  }, [editorDoc, pendingNew, active, kind, renameTemplate])

  /**
   * 新建模板并**直接展开插件内全屏画布**。
   *
   * `initialDoc` 用于 Word 导入场景 —— 解析出来的模板要立刻进入编辑，
   * 否则用户一旦取消，辛苦导入的版式就白做了。
   *
   * ⚠️ 落库是**惰性**的：只把名字/类型挂到 `pendingNew`，用户点「完成」时才建。
   * 这样「选了骨架又反悔」不会在列表里留下一个他从没要过的模板。
   * （历史包袱：这里曾经会 `window.open` 开独立窗口，并按「窗口有没有把结果传回来」
   *   决定落不落库；飞书代理 `window.open` 之后那条路整体废弃 —— 见 EditorOverlay 的文件头。）
   */
  const createAndEdit = useCallback(
    async (name: string, k: TemplateKind, initialDoc?: TemplateDoc): Promise<string | null> => {
      /**
       * **新建模板也直接展开全屏画布**（2026-09-20 用户要求）。
       *
       * 不放在这里的话：新建走的是「挂起待建 + 打开编辑器」那条路，
       * 而 `requestEditorFullscreen()` 只在卡片「编辑」的点击里调过 ⇒
       * 新建时画布只在插件内展开，用户还得再点一下「全屏」。
       *
       * ⚠️ 必须在**任何 await 之前**同步调用：`requestFullscreen()` 需要用户激活，
       * 而本函数就是被按钮的 onClick 直接调用的 ⇒ 这一行仍在激活窗口内。
       */
      requestEditorFullscreen()
      const trimmed = name.trim() || '未命名模板'
      // 骨架 / Word 解析出来的 doc 在 buildSkeleton / 解析阶段已经绑好字段，落库不会再改写它
      const base = initialDoc ?? emptyTemplate(k)

      setPendingNew({ name: trimmed, kind: k })
      setEditorDoc(cloneDoc(base))
      setEditorDirty(false)

      /**
       * **这里不落库**（惰性）⇒ 拿不到 id。
       * 调用方（骨架 / Word 导入）都不使用返回值，所以返回 `null` 是如实的表达。
       * ⚠️ 千万不要为了「凑一个 id」在这里 `await store.createTemplate(...)` ——
       * 那就等于把「打开编辑器之前先落库」写回来了：用户取消后会留下一个空白模板（用户报过）。
       */
      return null
    },
    [],
  )

  // ============================================================
  // 渲染
  // ============================================================

  /** 从模板文档里推导出这次渲染需要下载哪些图片、按什么规则下载 */
  const deriveAttachConfig = useCallback((d: TemplateDoc): AttachmentPrintConfig | null => {
    const configs = collectAttachConfigs(d)
    if (configs.length === 0) return null

    // 所有附件元素都不打印图片 → 整批跳过下载（F4-27 逃生舱）
    // `nameOnly` 同样不需要图片 ⇒ 整批跳过下载（否则会白下一堆用不上的图）
    const allSkip = configs.every((c) => c.mode === 'none' || c.mode === 'nameOnly' || c.textOnlyFallback)
    if (allSkip) return { ...DEFAULT_ATTACH_CONFIG, mode: 'none', textOnlyFallback: true }

    const live = configs.filter((c) => c.mode !== 'none' && !c.textOnlyFallback)
    const base = live[0] ?? DEFAULT_ATTACH_CONFIG
    return {
      ...base,
      // 取最严格的限制，避免某个元素放宽后把整批拉爆
      maxFileSizeMb: Math.min(...live.map((c) => c.maxFileSizeMb)),
      minDpi: Math.max(...live.map((c) => c.minDpi)),
      textOnlyFallback: false,
    }
  }, [])

  const runRender = useCallback(
    async (opts: { forOutput: boolean; forceImages: boolean }): Promise<RenderedDoc | null> => {
      if (!doc || !ctx) {
        setRender({ ...EMPTY_RENDER, phase: 'error', error: '还没有选择模板' })
        return null
      }
      abortRef.current?.abort()
      const ac = new AbortController()
      abortRef.current = ac
      /**
       * ⚠️ **记下"这次是按下哪套版式渲的"**（2026-09-19 修分页规则空白回归）。
       *
       * 为什么要在这里记、而不是靠"`phase === 'ready'` 就等于当前版式"：
       * 用户可以在一次渲染**还在飞的时候**就切换版式 —— 那次渲染照旧会跑完并置 `ready`，
       * 但它是**旧版式**的产物。只比对 `phase` 会把它误判成"当前版式已渲好"
       * ⇒ 永远不重渲 ⇒ **预览永久空白**（真机表现：切「每1条」后时而空白、只有切「每5条」才恢复）。
       */
      const layoutKeyAtStart = `${batchLayout}|${perPageN ?? 0}`

      setRender({ ...EMPTY_RENDER, phase: 'images' })
      try {
        // ① 图片预取 —— 顺序不能动（BP-6）。进输出前强制重新取链接（F4-23）。
        const cfg = deriveAttachConfig(doc)
        let images = new Map<string, import('../../render/context').ResolvedImage[]>()
        let imageFailures: ImageFailure[] = []
        let imageWarnings: ImageWarning[] = []
        let imageStats: ResolveStats | null = null

        if (cfg) {
          const res = await resolveAttachmentImages({
            ds,
            tableId: ctx.tableId,
            records: scopedRecords,
            fields,
            config: cfg,
            quality: opts.forOutput ? 'print' : 'preview',
            force: opts.forceImages,
            onProgress: (done, total) => setRender((s) => ({ ...s, phase: 'images', done, total })),
            signal: ac.signal,
          })
          images = res.images
          imageFailures = res.failures
          imageWarnings = res.warnings
          imageStats = res.stats
        }

        /**
         * ⚠️ 被中断时要**把 phase 交还给 idle**（2026-09-19 修）。
         *
         * 原来这里直接 `return null`、什么都不改 ⇒ phase 永远停在 `images`/`layout`。
         * 而"预览页自动补渲"那条 effect 见到 `images/layout` 就 `return`（怕插队）
         * ⇒ **谁都不会再触发重渲**，预览就永久空白（真机就是"切了分页规则后空白"）。
         * 只有"当前这一次"才有资格改状态（`abortRef.current === ac`），
         * 否则会把**新那次**渲染正在推进的 phase 打回 idle。
         */
        if (ac.signal.aborted) {
          if (abortRef.current === ac) {
            setRender((s) => (s.phase === 'ready' ? s : { ...s, phase: 'idle' }))
          }
          return null
        }


        /*
         * ⚠️ **预取"飞书显示文本"**（2026-09-24 第四批第 3 条的**根本解**）。
         *
         * 用户原话：「公式仅在**画布编辑页的预览**中是正确的，在**打印和打印预览**中不对」——
         * 因为预取最初只接在编辑器那条链上。这里是**第二个入口**（向导的预览 + 导出/打印），
         * 现在两条链共用 `lib/cell-strings.ts` 的同一份实现，不许再各写一套。
         *
         * 位置放在图片解析之前：它是纯 SDK 调用、不依赖图片，早一点拿到就能早一点进渲染。
         */
        await fillCellStrings(ds, ctx.tableId, scopedRecords, fields)

        // ② 渲染 + 分页
        setRender((s) => ({ ...s, phase: 'layout', done: 0, total: 0 }))
        const rendered = await renderDocument({
          doc,
          records: scopedRecords,
          ctx: {
            fields,
            fieldMap,
            images,
            today: formatToday(),
            totalRows: scopedRecords.length,
            batchLayout: kind === 'record' ? batchLayout : undefined,
            perPageN: layoutPerPageN,
          },
          forPreview: !opts.forOutput,
          title: active?.name ? `${active.name} · 打印预览` : '打印预览',
          onProgress: (done, total) => setRender((s) => ({ ...s, phase: 'layout', done, total })),
          signal: ac.signal,
        })

        /**
         * ⚠️ 被中断时要**把 phase 交还给 idle**（2026-09-19 修）。
         *
         * 原来这里直接 `return null`、什么都不改 ⇒ phase 永远停在 `images`/`layout`。
         * 而"预览页自动补渲"那条 effect 见到 `images/layout` 就 `return`（怕插队）
         * ⇒ **谁都不会再触发重渲**，预览就永久空白（真机就是"切了分页规则后空白"）。
         * 只有"当前这一次"才有资格改状态（`abortRef.current === ac`），
         * 否则会把**新那次**渲染正在推进的 phase 打回 idle。
         */
        if (ac.signal.aborted) {
          if (abortRef.current === ac) {
            setRender((s) => (s.phase === 'ready' ? s : { ...s, phase: 'idle' }))
          }
          return null
        }


        setRender({
          phase: 'ready',
          done: rendered.pages.length,
          total: rendered.pages.length,
          doc: rendered,
          error: null,
          imageFailures,
          imageWarnings,
          imageStats,
        })
        // 只有**真的渲成了**才登记"这个版式渲好了"（见上面的 layoutKeyAtStart 注释）
        renderedForRef.current = layoutKeyAtStart
        return rendered
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        // 失败**不登记**：否则这个版式会被误判成"已渲过"而永不重试
        renderedForRef.current = ''
        setRender({ ...EMPTY_RENDER, phase: 'error', error: msg })
        return null
      }
    },
    [doc, ctx, ds, scopedRecords, fields, fieldMap, kind, batchLayout, perPageN, active, deriveAttachConfig],
  )

  const cancelRender = useCallback(() => {
    abortRef.current?.abort()
    abortRef.current = null
    setRender((s) => (s.phase === 'ready' ? s : { ...s, phase: 'idle' }))
  }, [])

  /** 进第 3 步（预览） */
  const gotoPreview = useCallback(async () => {
    setStep(2)
    await runRender({ forOutput: false, forceImages: render.phase === 'idle' })
  }, [runRender, render.phase])

  // ============================================================
  // 输出
  // ============================================================

  const doPrint = useCallback(async () => {
    setOutput({ phase: 'working', message: '正在准备打印…', result: null, guidance: null })
    // 打印前强制重取图片链接（F4-23）——从编辑到打印很可能已超过 10 分钟
    const rendered = await runRender({ forOutput: true, forceImages: true })
    if (!rendered) {
      setOutput({ phase: 'error', message: render.error ?? '渲染失败，无法打印', result: null, guidance: null })
      return
    }
    try {
      await printDocument(rendered.html, doc!.pageSetup, rendered.pageWidthMm, rendered.pageHeightMm, {
        title: active?.name ?? '打印',
      })
      setOutput({ phase: 'done', message: '已调起打印对话框', result: null, guidance: null })
    } catch (e) {
      setOutput({
        phase: 'error',
        message: e instanceof Error ? e.message : String(e),
        result: null,
        guidance: '若浏览器拦截了弹出窗口，请允许本站弹出窗口后重试。',
      })
    }
  }, [runRender, render.error, doc, active])

  /**
   * ⛔ `doExportPdf` **已删除**（2026-09-18 用户要求）。
   *
   * 用户原话："移除'输出'界面的'导出PDF'功能，既然不能静默生成 PDF，那就不要占位了，
   * 用户选择打印的时候可以自行保存。"
   *
   * 它本来也只是 `exportPdf = saveHtmlFile` 的别名（见 `render/print.ts`），
   * 真正能出 PDF 的路径唯有"打印 → 浏览器对话框里选另存为 PDF"。
   * 留一个名不副实的按钮，只会让用户以为点了会直接得到 PDF。
   */

  const doSaveHtml = useCallback(async () => {
    setOutput({ phase: 'working', message: '正在保存…', result: null, guidance: null })
    const rendered = await runRender({ forOutput: true, forceImages: true })
    if (!rendered || !doc) {
      setOutput({ phase: 'error', message: '渲染失败，无法保存', result: null, guidance: null })
      return
    }
    /**
     * 文件名 = **打印目标数据表名 + 打印日期时间**（2026-09-18 用户要求）。
     *
     * 示例：`MJP20260918194411` = 表名 `MJP` + `2026 09 18 194411`。
     * 以前用的是**模板名**（`active?.name`），导出多个表的同一天文件会互相覆盖，
     * 而且从文件名看不出"这批纸是从哪张表出来的"。
     *
     * 时间格式化复用 `lib/field-types.ts` 的 `formatDateTime`（**不另写一份**）；
     * 非法字符由 `render/print.ts` 的 `normalizeHtmlName` 兜底清理。
     */
    const stamp = formatDateTime(Date.now(), 'YYYYMMDDHHmmss')
    const baseName = targetTableName || active?.name || '打印结果'
    const result = await saveHtmlFile(rendered.html, `${baseName}${stamp}.html`, doc.pageSetup)
    setOutput({
      phase: result.status === 'cancelled' ? 'idle' : 'done',
      message: result.message ?? null,
      result,
      guidance: null,
    })
  }, [runRender, doc, active, targetTableName])

  // ============================================================
  // 生命周期
  // ============================================================

  // F4-28：离开向导时释放全部 blob URL 与缩略图，否则大批量图片会吃满内存
  useEffect(() => {
    return () => {
      abortRef.current?.abort()
      releaseAttachmentCache()
    }
  }, [])

  // 模板或数据变了，之前的渲染结果就作废，避免用户看到过期预览
  useEffect(() => {
    if (render.phase === 'ready' || render.phase === 'error') {
      setRender((s) => ({ ...s, phase: 'idle', doc: null, error: null }))
    }
    // 只在关键输入变化时失效，不要依赖 render 自身（会死循环）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, scopedRecords.length, kind, batchLayout, perPageN])

  /**
   * ⚠️ **作废之后必须重渲**（2026-09-18 飞书真机反馈后补，缺失时是"预览卡死"）。
   *
   * 上面那个 effect 只把 `render` 打回 `{phase:'idle', doc:null}`，**全场没有任何地方会在
   * `idle` 时重新渲染** —— `runRender` 只有三个调用点：进预览（`gotoPreview`）、
   * 错误态的重试按钮、以及三个输出动作。于是用户在预览页把"默认模式"切成"连续模式"之后：
   *   · `render.doc` 为 null ⇒ 预览整块不渲染（"预览界面空空如也"）；
   *   · `Wizard.tsx` 的 `disabled: w.render.phase !== 'ready'` 恒真 ⇒「下一步：输出」永久变灰；
   *   · **切回默认也不恢复** —— 再触发一次本 effect 时 phase 已是 `idle`，连清空都不做。
   *   用户原话："必须要点击上方的'选模板'，再点击'下一步：预览'才能看到效果"。
   *
   * 修法：**在第 3 步内自动重渲**（不回滚旧 doc —— 那会让用户看到与所选版式不符的预览）。
   * 注意 `runRender` 的闭包在 state 提交后才拿到新的 `batchLayout`，所以必须放在 effect 里，
   * 不能在按钮的 onClick 里"顺手调一下"。
   *
   * ⚠️ **判据必须用"渲出来的那份是哪套版式"**（2026-09-19 修回归）：
   * 上一版写的是 `renderedKeyRef.current = key`（**在渲染发起前就登记**）+「phase==='ready' 就当已渲好」。
   * 两个洞都会让**同一个版式永不再渲**：
   *   ① 渲染发起后立刻登记 ⇒ 这次若被跳过/中断，key 已被吃掉；
   *   ② 用户在渲染**飞行中**又切版式 ⇒ 那次渲染照旧跑完并置 `ready`，但它是**旧版式**的产物，
   *      却被判成"当前版式已渲好"。
   * 真机表现就是用户说的"**切「每1条」后时而空白、没找到规律**，切到「每5条」又好了"
   * （证据：`_feishu-verify/shots/_g/g04-paging-BLANK0-f0180.png` —— 预览整块空白、
   *   连"共 N 页"都没有、「下一步：输出」变灰）。
   */
  const layoutKeyNow = `${batchLayout}|${perPageN ?? 0}`
  useEffect(() => {
    // 只在预览页自动补渲；其它步骤由各自入口显式触发
    if (step !== 2) return
    // 正在渲：别插队（phase 从 images → layout → ready 单调推进）
    if (render.phase === 'images' || render.phase === 'layout') return
    // 失败：停在 error 交给「重试」按钮，避免"失败→自动重试→再失败"的风暴
    if (render.phase === 'error') return
    // 手上这份 doc **就是**按当前版式渲出来的 ⇒ 无事可做
    if (renderedForRef.current === layoutKeyNow) return
    void runRender({ forOutput: false, forceImages: false })
  }, [step, render.phase, layoutKeyNow, runRender])

  const blockingWarnings: RenderWarning[] = useMemo(
    () => (render.doc?.warnings ?? []).filter((w) => w.kind === 'field-missing' || w.kind === 'field-unbound'),
    [render.doc],
  )

  return {
    // 状态
    step,
    kind,
    rangeMode,
    manualIds,
    batchLayout,
    perPageN,
    records,
    scopedRecords,
    activeHint,
    pickerHint,
    /** 向导级操作反馈（新建模板这条线），渲染在**底部操作栏**而不是勾选区里 */
    tplHint,
    selectCapability,
    /** 勾选列表/搜索框共用的行标签字段（当前视图的前两个，见 label-fields.ts） */
    labelFields,
    /** 拿不到视图排序时的如实说明（null = 无需说明） */
    orderNote,
    /** 字段顺序读不到时的说明（与 orderNote 对称，都是"读不到视图级"的如实告知） */
    fieldOrderNote,
    /** 连当前视图 id 都没拿到（最严重：视图筛选不生效、份数/标签/顺序三样一起错） */
    viewlessNote,
    loadingRecords,
    recordError,
    /**
     * 当前作用的数据表名（2026-09-21 UI 重设计新增的出口）。
     *
     * 唯一用途是选模板页的标题「当前 **xxx** 的模板」—— 用户给的设计稿写的是
     * 「当前xxx的模板」这种句式，`xxx` 就是表名。**不新算一遍**：它本来就是上面
     * `targetTableName`（= `ctx?.tableName`），只是以前没对外暴露 ⇒ 界面那侧要是
     * 自己再读一次 `ctx`，就会出现"同一个值两条读取路径"，将来必然有一天对不上。
     */
    tableName: targetTableName,
    templates,
    loadingTemplates,
    templateError,
    active,
    doc,
    editorDoc,
    /**
     * 编辑器当前编辑的那一份（名字 / 类型 / 改名目标）。
     * ⚠️ **只暴露这一个**，不再把 `pendingNew` 放出去 —— 留两个读法就一定会有人拼出
     * `active ?? pendingNew` 那种反过来的判据（用户报的串名 bug 就是这么来的）。
     */
    editorTarget,
    editorDirty,
    render,
    output,
    blockingWarnings,
    maxManual: MAX_MANUAL,

    // 动作
    setStep,
    /**
     * ⛔ `setKind` / `setKindOnly` **不再对外暴露**（2026-09-21）。
     * 类型现在只有一个口径："由所选的模板决定"，写入路径只有 `selectTemplate`
     * 与 `loadTemplates`（见这两个函数上方的注释）。界面不该再有"直接改类型"的入口 ——
     * 有入口就意味着会出现"选了记录模板、类型却是视图"这种自相矛盾的状态。
     */
    setRangeMode,
    /** 用户主动重新同步「当前选中记录」 */
    readActiveRecord: () => void syncActiveRecord('manual'),
    /** 用户主动读取"多维表格里选中的行（多条）"，失败会自动降级到光标那一行 */
    readSelectedRecords,
    toggleManual: (id: string) => setManualIds((prev) => prev.toggle(id, MAX_MANUAL)),
    clearManual: () => {
      setManualIds(new OrderedIds())
      setPickerHint(null)
    },
    selectAllManual: (ids: string[]) => setManualIds(new OrderedIds(ids.slice(0, MAX_MANUAL))),
    /**
     * **重排已选记录**（2026-09-19 用户要求）。
     *
     * 用户原话："所有被勾选的记录，都应该可以重新排序，比如按日期、数字、字母排序，
     * **打印的时候按照排序好的顺序打印**。"
     *
     * `OrderedIds` 的数组顺序**就是**打印顺序（`selectFirstN` 的注释里写着"勾选顺序即打印顺序"），
     * 所以"排序"= 用新顺序重建一个 `OrderedIds`，不需要另立一个 sortOrder 状态
     * —— 两套顺序并存必然有一天对不上。
     */
    reorderManual: (ids: string[]) => setManualIds(new OrderedIds(ids.slice(0, MAX_MANUAL))),
    /** 按行数勾选前 N 条（遵守 MAX_MANUAL，超限明确告知） */
    selectFirstN,
    setBatchLayout,
    setPerPageN,
    reloadRecords: () => loadRecords(rangeMode),

    loadTemplates,
    /**
     * 选模板 —— **同时带上它的类型**（2026-09-19 起）。
     *
     * 因为第一步不再问「记录模板 / 视图模板」了（用户要求移除那个选项），
     * 类型改由**所选的模板**决定 ⇒ 这里必须一起写 `kind`，
     * 否则 `batchLayout` / 分页 / 渲染口径还会按旧类型算。
     * 模板没找到（列表还没读回来）就只设 id，不动 kind —— 不猜。
     */
    selectTemplate: (id: string) => {
      setActiveId(id)
      const t = templates.find((x) => x.recordId === id)
      if (t) setKindState(t.kind)
    },
    createTemplate,
    createAndEdit,
    renameTemplate,
    duplicateTemplate,
    deleteTemplates,
    copyToTable,
    importPackage: async (json: string) => {
      const res = await store.importTemplatePackage(json, { targetTableId, targetTableName })
      await loadTemplates()
      return res
    },
    exportPackage: (ids?: string[]) => {
      const picked = ids && ids.length > 0 ? templates.filter((t) => ids.includes(t.recordId)) : templates
      return { json: exportTemplatePackage(picked, { appVersion: appVersion() }), count: picked.length }
    },

    openEditor,
    openEditorFor,
    openBlankEditor,
    changeEditorDoc,
    commitEditor,
    cancelEditor,

    gotoPreview,
    runRender,
    cancelRender,
    doPrint,
    // doExportPdf 已删除（2026-09-18：浏览器不能静默生成 PDF，不留占位按钮）
    doSaveHtml,
  }
}

// ============================================================
// 辅助
// ============================================================

/** 手选记录：用数组保序（用户勾选顺序 = 打印顺序），用 Set 只是为了 O(1) 判重 */
export class OrderedIds {
  readonly ids: string[]
  private readonly set: Set<string>
  constructor(ids: string[] = []) {
    this.ids = [...ids]
    this.set = new Set(this.ids)
  }
  has(id: string): boolean {
    return this.set.has(id)
  }
  toggle(id: string, max: number): OrderedIds {
    if (this.set.has(id)) {
      const next = this.ids.filter((x) => x !== id)
      return new OrderedIds(next)
    }
    if (this.ids.length >= max) return this
    return new OrderedIds([...this.ids, id])
  }
}

/** 深拷贝模板文档，避免编辑器直接改动列表里的对象（撤销栈会互相污染） */
function cloneDoc(d: TemplateDoc): TemplateDoc {
  return JSON.parse(JSON.stringify(d)) as TemplateDoc
}

/**
 * 拿数据源的原始 SDK 模块（`{ base, bridge, ui }`）。
 *
 * 为什么用结构化探测而不是给 DataSource 加方法：`rawModules()` 只有 SdkDataSource 有，
 * mock 没有 —— 这正是我们要的能力探测本身。为一个"可能不存在"的接口去改共享的
 * DataSource 接口，会逼着 mock 也实现一个假的，反而把"不支持"这件事藏起来。
 */
async function rawModulesOf(ds: DataSource): Promise<{ ui?: unknown } | null> {
  const fn = (ds as unknown as { rawModules?: () => Promise<{ ui?: unknown } | null> }).rawModules
  if (typeof fn !== 'function') return null
  try {
    return await fn.call(ds)
  } catch {
    return null
  }
}

/**
 * 取记录的可读标签，用于「已选中…（<主字段值>）」这类提示。
 *
 * 与勾选列表**用同一套取法**（label-fields.ts 的 pickLabelFields），
 * 保证提示里的名字和用户在列表里看到的完全一致 —— 否则用户会怀疑"点的是不是同一条"。
 */
function activeRecordLabel(rec: RecordItem, fields: FieldMeta[]): string {
  const parts = recordLabelText(rec, pickLabelFields(fields))
  /**
   * 兜底**不再打印 `rec.recordId`**。
   *
   * 那串 `tblXXXX/recXXXX` 是插件的内部标识，印给用户读等于"这条记录叫什么"答不出来 ——
   * 真机上用户在勾选列表里看到的正是这种"完全看不出来"的状态。
   * 换成一句人话：他看到就知道"是这条、只是标签字段都是空的"。
   */
  return parts.trim() !== '' ? parts : '未命名记录（标签字段都为空）'
}

/** 视图排序读不出来时的说明。**必须**显示，不能静默 —— 否则用户会以为列表是随便排的 */
const ORDER_NOTE_NO_SORT = '当前视图没有可读的排序，列表按表格默认顺序列出。'

function orderNoteOf(source?: RecordOrderSource): string | null {
  return source === 'default' ? ORDER_NOTE_NO_SORT : null
}

/**
 * 视图级**字段**顺序读不出来时的说明（2026-09-19）。
 *
 * 这条与 `ORDER_NOTE_NO_SORT` 对称，但要更具体：要告诉用户"会错在哪里" ——
 * 行标签取的是"视图前两个字段"，退回表级（无序）后取到的可能是别的字段。
 * 用户原话就是："原表前四个字段分别是 序号、日期、提交人、登记仓，
 * 但勾选列表中实际显示的是 序号、是否工厂分析用，而且顺序也是乱的"。
 */
const FIELD_ORDER_NOTE_NO_VIEW =
  '读不到当前视图的字段顺序，列表里的行标签可能不是你在表格里看到的前两列。'

function fieldOrderNoteOf(source?: FieldOrderSource | null): string | null {
  return source === 'table' ? FIELD_ORDER_NOTE_NO_VIEW : null
}

/**
 * 拿不到当前视图 id 时的说明。
 * 措辞刻意把三件后果都点出来（份数/标签/顺序），因为它们**同时**错，
 * 只说"顺序可能不准"会让用户以为只是排了一下序。
 */
const VIEWLESS_NOTE =
  '读不到当前视图（拿不到 viewId）：「视图筛选」不会生效，字段顺序与记录顺序也可能不准。'

/** 收集模板里所有附件元素 / 附件单元格的打印配置 */
function collectAttachConfigs(d: TemplateDoc): AttachmentPrintConfig[] {
  const out: AttachmentPrintConfig[] = []
  const visit = (els: unknown): void => {
    if (!Array.isArray(els)) return
    for (const raw of els) {
      const el = raw as Partial<AttachElement> & Partial<TableElement> & { kind?: string }
      if (!el || typeof el !== 'object') continue
      if (el.kind === 'attach' && el.config) out.push(el.config)
      if (el.kind === 'table' && Array.isArray(el.rows)) {
        for (const row of el.rows) {
          for (const cell of row.cells ?? []) {
            if (cell.attachment) out.push(cell.attachment)
          }
        }
      }
    }
  }
  visit(d.bands.header)
  visit(d.bands.loop.elements)
  visit(d.bands.footer)
  return out
}

function formatToday(): string {
  const d = new Date()
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** 构建期注入的版本号（见 vite.config.ts 的 define）。测试环境没有它，必须兜底。 */
function appVersion(): string {
  return typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'dev'
}
