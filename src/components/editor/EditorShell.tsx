/**
 * 编辑器外壳：顶栏 + 画布 + 侧栏/抽屉 + 检查条。
 *
 * 布局决策（PRD F2-01 / P3）：
 * 容器宽度决定形态，**按自身容器量**而不是 window.innerWidth —— 插件跑在飞书 iframe 里，
 * window.innerWidth 可能是宿主整页的宽度，用它切布局必然错判。
 *
 *   ≥900px 三栏：左「插入」常驻 + 中间画布 + 右「属性」常驻（画布吃掉剩余全部宽度）
 *   640–900px 两栏：画布常驻 + 左侧单面板（字段/元素/样式三选一，可收起）
 *   <640px  单栏：画布 + 底部抽屉（默认约 42% 高，带抓手可一键收起）
 *
 * 拖拽：Palette 与画布在不同容器里，统一由本组件接管 pointer 会话。ghost 浮层直接改 transform
 * （不 setState，避免每帧重渲染画布），落点用 Canvas 暴露的 hitTest 换算成 mm。
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react'
import type { FieldMeta, RecordItem } from '../../lib/data-source'
import {
  DEFAULT_TEXT_STYLE,
  finite,
  mmToPx,
  pageRenderSize,
  type AnyElement,
  type InlineNode,
  type InlineSysVar,
  type SysVarKey,
  type TemplateDoc,
  type TemplateKind,
  type TextStyle,
} from '../../lib/types'
import { fieldMeta } from '../../lib/field-types'
import { Canvas, type CanvasHandle, type DropProbe, type DropTarget, type DropVerdict } from './Canvas'
import { Inspector, PagePanel } from './Inspector'
import { Popover } from './Popover'
import { Palette, type PaletteDrag, type PaletteTab } from './Palette'
// 「检查」面板：列出画布上已放置的全部元素与字段（2026-09-18 用户要求新增）
import { InspectPanel } from './InspectPanel'
import { PreviewPane } from './PreviewPane'
import { Toolbar, type NodeTarget } from './Toolbar'
import { renderEditorPreview, type EditorPreviewResult } from './preview'
import {
  applyDefaultTextStyle,
  createDefaultElement,
  elementLabel,
  findCell,
  findElement,
  nodeAtRef,
  nodesAtRef,
  isSysVarNode,
  sameNodeRef,
  updateCell,
  useEditorState,
  withNodeStyle,
  withSysVarProps,
  type BandKey,
  type NodeRef,
  type StyledInlineNode,
} from './useEditorState'
// 格内子元素的尺寸口径换算（进格子 = 撑满为 100%、出格子 = 换算回 mm）—— 见 types.ts 第 ④ 条
import { normalizeChildInCell, normalizeChildOutOfCell } from './cell-child'
// `round1` 的规范实现（B 批收口：此前全项目 5 份副本、且不是同一种行为，见 round.ts 的文件头）
import { round1 } from './round'
// 表格动作 / 合并确认层。确认层的**两半**在这里合流：判据在 `table-actions`（纯函数，Node 可验），
// 状态与弹层在 `MergeConfirm`（`pending` 提升到本组件，见那里的文件头）。
import {
  applyMergeDown,
  applyMergeRight,
  applySplitCell,
  deleteColAt,
  deleteRowAt,
  insertColAt,
  insertRowAt,
  isHeaderCellAt,
  tableGrid,
  CELL_BLOCK_KINDS,
  attachChildToCell,
  detachChildFromCell,
  cellWidthMm,
  mergeRange,
  patchRangeStyle,
  resizeTableTo,
  tableSizeFromRect,
  setCellBordersPatch,
  setHeaderStylePatch,
  setHeaderRowsPatch,
  type CellRange,
  type DiscardedPart,
} from './table-actions'
import type { RangeOp } from './CellRangeBar'
import { MergeConfirmDialog, mergeWarnText, type PendingMerge } from './MergeConfirm'
import {
  IconBack,
  IconCaret,
  IconCheck,
  IconMinus,
  IconPanelLeft,
  IconPanelRight,
  IconPlus,
  IconWarning,
} from './Icons'

type DrawerTab = 'fields' | 'elements' | 'inspect' | 'style'

/**
 * 容器宽度断点：与 CSS 里的 [data-layout] 规则严格一致。
 *
 * 为什么三栏的门槛是 1120 而不是"看起来够宽"的 900：
 * 左右面板固定吃掉 496px，900px 时画布只剩 388px —— 纸张缩到 44%，
 * 比"底部抽屉（不占宽度）"的形态还差。1120 是画布还能保住 624px（纸张 ~72%）的下限。
 * 想要 1:1 看清一张 A4，容器需要 1338px 以上，这个是物理账，不是调参能解决的。
 */
const BP_WIDE = 1120
const BP_MID = 720

const MIN_SCALE = 0.25
const MAX_SCALE = 2
const SCALE_STEP = 0.1

const ZOOM_PRESETS: { value: string; label: string; hint?: string }[] = [
  { value: 'fit', label: '适应宽度', hint: '按可用宽度铺满纸张' },
  { value: '0.5', label: '50%' },
  { value: '0.75', label: '75%' },
  { value: '1', label: '100%', hint: '与打印尺寸 1:1' },
  { value: '1.25', label: '125%' },
  { value: '1.5', label: '150%' },
]

type LayoutMode = 'narrow' | 'mid' | 'wide'

export interface EditorShellProps {
  doc: TemplateDoc
  fields: FieldMeta[]
  /**
   * 宿主已经算好的预览记录（第①步「选范围」的产物）。
   *
   * ⚠️ 不传的话预览会退到**示例值**，用户看到的是满屏字段名 —— 所以向导一定要透传。
   * （历史注：以前"独立窗口"那条路**必须**传，因为那个窗口没有表格上下文；
   *  那条路已删除，现在编辑器与数据源在同一个文档里，但"能拿真的就拿真的"这条不变。）
   */
  records?: RecordItem[]
  templateName: string
  onChange(doc: TemplateDoc): void
  onDone(): void
  onCancel(): void
  /**
   * 正在落库（2026-09-21 新增）。
   *
   * 为什么要它：`onDone` 现在**真的要等落库**（以前 `await` 一个返回 undefined 的箭头函数，
   * 等于没等 —— 见 `commitEditor` 的注释）。等待期间如果不锁住按钮：
   *   · 用户会以为"点了没反应"，再点一次 ⇒ **新建那条路会建出两个模板**；
   *   · 点「返回」或按 Esc 会走取消，把刚存下去的东西又"取消"掉一次。
   * ⇒ 置 `true` 时「完成 / 返回」都禁用，且「完成」显示「保存中…」。
   */
  busy?: boolean
  /** 就地改名；不传则改名只影响本地显示 */
  onRename?(name: string): void
  /**
   * 顶栏右侧、紧挨「完成」左边的插槽（2026-09-20 新增）。
   *
   * 为什么要有它：全屏容器原来给"全屏/缩小"单独画了一行，
   * 于是用户看到**两行 chrome**（"这个'全屏''缩小'所在区域不能和'完成'合并吗？"）。
   * 而"这块画布占多大"本来就是**画布级动作**，放在画布自己的顶栏里才顺。
   */
  topActions?: ReactNode
  /** 未保存状态变化。确认弹窗（PRD F2-05）需要走 App 的保存流程，所以只上报状态 */
  onDirtyChange?(dirty: boolean): void
  /** 模板类型，仅用于提示文案 */
  kind?: TemplateKind
  /**
   * 把 Esc 的**仲裁链**交给宿主浮层（2026-09-23 真机反馈第 5 条）。
   *
   * 方向是**子 → 父**：Esc 的监听器挂在浮层（`EditorOverlay`）上，而"能退哪一层"的状态
   * 全在 shell 里 ⇒ 由 shell 注册上去。返回 `true` = 这一层把 Esc 用掉了
   * （关预览 / 退表格编辑态 / 取消选中），浮层就**不能**再走"关掉编辑器"那条路。
   */
  onEscapeLayerReady?(fn: (() => boolean) | null): void
}

