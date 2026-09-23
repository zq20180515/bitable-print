/**
 * 编辑器内预览：把「当前文档」送进 **与第③步预览完全相同的那一条** `renderDocument` 管线。
 *
 * 为什么这件事必须写清楚（用户原话）：
 *   「再增加直接在此页面预览打印效果的功能」
 * 而项目里已经**三次**栽在"同一个偏移量两处各写一套"上（见 pipeline.ts 里
 * "PlacedBlock 的 html 只含块内部内容，定位由 html.ts 统一包裹"那段注释）。
 * 所以这里**一行排版逻辑都没有**：只是把输入凑齐、调 `renderDocument`、把
 * `RenderedDoc.html` 原样交给 iframe。渲染层改了，这里自动跟着改。
 *
 * 走的具体路径（报告里要能一句话说清）：
 *   EditorShell 顶栏「预览」→ renderEditorPreview()
 *     → emptyRenderContext() 造 RunContext（与 wizard 的 runRender 同一个构造器）
 *     → renderDocument({ doc, records, ctx, forPreview: true })   ← 就是第③步那一个函数
 *     → RenderedDoc.html → <iframe srcdoc>（与第③步 PreviewFrame 同一份产物）
 *
 * 数据从哪来（这是本文件唯一需要自己判断的地方）：
 *   编辑器自己**不持有 records**，所以按"能用真的就用真的"三级取数：
 *     ① 宿主注入的 records（最准：由向导 / `EditorOverlay` 透传 —— 见 EditorPreviewInput.records）
 *     ② 自建一个数据源去读当前表（`createDataSource()`：?mock=1 时是示例数据，
 *        在飞书里是真实表格；与 App 用的是同一个入口，不另写一套取数）
 *     ③ 兜不住就用**示例值**渲染样张，并在预览面板上明说"这是示例值、每列填的其实是字段名"
 *   三级都必须落到 `renderDocument`，不存在"预览时用另一套简排版"的分支。
 *
 * ⚠️ 优先信 ①。历史注（2026-09-21 更新）：以前编辑器跑在**独立窗口**里、不加载飞书 SDK、
 * 没有表格上下文 ⇒ ② 必然失败 ⇒ 每次预览都掉到第③级 ⇒ 用户看到**满屏字段名**。
 * 那条路已整体删除，编辑器现在在**插件内全屏浮层**（`EditorOverlay`）里，与数据源同一个文档，
 * 所以 ② 其实是可用的了。但"能拿 ① 就拿 ①"这条不变：少一次取数，也少一处上下文不一致的可能。
 */

import type { DataSource, FieldMeta, RecordItem } from '../../lib/data-source'
import { createDataSource } from '../../lib/bootstrap'
import { resolveAttachmentImages } from '../../lib/attachment'
import type { ResolvedImage } from '../../render/context'
import { DEFAULT_ATTACH_CONFIG } from '../../lib/types'
import { emptyRenderContext } from '../../render/context'
import { renderDocument } from '../../render/pipeline'
import type { TemplateDoc, TemplateKind } from '../../lib/types'

/** 自建数据源的截止时间。SDK 抖动时宁可退回示例值，也不能让"预览"按钮转圈到用户以为坏了 */
const BOOT_TIMEOUT_MS = 8000
/**
 * 编辑器内预览最多渲染多少条记录。
 *
 * 不跟第③步一样吃全量：这里的使用场景是"边改边看一眼"，改一次要看一次，
 * 全量 600 条会让每次点预览都等好几秒。30 条足够暴露分页/换行/表头重复的问题，
 * 面板上会写清"只渲染了前 N 条"。
 */
const PREVIEW_MAX_RECORDS = 30
/** 兜底样张渲染几条 */
const SAMPLE_RECORD_COUNT = 3

export interface EditorPreviewInput {
  doc: TemplateDoc
  fields: FieldMeta[]
  kind: TemplateKind
  /**
   * 宿主已经算好的记录（第①步「选范围」的产物、已按筛选过滤过）。
   * 给了就直接用，不再自建数据源 —— 这条路径与第③步的结果**逐字节相同**。
   */
  records?: RecordItem[]
  signal?: AbortSignal
}

export interface EditorPreviewResult {
  /** 与打印**共用**的那一份 HTML（RenderedDoc.html 原样） */
  html: string
  pages: number
  pageWidthMm: number
  pageHeightMm: number
  warnings: number
  /** 这批数据是哪来的。直接摊在预览面板上 —— 用户必须知道自己在看什么 */
  source: string
  recordCount: number
}