export function EditorShell({
  doc,
  fields,
  records,
  templateName,
  onChange,
  onDone,
  onCancel,
  onRename,
  topActions,
  onDirtyChange,
  busy = false,
  kind = 'view',
  onEscapeLayerReady,
}: EditorShellProps) {
  /** 供 useEditorState 的 Esc 处理器读取"当前是否停在单元格级"，避免闭包捕获陈旧值 */
  const selectedCellRef = useRef<string | null>(null)
  /**
   * 同理，供 Esc 处理器读取"当前是否停在节点级"。
   *
   * Esc 的层级语义现在是**逐级退**：这一处字段 → 单元格 → 整个元素 → 不选中。
   * 一次退一整层是用户在"改细一层又改错了"时最想按的键。
   */
  const selectedNodeRef = useRef<NodeRef | null>(null)
  /**
   * Esc 仲裁链的**唯一实现**见下面的 `escapeStep`。
   *
   * ⚠️ 这里用 ref 转发而不是直接写实现：`escapeStep` 要读 `api`（`selectedId`）与 `preview`，
   * 而它们都在后面才定义；`useEditorState` 又需要 `onEscape` —— 先有鸡还是先有蛋，
   * 只能靠 ref 把环打破。
   */
  const escapeStepRef = useRef<(() => boolean) | null>(null)
  const api = useEditorState({
    doc,
    onChange,
    fields,
    /**
     * Esc 的层级语义：**逐级退**（预览 → 节点 → 单元格 → 表格编辑态 → 元素选中）。
     * 一次退一整层，是用户在"改细一层又改错了"时最想按的键。
     */
    onEscape: () => escapeStepRef.current?.() ?? false,
  })
  /** `api` 的 ref 镜像：`escapeStep` 要读 `selectedId`、要调 `select(null)` */
  const apiRef = useRef<ReturnType<typeof useEditorState> | null>(null)
  apiRef.current = api
  /**
   * 画布注册上来的"退出表格编辑态"。
   *
   * `editTableId` 是画布内部状态（见 `CanvasProps.onExposeExitEdit` 的说明）——
   * 与其为它做一次受控 prop 提升（会牵动画布里 3 处用法），不如让画布把
   * "当前怎么退出去"注册上来。
   */
  const exitCanvasEditRef = useRef<(() => boolean) | null>(null)
  const registerExitCanvasEdit = useRef((fn: (() => boolean) | null): void => {
    exitCanvasEditRef.current = fn
  }).current
  // null = 面板收起，把整屏让给画布（窄侧栏里这个动作很常用）
  const [tab, setTab] = useState<DrawerTab | null>('fields')
  const [layout, setLayout] = useState<LayoutMode>('narrow')
  const [leftOpen, setLeftOpen] = useState(true)
  const [rightOpen, setRightOpen] = useState(true)
  const [zoomKey, setZoomKey] = useState<string>('fit')
  const [bodyW, setBodyW] = useState(340)
  const [selectedCellId, setSelectedCellId] = useState<string | null>(null)
  selectedCellRef.current = selectedCellId
  /** 节点级选中（字段占位符 / 系统变量 / 文字片段本身）。见 useEditorState 的 NodeRef */
  const [selectedNode, setSelectedNode] = useState<NodeRef | null>(null)
  selectedNodeRef.current = selectedNode
  const [defaultTextStyle, setDefaultTextStyle] = useState<TextStyle>({ ...DEFAULT_TEXT_STYLE })
  const [checkOpen, setCheckOpen] = useState(false)
  const [toast, setToast] = useState<string | null>(null)
  const [nameEditing, setNameEditing] = useState(false)
  const [nameDraft, setNameDraft] = useState(templateName)
  const [dropLabel, setDropLabel] = useState<string | null>(null)
  /** 拖拽中的落点判定：可放置的目标格子 / 会被拒绝的理由。见 Canvas 的 DropTarget */
  const [dropTarget, setDropTarget] = useState<DropTarget>(null)
  /** 编辑器内预览（顶栏「预览」按钮）。open 时才渲染浮层 */
  const [preview, setPreview] = useState<{
    open: boolean
    result: EditorPreviewResult | null
    error: string | null
    busy: string | null
  }>({ open: false, result: null, error: null, busy: null })
  const previewAbort = useRef<AbortController | null>(null)

  /**
   * Esc 的**唯一仲裁链**（2026-09-23 真机反馈第 5 条）。
   *
   * 用户原话：「全屏画布下，预览时，按 Esc 会直接缩回小尺寸页面，优化一下，
   * 按 Esc 是退出预览，但不是退出全屏；画布编辑下，按 Esc 是退出编辑，不是退出大屏」。
   *
   * 语义 = **逐级退一层**：从最上层往下问，谁先接住就到此为止。
   *
   *   ① 预览浮层      → 关预览
   *   ② 字段 / 变量节点 → 退回元素级
   *   ③ 单元格        → 退回整表
   *   ④ 表格编辑态     → 退出编辑（画布注册上来的）
   *   ⑤ 元素选中      → 取消选中
   *
   * 全都没得退才返回 `false` —— 这时浮层才会走"关掉编辑器"（有改动先问一句）。
   *
   * ⚠️ 返回值必须**如实**：`true` 就是在告诉浮层"别再往下退了"。
   * ⚠️ 两个消费方共用它：`EditorOverlay` 的捕获阶段监听器（主路径）与
   *    `useEditorState` 的冒泡阶段兜底（没有浮层时）。
   */
  const escapeStep = useCallback((): boolean => {
    if (preview.open) {
      setPreview((s) => (s.open ? { ...s, open: false } : s))
      return true
    }
    if (selectedNodeRef.current) {
      selectedNodeRef.current = null
      setSelectedNode(null)
      return true
    }
    if (selectedCellRef.current) {
      selectedCellRef.current = null
      setSelectedCellId(null)
      return true
    }
    if (exitCanvasEditRef.current?.()) return true
    if (apiRef.current?.selectedId) {
      apiRef.current.select(null)
      return true
    }
    return false
  }, [preview.open])
  /** 供 `useEditorState` 的兜底处理器调用（见上面 `onEscape`） */
  escapeStepRef.current = escapeStep
  /** 把仲裁链注册给宿主浮层 —— 它要在捕获阶段先问一遍 */
  useEffect(() => {
    onEscapeLayerReady?.(escapeStep)
    return () => onEscapeLayerReady?.(null)
  }, [onEscapeLayerReady, escapeStep])
  /**
   * "待确认的合并"。
   *
   * 它原来住在 `Inspector` 的 `CellPanel` 里 —— 那时只有"从单元格面板点合并"这一条路
   * 会问用户。B 批给顶栏加了表格工具条（`CellPanel` 的**兄弟**），状态放那里就够不着了；
   * 所以提升到 shell：两个入口共用同一次挂起、同一个弹层。存的是**定位 + 结构**而不是闭包
   * （理由见 `MergeConfirm.tsx` 的 `PendingMerge`）。
   */
  const [pendingMerge, setPendingMerge] = useState<PendingMerge | null>(null)
  /**
   * 刚插入的那张表的 id ⇒ 画布会浮出「表格尺寸」面板（规格 一）。
   * ⚠️ 只在**插入表格**这条路上置位；用户点「完成」就清掉 ——
   *    不做「记住上次改过哪张表」那种事，幽灵面板比不显示更糟。
   */
  const [newTableId, setNewTableId] = useState<string | null>(null)

  /*
   * 「表格尺寸」小窗的**关闭时机**（真机反馈 2026-09-23 第 6 条：
   * 「点击空白处或者其他元素后，就自动消失，点击编辑表格再次出现」）。
   *
   * 判据只有一条：**当前选中的不是那张表了** —— 点空白（selectedId 变 null）、点别的元素、
   * 删掉那张表，三种都归到这一条上；不必在每条路径里各清一次
   * （那种"各处都记得清"的写法必有漏网，本项目栽过多次）。
   */
  useEffect(() => {
    if (newTableId && api.selectedId !== newTableId) setNewTableId(null)
  }, [api.selectedId, newTableId])
  /**
   * 「拖出表格」模式（规格 一 后半句）。
   *
   * ⚠️ **为什么必须有这个入口**：上一轮把「拖出矩形换算行列数」的逻辑做完了，但它只在
   *    「按下点在纸张内」时起算 —— 而面板拖拽的按下点**一定在纸张外**，于是那条路
   *    用户根本按不出来。这个按钮就是补上「在纸张内起拖」的入口。
   */
  /** 正在画的那一框（**视口坐标**：覆盖层是 fixed 的，不需要 mm 就能画） */
  const [rectDragBox, setRectDragBox] = useState<{ x: number; y: number; w: number; h: number } | null>(null)

  const rootRef = useRef<HTMLDivElement | null>(null)
  const canvasRef = useRef<CanvasHandle | null>(null)
  const canvasAreaRef = useRef<HTMLDivElement | null>(null)
  const ghostRef = useRef<HTMLDivElement | null>(null)
  const toastTimer = useRef<number | null>(null)

  useEffect(() => setNameDraft(templateName), [templateName])

  const notice = useCallback((message: string) => {
    setToast(message)
    if (toastTimer.current !== null) window.clearTimeout(toastTimer.current)
    toastTimer.current = window.setTimeout(() => setToast(null), 3200)
  }, [])

  useEffect(
    () => () => {
      if (toastTimer.current !== null) window.clearTimeout(toastTimer.current)
    },
    [],
  )

  // ---- 布局断点：量自己容器，而不是 window ----
  useLayoutEffect(() => {
    /*
     * ⚠️ 每次都从 ref **现取**节点，不在闭包里留一份。
     *
     * 留一份的写法在"根节点被重建"之后会变成在观察一个已经摘下去的节点：
     * 它再也不会变宽变窄，断点就永远停在挂载那一刻的值。
     * 实测踩到过 —— 视口已经是 380px、`.bp-editor` 的 clientWidth 也是 380，
     * `data-layout` 却还写着 wide，于是顶栏不肯收成「文字设置」弹层，
     * 在 364px 里硬换行成 121px 高（正是"窄侧栏塌掉"的样子）。
     * 现取 + 底下那条 window resize 兜底，这两处一起才没有这个缝。
     */
    const measure = (): void => {
      const node = rootRef.current
      if (!node) return
      const w = node.clientWidth
      if (!Number.isFinite(w) || w <= 0) return
      setLayout(w >= BP_WIDE ? 'wide' : w >= BP_MID ? 'mid' : 'narrow')
    }
    // useLayoutEffect 里先量一次：首帧就定下形态，不会出现"先窄后宽"的跳变
    measure()
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    if (ro && rootRef.current) ro.observe(rootRef.current)
    // 保险：ResizeObserver 不可用、或观察对象被换掉时，窗口尺寸变化仍然会把形态算对
    window.addEventListener('resize', measure)
    return () => {
      ro?.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [])

  // ---- 画布可用宽度（决定"适应宽度"的缩放比） ----
  useEffect(() => {
    const node = canvasAreaRef.current
    if (!node) return
    const measure = (): void => {
      const w = node.clientWidth
      if (Number.isFinite(w) && w > 0) setBodyW(w)
    }
    measure()
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure)
      return () => window.removeEventListener('resize', measure)
    }
    const ro = new ResizeObserver(measure)
    ro.observe(node)
    return () => ro.disconnect()
  }, [])

  const render = pageRenderSize(doc.pageSetup)
  const paperWpx = Math.max(1, mmToPx(render.w))
  /** 纸张四周留白：宽屏给足"工作台"感，窄屏尽量把纸让出来 */
  const canvasPad = layout === 'wide' ? 24 : layout === 'mid' ? 18 : 10
  const fitScale = Math.min(Math.max((bodyW - canvasPad * 2) / paperWpx, MIN_SCALE), MAX_SCALE)
  const manualScale = Number(zoomKey)
  const scale = zoomKey === 'fit' || !Number.isFinite(manualScale) ? fitScale : manualScale
  const zoomLabel = `${Math.round(scale * 100)}%`

  const stepZoom = useCallback(
    (dir: 1 | -1) => {
      const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, Math.round((scale + dir * SCALE_STEP) * 100) / 100))
      setZoomKey(String(next))
    },
    [scale],
  )

  // ---- 选中 ----
  // 宽屏下属性面板常驻，选中元素不该去动左侧「插入」面板；窄屏/中屏才需要把面板切过去
  const handleSelect = useCallback(
    (id: string | null) => {
      api.select(id)
      setSelectedCellId(null)
      /**
       * ⚠️ 这里**只清"换了个元素"的那种陈旧节点选中**，不能一律清空。
       *
       * 点表格里的一个字段占位符时，点击事件依次冒泡经过三层：chip → td → 表格元素。
       * 三层的处理函数顺序固定是「选中节点」→「选中单元格」→「选中元素」，
       * 最后这一层要是无条件清掉节点，用户就永远选不中单元格里的字段。
       * 同元素重复选中（td 与表格 el 是同一个 id）时保留它，换元素/点空白时才丢。
       */
      setSelectedNode((cur) => (cur && id && cur.elementId === id ? cur : null))
      if (id && layout !== 'wide') setTab('style')
    },
    [api, layout],
  )

  const handleSelectCell = useCallback(
    (elementId: string | null, cellId: string | null) => {
      if (elementId) api.select(elementId)
      setSelectedCellId(cellId)
      /**
       * ⚠️ 这里**不能**清掉节点选中。
       *
       * 点画布上的字段占位符时，这一路的点击事件是**冒泡上来**的（Canvas 刻意没有
       * stopPropagation，见 renderInline 的注释），所以顺序固定是
       * 「chip 的 onClick」→「td 的 onClick」：先选中节点，再选中它所在的那一格。
       * 如果这里顺手清掉节点，用户就永远选不中单元格里的字段 —— 而那正是本次要修的问题。
       * 节点归属由下面的 nodeTarget 统一校验，串味的情况在那里已经挡住了。
       */
      if (cellId && layout !== 'wide') setTab('style')
    },
    [api, layout],
  )

  /**
   * 点画布上的行内节点（chip）→ 选中/取消选中这一处。
   *
   * Canvas 已经把"再点一次同一个"翻译成了 `null`，所以这里只做落地，不做取反判断 ——
   * 取反逻辑只写在一处，两边各写一遍必然会有一天不一致。
   */
  const handleSelectNode = useCallback(
    (sel: NodeRef | null) => {
      setSelectedNode(sel)
      if (sel) {
        if (layout !== 'wide') setTab('style')
        return
      }
      // 退到上一层时保持元素/单元格选中不变：用户按 Esc 的意思是"改粗一点"，不是"什么都不选"
    },
    [layout],
  )

  /**
   * 合并的统一入口 —— 右侧单元格面板与顶栏表格工具条**共用这一条**。
   *
   * 为什么合并要收到 shell 来：合并会**整个丢掉**被并进来那一格的内容（连同字段绑定），
   * 必须先过确认层；而那两个入口是兄弟组件，各自揣一份 `pending` 就会出现两个弹层、
   * 两处文案、还有"其中一个忘了问"的口子。判据住在 `./table-actions`：
   * `applyMergeRight/Down` **强制接收** `decide`，所以"绕过确认层"在结构上做不到。
   *
   * `allow=false` 是第一次点（被丢的那格非空时会挂起，等用户点头）；
   * `allow=true` 是用户确认后重跑的那一次。
   */
  const runMerge = useCallback(
    (
      elementId: string,
      cellId: string,
      dir: 'right' | 'down' | 'row' | 'col' | 'range',
      allow: boolean,
      range?: CellRange,
    ): void => {
      /**
       * 每次都从**当前** doc 里重新定位这一张表 —— 不能闭包捕获弹层弹出时那一份 `element`。
       * 用户在确认层开着的这段时间里可能改了表格（甚至删了这一格），拿旧快照去合并
       * 会把这期间的改动整片盖掉。定位失效时动作层返回 null，这里自然什么都不做。
       */
      const found = findElement(doc, elementId)
      if (!found || found.el.kind !== 'table') return
      const decide = (parts: DiscardedPart[]): boolean => {
        if (allow) return true
        setPendingMerge({ elementId, cellId, dir, parts })
        return false
      }
      /*
       * 删除整行 / 整列：与合并共用同一个 `decide` ⇒ 也就共用同一个确认层。
       * ⚠️ 列号要从**网格**里取（`loc.colIdx` 是数组下标，span 模型下与列号不是一回事）。
       */
      if (dir === 'range') {
        if (!range) return
        const r = mergeRange(found.el, range, decide)
        if (!r) return
        api.mergeElement(elementId, r.patch)
        if (r.nextCellId) handleSelectCell(elementId, r.nextCellId)
        return
      }

      if (dir === 'row' || dir === 'col') {
        const loc = findCell(found.el.rows, cellId)
        if (!loc) return
        let r = null as ReturnType<typeof deleteRowAt>
        if (dir === 'row') {
          r = deleteRowAt(found.el, loc.rowIdx, decide)
        } else {
          const grid = tableGrid(found.el.rows, found.el.colWidthsMm.length)
          const slot = (grid[loc.rowIdx] ?? []).find((g) => g?.cell.id === cellId)
          if (!slot) return
          r = deleteColAt(found.el, slot.colStart, decide)
        }
        if (!r) return
        api.mergeElement(elementId, r.patch)
        return
      }

      const r = dir === 'right' ? applyMergeRight(found.el, cellId, decide) : applyMergeDown(found.el, cellId, decide)
      if (!r) return
      api.mergeElement(elementId, r.patch)
      // 右合并后留下的仍是发起的那一格（选中不必变）；`nextCellId` 是动作层给的显式建议
      if (r.nextCellId) handleSelectCell(elementId, r.nextCellId)
    },
    [doc, api, handleSelectCell],
  )

  /** 面板 / 工具条点「合并」：被丢的那格非空时先挂起，用户点头后由 `confirmPendingMerge` 重跑 */
  const requestMerge = useCallback(
    (elementId: string, cellId: string, dir: 'right' | 'down' | 'row' | 'col' | 'range', range?: CellRange) =>
      runMerge(elementId, cellId, dir, false, range),
    [runMerge],
  )

  const confirmPendingMerge = useCallback(() => {
    const req = pendingMerge
    setPendingMerge(null)
    if (req) runMerge(req.elementId, req.cellId, req.dir, true, req.range)
  }, [pendingMerge, runMerge])

  /**
   * 确认层的文案按"这一下会发生什么"分岔。
   * 合并与删除共用同一个弹层（结构一样：一句"会丢什么" + 取消/仍然执行），
   * 但**说的话必须不一样** —— 让用户点"仍然合并"去确认一次删除，是最容易误解的那种文案。
   */
  const confirmCopyOf = (dir: PendingMerge['dir']): { title: string; text: string; confirmLabel: string; confirmAriaLabel: string } =>
    dir === 'range'
      ? { title: '合并会丢内容', text: '选区里有多个图片单元格，只有左上角那格的图会留下；文本会按换行拼接保留。确定合并吗？', confirmLabel: '仍然合并', confirmAriaLabel: '确认合并' }
      : dir === 'row'
      ? { title: '删这一行会丢内容', text: '这一行里的内容会被丢弃，删除后无法恢复。确定删除吗？', confirmLabel: '仍然删除', confirmAriaLabel: '确认删除行' }
      : dir === 'col'
        ? { title: '删这一列会丢内容', text: '这一列里的内容会被丢弃，删除后无法恢复。确定删除吗？', confirmLabel: '仍然删除', confirmAriaLabel: '确认删除列' }
        : { title: '合并会丢内容', text: '', confirmLabel: '仍然合并', confirmAriaLabel: '确认合并' }

  /**
   * 确认层只在"待确认的那次合并正好是当前这一格"时才显示：
   * 用户中途点了别的格子就当没提过，避免把确认动作落到另一格上。
   */
  const activePending =
    pendingMerge && pendingMerge.elementId === api.selectedId && pendingMerge.cellId === selectedCellId ? pendingMerge : null

  /**
   * 当前生效的节点级目标 —— **算一次，同时喂给顶栏工具栏与右侧属性面板**。
   *
   * 为什么必须同源：用户看到顶栏写着"改：字段「产品名称」"，右侧面板却按"整个文本元素"
   * 在改字号 —— 这种自相矛盾比"没有这个功能"更难查。两处用同一个对象就不可能不一致。
   *
   * 三重校验缺一不可：
   *   ① 必须真有节点选中；
   *   ② 它必须属于**当前选中的元素**；
   *   ③ 它必须属于**当前选中的那一格**（文本元素内部为 null）。
   * 定位失效（元素/格子被删、下标越界）时 nodeAtRef 返回 null，界面自动退回上一层，
   * 不必在每条删除路径上都去清一次状态。
   */
  const nodeTarget: NodeTarget | null = useMemo(() => {
    if (!selectedNode) return null
    if (!api.selected || api.selected.id !== selectedNode.elementId) return null
    if ((selectedNode.cellId ?? null) !== (selectedCellId ?? null)) return null
    const node = nodeAtRef(doc, selectedNode)
    return node ? { ref: selectedNode, node } : null
  }, [doc, selectedNode, api.selected, selectedCellId])

  /**
   * Delete / Backspace 落在"表格内部"时该删什么（2026-09-20 修一个**数据丢失级** bug）。
   *
   * 现象（用户原话）："如果选中了单元格中的某个字段，想要删除，此时按了键盘的删除键，
   * **那么整个表格都会被删除**"。
   *
   * 根因：`useEditorState` 的全局删除处理器只挡了 `INPUT / TEXTAREA / contentEditable`，
   * 而点选单元格/字段时**焦点还在画布上** ⇒ 它拿到 `selectedId`（就是整张表）
   * 直接 `removeElement` ⇒ 一次误按把整张表连同内容一起删掉，且用户毫无预警。
   *
   * 语义改成两级，且**在表格内部时永不删元素**：
   *   ① 选中的是格子里的某个节点（字段占位符 / 文字）⇒ 只删这一个节点；
   *   ② 只选中了单元格 ⇒ 清空这一格的内容（节点 + 附件）；
   *   ③ 两者都没选中 ⇒ 交回全局处理器（那时删元素才是用户的意思）。
   *
   * `return true` = "我处理了（或有意地什么都不做）"；`false` = "交回去"。
   */
  const deleteInsideTable = useCallback((): boolean => {
    const el = api.selected
    if (!el || el.kind !== 'table') return false

    // ① 格子里的某个节点
    const ref = nodeTarget?.ref
    if (ref?.cellId) {
      const nodes = nodesAtRef(doc, ref)
      const found = findElement(doc, ref.elementId)
      if (nodes && found && found.el.kind === 'table') {
        api.mergeElement(ref.elementId, {
          rows: updateCell(found.el.rows, ref.cellId, { nodes: nodes.filter((_, i) => i !== ref.index) }),
        })
        setSelectedNode(null)
        return true
      }
    }

    // ② 选中的是单元格
    if (selectedCellId) {
      const found = findElement(doc, el.id)
      if (found && found.el.kind === 'table') {
        const loc = findCell(found.el.rows, selectedCellId)
        if (loc && (loc.cell.nodes.length > 0 || loc.cell.attachment)) {
          api.mergeElement(el.id, {
            rows: updateCell(found.el.rows, selectedCellId, { nodes: [], attachment: undefined }),
          })
        }
      }
      /**
       * ⚠️ **选中着单元格就一律吞掉这个按键**，哪怕这一格是空的。
       *
       * 这一条正是那个数据丢失 bug 的堵口：格子为空时如果 `return false` 交回去，
       * 全局处理器就会把**整张表**删掉 —— 而用户明明只是选中了一个空格子。
       */
      return true
    }

    return false
  }, [api, doc, nodeTarget, selectedCellId])

  /**
   * 把上面那条规则接到键盘上。
   *
   * ⚠️ **必须用捕获阶段**：`useEditorState` 的删除处理器挂在 `window` 的**冒泡**阶段，
   * 而捕获阶段先跑 ⇒ 这里 `stopImmediatePropagation()` 才能拦住它。
   * （本项目三个弹层 Popover / MergeConfirm / PreviewPane 都是这个写法，口径一致。）
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.ctrlKey || e.metaKey || e.altKey) return
      if (e.key !== 'Delete' && e.key !== 'Backspace') return
      const t = e.target as HTMLElement | null
      // 正在输入框里打字时不抢（与全局处理器同一口径）
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
      if (!deleteInsideTable()) return
      e.preventDefault()
      e.stopImmediatePropagation()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [deleteInsideTable])

  /**
   * 交给画布做高亮的**只有校验通过的那一个**。
   *
   * 不能把 `selectedNode` 原样传下去：用户从"格子里那个字段"退到整表时，
   * state 里可能还留着上一次的定位，画布就会继续把它圈成蓝底，而顶栏和右侧面板
   * 已经显示"整张表格"了 —— 三处各说一句话，是最难查的一类不一致。
   * 统一由 nodeTarget 派生之后，"圈着的"和"正在改的"必然是同一个东西。
   */
  const activeNodeRef = nodeTarget ? nodeTarget.ref : null

  /**
   * 改**这一处节点自己**的样式覆写。
   *
   * 与单元格 / 元素级改样式的写法刻意一致：都是"从当前文档算出新的那一小段，再 merge 回去"。
   * mergeKey 一路透传，所以连续调字号（0.5pt 一格）只占一次撤销。
   */
  const applyNodeStyle = useCallback(
    (patch: TextStyle, mergeKey?: string) => {
      const ref = nodeTarget?.ref
      if (!ref) return
      const nodes = nodesAtRef(doc, ref)
      const cur = nodes?.[ref.index]
      if (!nodes || !cur || cur.type === 'br') return
      const arr = nodes.slice()
      arr[ref.index] = withNodeStyle(cur, patch)
      if (ref.cellId) {
        const found = findElement(doc, ref.elementId)
        if (!found || found.el.kind !== 'table') return
        api.mergeElement(ref.elementId, { rows: updateCell(found.el.rows, ref.cellId, { nodes: arr }) }, mergeKey)
        return
      }
      api.mergeElement(ref.elementId, { nodes: arr }, mergeKey)
    },
    [api, doc, nodeTarget],
  )

  /** 清掉这一处的全部样式覆写（回到完全继承外层） */
  const clearNodeStyle = useCallback(() => {
    const ref = nodeTarget?.ref
    if (!ref) return
    const nodes = nodesAtRef(doc, ref)
    const cur = nodes?.[ref.index]
    if (!nodes || !cur || cur.type === 'br') return
    // 走 withNodeStyle 而不是自己 delete style：清空语义只写一份，免得以后改了那边忘了这边
    const clear: TextStyle = {}
    const bag = clear as Record<string, unknown>
    for (const k of Object.keys(cur.style ?? {})) bag[k] = undefined
    const arr = nodes.slice()
    arr[ref.index] = withNodeStyle(cur as StyledInlineNode, clear)
    if (ref.cellId) {
      const found = findElement(doc, ref.elementId)
      if (!found || found.el.kind !== 'table') return
      api.mergeElement(ref.elementId, { rows: updateCell(found.el.rows, ref.cellId, { nodes: arr }) })
      return
    }
    api.mergeElement(ref.elementId, { nodes: arr })
    notice('已清除这一处的样式覆写，它现在完全跟随外层')
  }, [api, doc, nodeTarget, notice])

  /**
   * 改这一处系统变量自己的属性（时间格式 / 要不要「共 N 页」）。
   *
   * 和 applyNodeStyle 共用同一套"写到哪个容器"的判断（格子 or 元素），
   * 但走的是 withSysVarProps —— 这两项不是样式，不该被「清除覆写」清掉，
   * 也不该混进 nodeStyleCount。
   */
  const applyNodeProps = useCallback(
    (patch: { format?: string; hideTotal?: boolean }) => {
      const ref = nodeTarget?.ref
      if (!ref) return
      const nodes = nodesAtRef(doc, ref)
      const cur = nodes?.[ref.index]
      if (!nodes || !isSysVarNode(cur)) return
      const arr = nodes.slice()
      arr[ref.index] = withSysVarProps(cur, patch)
      if (ref.cellId) {
        const found = findElement(doc, ref.elementId)
        if (!found || found.el.kind !== 'table') return
        api.mergeElement(ref.elementId, { rows: updateCell(found.el.rows, ref.cellId, { nodes: arr }) })
        return
      }
      api.mergeElement(ref.elementId, { nodes: arr })
    },
    [api, doc, nodeTarget],
  )

  /**
   * 顶栏「预览」：在编辑器里直接看打印效果。
   *
   * **走的就是第③步那一条 `renderDocument` 管线**（见 preview.ts 的模块注释）。
   * 这里只负责开浮层与收状态，一行排版逻辑都没有。
   */
  const openPreview = useCallback(() => {
    previewAbort.current?.abort()
    const ac = new AbortController()
    previewAbort.current = ac
    setPreview({ open: true, result: null, error: null, busy: '正在排版…' })
    void renderEditorPreview({ doc, fields, kind, records, signal: ac.signal })
      .then((r) => {
        if (ac.signal.aborted) return
        setPreview({ open: true, result: r, error: null, busy: null })
      })
      .catch((e: unknown) => {
        if (ac.signal.aborted) return
        setPreview({ open: true, result: null, error: e instanceof Error ? e.message : String(e), busy: null })
      })
  }, [doc, fields, kind, records])

  const closePreview = useCallback(() => {
    previewAbort.current?.abort()
    previewAbort.current = null
    setPreview((s) => ({ ...s, open: false }))
  }, [])

  useEffect(
    () => () => {
      previewAbort.current?.abort()
    },
    [],
  )

  // ---- 插入 ----
  const nextFreeY = useCallback(
    (band: BandKey): number => {
      let bottom = 0
      for (const el of band === 'loop' ? doc.bands.loop.elements : doc.bands[band]) {
        const b = finite(el.y, 0) + (el.h === 'auto' ? 12 : finite(el.h, 10))
        if (b > bottom) bottom = b
      }
      return Math.min(Math.round((bottom + 3) * 10) / 10, Math.max(0, api.layout.contentHMm - 5))
    },
    [api.layout.contentHMm, doc.bands],
  )

  /** 面板拖出来的东西 → 一个待插入的元素。拖拽开始时算一次就够，拖动过程中不必反复造对象 */
  const buildPayloadElement = useCallback(
    (payload: PaletteDrag): AnyElement => {
      const contentW = api.layout.contentWMm
      if (payload.insert.type === 'sysvar') {
        const key: SysVarKey = payload.insert.key
        const base = createDefaultElement({ kind: 'text', text: '' }, contentW)
        const el: AnyElement =
          base.kind === 'text' ? { ...base, w: Math.min(contentW, 34), nodes: [{ type: 'sysvar', key } satisfies InlineSysVar] } : base
        return applyDefaultTextStyle(el, defaultTextStyle)
      }
      return applyDefaultTextStyle(createDefaultElement(payload.insert.spec, contentW), defaultTextStyle)
    },
    [api.layout.contentWMm, defaultTextStyle],
  )

  /**
   * 这个拖拽载荷能被**单元格**装下的话，对应的行内节点是什么；装不下返回 null。
   *
   * 能进格子的只有"一段行内内容"：字段占位符、系统变量、纯文字。
   * 表格 / 图片 / 二维码 / 分页符这些是块级元素，格子装不下 —— 说清楚比默默叠上去好。
   */
  const inlineNodeOf = useCallback((payload: PaletteDrag): InlineNode | null => {
    if (payload.insert.type === 'sysvar') return { type: 'sysvar', key: payload.insert.key }
    const spec = payload.insert.spec
    if (spec.kind !== 'fieldBlock') return null
    /*
     * 附件字段不在"行内内容"这条路上 —— 它要作为**块级子元素（`attach`）**住进格子，
     * 见下面的 `cellBlockElementOf`。塞成一行文字只会变成一个没有意义的占位符。
     */
    if (fieldMeta(spec.fieldType).renderKind === 'attachment') return null
    return { type: 'field', fieldId: spec.fieldId ?? null, fieldName: spec.fieldName ?? '' }
  }, [])

  /**
   * 这个拖拽载荷能不能作为**块级元素住进单元格**；能就把它建出来（不能返回 null）。
   *
   * ⚠️⚠️ 判据必须是**建出来的那个元素的 `kind`**，不能是载荷自己的 `spec.kind`。
   *
   * 真机反馈 2026-09-23 第 10 条就是这么来的：用户把左侧的「附件」字段拖进表格，
   * 弹的是"格子里能放图片 / 二维码 / …，装不下「异常照片1-3」"。
   * 病根：附件在载荷上是 `{kind:'fieldBlock', fieldType:附件}`，而 `createDefaultElement`
   * 会把它建成一个 **`attach` 元素**（附件字段拖到画布上本来就是附件块）。
   * 按 `spec.kind === 'fieldBlock'` 去查 `CELL_BLOCK_KINDS` ⇒ 查不到 ⇒ 一条"装不下"把它挡在外面，
   * 尽管**允许名单里明明有 `attach`**。
   *
   * 它被**两处**共用：拖拽过程中的落点判定（这一放能不能成）与松手时的实际插入 ——
   * 两处各建一次、各判一次，迟早会出现"判能成、插不进去"（或者反过来）。
   */
  const cellBlockElementOf = useCallback(
    (payload: PaletteDrag): AnyElement | null => {
      if (payload.insert.type !== 'element') return null
      const built = applyDefaultTextStyle(buildPayloadElement(payload), defaultTextStyle)
      return CELL_BLOCK_KINDS.includes(built.kind) ? built : null
    },
    [buildPayloadElement, defaultTextStyle],
  )

  /**
   * 按"画出来的框"建一张表（规格 一 后半句的落地动作）。返回是否真的建了。
   *
   * ⚠️ 两条入口**共用这一份**：① 面板拖拽时拖出矩形；② 画布上的「拖出表格」按钮。
   *    两处各写一遍的话，"框太小要退回默认"之类的判据迟早只改一处。
   */
  const insertTableRect = useCallback(
    (box: { xMm: number; yMm: number; wMm: number; hMm: number }): boolean => {
      if (!(box.wMm >= 20 && box.hMm >= 6)) return false
      const { rows, cols } = tableSizeFromRect(box.wMm, box.hMm, api.layout.contentWMm)
      /* 与面板插入**同一条口径**（`withViewMergedTable`）：视图模板 + 循环区只此一表 ⇒ 默认合并成连续大表。
         两处各写一遍一定会分叉 —— 这条纪律在本项目已经栽过多次。 */
      const el = withViewMergedTable(createDefaultElement({ kind: 'table', rows, cols }, api.layout.contentWMm), 'loop')
      const placed: AnyElement = {
        ...el,
        x: Math.round(Math.max(0, Math.min(box.xMm, api.layout.contentWMm - Math.max(4, el.w))) * 10) / 10,
        y: Math.round(Math.max(0, box.yMm) * 10) / 10,
        w: Math.round(Math.min(box.wMm, api.layout.contentWMm) * 10) / 10,
      }
      api.addElement(placed, 'loop')
      setNewTableId(placed.id)
      notice(`已插入 ${rows} 行 × ${cols} 列的表格（按你拖出的框换算）`)
      return true
    },
    [api, notice],
  )

  /**
   * 落点高度 ⇒ 目标版式区（真机反馈 2026-09-22：「当前没办法直接拖动元素到表头区和表尾区，
   * 都只能靠右侧的属性栏调整」）。
   *
   * 根因：`insertPayload(payload, at)` 的 `band` 参数一直用默认值 `'loop'` ——
   * 落在表头/表尾区域也照样建到循环区里 ⇒ 用户"放不进去"。
   */
  const bandAtY = useCallback(
    (yMm: number): BandKey => {
      if (yMm < api.layout.loopTopMm) return 'header'
      if (yMm >= api.layout.footerTopMm) return 'footer'
      return 'loop'
    },
    [api.layout.footerTopMm, api.layout.loopTopMm],
  )

  /**
   * 视图模板里**拖进循环区的表格默认"合并成一张连续大表"**（真机反馈 2026-09-23 第 4 条）。
   *
   * 用户原话：「视图模板打印的效果，正常应该是表格内的**标题行只出现一次**，
   * 然后循环的数据在表格内**自动添加行数**，批量打印才对，当前的效果更像是记录模板打印」。
   *
   * 为什么是"默认开"而不是"让用户自己开"：这个开关（`rowsFromRecords`）只在**表格属性面板**
   * 里，而用户是"拖一张表进循环区"——他不会想到还要去某个面板里再勾一下；
   * 而他看到的结果（一记录一张表，标题行刷 5 遍）显然不是他要的。
   *
   * 四个**同时满足**才开（这只是"给个合理默认值"，用户随时可在表格属性面板里改）：
   *   ① 载荷是表格；② 落在**循环区**；③ 插入时循环区**还是空的**（= 它插进去后就是唯一那张表）；
   *   ④ 模板是**视图模板**（记录模板"一条一份"本来就该一记录一张表）。
   *
   * ⚠️ 2026-09-23 第 7 条放宽之后，「循环区恰好一个元素」**不再是渲染层的前提** ——
   * 表格下方还有别的元素时，渲染层照样会铺成连续大表（那些元素只按第一条记录渲染一次）。
   * 这里保留条件 ③ 只是因为"用户刚拖进来的第一张表"开合并最符合直觉，不是因为渲染层要求它。
   */
  const withViewMergedTable = useCallback<(el: AnyElement, band: BandKey) => AnyElement>(
    (el, band) =>
      kind === 'view' &&
      band === 'loop' &&
      el.kind === 'table' &&
      api.doc.bands.loop.elements.length === 0 &&
      el.rowsFromRecords !== false
        ? { ...el, rowsFromRecords: true }
        : el,
    [api.doc.bands.loop.elements.length, kind],
  )

  const insertPayload = useCallback(
    (payload: PaletteDrag, at: { xMm: number; yMm: number } | null, band: BandKey = 'loop') => {
      const el = withViewMergedTable(buildPayloadElement(payload), band)
      // 落点在右边缘时把 x 收回来，避免一放上去就"超出纸张"（宽度仍是满版心）
      const maxX = Math.max(0, api.layout.contentWMm - Math.max(4, finite(el.w, 20)))
      const placed: AnyElement = {
        ...el,
        x: at ? Math.min(Math.max(0, at.xMm), Math.round(maxX * 10) / 10) : 0,
        y: at ? at.yMm : nextFreeY(band),
      }
      api.addElement(placed, band)
      if (layout !== 'wide') setTab('style')
      // 表格插完就浮出尺寸面板（默认已经是 3 行 4 列，用户想微调再点）
      setNewTableId(placed.kind === 'table' ? placed.id : null)
      if (placed.kind === 'image' && !placed.dataUrl) notice('图片元素已插入，请在属性面板选择本地图片（单张 ≤300KB）')
    },
    [api, buildPayloadElement, layout, nextFreeY, notice],
  )

  /**
   * 把一次字段投放**塞进某个单元格**（而不是在表格上再浮一个元素）。
   *
   * 用户的原话是"从左侧拖入的其他字段无法放置到单元格内，似乎是漂浮在单元格上了"：
   * 拖到表格上时，落点明明在某个格子里，代码却只会新建一个绝对定位的字段块压在表格上——
   * 看起来就是"漂着"。这里改成直接写进那个格子的 `nodes`，行为和"双击格子打字"完全一致。
   */
  /**
   * 把面板里的东西放进**指定单元格**。返回要展示给用户的那句话（`false` = 装不下、已取消）。
   *
   * ⚠️ 返回值从 `boolean` 改成 `string | false`：因为「替换掉了格子里原来那个」这件事
   *    **必须说出来**（静默替换 = 丢数据），而提示语由调用方统一 `notice`。
   *    原来返回 boolean 时，我只能在函数里先 notice 一次 —— 紧接着又被调用方的
   *    「已放进「X」」覆盖掉，用户根本看不到「被替换了」。
   */
  const insertIntoCell = useCallback(
    (payload: PaletteDrag, tableId: string, cellId: string): string | false => {
      const found = findElement(api.doc, tableId)
      if (!found || found.el.kind !== 'table') return false
      /*
       * ① 块级元素（图片 / 码 / 水平线 / 文本块 / **附件字段块**）⇒ 作为**子元素驻留**（规格 六）。
       *    名单的唯一来源是 `CELL_BLOCK_KINDS`，而**判据取"建出来的元素"**（见 cellBlockElementOf 的注释）。
       */
      const block = cellBlockElementOf(payload)
      if (block) {
        /* 传格宽：码的 `w` 要按 `18mm / 格宽` 反算，外层绿框才会贴着码（第四批第 3 / 5 条） */
        const child = normalizeChildInCell(block, cellWidthMm(found.el, cellId))
        const r = attachChildToCell(found.el, cellId, child)
        if (!r) return false
        api.mergeElement(tableId, r.patch)
        api.select(tableId)
        setSelectedCellId(cellId)
        if (layout !== 'wide') setTab('style')
        return r.replaced ? `已放进单元格（格子里原来那个「${payload.label}」被替换掉了）` : '已放进单元格'
      }

      // ② 行内内容（字段 / 系统变量 / 文字）⇒ 老路：进 `nodes`
      const node = inlineNodeOf(payload)
      if (!node) return false
      const loc = findCell(found.el.rows, cellId)
      /*
       * 标题行 / 标题列里**不放字段**（真机反馈 2026-09-23 第 9 条）。
       * 这里是**真正的闸门**（`resolveDrop` 里那条只是提前把话说清）——
       * 两条都要有：少了这条，拖拽之外的路（比如以后加个"点一下插入"）会绕过去。
       */
      if (node.type === 'field' && loc && isHeaderCellAt(found.el, cellId)) {
        notice('标题行 / 标题列里不放字段，请放到下面的数据格子里')
        return false
      }
      const empties = loc ? loc.cell.nodes.length === 0 : true
      const rows = updateCell(found.el.rows, cellId, {
        // 格子里已经有内容时补一个分隔，别把两段粘成一个词
        nodes: loc ? [...loc.cell.nodes, ...(empties ? [] : [{ type: 'text', text: ' ' } as const]), node] : [node],
      })
      api.mergeElement(tableId, { rows })
      // 顺手选中这个格子：用户能立刻看到"东西进哪儿了"，也能接着改内容
      api.select(tableId)
      setSelectedCellId(cellId)
      if (layout !== 'wide') setTab('style')
      return '已放进单元格'
    },
    [api, buildPayloadElement, defaultTextStyle, layout],
  )

  /**
   * 拖拽会话：pointerdown 起，document 上的 pointermove/pointerup 结束。
   * 位移小于 4px 视为"点击"，按点击插入处理 —— 用户不必学两套操作。
   */
  const beginPaletteDrag = useCallback(
    (payload: PaletteDrag, e: ReactPointerEvent) => {
      if (e.button !== 0) return
      e.preventDefault()
      const startX = e.clientX
      const startY = e.clientY
      let moved = false
      const ghost = ghostRef.current
      // 载荷在整段拖拽里不会变，判定用的探针算一次就够
      /** 只有「表格」载荷支持拖出矩形换算行列数（规格 一 后半句） */
      const rectDrag = payload.insert.type === 'element' && payload.insert.spec.kind === 'table'
      /** 最后一次算出的矩形（松手时要读它） */
      const lastRectRef: { current: { xMm: number; yMm: number; wMm: number; hMm: number } | null } = {
        current: null,
      }
      const probe: DropProbe = {
        inline: inlineNodeOf(payload) !== null,
        // ⚠️ 判据取**建出来的元素**（见 cellBlockElementOf）：附件字段的载荷是 fieldBlock，
        //    但它建出来是 attach —— 按 spec.kind 判会让附件字段在"落点判定"这一关就被拒，
        //    用户眼前弹出的是"装不下「异常照片1-3」"（真机反馈第 10 条）。
        cellBlock: cellBlockElementOf(payload) !== null,
        // 字段载荷 —— 用来在**拖动过程中**就挡掉"标题行/标题列"（第 9 条）
        field: inlineNodeOf(payload)?.type === 'field',
        label: payload.label,
      }
      /** 上一次报给画布的判定结果，用来避免每帧都 setState（那会让整张画布重渲染） */
      let lastSig = ''

      const verdictAt = (x: number, y: number): DropVerdict | null =>
        moved ? canvasRef.current?.resolveDrop(x, y, probe) ?? null : null

      const onMove = (ev: PointerEvent): void => {
        const dx = ev.clientX - startX
        const dy = ev.clientY - startY
        if (!moved) {
          if (Math.abs(dx) + Math.abs(dy) < 4) return
          moved = true
          // 只有真的开始拖了才隐藏抽屉 + 亮出 ghost：
          // 单纯点一下插入不该让面板闪一下
          setDropLabel(payload.label)
          if (ghost) ghost.style.display = 'flex'
        }
        // 直接改 transform：走 state 的话每一帧都会重渲染整张画布，拖动会掉帧
        if (ghost) ghost.style.transform = `translate3d(${ev.clientX + 12}px, ${ev.clientY + 12}px, 0)`

        // 实时反馈：**松手之前**就告诉用户这一下成不成。
        // 只在"判定结果真的变了"时更新 state —— 拖动时 pointermove 每秒几十次，
        // 每次都 setState 会让画布每帧重渲染。
        /*
         * 表格走**拖出矩形**这条路（规格 一 后半句）：按下点到当前位置的矩形，
         * 松手时按它的宽高换算行列数。其它载荷保持原来的落点判定。
         * ⚠️ 矩形要用**同一个** `resolveDrop` 拿 mm（它内部会把落点夹进版心），
         *    自己另算一套 px→mm 就会和「真正插进去的位置」差一个页边距。
         */
        if (rectDrag) {
          const a = canvasRef.current?.resolveDrop(startX, startY, probe) ?? null
          const b = canvasRef.current?.resolveDrop(ev.clientX, ev.clientY, probe) ?? null
          if (a && b && a.kind === 'free' && b.kind === 'free') {
            const box: DropTarget = {
              kind: 'rect',
              xMm: Math.min(a.xMm, b.xMm),
              yMm: Math.min(a.yMm, b.yMm),
              wMm: Math.abs(b.xMm - a.xMm),
              hMm: Math.abs(b.yMm - a.yMm),
            }
            const sig2 = `rect:${Math.round(box.xMm)}:${Math.round(box.yMm)}:${Math.round(box.wMm)}:${Math.round(box.hMm)}`
            if (sig2 !== lastSig) {
              lastSig = sig2
              lastRectRef.current = box
              setDropTarget(box)
            }
            return
          }
        }

        const v = verdictAt(ev.clientX, ev.clientY)
        const next: DropTarget =
          v?.kind === 'cell' ? { kind: 'cell', cellId: v.cellId } : v?.kind === 'reject' ? { kind: 'reject', reason: v.reason } : null
        const sig = next ? `${next.kind}:${next.kind === 'cell' ? next.cellId : next.reason}` : ''
        if (sig !== lastSig) {
          lastSig = sig
          setDropTarget(next)
        }
      }

      const onUp = (ev: PointerEvent): void => {
        document.removeEventListener('pointermove', onMove)
        document.removeEventListener('pointerup', onUp)
        document.removeEventListener('pointercancel', onUp)
        if (ghost) ghost.style.display = 'none'
        setDropLabel(null)
        setDropTarget(null)
        if (!moved) {
          // 没拖动 = 单击插入，保持老行为（落点由 nextFreeY 找空位，不会压到别人）
          insertPayload(payload, null)
          return
        }
        /* 表格 + 拖出了像样的矩形 ⇒ 按矩形宽高换算行列数建表（而不是插一张固定 3×4） */
        if (rectDrag && lastRectRef.current && insertTableRect(lastRectRef.current)) return

        const v = verdictAt(ev.clientX, ev.clientY)
        if (v?.kind === 'cell') {
          const placed = insertIntoCell(payload, v.tableId, v.cellId)
          if (placed) {
            notice(`${placed}（${v.label}）`)
            return
          }
          notice('这个单元格装不下它，已取消')
          return
        }
        if (v?.kind === 'reject') {
          // 拒绝时必须**当场把理由说出来**：用户反复抱怨"拖了没反应"，
          // 静默弹回原位正是他要的那个"没反应"。
          notice(v.reason)
          return
        }
        const at = canvasRef.current?.hitTest(ev.clientX, ev.clientY) ?? null
        const band = at ? bandAtY(at.yMm) : 'loop'
        /*
         * ⚠️ 表尾区的元素坐标是**相对该区上边界**的（见 `bandTopMm`）⇒ 落点要减去区起点，
         *    否则元素会被再加一次偏移、直接掉出版心。
         */
        const local = at && band === 'footer' ? { ...at, yMm: at.yMm - api.layout.footerTopMm } : at
        insertPayload(payload, local, band)
      }
      document.addEventListener('pointermove', onMove)
      document.addEventListener('pointerup', onUp)
      document.addEventListener('pointercancel', onUp)
    },
    [insertIntoCell, insertPayload, insertTableRect, inlineNodeOf, notice],
  )

  /**
   * Palette 的拖拽回调必须保持引用稳定，否则拖动元素时每一帧都会连带重渲染整个字段面板
   * （30+ 个字段胶囊）。用 ref 转发即可把回调从 api 对象的"每次渲染都变"里解耦出来。
   */
  const beginDragRef = useRef(beginPaletteDrag)
  beginDragRef.current = beginPaletteDrag
  const stableDragStart = useCallback(
    (payload: PaletteDrag, e: ReactPointerEvent) => beginDragRef.current(payload, e),
    [],
  )

  // ---- 检查条 ----
  const { invalidElementIds, unboundElementIds, outOfBoundsElementIds, issues } = api.analysis
  const blockCount = new Set([...invalidElementIds, ...unboundElementIds]).size
  const warnCount = outOfBoundsElementIds.length
  const totalIssues = blockCount + warnCount

  const gotoIssue = useCallback(
    (elementId: string) => {
      api.select(elementId)
      setSelectedCellId(null)
      if (layout !== 'wide') setTab('style')
      canvasRef.current?.scrollToElement(elementId)
    },
    [api, layout],
  )

  const commitName = (): void => {
    const next = nameDraft.trim()
    setNameEditing(false)
    if (!next || next === templateName) {
      setNameDraft(templateName)
      return
    }
    onRename?.(next)
  }

  const paletteTab: PaletteTab = tab === 'elements' ? 'elements' : 'fields'

  const elementCount = useMemo(
    () => doc.bands.header.length + doc.bands.loop.elements.length + doc.bands.footer.length,
    [doc.bands],
  )

  const dirty = api.dirty
  useEffect(() => {
    onDirtyChange?.(dirty)
  }, [dirty, onDirtyChange])

  /**
   * 页面设置的内容 —— 右侧「页面属性」面板与顶栏「页面设置」弹层**共用这一份**。
   * 用户要求把"页面的相关设置"收进顶栏那个按钮里；抄一份过去就意味着以后加一个页面字段
   * 只有其中一个入口有。右栏入口按原样保留（宽屏下它才是主入口）。
   */
  const pageSettingsNode = (
    <PagePanel
      doc={doc}
      fields={fields}
      layout={api.layout}
      selected={null}
      selectedBand={api.selectedBand}
      selectedCellId={null}
      defaultTextStyle={defaultTextStyle}
      onPageSetup={api.setPageSetup}
      onSetLoopOffset={api.setLoopOffset}
      onSetBandEnabled={api.setBandEnabled}
      onDefaultTextStyle={(p) => setDefaultTextStyle((s) => ({ ...s, ...p }))}
      onMerge={api.mergeElement}
      onRemove={api.removeElement}
      onSetBand={api.setElementBand}
      onSelectCell={handleSelectCell}
      // 页面设置面板用不到合并，但 `PagePanel` 的 props 就是整套 `InspectorProps`
      // （它已经忽略 onMerge / onRemove / onSetBand 等好多项），这里按同一口径给全
      onAskMerge={requestMerge}
      onNotice={notice}
    />
  )

  const inspectorNode = (
    <Inspector
      doc={doc}
      fields={fields}
      layout={api.layout}
      selected={api.selected}
      selectedBand={api.selectedBand}
      selectedCellId={selectedCellId}
      /* 格内子元素 → 面板换一套尺寸控件（见 InspectorProps.selectedInCell 的注释）。
         来源是 `api.selectedInCell`（由 `findCellChild` 下钻得到），面板里不再自己判 id 前缀。 */
      selectedInCell={api.selectedInCell}
      selectedNode={activeNodeRef}
      defaultTextStyle={defaultTextStyle}
      onPageSetup={api.setPageSetup}
      onSetLoopOffset={api.setLoopOffset}
      onSetBandEnabled={api.setBandEnabled}
      onDefaultTextStyle={(p) => setDefaultTextStyle((s) => ({ ...s, ...p }))}
      onMerge={api.mergeElement}
      onRemove={api.removeElement}
      onSetBand={api.setElementBand}
      onSelectCell={handleSelectCell}
      onAskMerge={requestMerge}
      onNodeStyle={applyNodeStyle}
      onClearNodeStyle={clearNodeStyle}
      onNodeProps={applyNodeProps}
      onSelectNode={handleSelectNode}
      onNotice={notice}
    />
  )

  const paletteNode = <Palette tab={paletteTab} fields={fields} onDragStart={stableDragStart} onNotice={notice} />

  /**
   * 「检查」面板（2026-09-18 用户要求新增）：列出画布上**已经放上去的**全部元素与字段，
   * 点一下就在画布上选中它（`api.select` 会把画布滚到可视区并画上选中框），
   * 行内还带一个删除按钮 —— 专门解决"不小心拖进来一个、又点不中它"。
   */
  const inspectNode = (
    <InspectPanel
      doc={doc}
      fields={fields}
      selectedId={api.selectedId}
      onSelect={handleSelect}
      onRemove={api.removeElement}
    />
  )

  const showLeftPane = layout === 'wide' ? leftOpen : layout === 'mid' && tab !== null
  const showRightPane = layout === 'wide' && rightOpen

  return (
    <div
      className="bp-editor"
      ref={rootRef}
      data-layout={layout}
      style={{ '--bp-canvas-pad': `${canvasPad}px` } as unknown as CSSProperties}
    >
      {/* ---------------- 顶栏 ---------------- */}
      <header className="bp-top">
        <div className="bp-top__row">
          <button
            type="button"
            className="bp-iconbtn"
            aria-label="返回模板列表"
            title={busy ? '正在保存…' : '返回'}
            disabled={busy}
            onClick={onCancel}
          >
            <IconBack size={16} />
          </button>

          {nameEditing ? (
            <input
              className="bp-name__input"
              value={nameDraft}
              autoFocus
              aria-label="模板名称"
              onChange={(e) => setNameDraft(e.target.value)}
              onBlur={commitName}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitName()
                if (e.key === 'Escape') {
                  setNameDraft(templateName)
                  setNameEditing(false)
                }
              }}
            />
          ) : (
            <button
              type="button"
              className="bp-name"
              title="点击改名"
              aria-label={`模板名称：${templateName}，点击修改`}
              onClick={() => setNameEditing(true)}
            >
              {templateName || '未命名模板'}
            </button>
          )}

          <div className="bp-top__spacer" />

          {/* 容器塞进来的画布级动作（全屏 / 缩小），紧挨「完成」左边 */}
          {topActions}

          {/*
            撤销 / 重做**不在这里**了：它们挪到了下面那条工具行的最右端（见 <Toolbar/>）。
            用户给的参照是官方那套工具条的排法 —— 左边文本编辑、右边纸张与页面、最右撤销/重做，
            "改完随手一个撤销"就在手指边上；这一行留给模板级动作（返回 / 改名 / 完成）。
          */}
          {/*
            ⚠️ `busy` 时禁用（2026-09-21）：落库期间再点一次，
            「新建模板」那条路会**建出两个模板**（`commitEditor` 每次都会 `createTemplate`）。
            显示「保存中…」而不是只禁用 —— 否则用户以为"点了没反应"。
          */}
          <button
            type="button"
            className="bp-btn bp-btn--primary"
            disabled={busy}
            onClick={() => {
              // E-46：空模板阻断，不让用户带着一张白纸去预览
              if (elementCount === 0) {
                notice('模板还是空的，请先从「字段」或「元素」面板拖入内容')
                setCheckOpen(false)
                return
              }
              if (totalIssues > 0) notice(`模板还有 ${totalIssues} 项待处理，建议先修正后再继续`)
              onDone()
            }}
          >
            <IconCheck size={14} /> {busy ? '保存中…' : '完成'}
          </button>
        </div>

        <div className="bp-top__row bp-top__row--sub">
          {layout === 'wide' ? (
            <>
              <button
                type="button"
                className={`bp-iconbtn bp-iconbtn--toggle${leftOpen ? ' is-on' : ''}`}
                aria-pressed={leftOpen}
                aria-label="显示或隐藏插入面板"
                title={leftOpen ? '隐藏插入面板' : '显示插入面板'}
                onClick={() => setLeftOpen((v) => !v)}
              >
                <IconPanelLeft size={15} />
              </button>
              <button
                type="button"
                className={`bp-iconbtn bp-iconbtn--toggle${rightOpen ? ' is-on' : ''}`}
                aria-pressed={rightOpen}
                aria-label="显示或隐藏属性面板"
                title={rightOpen ? '隐藏属性面板' : '显示属性面板'}
                onClick={() => setRightOpen((v) => !v)}
              >
                <IconPanelRight size={15} />
              </button>
              <span className="bp-top__meta">
                版心 {round1(api.layout.contentWMm)}×{round1(api.layout.contentHMm)}mm
                <span className="bp-top__sep" aria-hidden>
                  ·
                </span>
                {elementCount} 个元素
              </span>
              {/* 宽屏下左内容、右缩放；窄屏下让页签自己吃掉余量，别再插一个 spacer */}
              <div className="bp-top__spacer" />
            </>
          ) : (
            <div className="bp-tabs" role="tablist" aria-label="编辑器面板">
              {(
                [
                  { key: 'fields', label: '字段' },
                  { key: 'elements', label: '元素' },
                  { key: 'inspect', label: '检查' },
                  { key: 'style', label: '样式' },
                ] as { key: DrawerTab; label: string }[]
              ).map((t) => (
                <button
                  key={t.key}
                  type="button"
                  role="tab"
                  aria-selected={tab === t.key}
                  className={`bp-tabs__item${tab === t.key ? ' is-active' : ''}`}
                  title={tab === t.key ? '再次点击收起面板' : undefined}
                  onClick={() => setTab((cur) => (cur === t.key ? null : t.key))}
                >
                  {t.label}
                </button>
              ))}
            </div>
          )}

          <div className="bp-zoomctl">
            <button
              type="button"
              className="bp-zoomctl__step"
              aria-label="缩小画布"
              title="缩小"
              disabled={scale <= MIN_SCALE + 1e-6}
              onClick={() => stepZoom(-1)}
            >
              <IconMinus size={13} />
            </button>
            <Popover
              role="listbox"
              ariaLabel="画布缩放"
              matchTriggerWidth
              width={148}
              renderTrigger={({ open, toggle, buttonRef }) => (
                <button
                  ref={buttonRef}
                  type="button"
                  className={`bp-zoomctl__value${open ? ' is-open' : ''}`}
                  aria-haspopup="listbox"
                  aria-expanded={open}
                  aria-label={`画布缩放：${zoomLabel}`}
                  title="画布缩放"
                  onClick={toggle}
                >
                  <span className="bp-zoomctl__pct">{zoomLabel}</span>
                  <span className={`bp-zoomctl__caret${open ? ' is-open' : ''}`}>
                    <IconCaret size={11} />
                  </span>
                </button>
              )}
            >
              {({ close }) => (
                <ul className="bp-picker__list">
                  {ZOOM_PRESETS.map((o) => {
                    const active = zoomKey === o.value
                    return (
                      <li key={o.value} className="bp-picker__opt-wrap">
                        <button
                          type="button"
                          role="option"
                          aria-selected={active}
                          className={`bp-picker__opt${active ? ' is-active' : ''}`}
                          title={o.hint ?? o.label}
                          onClick={() => {
                            setZoomKey(o.value)
                            close()
                          }}
                        >
                          <span className="bp-picker__opt-label">{o.label}</span>
                          {o.value === 'fit' ? (
                            <span className="bp-picker__opt-tag">{Math.round(fitScale * 100)}%</span>
                          ) : null}
                          {active ? <span className="bp-picker__tick" aria-hidden /> : null}
                        </button>
                      </li>
                    )
                  })}
                </ul>
              )}
            </Popover>
            <button
              type="button"
              className="bp-zoomctl__step"
              aria-label="放大画布"
              title="放大"
              disabled={scale >= MAX_SCALE - 1e-6}
              onClick={() => stepZoom(1)}
            >
              <IconPlus size={13} />
            </button>
          </div>
        </div>

        {/* ---- 工具行：文本编辑 + 纸张/方向 + 页面设置 + 在此页预览打印效果 + 撤销/重做 ---- */}
        <Toolbar
          doc={doc}
          kind={kind}
          nodeTarget={nodeTarget}
          selected={api.selected}
          selectedCellId={selectedCellId}
          defaultTextStyle={defaultTextStyle}
          compact={layout !== 'wide'}
          canUndo={api.canUndo}
          canRedo={api.canRedo}
          onUndo={api.undo}
          onRedo={api.redo}
          onPatchNodeStyle={applyNodeStyle}
          onClearNodeStyle={clearNodeStyle}
          onClearNode={() => setSelectedNode(null)}
          onDefaultTextStyle={(p) => setDefaultTextStyle((s) => ({ ...s, ...p }))}
          onMerge={api.mergeElement}
          onAskMerge={requestMerge}
          onPageSetup={api.setPageSetup}
          onPreview={openPreview}
          pageSettings={pageSettingsNode}
          contentLabel={
            // 宽屏副行里已经有一份带「版心」前缀的读数，这里的窄档版本省掉前缀换两三个控件的位置
            layout === 'wide'
              ? `版心 ${round1(api.layout.contentWMm)}×${round1(api.layout.contentHMm)}mm · ${elementCount} 个元素`
              : `${round1(api.layout.contentWMm)}×${round1(api.layout.contentHMm)}mm · ${elementCount} 个元素`
          }
        />
      </header>

      {/* ---------------- 主体：侧栏 + 画布 ---------------- */}
      <div className="bp-body">
        {showLeftPane ? (
          <aside className="bp-side bp-side--left">
            {layout === 'wide' ? (
              <div className="bp-side__head">
                <div className="bp-seg bp-seg--tabs" role="tablist" aria-label="插入面板">
                  {(
                    [
                      { key: 'fields', label: '字段' },
                      { key: 'elements', label: '元素' },
                      { key: 'inspect', label: '检查' },
                    ] as { key: DrawerTab; label: string }[]
                  ).map((t) => (
                    <button
                      key={t.key}
                      type="button"
                      role="tab"
                      aria-selected={paletteTab === t.key}
                      className={`bp-seg__item${paletteTab === t.key ? ' is-active' : ''}`}
                      onClick={() => setTab(t.key)}
                    >
                      <span className="bp-seg__text">{t.label}</span>
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <div className="bp-side__head">
                <span className="bp-side__title">
                  {tab === 'style' ? '属性' : tab === 'elements' ? '元素' : '字段'}
                </span>
                <button
                  type="button"
                  className="bp-iconbtn bp-iconbtn--sm"
                  aria-label="收起面板"
                  title="收起面板"
                  onClick={() => setTab(null)}
                >
                  <IconPanelLeft size={14} />
                </button>
              </div>
            )}
            <div className="bp-side__body">
              {tab === 'inspect' ? inspectNode : tab === 'style' && layout !== 'wide' ? inspectorNode : paletteNode}
            </div>
          </aside>
        ) : null}

        <div className="bp-canvas-area" ref={canvasAreaRef}>
          <Canvas
            ref={canvasRef}
            /*
             * 画布上的页边距红线被点击 ⇒ 改这一侧的边距（2026-09-19）。
             *
             * 这里**逐条赋值**而不是 `{ ...m, [side]: mm }`：
             * 计算属性名会把对象类型拓宽成 `{ [x: string]: number }`，
             * 于是 `margin` 不再满足 `PageMargin`，TS 会拦下来。显式四分支最稳、也最好读。
             */
            onElementIntoCell={(elementId, tableId, cellId) => {
              /**
               * 拖动已有元素、松手落在单元格上 ⇒ **把它变成这一格的内容**
               * （2026-09-19 用户要求："从画布中拖其他元素或者字段到表格上时，
               * 可以自动吸附到单元格内完成绑定"）。
               *
               * 能转的只有两类，因为**单元格里只装行内节点**（文字 / 字段占位符 / 系统变量）：
               *   · 字段块 ⇒ 一个字段占位符
               *   · 文本   ⇒ 它的行内节点原样搬过来（字段占位符一并保留）
               * 其余（表格 / 图片 / 附件 / 二维码 / 分隔线 / 分页符）**结构上装不进单元格**，
               * 必须明说原因 —— 静默什么都不发生正是用户最烦的那种"没反应"。
               */
              const pools = [doc.bands.header ?? [], doc.bands.loop?.elements ?? [], doc.bands.footer ?? []]
              const el = pools.flat().find((e) => e.id === elementId)
              if (!el) return false
              const table = pools.flat().find((e) => e.id === tableId)
              if (!table || table.kind !== 'table') return false

              /*
               * 规格 六（2026-09-22）：**图片 / 二维码 / 条形码 / 水平线**现在能真的"住进"格子里了
               * —— 它们作为块级子元素存进 `TableCell.children`（原来只能拒绝）。
               * 文本与字段块仍走老路（转成行内节点）：它们本来就是行内内容，放进 `nodes` 更自然
               * （能被格子的对齐/字号统一管）。
               */
              if (CELL_BLOCK_KINDS.includes(el.kind)) {
                /* 归一化尺寸口径：自由层的 `w` 是 mm、格内是百分比（见 types.ts 第 ④ 条）。
                   不换算的话，一个 40mm 宽的图片进了格子会变成 40% 宽 —— 用户什么都没做，
                   只是把它拖进格子，尺寸不该自己变。 */
                const r = attachChildToCell(table, cellId, normalizeChildInCell(el, cellWidthMm(table, cellId)))
                if (!r) return false
                // 先写格子、再删原元素 —— 顺序反了会出现"元素没了、内容也没进去"的空档
                api.mergeElement(tableId, r.patch)
                api.removeElement(elementId)
                notice(
                  r.replaced
                    ? `已把「${elementLabel(el)}」放进单元格（原来格内那个被替换掉了）`
                    : `已把「${elementLabel(el)}」放进单元格`,
                )
                return true
              }

              let incoming: InlineNode[] | null = null
              if (el.kind === 'fieldBlock') {
                incoming = [{ type: 'field', fieldId: el.fieldId ?? null, fieldName: el.fieldName ?? '' }]
              } else if (el.kind === 'text') {
                incoming = el.nodes.length > 0 ? el.nodes : [{ type: 'text', text: ' ' }]
              }
              if (!incoming) {
                notice(
                  `「${elementLabel(el)}」装不进单元格 —— 格子里能放图片 / 二维码 / 条形码 / 水平线 / 文字 / 字段块；表格、附件块与分页符不行`,
                )
                return false
              }

              const rows = table.rows.map((r) => ({
                ...r,
                cells: r.cells.map((c) =>
                  c.id === cellId ? { ...c, nodes: [...c.nodes, ...incoming!] } : c,
                ),
              }))
              // 先写格子的内容，再删掉原元素 —— 顺序反了会出现"元素没了、内容也没进去"的空档
              api.mergeElement(tableId, { rows })
              api.removeElement(elementId)
              notice(`已把「${elementLabel(el)}」放进单元格`)
              return true
            }}

            onSetMargin={(side, mm) => {
              const m = { ...doc.pageSetup.margin }
              if (side === 'top') m.top = mm
              else if (side === 'right') m.right = mm
              else if (side === 'bottom') m.bottom = mm
              else m.left = mm
              api.setPageSetup({ margin: m })
            }}
            doc={doc}
            fields={fields}
            layout={api.layout}
            scale={scale}
            selectedId={api.selectedId}
            selectedCellId={selectedCellId}
            selectedNode={activeNodeRef}
            onSelectNode={handleSelectNode}
            outOfBoundsIds={outOfBoundsElementIds}
            dropActive={dropLabel !== null}
            dropTarget={dropTarget}
            kind={kind}
            onSelect={handleSelect}
            onSelectCell={handleSelectCell}
            onMerge={api.mergeElement}
            onCommitEnd={api.endMerge}
            /*
             * 右键菜单的动作集（2026-09-22）。合并走 `requestMerge` ——
             * 它已经带"被丢的那格非空时先弹确认"的流程，与右侧面板点合并**同一条路径**
             * （两处各写一套确认逻辑，迟早会出现一条路径漏了确认）。
             */
            newTableId={newTableId}
            onCloseTableSize={() => setNewTableId(null)}
            onOpenTableSize={(tableId) => setNewTableId(tableId)}
            /* 画布把"退出表格编辑态"注册上来，供 Esc 仲裁链的第 ④ 层使用 */
            onExposeExitEdit={registerExitCanvasEdit}
            onDropTargetChange={setDropTarget}
            onResizeTable={(tableId, rows, cols) => {
              const f = findElement(doc, tableId)
              if (!f || f.el.kind !== 'table') return
              /*
               * 用 resizeTableTo：内容按左上角对齐保留（不是重建一张表），
               * 且它复用增删行列那一套（合并关系/行高列宽一起平移）。
               * 这里是「刚插进来的空表」，理论上没有可丢的内容；仍然传 decide ——
               * 万一用户先在小面板里填了字再改尺寸，丢弃也必须走确认（与合并同口径）。
               */
              const r = resizeTableTo(f.el, rows, cols, (parts) => {
                setPendingMerge({ elementId: tableId, cellId: '', dir: 'row', parts })
                return false
              })
              if (r) api.mergeElement(tableId, r.patch)
            }}
            actions={{
              /*
               * 插入行列：**不丢任何数据**，所以直接做（不弹确认）。
               * 删除行列：交给 `requestMerge`（同一个确认层）—— 行/列里通常有内容，
               * 静默删掉用户打的字是这个项目最不能接受的一类缺陷。
               * 两处都用 **cellId 作定位器**（行/列号在确认期间会变，见 PendingMerge 的注释）。
               */
              insertRow: (tableId, cellId, where) => {
                const f = findElement(doc, tableId)
                if (!f || f.el.kind !== 'table') return
                const loc = findCell(f.el.rows, cellId)
                if (!loc) return
                const r = insertRowAt(f.el, loc.rowIdx, where)
                if (r) api.mergeElement(tableId, r.patch)
              },
              insertCol: (tableId, cellId, where) => {
                const f = findElement(doc, tableId)
                if (!f || f.el.kind !== 'table') return
                const loc = findCell(f.el.rows, cellId)
                if (!loc) return
                const grid = tableGrid(f.el.rows, f.el.colWidthsMm.length)
                const slot = (grid[loc.rowIdx] ?? []).find((g) => g?.cell.id === cellId)
                if (!slot) return
                const r = insertColAt(f.el, slot.colStart, where)
                if (r) api.mergeElement(tableId, r.patch)
              },
              deleteRow: (tableId, cellId) => requestMerge(tableId, cellId, 'row'),
              deleteCol: (tableId, cellId) => requestMerge(tableId, cellId, 'col'),
              askMergeRange: (tableId, range) => requestMerge(tableId, '', 'range', range),
              moveChildToCell: (fromTableId, fromCellId, toTableId, toCellId) => {
                const f = findElement(doc, fromTableId)
                if (!f || f.el.kind !== 'table') return
                const det = detachChildFromCell(f.el, fromCellId)
                if (!det || !det.child) return
                const t = findElement(doc, toTableId)
                if (!t || t.el.kind !== 'table') return
                if (fromTableId === toTableId) {
                  /* 同一张表：两次改动要基于**同一份中间状态**算，否则后写的会把先写的盖掉 */
                  const mid = { ...f.el, ...det.patch }
                  const att = attachChildToCell(mid, toCellId, det.child)
                  if (att) api.mergeElement(fromTableId, att.patch)
                  if (att?.replaced) notice('目标格原来的元素被替换掉了')
                  return
                }
                api.mergeElement(fromTableId, det.patch)
                const att = attachChildToCell(t.el, toCellId, det.child)
                if (att) api.mergeElement(toTableId, att.patch)
                notice(att?.replaced ? '已换到目标格（目标格原来的元素被替换掉了）' : '已换到目标格')
              },
              takeOutChild: (tableId, cellId, at) => {
                const f = findElement(doc, tableId)
                if (!f || f.el.kind !== 'table') return
                const r = detachChildFromCell(f.el, cellId)
                if (!r) return
                api.mergeElement(tableId, r.patch)
                if (!r.child) return
                /*
                 * ⚠️ 尺寸口径要**换算回自由层**：格内 `w` 是百分比，自由层是 mm
                 *   （见 types.ts 第 ④ 条）。不换算的话，`w: 100` 会变成一个 100mm 宽的画布元素 ——
                 *   "取出到画布"后它的视觉宽度会跟格子里差一大截。
                 *   基准取这一格的实际宽度（合并单元格取跨列之和）—— `cellWidthMm` 是这件事的
                 *   **唯一实现**，别在这里再写一遍 `colWidthsMm[colIdx]`（下标 ≠ 网格列号）。
                 */
                const out = normalizeChildOutOfCell(r.child, cellWidthMm(f.el, cellId))
                /*
                 * 落点：`at` 给了就用它（**拖出来**那条路）、不给就落在表格右侧（右键菜单那条路）。
                 * 两种都要夹进版心 —— 拖到纸张右边缘上松手时不能把元素甩出版心。
                 */
                api.addElement(
                  {
                    ...out,
                    x: Math.round(
                      Math.max(
                        0,
                        Math.min(
                          at ? at.xMm : f.el.x + f.el.w + 4,
                          api.layout.contentWMm - Math.max(10, out.w),
                        ),
                      ) * 10,
                    ) / 10,
                    y: Math.round(Math.max(0, at ? at.yMm : f.el.y) * 10) / 10,
                  } as typeof r.child,
                  f.band,
                )
                notice(at ? '已把格内元素取出，放到你松开的位置' : '已把格内元素取出，放到表格右侧')
              },
              removeChild: (tableId, cellId) => {
                const f = findElement(doc, tableId)
                if (!f || f.el.kind !== 'table') return
                const r = detachChildFromCell(f.el, cellId)
                if (r) api.mergeElement(tableId, r.patch)
              },
              applyRange: (tableId, range, op) => {
                const f = findElement(doc, tableId)
                if (!f || f.el.kind !== 'table') return
                const r =
                  op.kind === 'bold' || op.kind === 'align' || op.kind === 'fill' || op.kind === 'color'
                    ? patchRangeStyle(
                        f.el,
                        range,
                        op.kind === 'bold'
                          ? { bold: op.on }
                          : op.kind === 'align'
                            ? { ...(op.h ? { align: op.h } : null), ...(op.v ? { vAlign: op.v } : null) }
                            : op.kind === 'color' ? { color: op.color } : { background: op.color },
                      )
                    : op.kind === 'header'
                      ? setHeaderRowsPatch(f.el, range, op.on)
                      : op.kind === 'border'
                        ? setCellBordersPatch(f.el, range, { [op.edge]: op.on })
                        : op.kind === 'borderFollow'
                          ? setCellBordersPatch(f.el, range, {
                              top: undefined,
                              right: undefined,
                              bottom: undefined,
                              left: undefined,
                            })
                          : op.kind === 'borderWidth'
                            ? setCellBordersPatch(f.el, range, { widthPt: op.pt })
                            : op.kind === 'borderColor'
                              ? setCellBordersPatch(f.el, range, { color: op.color })
                              : op.kind === 'headerCol'
                                ? setHeaderStylePatch(f.el, range, op.on)
                                : null
                if (r) api.mergeElement(tableId, r.patch)
              },
              copy: (id) => void api.copyElement(id),
              cut: (id) => void api.cutElement(id),
              paste: (band, at) => api.pasteClipboard(band, at),
              clipboardHas: api.clipboardHas,
              align: (id, mode) => api.alignElement(id, mode),
              toggleSnap: () => api.toggleSnap(),
              setPageSetup: (patch) => {
                /* marginAllMm = 四边同值（右键里的预设）；其余直接透传给 pageSetup */
                const { marginAllMm, ...rest } = patch
                if (marginAllMm != null) {
                  api.setPageSetup({
                    ...rest,
                    margin: { top: marginAllMm, right: marginAllMm, bottom: marginAllMm, left: marginAllMm },
                  })
                  return
                }
                api.setPageSetup(rest)
              },
              zIndex: (id, where) => api.moveZIndex(id, where),
              remove: (id) => api.removeElement(id),
              askMerge: (tableId, cellId, dir) => requestMerge(tableId, cellId, dir),
              splitCell: (tableId, cellId) => {
                const f = findElement(doc, tableId)
                if (!f || f.el.kind !== 'table') return
                const r = applySplitCell(f.el, cellId)
                if (r) api.mergeElement(tableId, r.patch)
              },
              setHeaderRow: (tableId, rowIdx) => {
                const f = findElement(doc, tableId)
                if (!f || f.el.kind !== 'table') return
                const on = !f.el.rows[rowIdx]?.isHeader
                /*
                 * 「设为表头行」要三件事一起做（用户规格 · 五）：
                 *   ① `isHeader` —— 渲染层据此数出表头行（`render/html.ts` 的 headerRowCount）；
                 *   ② `repeatHeader` —— 打印跨页重复（分页由渲染层做，这里只表态）；
                 *   ③ 整行套样式：加粗 + 居中 + 底纹。底纹走 `TextStyle.background`
                 *      （这个字段本来就有，注释里写着"背景色（单元格底纹等）"）。
                 * 取消时把样式**还原成常规** —— 否则"再点一次取消"看起来没生效。
                 */
                const rows = f.el.rows.map((r, i) =>
                  i !== rowIdx
                    ? r
                    : {
                        ...r,
                        isHeader: on,
                        cells: r.cells.map((c) => ({
                          ...c,
                          style: {
                            ...c.style,
                            bold: on,
                            // `as const` 不能少：三元表达式会把字面量拓成 string，而 `TextStyle.align` 是联合类型
                            align: (on ? 'center' : 'left') as 'center' | 'left',
                            background: on ? (c.style?.background ?? '#f2f3f5') : undefined,
                          },
                        })),
                      },
                )
                api.mergeElement(tableId, { rows, repeatHeader: on ? true : f.el.repeatHeader })
              },
            }}
          />
          {/*
            ---- 「拖出表格」入口（规格 一 后半句）----
            按钮常驻在画布左下角；点开后画布上盖一层透明的「画框」层：
            按下 → 拖 → 松手 ⇒ 按框的宽高换算行列数建表（复用 insertTableRect）。
            ⚠️ 覆盖层只在**正在拖框时**存在（`rectDragBox` 非空）—— 常驻的话会把画布的点击/拖拽全吃掉。
            ⚠️ 框的坐标用**视口坐标**画（覆盖层是 position: fixed），
               而建表要的 mm 由 hitTest 换算 —— 那一个函数内部处理了缩放与页边距。
          */}
          {rectDragBox ? (
            <div
              className="bp-rectlayer"
              onPointerDown={(ev) => {
                ev.preventDefault()
                const start = { x: ev.clientX, y: ev.clientY }
                setRectDragBox({ x: start.x, y: start.y, w: 0, h: 0 })
                const onMove = (mv: PointerEvent): void => {
                  setRectDragBox({
                    x: Math.min(start.x, mv.clientX),
                    y: Math.min(start.y, mv.clientY),
                    w: Math.abs(mv.clientX - start.x),
                    h: Math.abs(mv.clientY - start.y),
                  })
                }
                const onUp = (up: PointerEvent): void => {
                  document.removeEventListener('pointermove', onMove)
                  document.removeEventListener('pointerup', onUp)
                  document.removeEventListener('pointercancel', onUp)
                  setRectDragBox(null)
                  const a = canvasRef.current?.hitTest(start.x, start.y) ?? null
                  const b = canvasRef.current?.hitTest(up.clientX, up.clientY) ?? null
                  if (!a || !b) {
                    notice('这一框没落在纸张上，没有插入')
                    return
                  }
                  insertTableRect({
                    xMm: Math.min(a.xMm, b.xMm),
                    yMm: Math.min(a.yMm, b.yMm),
                    wMm: Math.abs(b.xMm - a.xMm),
                    hMm: Math.abs(b.yMm - a.yMm),
                  })
                }
                document.addEventListener('pointermove', onMove)
                document.addEventListener('pointerup', onUp)
                document.addEventListener('pointercancel', onUp)
              }}
            />
          ) : null}
          {rectDragBox ? (
            <span
              className="bp-rect-preview is-floating"
              aria-hidden
              style={{ left: rectDragBox.x, top: rectDragBox.y, width: rectDragBox.w, height: rectDragBox.h }}
            />
          ) : null}
          {/* 「拖出表格」按钮已移除（2026-09-23 第 10 条）：改为「允许拖出页面」开关，见页面属性与画布右键菜单 */}
          {elementCount === 0 ? (
            <div className="bp-canvas-empty">
              <p className="bp-canvas-empty__title">画布还是空的</p>
              <p className="bp-canvas-empty__text">
                {layout === 'wide'
                  ? '从左侧「字段」把字段拖到纸张上，或在「元素」里加点文本 / 表格。'
                  : '从下方「字段」把字段拖到纸张上，或在「元素」里加点文本 / 表格。'}
              </p>
            </div>
          ) : null}
        </div>

        {showRightPane ? (
          <aside className="bp-side bp-side--right">
            <div className="bp-side__head">
              <span className="bp-side__title">属性</span>
            </div>
            <div className="bp-side__body">{inspectorNode}</div>
          </aside>
        ) : null}
      </div>

      {/* ---------------- 窄屏底部抽屉 ---------------- */}
      {layout === 'narrow' && tab ? (
        <div className={`bp-drawer${dropLabel ? ' is-dragging' : ''}`}>
          <button
            type="button"
            className="bp-drawer__grab"
            aria-label="收起面板"
            title="收起面板"
            onClick={() => setTab(null)}
          >
            <span className="bp-drawer__bar" />
          </button>
          <div className="bp-drawer__body">
            {tab === 'inspect' ? inspectNode : tab === 'style' ? inspectorNode : paletteNode}
          </div>
        </div>
      ) : null}

      {/* ---------------- 检查条 ---------------- */}
      <div className={`bp-checkbar${totalIssues > 0 ? ' is-warn' : ''}`}>
        <button
          type="button"
          className="bp-checkbar__head"
          aria-expanded={checkOpen}
          onClick={() => (totalIssues > 0 ? setCheckOpen((v) => !v) : undefined)}
        >
          <span className="bp-checkbar__icon">
            {totalIssues > 0 ? <IconWarning size={14} /> : <IconCheck size={14} />}
          </span>
          <span className="bp-checkbar__text">
            {totalIssues === 0
              ? '模板检查通过'
              : `模板检查：${blockCount} 项必须修正${warnCount ? ` · ${warnCount} 项提示` : ''}`}
          </span>
          {totalIssues > 0 ? <span className={`bp-checkbar__caret${checkOpen ? ' is-open' : ''}`}>▾</span> : null}
        </button>

        {checkOpen && totalIssues > 0 ? (
          <ul className="bp-checkbar__list">
            {issues.map((it) => (
              <li key={it.id}>
                <button
                  type="button"
                  className={`bp-issue bp-issue--${it.level}`}
                  onClick={() => {
                    gotoIssue(it.elementId)
                    setCheckOpen(false)
                  }}
                >
                  <span className="bp-issue__dot" aria-hidden />
                  <span className="bp-issue__text">{it.message}</span>
                  <span className="bp-issue__go">定位</span>
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </div>

      {/* 拖拽跟随浮层：直接改 transform，不进 state */}
      <div className="bp-ghost" ref={ghostRef} aria-hidden>
        <span className="bp-ghost__dot" />
        <span className="bp-ghost__label">{dropLabel ?? ''}</span>
      </div>

      {/* 在此页预览打印效果：产物是 renderDocument 吐出的那一份 HTML 本体 */}
      {preview.open ? (
        <PreviewPane result={preview.result} error={preview.error} busy={preview.busy} onClose={closePreview} />
      ) : null}

      {/* 合并前的确认层：右侧单元格面板与顶栏表格工具条**共用这一个**（portal 到 body） */}
      {activePending ? (
        <MergeConfirmDialog
          {...confirmCopyOf(activePending.dir)}
          parts={mergeWarnText(activePending.parts)}
          onConfirm={confirmPendingMerge}
          onCancel={() => setPendingMerge(null)}
        />
      ) : null}

      {toast ? (
        <div className="bp-toast" role="status">
          {toast}
        </div>
      ) : null}

      {kind === 'record' ? (
        <p className="sr-only">当前为记录模板：一条记录渲染一份文档，循环区仅渲染首行</p>
      ) : null}

      <div className="sr-only" aria-live="polite">
        {api.selectedId ? `已选中元素` : '未选中元素'}
      </div>
    </div>
  )
}

export default EditorShell