interface TableData {
  ds: DataSource
  tableId: string
  fields: FieldMeta[]
  records: RecordItem[]
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what}超时（${ms}ms）`)), ms)
    p.then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      (e) => {
        clearTimeout(timer)
        reject(e)
      },
    )
  })
}

/**
 * 解析这批记录里用到的**附件图片**（真机反馈 2026-09-23 第 9 条：
 * 「不论是打印还是预览界面，图片附件都无法显示」）。
 *
 * ⚠️ 渲染器只读 `ctx.images`、**不发任何网络请求**（见 RenderContext 的注释）——
 *    这里不填的话，所有附件图片都会走"没解析到 URL"的占位分支，用户看到的就是"一张图都没有"。
 *
 * 为什么之前只有 wizard 那条链路是对的：导出前调了 `resolveAttachmentImages`（见
 * `useWizardState` 的 runRender），而**编辑器点「预览」这条路直接 `emptyRenderContext` 起了个空 Map**
 * ⇒ 同一个模板、同一批数据，导出有图、预览没图。
 *
 * 失败**不抛**：拿不到图片只是"少了几张"，不该让整个预览打不开（渲染器会画"加载失败"占位框，
 * 比一片空白或者一个报错弹窗都更有用）。
 */
async function resolvePreviewImages(
  records: RecordItem[],
  fields: FieldMeta[],
  signal?: AbortSignal,
): Promise<Map<string, ResolvedImage[]>> {
  try {
    const data = await withTimeout(loadTable(), BOOT_TIMEOUT_MS, '读取表格数据')
    const r = await resolveAttachmentImages({
      ds: data.ds,
      tableId: data.tableId,
      records,
      fields,
      config: DEFAULT_ATTACH_CONFIG,
      // 编辑器预览走缩略图档：侧边栏内存有限，全尺寸图会 OOM（与 wizard 的 forOutput=false 同口径）
      quality: 'preview',
      signal,
    })
    return r.images
  } catch {
    return new Map()
  }
}

/**
 * 模块级缓存：一次会话里只建一个数据源。
 *
 * 编辑器里"点预览"是个高频动作，每次都重新握手/重新拉 600 条记录纯属浪费；
 * 失败**不缓存**（用户可能过一会儿才把表格打开）。
 */
let tablePromise: Promise<TableData> | null = null

function loadTable(): Promise<TableData> {
  if (!tablePromise) {
    tablePromise = (async (): Promise<TableData> => {
      const { ds } = await createDataSource()
      const ctx = await ds.getContext()
      const fields = await ds.listFields(ctx.tableId, ctx.viewId)
      const res = await ds.fetchRecords({
        tableId: ctx.tableId,
        viewId: ctx.viewId,
        pageSize: 200,
        maxRecords: 600,
      })
      return { ds, tableId: ctx.tableId, fields, records: res.records }
    })()
    tablePromise.catch(() => {
      tablePromise = null
    })
  }
  return tablePromise
}

/**
 * 兜底样张：每个字段的示例值就用**字段名**。
 *
 * 不是偷懒 —— 字段名是唯一"长度与真实数据量级相当、且用户一眼能对上是哪一列"的取值。
 * 写死 "示例文本" 反而会让用户误以为那一列的数据坏了。
 */
function sampleRecords(fields: FieldMeta[]): RecordItem[] {
  return Array.from({ length: SAMPLE_RECORD_COUNT }, (_, i) => ({
    recordId: `sample-${i + 1}`,
    fields: Object.fromEntries(fields.map((f) => [f.id, f.name])),
  }))
}

export async function renderEditorPreview(input: EditorPreviewInput): Promise<EditorPreviewResult> {
  const { doc, kind } = input
  let fields = input.fields
  let records: RecordItem[]
  let source: string

  if (input.records && input.records.length > 0) {
    records = input.records.slice(0, PREVIEW_MAX_RECORDS)
    source = `已选范围的前 ${records.length} 条记录`
  } else {
    let data: TableData | null = null
    try {
      data = await withTimeout(loadTable(), BOOT_TIMEOUT_MS, '读取表格数据')
    } catch {
      // 拿不到就退回示例值：预览按钮永远不能"点了没反应"
      data = null
    }
    if (data && data.records.length > 0) {
      records = data.records.slice(0, PREVIEW_MAX_RECORDS)
      if (data.fields.length) fields = data.fields
      source = `当前表格前 ${records.length} 条记录（共读到 ${data.records.length} 条）`
    } else {
      records = sampleRecords(fields)
      source = '示例值（没读到你的表格数据）—— 下面每列填的其实是字段名，只验证版式'
    }
  }

  if (!records.length) {
    throw new Error('没有可渲染的数据：表格里既没有记录，也没有字段可以生成示例值')
  }

  // 上下文构造器与 wizard 的 runRender 同源（emptyRenderContext）。today / printTime
  // 由它在**进入渲染时定值**，所以同一份预览里不会出现两个打印时间。
  /* 附件图片必须先解析好再交给渲染器（见 resolvePreviewImages 的注释） */
  const images = await resolvePreviewImages(records, fields, input.signal)

  const ctx = emptyRenderContext({
    fields,
    images,
    totalRows: records.length,
    batchLayout: kind === 'record' ? 'default' : undefined,
    perPageN: null,
  })

  const rendered = await renderDocument({
    doc,
    records,
    ctx,
    forPreview: true,
    title: '打印效果预览',
    signal: input.signal,
  })

  return {
    html: rendered.html,
    pages: rendered.pages.length,
    pageWidthMm: rendered.pageWidthMm,
    pageHeightMm: rendered.pageHeightMm,
    warnings: rendered.warnings.length,
    source,
    recordCount: records.length,
  }
}
