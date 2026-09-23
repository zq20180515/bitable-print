/**
 * 画布：纸张 + 元素 + 直接操作（拖动 / 缩放 / 就地编辑）。
 *
 * 拖拽为什么不用 HTML5 drag-and-drop：
 * 插件跑在飞书 sandbox iframe 里，HTML5 DnD 在这个环境下面目全非 ——
 * 拖影由浏览器合成、无法自定义，`dragover`/`drop` 偶发不触发，且 pointer capture 与它互斥。
 * 这里全程用 Pointer Events（pointerdown/move/up）手写会话，行为在所有环境下一致，
 * 也顺带解决了"从抽屉拖到画布"这个跨容器拖拽（见 EditorShell 的 ghost 浮层）。
 *
 * 坐标：元素坐标一律 mm；写 CSS 时统一 `pxOf(mm)` 换算，再靠纸张的 `transform: scale()` 缩放。
 * 因此"画布缩放"不会污染任何一次命中测试 —— hitTest 一律拿 getBoundingClientRect 反推。
 */

import type { CellBorders } from '../../lib/types'
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react'
import {
  MM_TO_PX,
  contentBoxSize,
  finite,
  mmToPx,
  pageRenderSize,
  type AnyElement,
  type InlineNode,
  type TableElement,
  type TemplateDoc,
  type TemplateKind,
  type TextStyle,
  DEFAULT_TEXT_STYLE,
} from '../../lib/types'
import { fieldMeta } from '../../lib/field-types'
import type { FieldMeta } from '../../lib/data-source'
import { barcodeSvg, isCode128Encodable, qrCodeSvg, QR_MAX_BYTES, utf8ByteLength } from '../../render/code-elements'
import type { BandLayout } from './useEditorState'
import {
  BAND_HINT,
  DEFAULT_CODE_BG,
  DEFAULT_CODE_FG,
  SYSVAR_LABEL,
  cellLabel,
  elementHeightMm,
  elementLabel,
  findCell,
  findElement,
  gridOptions,
  heightOf,
  nodesToText,
  readBand,
  snapMm,
  textToNodes,
  updateCell,
  type BandKey,
} from './useEditorState'
// `round1` 的规范实现（B 批收口：此前全项目 5 份副本、且不是同一种行为，见 round.ts 的文件头）
import { round1 } from './round'
// 拖表格边框线调大小：与右侧面板的列宽/行高输入框**同一份**纯函数。
// 列宽必须走 setColWidthPatch —— 它在改列宽数组的同时同步元素总宽 `w`（E-45 的约束），
// 另写一遍就一定会有一天不同步（总宽和列宽之和对不上，渲染层会按比例压缩，画布与打印对不上）。
// `colEdgeFrac`（列宽 → 边界占比）与它同处一文件：读写的是同一个 `colWidthsMm`，
// 将来改列宽语义时改一处就能看见另一处 —— 原来它是本文件里的一个局部函数，
// 移出去是为了能单测（"末边界恒为 1、不吃到 >1"这条只有测得到才守得住）。
// `scaleColWidths`：拖**外框**改总宽时按比例缩放列宽，保住「Σ列宽 === w」这个不变量。
// 没有它，`table-layout:fixed` 会让表格宽度纹丝不动（定宽表格 used width = max(W, Σ列宽)）。
import {
  MIN_COL_MM,
  MIN_ROW_MM,
  colEdgeFrac,
  scaleColWidths,
  setColWidthPatch,
  setRowHeightPatch,
} from './table-actions'
// 智能对齐线：判定是纯函数（全在 mm 空间，见 align-guides.ts 的文件头），画布只负责画
import { buildDocRefs, computeGuides, dedupeGuides, type BoxMm, type GuideLine } from './align-guides'
import { BAND_META, layoutBandBars, layoutBandGutters, type BandGeometry } from './band-bars'
// 表格的悬浮操作层（表格手柄 / 行首列首「+」/ 边缘感应区）——纯展示 + 纯回调，见它的文件头
import { TableAfford, tableAnchors } from './TableAfford'
// 矩形选区的浮动工具条（规格 四）+ 它用到的选区纯函数
import { CellRangeBar, type RangeOp } from './CellRangeBar'
import { TableSizePanel } from './TableSizePanel'
// 「拆分单元格」的输入弹层（第 7 条）：本组件只负责开/关与把动作层的拒绝原因透给它
import { SplitCellDialog } from './SplitCellDialog'
import {
  MAX_CELL_CHILDREN,
  canSplitCell,
  expandRangeToWholeCells,
  isFirstColHeaderStyled,
  isHeaderCellAt,
  normalizeRange,
  rangeArea,
  resolveCellEdges,
  setHeaderColPatch,
  setHeaderRowsPatch,
  setHeaderStylePatch,
  splitCellToGrid,
  snapSizeToNeighbors,
  tableGrid,
  type CellRange,
} from './table-actions'
// 右键菜单：菜单本体是独立组件（含视口收边 / 四条关闭出口），画布只负责「命中什么、给哪些项」
import { ContextMenu, type CtxItem } from './ContextMenu'
// 表格动作层：合并走 `onAskMerge`（确认层在 EditorShell，那里已有「丢弃内容」的确认流程），
// 拆分与「设为表头行」没有丢失风险，画布直接改数据
import { applySplitCell } from './table-actions'
import type { AlignMode } from './useEditorState'
// 格内子元素：复合 id（点击要选它自己）、百分比宽 / 固定高（渲染要认这两个口径）
import { cellChildId, childHeightMm, childWidthPct, parseCellChildId } from './cell-child'

/**
 * 1pt = 1/72 inch → CSS px
 */
/** 空白右键菜单里的网格间距档位（mm） */
const GRID_STEPS = [2, 5, 10, 20]

/** 页边距预设（四边同值）—— 真机反馈要求右键里能直接调页边距 */
const MARGIN_PRESETS: { name: string; mm: number }[] = [
  { name: '无', mm: 0 },
  { name: '窄', mm: 10 },
  { name: '常规', mm: 12 },
  { name: '宽', mm: 20 },
]

const ptToPx = (pt: number): number => finite(pt, 0) * (96 / 72)

/** 写进 style 的数值统一兜底：getBoundingClientRect / 拖动算出来的数在无头环境下可能是 NaN */
const nz = (n: number, fb = 0): number => (Number.isFinite(n) ? n : fb)

/** 缩放手柄的 8 个方向：四角 + 四边中点 */
type ResizeEdge = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w'
const RESIZE_EDGES: readonly ResizeEdge[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']

/**
 * 这些元素的**内容应该填满声明框**（而不是让框去迁就内容）。
 *
 * 2026-09-19 真机 + 自测定位（`_cdp.mjs` 在 mock 画布上实测）：
 * 元素外壳用的是 `min-height`（= max(声明高, 内容自然高)）⇒ **声明高 > 内容自然高时，
 * 外壳就比内容高**，于是"蓝色选区比里面的东西大一圈"。
 * 用户报的三种都命中：
 *   · 表格声明 15mm、真实约 13mm ⇒ 蓝框多出 2mm（截图 `image#8`）；
 *   · 二维码/条形码声明 25mm、占位内容约 22mm ⇒ 同上（`g06-code`）；
 *   · 附件同理。
 *
 * 为什么是"填满框"而不是"框去迁就内容"：
 *   框架式文档（Word/PPT/Excel）里，**框的尺寸就是对象的尺寸** —— 声明 15mm 就该看起来 15mm。
 *   而且打印侧本来就是 `min-height: 声明高`（`render/html.ts`），
 *   内容不填满只会在纸上留一段看不见的空隙；**让内容撑满，画布与打印才真正一致**。
 *
 * 顺带治好"拖表格底边、表格不动"：填满之后，声明高变大 ⇒ 表格行跟着分摊，
 * 表格**真的会变高**（以前只改了框、行纹丝不动）。
 *
 * 为什么只给这几种：文本/字段块本来就是行盒决定高度、实测差 0.1~0.9px（可忽略），
 * 给它们加 flex 拉伸反而会把单行文字拉到框底、改变基线，是没必要的风险。
 */
const FILL_KINDS = new Set(['table', 'qrcode', 'barcode', 'attach', 'image'])

/**
 * 「有固有尺寸」的元素：它们的高度该由**框**说了算（图片缩放到框里即可）。
 *
 * 与 `FILL_KINDS` 成员相同但**语义不同**，所以刻意不合并：
 *   · `FILL_KINDS` 管的是"内容要不要撑满声明框"（样式上的 fill）；
 *   · `PIC_LIKE` 管的是"显式高度算精确值还是下限"（几何语义）。
 * 哪天两者的成员要分开变，合在一起就会互相拖着走。
 * ⚠️ 必须与 `render/html.ts` 里 `heightCss` 的 `picLike` 判断**保持一致**。
 */
const PIC_LIKE = new Set(['attach', 'qrcode', 'barcode', 'image'])

/** 页边距的四条边（顺序固定，便于渲染时稳定输出） */
const MARGIN_SIDES = ['top', 'right', 'bottom', 'left'] as const

/** 页边距的中文名（画布标注与 prompt 文案共用一份，避免两处措辞不一致） */
const MARGIN_SIDE_CN: Record<(typeof MARGIN_SIDES)[number], string> = {
  top: '上',
  right: '右',
  bottom: '下',
  left: '左',
}

/** 拖列边框的最窄列宽（mm）。与右侧面板「第 N 列」那个输入框的 min 是同一个数 */

// 列宽/行高的下限**只在 table-actions 里定义一份**（MIN_COL_MM / MIN_ROW_MM，规格：32px / 24px）。
// 这里原来还有一个 `const MIN_COL_MM = 4` —— 同一个量两处定义，今天统一掉了。

export interface DropHit {
  xMm: number
  yMm: number
}

/**
 * 投放探针：把"要从左侧面板放进来的东西"告诉画布。
 * 画布据此判断"这个落点收不收"——**不收的话必须给一句人能看懂的理由**。
 */
export interface DropProbe {
  /** 能不能作为**行内节点**进格子（字段 / 系统变量 / 文字为 true）。 */
  inline: boolean
  /**
   * 能不能作为**块级子元素**进格子（规格 六，2026-09-22 加）。
   *
   * 在这之前，这个探针只有 `inline` 一个档 ⇒ 从面板拖图片/二维码到格子上会被
   * 「表格单元格里只能放字段、系统变量或文字」直接拒掉 —— 而规格六要的正是让它们住进去。
   * ⚠️ 名单的唯一来源是 `table-actions` 的 `CELL_BLOCK_KINDS`，这里只是把判定结果传进来。
   */
  cellBlock?: boolean
  /**
   * 是不是**字段占位符**这一类的载荷（2026-09-23 第 9 条）。
   *
   * 用途只有一个：标题行 / 标题列里**不允许放字段**（用户明确要求）。
   * 用它在**拖动过程中**就把那一格标成"不行"，而不是等用户松手才弹一句拒绝 ——
   * 松手才知道成不成，是这个项目反复强调要避免的"点了没反应/最后才说不"。
   * 只认字段（`field`）；系统变量（页码/行号）不进这条禁令，标题行里写"第 X 页"是合理的。
   */
  field?: boolean
  /** 报错文案里用的名字，如「客户名称」「表格」 */
  label: string
}

/**
 * 投放判定。三选一，没有第四种：
 *  - `cell`：落点在表格单元格里，且放的东西能被单元格装下 → 塞进那个格子
 *  - `free`：落点可用 → 正常落位
 *  - `reject`：落点不能用（不在纸张上 / 在下页边距里 / 格子装不下这东西）→ 拒绝，
 *    并把 `reason` 说给用户听
 *
 * ⚠️ **刻意没有"与已有元素重叠"这一条**：用户明确要求取消元素之间的重叠限制
 * （原来只有"从左侧面板拖进来"这条路会拦，拖动画布上已有的元素却不拦，
 * 同一个操作两种结果 —— 那条限制本来就不自洽）。重叠改由画布上的
 * `.bp-overlap` 高亮画出来（见下面的 overlaps），看得见、但不拦。
 * 剩下的三条拒绝理由都**保留**，它们和重叠无关。
 */
export type DropVerdict =
  | { kind: 'cell'; tableId: string; cellId: string; label: string }
  | { kind: 'free'; xMm: number; yMm: number }
  | { kind: 'reject'; reason: string }

/** 拖拽过程中的实时反馈：让用户**松手之前**就知道这一下会成还是不会成 */
export type DropTarget =
  | { kind: 'cell'; cellId: string }
  | { kind: 'reject'; reason: string }
  /**
   * 拖出矩形的**实时预览框**（规格 一 后半句：「或支持在画布上按住拖出矩形后，
   * 按矩形宽高自动换算行列数」）。坐标全是版心 mm ——
   * 画布只负责把它画出来，换算行列数在编辑器那一侧做。
   */
  | { kind: 'rect'; xMm: number; yMm: number; wMm: number; hMm: number }
  | null

export interface CanvasHandle {
  /** 屏幕坐标 → 版心坐标(mm)。不在纸张内返回 null。供 EditorShell 完成拖放落点 */
  hitTest(clientX: number, clientY: number): DropHit | null
  /** 判断这次投放落在哪儿、收不收（见 DropVerdict）。拖拽过程中也会调，所以必须是纯计算 */
  resolveDrop(clientX: number, clientY: number, probe: DropProbe): DropVerdict
  /** 把某元素滚动到可视区（检查条点击定位用） */
  scrollToElement(id: string): void
}

/**
 * 右键菜单的动作集。**签名刻意窄**：都是"给 id 就干活"，不泄漏编辑器内部状态。
 * 复制/剪切作用在**当前选中**的元素上 —— 右键时画布会先把命中的元素选中（见 handler），
 * 所以"点菜单时选中的就是刚才右键的那个"这件事由**流程**保证，不由参数重复传一遍。
 */
export interface CanvasContextActions {
  copy(id: string): void
  cut(id: string): void
  paste(band: BandKey, at: { x: number; y: number }): void
  /** 剪贴板里有没有东西（决定「粘贴」可不可点） */
  clipboardHas: boolean
  align(id: string, mode: AlignMode): void
  /** 网格吸附开关（空白处右键那一项，带勾选态） */
  toggleSnap(): void
  /**
   * 页面设置：网格间距 / 显示网格 / 网格吸附 / 页边距（四边同值）。
   * 真机反馈（2026-09-22）要求空白右键菜单里能直接调这几项。
   */
  setPageSetup(patch: {
    gridMm?: number
    showGrid?: boolean
    snapToGrid?: boolean
    marginAllMm?: number
    /** 「允许拖出页面」开关（第 10 条）。布尔开关类设置都从这里进 */
    allowOutOfPage?: boolean
  }): void
  zIndex(id: string, where: 'front' | 'back' | 'forward' | 'backward'): void
  remove(id: string): void
  /** 合并：交给 EditorShell 那套（它会在"被丢的那格非空"时先弹确认） */
  askMerge(tableId: string, cellId: string, dir: 'right' | 'down'): void
  /** 插入行列：不丢数据，直接做 */
  insertRow(tableId: string, cellId: string, where: 'above' | 'below'): void
  insertCol(tableId: string, cellId: string, where: 'left' | 'right'): void
  /** 删除行列：会丢内容 ⇒ 走确认层（与合并同一个）。定位器是 cellId，不是行/列号 */
  deleteRow(tableId: string, cellId: string): void
  deleteCol(tableId: string, cellId: string): void
  /** 矩形选区合并（会丢图片格 ⇒ 与合并共用确认层） */
  askMergeRange(tableId: string, range: CellRange): void
  /** 选区样式（对齐/加粗/底纹/表头行）：不丢东西，直接套补丁 */
  applyRange(tableId: string, range: CellRange, op: RangeOp): void
  /**
   * 把格子里的块级子元素取出放回画布（规格 六：「可以再拖出来，回到画布自由层」）。
   *
   * `at` 给了就落在指定的版心坐标（**拖出来**那条路用它），
   * 不给就落在表格右侧（右键菜单那条路用它）。
   */
  takeOutChild(tableId: string, cellId: string, at?: { xMm: number; yMm: number }): void
  /** 只删掉格子里的子元素（保留格子里的文字） */
  removeChild(tableId: string, cellId: string): void
  /** 把子元素从一格**挪到另一格**（拖到别的格子上松开） */
  moveChildToCell(fromTableId: string, fromCellId: string, toTableId: string, toCellId: string): void
  /** 拆分单元格（无丢失风险，直接改数据） */
  splitCell(tableId: string, cellId: string): void
  /** 设为/取消表头行（整行样式 + 打印时跨页重复） */
  setHeaderRow(tableId: string, rowIdx: number): void
}

/** 右键命中的三种对象 —— 菜单项按它分岔，这就是用户要的"依据元素类型智能弹出" */
type CtxTarget =
  /** 格内子元素（真机反馈第 3 条）：它住在格子里，不是画布上的自由元素 */
  | { kind: 'child'; tableId: string; cellId: string }
  | { kind: 'blank'; band: BandKey; xMm: number; yMm: number }
  | { kind: 'element'; id: string; band: BandKey }
  | { kind: 'cell'; tableId: string; cellId: string }

export interface CanvasProps {
  doc: TemplateDoc
  fields: FieldMeta[]
  layout: BandLayout
  /** 当前缩放比 */
  scale: number
  selectedId: string | null
  selectedCellId: string | null
  /** 检查出来的超界元素 id，用于打斜纹遮罩 */
  outOfBoundsIds: string[]
  /** 模板类型：只影响循环区的提示文案（记录模板只渲染首行） */
  kind?: TemplateKind
  /** 外部（Palette）正在拖拽，纸张需要给出"可放置"提示 */
  dropActive?: boolean
  /**
   * 请求把「表格尺寸」小窗开到某张表上 —— 进编辑态时用
   * （真机反馈 2026-09-23 第 6 条：「点击编辑表格再次出现」）。
   *
   * 小窗的**状态**握在 EditorShell 手里（`newTableId`），画布只负责"请求打开"与"请求关闭"，
   * 这样"什么时候该收"只有一个判据（见 EditorShell 里那个 effect），不会两处各判一次。
   */
  onOpenTableSize?(tableId: string): void
  /** 正在拖拽时，这一下的落点判定结果（可放置的格子 / 会被拒绝的理由） */
  dropTarget?: DropTarget
  /** 节点级选中（字段/文字/系统变量占位符本身） */
  selectedNode?: NodeSel | null
  onSelect(id: string | null): void
  onSelectCell(elementId: string | null, cellId: string | null): void
  /**
   * 在画布上直接改某一侧的页边距（2026-09-19 用户要求："点击数字后，可以修改四边的页边距"）。
   *
   * 为什么要在画布上也能改：页边距的可视化（红线丈量）就画在画布上，
   * 用户看到"左边距 12mm"时**下一步就是想改它**；让他去右侧面板找四个数字框，
   * 等于把"看到问题"和"解决问题"拆到两个地方 —— 那正是这次要消掉的摩擦。
   *
   * 为什么用"单侧 + 数值"而不是直接传整个 `PageSetup`：
   * 画布只需要"改哪一边、改成多少"，不该知道 PageSetup 的其余字段（纸张、方向…）。
   * 接口越窄，画布与页面设置模块的耦合越少。
   */
  onSetMargin(side: 'top' | 'right' | 'bottom' | 'left', mm: number): void
  /**
   * **把画布上已有的元素"放进"某个表格单元格**（2026-09-19 用户要求）。
   *
   * 用户原话："单元格内可以依靠从左边的工具栏手动拖元素、字段，直接绑定至某个单元格，
   * **但如果是从画布的其他区域拖过去，那么这个元素就无法拖入到单元格内绑定，
   * 只会叠加在整个表格上**，改为从画布中拖其他元素或者字段到表格上时，
   * 可以**自动吸附到单元格内**完成绑定。"
   *
   * 为什么会不一致：左侧面板拖入走的是 `resolveDrop`（它**会**判定 `td`），
   * 而在画布上拖动已有元素走的是 `beginSession('move')`，落点**只写 x/y、从不看落点是什么**
   * ⇒ 拖到表格上就等于叠上去。
   *
   * 返回 `true` 表示这次落点已被"放进单元格"消费掉。
   */
  onElementIntoCell?(elementId: string, tableId: string, cellId: string): boolean
  /**
   * 右键菜单要用的动作集（2026-09-22）。
   *
   * 为什么是**一个对象**而不是八个 prop：这八件事全是"菜单项 → 编辑器动作"的一对一映射，
   * 它们的共同点是"只在右键菜单里用"。拆成八个 prop 会让组件签名长一倍，
   * 而且下次再加一个菜单项就要再动一次签名 —— 归一化成一个可选对象，
   * 缺省时右键菜单**整体不启用**（画布仍可只读预览）。
   */
  actions?: CanvasContextActions
  /** 刚插入的那张表的 id（规格 一：插完立刻浮出「表格尺寸」让他微调，默认已是 3 行 4 列） */
  newTableId?: string | null
  onResizeTable?(tableId: string, rows: number, cols: number): void
  onCloseTableSize?(): void
  /**
   * 画布想临时高亮某个单元格（拖子元素换格时用）。
   * ⚠️ 落点提示状态（`dropTarget`）一直握在 EditorShell 手里，画布只上报 ——
   *    画布自己再存一份就会有两个真相源。
   */
  onDropTargetChange?(t: DropTarget | null): void
  /** 点选某个行内节点；传 null 表示取消 */
  onSelectNode?(sel: NodeSel | null): void
  onMerge(id: string, patch: Partial<AnyElement>, mergeKey?: string): void
  /** 拖动/缩放松开时通知外部关闭撤销合并窗口 */
  onCommitEnd?(): void
}

// ============================================================
// 样式小工具
// ============================================================

const FONT_STACKS: Record<string, string> = {
  system: 'var(--font-sans)',
  serif: 'var(--font-serif)',
  mono: 'var(--font-mono)',
}

function fontCss(name?: string): string {
  if (!name || name === 'system') return FONT_STACKS.system
  if (FONT_STACKS[name]) return FONT_STACKS[name]
  // 用户自定义字体（含 Word 导入的中文字体名）原样引用，含空格时加引号
  return `${JSON.stringify(name)}, ${FONT_STACKS.system}`
}

/** 文本样式 → CSS。行距的固定值(pt)优先于倍数 */
function textCss(el: AnyElement): CSSProperties {
  const s = el.style
  const deco = [s?.underline ? 'underline' : '', s?.strike ? 'line-through' : ''].filter(Boolean).join(' ')
  const lh =
    typeof s?.lineHeightPt === 'number' && Number.isFinite(s.lineHeightPt)
      ? `${ptToPx(s.lineHeightPt)}px`
      : `${nz(finite(s?.lineHeight, DEFAULT_TEXT_STYLE.lineHeight), 1.5)}`
  return {
    fontFamily: fontCss(s?.fontFamily),
    fontSize: ptToPx(finite(s?.fontSizePt, DEFAULT_TEXT_STYLE.fontSizePt)),
    fontWeight: s?.bold ? 600 : 400,
    fontStyle: s?.italic ? 'italic' : 'normal',
    textDecoration: deco || 'none',
    color: s?.color || DEFAULT_TEXT_STYLE.color,
    background: s?.background || undefined,
    textAlign: s?.align ?? DEFAULT_TEXT_STYLE.align,
    lineHeight: lh,
    paddingLeft: mmToPx(finite(s?.indentLeftMm, 0)),
    paddingRight: mmToPx(finite(s?.indentRightMm, 0)),
    textIndent: mmToPx(finite(s?.indentFirstLineMm, 0)),
    marginTop: ptToPx(finite(s?.spaceBeforePt, 0)),
    marginBottom: ptToPx(finite(s?.spaceAfterPt, 0)),
  }
}

/**
 * **行内节点自己的**样式 → CSS。
 *
 * 与 `textCss` 的关键区别：这里只输出**显式设过**的那几项，没设的一律 undefined 交给继承 ——
 * 节点级样式是"元素样式之上的一层覆写"，把整份默认值铺上去会把外层样式全顶掉，
 * 用户改了整块文本的字号，chip 却纹丝不动。渲染层（render/html.ts 的 inlineCss）是同一个口径。
 */
function nodeCss(s?: TextStyle): CSSProperties | undefined {
  if (!s) return undefined
  const out: CSSProperties = {}
  if (s.fontFamily) out.fontFamily = fontCss(s.fontFamily)
  if (typeof s.fontSizePt === 'number' && Number.isFinite(s.fontSizePt)) out.fontSize = ptToPx(s.fontSizePt)
  if (s.bold !== undefined) out.fontWeight = s.bold ? 600 : 400
  if (s.italic !== undefined) out.fontStyle = s.italic ? 'italic' : 'normal'
  if (s.underline !== undefined || s.strike !== undefined) {
    out.textDecoration =
      [s.underline ? 'underline' : '', s.strike ? 'line-through' : ''].filter(Boolean).join(' ') || 'none'
  }
  if (s.color) out.color = s.color
  if (s.background) out.background = s.background
  return Object.keys(out).length ? out : undefined
}

/**
 * 文本**元素**（块级）自己的样式 → CSS。
 *
 * 与 `nodeCss` 同一个口径：**只输出显式设过的那几项**，其余交给画布的默认样式。
 *
 * 为什么不是直接铺整份 `textCss`：`textCss` 会给没设过的项补默认值（例如
 * `fontSizePt ?? 10.5`），那样一来**所有**文本元素的字号都会在画布上整体跳一档 ——
 * 明明没动过任何东西、观感却变了，这是最难查的一类回归。
 *
 * 为什么必须有这个函数：`kind === 'text'` 的元素在画布上原来**完全不吃** `el.style`
 * （只有 fieldBlock 吃），于是"给文本元素改字体/字号/加粗"在画布上毫无反应 ——
 * 顶栏「文本编辑」点下去画布纹丝不动，用户只会认为功能坏了。
 * 渲染层（render/html.ts 的 `textCss(el.style, [TEXT_FLOW])`）一直是应用的，
 * 所以补上它同时也把"画布 vs 打印"的这条偏差一起收掉。
 */
function blockCss(s?: TextStyle): CSSProperties | undefined {
  const out: CSSProperties = { ...(nodeCss(s) ?? {}) }
  if (!s) return Object.keys(out).length ? out : undefined
  if (s.align) out.textAlign = s.align
  // 行距的固定值(pt)优先于倍数 —— 与 textCss / 渲染层同一口径
  if (typeof s.lineHeightPt === 'number' && Number.isFinite(s.lineHeightPt)) out.lineHeight = `${ptToPx(s.lineHeightPt)}px`
  else if (typeof s.lineHeight === 'number' && Number.isFinite(s.lineHeight)) out.lineHeight = s.lineHeight
  if (typeof s.indentLeftMm === 'number') out.paddingLeft = mmToPx(s.indentLeftMm)
  if (typeof s.indentRightMm === 'number') out.paddingRight = mmToPx(s.indentRightMm)
  if (typeof s.indentFirstLineMm === 'number') out.textIndent = mmToPx(s.indentFirstLineMm)
  if (typeof s.spaceBeforePt === 'number') out.marginTop = ptToPx(s.spaceBeforePt)
  if (typeof s.spaceAfterPt === 'number') out.marginBottom = ptToPx(s.spaceAfterPt)
  return Object.keys(out).length ? out : undefined
}

function tableCss(el: TableElement): {
  table: CSSProperties
  cell: (rowIdx: number, colIdx: number, cellBorders?: CellBorders) => CSSProperties
} {
  // 没写线色时的兜底必须和渲染层一致（render/html.ts 用的是 #d0d3d9）。
  // 原来这里兜的是 var(--paper-line) —— 那**同时也是网格线的颜色**，于是"没设过线色的表格"
  // 画出来和网格几乎同色，用户根本分不清哪条是表格、哪条是网格。
  const w = `${nz(ptToPx(finite(el.border.widthPt, 0.75)), 1)}px solid ${el.border.color || '#d0d3d9'}`
  const none = 'none'
  const mode = el.border.mode
  const lastRow = el.rows.length - 1
  const lastCol = el.colWidthsMm.length - 1
  const table: CSSProperties = {
    width: '100%',
    borderCollapse: 'collapse',
    tableLayout: 'fixed',
    borderTop: mode === 'all' || mode === 'outer' ? w : none,
    borderLeft: mode === 'all' || mode === 'outer' ? w : none,
    borderRight: mode === 'all' || mode === 'outer' ? w : none,
    borderBottom: mode === 'all' || mode === 'outer' ? w : none,
  }
  const cell = (r: number, c: number, cellBorders?: CellBorders): CSSProperties => {
    /*
     * 单边边框（规格 八）：有覆盖时逐边给出最终结果 —— 与打印端读的是**同一个** `resolveCellEdges`。
     * 没有覆盖时保持原路径（老模板在画布上的观感一点不变）。
     */
    if (cellBorders) {
      const e = resolveCellEdges(mode, cellBorders, { row: r, rows: el.rows.length, col: c, cols: el.colWidthsMm.length })
      const cw = `${nz(ptToPx(finite(cellBorders.widthPt ?? el.border.widthPt, 0.75)), 1)}px solid ${cellBorders.color || el.border.color || '#d0d3d9'}`
      return {
        borderTop: e.top ? cw : none,
        borderRight: e.right ? cw : none,
        borderBottom: e.bottom ? cw : none,
        borderLeft: e.left ? cw : none,
      }
    }
    if (mode === 'none') return { border: none }
    if (mode === 'all') return { border: w }
    if (mode === 'horizontal') return { borderBottom: r === lastRow ? none : w }
    // outer：只有外圈有框线
    return {
      borderRight: c === lastCol ? none : undefined,
      borderBottom: r === lastRow ? none : undefined,
      boxShadow: undefined,
    }
  }
  return { table, cell }
}

// ============================================================
// 行内节点渲染（画布上的"所见即所得"近似）
// ============================================================

/**
 * 行内节点的**节点级**选中：`元素 + 格子` 定位到一个具体节点（`nodes[index]`）。
 *
 * 为什么单元格也要进 key：同一个文本元素里不会有两份 nodes，但表格的每一格都有一份，
 * 只靠 index 的话"第 3 格的第 0 个节点"和"第 5 格的第 0 个节点"会撞在一起。
 */
export interface NodeSel {
  elementId: string
  /** 文本元素内部为 null；表格单元格为那一格的 id */
  cellId: string | null
  index: number
}

/** 渲染行内节点时的"可点选"上下文；不传就是纯展示 */
interface InlinePick {
  elementId: string
  cellId: string | null
  selectedNode: NodeSel | null
  onSelectNode(sel: NodeSel | null): void
}

const sameNode = (a: NodeSel | null, b: NodeSel): boolean =>
  !!a && a.elementId === b.elementId && a.cellId === b.cellId && a.index === b.index

/**
 * 哪些行内节点**可以被单独选中**。
 *
 * 只有"占位符"这两类：字段 `chip` 与系统变量。
 *
 * 为什么普通文字片段不算：用户的诉求是"无法对**字段内容**进行字体的设置"，
 * 要改的正是这一层。而文字片段的样式在元素/单元格那一层改更顺手 ——
 * 如果中间那段字也能被单独选中，用户在文本元素正中间点一下拿到的是"文字片段"，
 * 反而选不中元素本身（宽度、位置、所属版式区都在元素面板里），
 * 是拿一个小便利换掉一个大入口。硬换行更是没有任何样式可设。
 */
function pickableNode(n: InlineNode): boolean {
  return n.type === 'field' || n.type === 'sysvar'
}

function renderInline(nodes: InlineNode[], fields: FieldMeta[], keyPrefix: string, pick?: InlinePick): ReactNode[] {
  const known = new Set(fields.map((f) => f.id))
  return nodes.map((n, i) => {
    const key = `${keyPrefix}_${i}`
    const mine: NodeSel = { elementId: pick?.elementId ?? '', cellId: pick?.cellId ?? null, index: i }
    /**
     * `data-node-*` 挂在**所有**可承载样式的节点上（便于诊断"这一处到底是第几个节点"），
     * 但**点击钩子只给占位符**（见 pickableNode）。
     */
    const canPick = pickableNode(n)
    const hit = !!pick && canPick && sameNode(pick.selectedNode, mine)
    const nodeProps: Record<string, unknown> =
      n.type === 'br'
        ? {}
        : {
            'data-node-index': i,
            'data-node-kind': n.type,
            ...(pick && canPick
              ? {
                  // 刻意**不** stopPropagation：点 chip 时外面那一层（单元格 / 元素）的点击也要照常发生，
                  // 否则"选中了 chip 却看不到它所在那一格的面板"。节点选中只是多叠一层。
                  onClick: () => pick.onSelectNode(hit ? null : mine),
                }
              : {}),
          }
    const selCls = hit ? ' is-node-sel' : ''
    // 换行节点没有样式（InlineBreak 上没有 style 字段）
    const own = n.type === 'br' ? undefined : nodeCss(n.style)
    if (n.type === 'text') {
      return (
        <span key={key} className={hit ? 'is-node-sel' : undefined} style={own} {...nodeProps}>
          {n.text}
        </span>
      )
    }
    if (n.type === 'br') return <br key={key} />
    if (n.type === 'field') {
      const invalid = !n.fieldId || !known.has(n.fieldId)
      return (
        <span
          key={key}
          className={`bp-chip${invalid ? ' bp-chip--missing' : ''}${selCls}`}
          style={own}
          title={invalid ? `「${n.fieldName || '未绑定'}」已失效或未绑定字段，导出时会原样输出这段文字` : n.fieldName}
          {...nodeProps}
        >
          {/* 截断放在内层：chip 自己必须 `overflow: visible`，否则它的基线会取底边、
              和同一行的前后缀错位（见 editor.css 里 .bp-chip 的注释） */}
          <span className="bp-chip__text">{n.fieldName || '未绑定字段'}</span>
        </span>
      )
    }
    return (
      <span key={key} className={`bp-chip bp-chip--sys${selCls}`} style={own} {...nodeProps}>
        <span className="bp-chip__text">{SYSVAR_LABEL[n.key]}</span>
      </span>
    )
  })
}

// ============================================================
// 二维码 / 条形码的编辑期预览
// ============================================================

interface CodePreview {
  /** 真的能扫的码（只有"固定内容"来源才会生成） */
  svg: string | null
  /** 占位文案：固定内容为空时是"未填写内容"，绑定字段时是字段名 */
  text: string
  /** 占位角标 */
  badge: string
  background: string
  /** 未绑定 / 未填写，画布上用警示样式 */
  warn: boolean
  hint: string
}

/**
 * 为什么"绑定字段"时不画真码：
 * 编辑期根本没有"当前记录"这个稳定值（一条模板要打几百条不同的记录），
 * 拿字段名硬编一个码出来，用户会以为那就是打印效果，扫描出来却是一串假数据。
 * 所以这里只画一个明确的占位框，并把"打印时逐条生成"写在 title 里。
 */
function codePreview(el: Extract<AnyElement, { kind: 'qrcode' | 'barcode' }>, fields: FieldMeta[]): CodePreview {
  const background = el.background || DEFAULT_CODE_BG
  const foreground = el.foreground || DEFAULT_CODE_FG
  const src = el.source

  if (src.kind === 'field') {
    const bound = !!src.fieldId && fields.some((f) => f.id === src.fieldId)
    const name = src.fieldName || '未绑定字段'
    return {
      svg: null,
      text: name,
      badge: bound ? '字段' : '未绑定',
      background,
      warn: !bound,
      hint: bound
        ? `「${name}」：打印时按每条记录的值逐条生成（编辑期不显示真实内容）`
        : '尚未绑定字段，打印时会输出空白',
    }
  }

  const text = src.value.trim()
  if (!text) {
    return { svg: null, text: '未填写内容', badge: '待填', background, warn: true, hint: '在右侧属性面板里填写固定内容或改为从字段取值' }
  }

  // 渲染库对超长 / 非法内容可能抛错。这里必须兜住：画布抛异常会直接冒到 window，
  // 而 e2e 断言"无未捕获异常"，一个畸形字符串就能把整条链路判死。
  let svg: string | null = null
  try {
    const hMm = el.h === 'auto' ? elementHeightMm(el) : Math.max(1, finite(el.h, 20))
    // 二维码必须是正方形：宽高被拉成不一致时取小值，宁可留白也不要画出扫不出来的畸形码
    svg =
      el.kind === 'qrcode'
        ? qrCodeSvg(text, {
            sizeMm: Math.max(4, Math.min(finite(el.w, 28), hMm)),
            ...(el.ecLevel ? { ecLevel: el.ecLevel } : {}),
            foreground,
            background,
          })
        : barcodeSvg(text, {
            widthMm: Math.max(4, finite(el.w, 50)),
            heightMm: Math.max(4, hMm),
            showText: !!el.showText,
            foreground,
            background,
          })
  } catch {
    svg = null
  }
  if (!svg) {
    // 空串是渲染库的"编不出来"约定（空内容 / 超容量 / 条形码含非 ASCII）。
    // 把原因说清楚：只说"生成失败"会让人以为插件坏了。
    const bad =
      el.kind === 'barcode'
        ? isCode128Encodable(text)
          ? '内容无法生成条形码'
          : '条形码只支持数字、字母与常用符号'
        : utf8ByteLength(text) > QR_MAX_BYTES
          ? `内容过长（上限约 ${QR_MAX_BYTES} 字节）`
          : '内容无法生成二维码'
    return { svg: null, text: bad, badge: '出错', background, warn: true, hint: '改短或换一段内容再试' }
  }
  return { svg, text, badge: '', background, warn: false, hint: text }
}

// ============================================================
// 版式区标签
// ============================================================

// ============================================================
// 说明：原来这里有一个 `BandTag` 组件（左页边距里一枚横排小胶囊）。
// 2026-09-22 分区带重做时**删掉**了 —— 它的两个问题正是用户这次抱怨的：
//   ① 三条带里只有循环区那条能显示（表头/表尾挂在"该区有元素"这个条件下，空分区什么都看不到）；
//   ② 页边距槽只有 ~30px 宽，横排文字放不下四个字，只能省略号。
// 现在由「带内标签条 + 左侧竖排标签」两件事承担（DOM 见 `.bp-band__title` / `.bp-band__gutter`），
// 落点算法在 `band-bars.ts`（纯函数、可单测）。
// ============================================================

// ============================================================
// Canvas
// ============================================================

export const Canvas = forwardRef<CanvasHandle, CanvasProps>(function Canvas(
  {
    doc,
    fields,
    layout,
    scale,
    selectedId,
    selectedCellId,
    outOfBoundsIds,
    dropActive,
    dropTarget,
    selectedNode = null,
    kind = 'view',
    onSelect,
    onSelectCell,
    onOpenTableSize,
    onSetMargin,
    onElementIntoCell,
    onSelectNode,
    onMerge,
    onCommitEnd,
    actions,
    newTableId,
    onResizeTable,
    onCloseTableSize,
    onDropTargetChange,
  },
  ref,
) {
  const paperRef = useRef<HTMLDivElement | null>(null)
  const viewportRef = useRef<HTMLDivElement | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  /** 正在就地编辑的单元格（仅表格元素用；null 表示编辑的是元素自身） */
  const [editingCellId, setEditingCellId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  /**
   * 正被拖到"版式区上边界"上、已经推不动的元素 id。
   *
   * 为什么需要它：版式区的上边界是硬约束（循环区元素不能压到页级重复区上），元素顶到边界后
   * 再怎么拖位置都不变 —— 如果画面上没有任何反应，用户会认为"拖动坏了"，
   * 而不是"到头了"。所以顶住期间给出可见反馈（描边 + 一枚"已贴版式区上边"小标）。
   */
  const [pinnedId, setPinnedId] = useState<string | null>(null)
  /**
   * 当前鼠标悬停的元素 id（2026-09-19）。
   *
   * 只为**表格悬浮工具栏**服务（见 renderBand 里那段）：工具栏在"悬停或选中"时出现。
   * 用 `onPointerEnter/Leave` 而不是 `onPointerOver/Out`：后者会在子元素之间反复触发
   * （表格里全是 `td`），每次进出都 setState 会把画布刷爆。
   */
  const [hoverId, setHoverId] = useState<string | null>(null)
  /** Esc 取消编辑时置位，防止随后的 blur 把内容又提交回去 */
  const cancelledRef = useRef(false)

  /**
   * 选中表格时，**行边框手柄**的纵向位置（未缩放 CSS px，相对表格左上角）。
   * 每行一条，**最后一条就是表底边**（= 最后一行的下边框）—— 那里也要有手柄，
   * 否则"最下面那一行"的高度调不了（需求 ⑧）。
   *
   * 为什么行手柄要量 DOM、列手柄却不用：
   *   列宽是**显式给定**的（`colWidthsMm`），按列宽占比换算就准；
   *   行高是可选的 —— `TableRow.heightMm` 为空时由内容撑开，而模型里估的高与画出来的差得远
   *   （这个文件 resolveDrop 上面那段注释记着实测：估 20mm，实际 9.08mm）。
   *   与其再造第三份"单元格几何"，不如直接量真正画出来的 `<tr>` —— 与落点判定同一个道理。
   */
  const [rowEdges, setRowEdges] = useState<number[]>([])

  /** 正在拖 / 缩放时显示的对齐参考线（内容坐标，mm）。松手即清 */
  const [guides, setGuides] = useState<GuideLine[]>([])

  /**
   * 拖行高 / 列宽时的**预览线 + 数值浮层**（用户规格 三）。
   *
   * 规格原话："按下拖拽时：显示一根 1px 主题色（蓝色）预览线跟随鼠标，
   * 旁边浮层显示当前像素值（如 120px）。"
   *
   * 坐标用**视口坐标系**（`position: fixed`）：拖动过程中手指下那一根线必须**1:1 跟手**，
   * 而纸张整体有 `transform: scale()` —— 换算成纸张坐标再乘回去，只要有一次取整就会"线在手指旁边 1px 处抖"。
   * 起点直接取按下时的 `clientX/clientY`（那一下就落在边界线上），于是预览线天然与指针重合。
   */
  const [sizeGhost, setSizeGhost] = useState<{ axis: 'col' | 'row'; x: number; y: number; label: string } | null>(null)
  /**
   * 表格的**编辑态**（真机反馈 2026-09-22 第 6 条）。
   *
   * 未编辑时：悬浮菜单只给「编辑表格 / 删除表格」，**不显示**行首列首的「+」等编辑手柄；
   * 编辑中：手柄全出（加号 / 行首列首 / 拖拽调尺寸），菜单换成编辑功能 + 「完成编辑」。
   * 这样平时是一块可移动的内容，点了编辑才是一张可改的表。
   */
  const [editTableId, setEditTableId] = useState<string | null>(null)
  /** 选中项一旦不再是那张表（点了别的元素 / 空白），就退出编辑态 —— 不留一个幽灵编辑态 */
  useEffect(() => {
    if (editTableId && selectedId !== editTableId) setEditTableId(null)
  }, [editTableId, selectedId])

  /**
   * 正在原地编辑的那一侧页边距（真机反馈 2026-09-22：不要弹原生窗口，就地改）。
   * `value` 存**字符串**：用户输到一半的 `1`、`12.`、空串都要原样留着，不然光标会跳。
   */
  const [editMargin, setEditMargin] = useState<{ side: 'top' | 'right' | 'bottom' | 'left'; value: string } | null>(null)

  /** 提交页边距：非法输入（NaN / 负数 / > 60）一律**忽略并退出编辑**，不动文档 */
  const commitMargin = useCallback(
    (side: 'top' | 'right' | 'bottom' | 'left', raw: string, fallback: number) => {
      const n = Number(raw.trim())
      setEditMargin(null)
      if (raw.trim() === '' || !Number.isFinite(n) || n < 0 || n > 60) {
        if (raw.trim() !== '' && !Number.isFinite(n)) onSetMargin(side, fallback)
        return
      }
      onSetMargin(side, Math.round(n * 10) / 10)
    },
    [onSetMargin],
  )

  /** 从格子里往外拖子元素时跟着指针的小浮标（规格 六）。视口坐标，与预览线同理 */
  const [childGhost, setChildGhost] = useState<{ x: number; y: number; label: string } | null>(null)

  useLayoutEffect(() => {
    /*
     * ⚠️ 2026-09-22：目标从 `selectedId` 扩成 `selectedId ?? hoverId`。
     * 规格 一·二 要求**行手柄与行首「+」在悬停时就能看见**，而行高只能量 DOM
     * （`heightMm` 为空时由内容撑开，模型里估的高与画出来的差得远 —— 见上面那段实测）。
     * 只按 selectedId 量 ⇒ 悬停时 `rowEdges` 是空数组 ⇒ **行手柄与行「+」一个都不渲染**
     * （实测读数 `{cols: 4, rows: 0}`：列手柄全在、行的一个没有）。
     */
    const targetId = selectedId ?? hoverId
    const host = targetId ? paperRef.current?.querySelector<HTMLElement>(`[data-el-id="${targetId}"]`) : null
    const tbl = host?.querySelector<HTMLTableElement>('table.bp-el-table') ?? null
    if (!tbl) {
      setRowEdges((cur) => (cur.length === 0 ? cur : []))
      return
    }
    const next: number[] = []
    for (const tr of Array.from(tbl.querySelectorAll<HTMLElement>('tbody > tr'))) next.push(tr.offsetTop + tr.offsetHeight)
    // 不 pop：最后一条是表底边，那里也要有个手柄去调"最后一行"的行高（需求 ⑧）。
    // 只在真的变了时写回：测量 → setState → 重渲染 → 再测量，不给它打转的机会
    setRowEdges((cur) =>
      cur.length === next.length && cur.every((v, i) => Math.abs(v - next[i]) < 0.5) ? cur : next,
    )
  }, [selectedId, hoverId, doc])

  const render = pageRenderSize(doc.pageSetup)
  const content = contentBoxSize(doc.pageSetup)
  const margin = doc.pageSetup.margin
  const grid = gridOptions(doc.pageSetup)
  const oob = useMemo(() => new Set(outOfBoundsIds), [outOfBoundsIds])

  /** mm → 未缩放 CSS px */
  const pxOf = useCallback((mm: number) => mmToPx(nz(mm, 0)), [])

  // 左侧页边距槽：够宽才放版式区标签。标签字号用 --bp-inv 反向缩放，屏幕上恒定约 9px，
  // 因此它在纸张坐标系里占的宽度是 26px/inv —— 槽宽必须大于它，否则会溢进正文。
  const inv = 1 / Math.max(scale, 0.05)
  /**
   * 版式区标签（表头 / 循环 / 表尾）的槽宽。
   *
   * ⚠️ 标签挂在纸张**左侧外面**（用负 `left`），**本来就不受页边距宽度约束**；
   * 但下面那个 `>= 34px` 的闸门是按"标签写在页边距里"的老做法设的，
   * 于是 2026-09-19 把默认页边距从 20mm 调到 12mm 之后，
   * 12mm 在画布缩放下只有约 31px ⇒ **闸门没过 ⇒ 三个版式区标签全部不显示了**。
   * 用户原话："表头区和表尾区也没有可以调整的地方，**看也看不到**。"
   *
   * ⇒ 给标签一个**最小槽宽**（40px，够放"表头/循环/表尾"两个字），不随页边距收缩。
   */
  const TAG_MIN_PX = 72
  const gutterPx = Math.max(pxOf(margin.left), TAG_MIN_PX * inv)
  const showGutterTags = gutterPx >= 34 * inv

  /**
   * 「你现在在哪一个分区」——三条带里唯一被高亮的那条。
   *
   * 用户原话把这件事说得很清楚："循环区（**橙色高亮，因为现在在循环区**）" ⇒
   * 高亮表达的是**当前所在**，不是"循环区天生是橙的"。
   * 判据取**选中元素所在的区**（没选中时退回 `loop` —— 新元素默认落在这里，
   * 也是绝大多数模板的主战场）。这样"选中循环区里的表格 ⇒ 循环区亮"是自解释的。
   */
  const activeBand = useMemo<BandKey>(() => {
    if (selectedId) {
      for (const b of ['header', 'loop', 'footer'] as BandKey[]) {
        if (readBand(doc, b).some((e) => e.id === selectedId)) return b
      }
      /*
       * 选中的是**格内子元素**：它自己不在任何版式区里，但它所在的那张表在。
       * 不补这一步，“表头区那张表格里的图片被选中 ⇒ 循环区被高亮” —— 高亮在讲一件错的事。
       */
      const owner = parseCellChildId(selectedId)
      if (owner) {
        for (const b of ['header', 'loop', 'footer'] as BandKey[]) {
          const table = readBand(doc, b).find((e) => e.id === owner.tableId)
          if (table) return b
        }
      }
    }
    return 'loop'
  }, [doc, selectedId])

  /**
   * 三条分区的**像素几何**（paper 坐标系，未叠加画布缩放）。
   * 高度用 `computeBandLayout` 的真实值 —— 空分区的高度就是 0，不许在这里"补一个好看的数"，
   * 否则画出来的边界线是假的（用户会照着一个不存在的边界去放东西）。
   */
  const bandGeoPx = useMemo((): Record<BandKey, BandGeometry> => {
    const headerH = pxOf(layout.loopTopMm)
    const loopTop = headerH
    const loopH = pxOf(layout.loopExtentMm)
    const footerTop = pxOf(layout.footerTopMm)
    const footerH = Math.max(0, pxOf(content.h) - footerTop)
    return {
      header: { key: 'header', topPx: 0, heightPx: headerH },
      loop: { key: 'loop', topPx: loopTop, heightPx: loopH },
      footer: { key: 'footer', topPx: footerTop, heightPx: footerH },
    }
  }, [layout.loopTopMm, layout.loopExtentMm, layout.footerTopMm, content.h, pxOf])

  /**
   * 标签条 / 左侧竖排标签的落点（纯函数在 band-bars.ts，含"空分区不画条""挤了就下推"两条规则）。
   * 尺寸都要乘 `inv`(=1/缩放)：画布整体 `transform: scale()` 会把这些小标签一起缩小，
   * 乘回去之后**屏幕上视觉尺寸恒定**（18px / 11px），这是本文件的既定做法（见 `--bp-inv`）。
   */
  const BAND_BAR_PX = 18 * inv
  const bandBars = useMemo(
    () =>
      layoutBandBars(Object.values(bandGeoPx), {
        barHpx: BAND_BAR_PX,
        gapPx: 2 * inv,
        // 带太矮塞不下一条 18px 的标签条 ⇒ 不画条（名字交给左侧竖排标签，那里不挤）
        minBandPx: BAND_BAR_PX * 1.15,
      }),
    [bandGeoPx, BAND_BAR_PX, inv],
  )
  /*
   * ⚠️ `labelHpx` 以前写的是 16px —— 那是**横排**标签的高度；竖排标签的高度等于**它的文字长度**，
   *    真实值约 3 字 × 9px + 内边距 ≈ 40px ⇒ 原来三条标签必然互相压（真机反馈：「三个标签不要挤压」）。
   *    现在按最长名字（3 字）算，并留 6px 间隙。
   */
  const bandGutters = useMemo(
    () =>
      layoutBandGutters(Object.values(bandGeoPx), {
        labelHpx: (BAND_META.header.name.length * 9 + 10) * inv,
        gapPx: 6 * inv,
      }),
    [bandGeoPx, inv],
  )


  // 循环区「一张连续大表」时，画布上仍是模板原样（一行），真正的按记录铺开发生在导出/打印时。
  // 不说清楚的话，用户会以为开关没生效。判定口径与渲染层 mergedLoopTableOf 一致。
  const loopOnly = doc.bands.loop.elements.length === 1 ? doc.bands.loop.elements[0] : null
  const continuousTable = !!loopOnly && loopOnly.kind === 'table' && loopOnly.rowsFromRecords === true

  /**
   * 分区标签的 tooltip。循环区那条要**分情况说话**，因为它有三种完全不同的行为：
   *   · 连续大表：画布按模板原样显示一行，导出时才按记录铺开；
   *   · 记录模板：循环区只渲染首行（一条记录一份）；
   *   · 其余：按行重复。
   * 这几句原来挂在胶囊的 `hint` 上，2026-09-22 分区带重做时原样搬到标签条/竖排标签的 title 上 ——
   * 句子是**同一个事实**，不该因为换了载体就被丢掉。
   */
  const bandTip = useCallback(
    (k: BandKey): string => {
      if (k === 'loop') {
        return continuousTable
          ? '画布按模板原样显示，导出时按记录逐行铺开'
          : kind === 'record'
            ? '记录模板下循环区只渲染首行'
            : BAND_HINT.loop
      }
      return k === 'header' ? BAND_HINT.header : BAND_HINT.footer
    },
    [continuousTable, kind],
  )

  /**
   * 每页重复区内容的底部（mm，版心坐标系）—— 渲染层 `headerReserve` 的画布等价量。
   *
   * 渲染层在 `render/pipeline.ts:337-339` 用**实测**出来的 headerReserve 算循环区偏移：
   * `loopOffset = max(0, loop.offsetMm - headerReserve)`；分页时还会用
   * `max(块.y, 游标)` 再兜一次底，而游标的起点正是 headerReserve
   * （`render/layout.ts:343-345`、`:357`、`:360`）。
   *
   * 表格高度只有 DOM 能量出来，画布拿不到那次测量结果，这里代入同一位置上的**估算**值
   * `elementHeightMm`：公式一模一样，只是高度来源从"实测"换成"估算"。
   */
  const headerReserveMm = useMemo(
    () => doc.bands.header.reduce((m, el) => Math.max(m, nz(el.y, 0) + elementHeightMm(el)), 0),
    [doc.bands.header],
  )
  /** 循环区元素相对版心顶部的额外位移 —— 同 `render/pipeline.ts:339` 的 `loopOffset` */
  const loopOffsetMm = Math.max(0, layout.loopTopMm - headerReserveMm)

  /**
   * 表尾区整组占用的高度（mm）—— 渲染层 `footerReserve`（`render/layout.ts:176`
   * 对表尾块的 `reservedHeight`）的画布等价量，同样把"实测"换成"估算"。
   *
   * 打印侧表尾是**从版心底部往上量**的（`render/layout.ts:409-410`）：
   * `top = max(0, contentH - footerReserve)`，块落在 `top + el.y`。
   * 实测（见任务 5 第 1 步）：同一模板 1 / 6 / 20 / 60 条记录下，表尾两条的
   * 打印 y 恒为 263.75 / 271.64mm，一个字都不动 —— 记录数只影响循环区，
   * 表尾永远贴着版心底部（最底那条的底边正好落在版心边界 277mm 上）。
   */
  const footerReserveMm = useMemo(
    () => doc.bands.footer.reduce((m, el) => Math.max(m, nz(el.y, 0) + elementHeightMm(el)), 0),
    [doc.bands.footer],
  )

  /**
   * 版式区把元素往下推多少（`offsetMm`）、推到哪儿就不许再往上（`floorMm`）。
   *
   * 三个数都是从渲染侧的真实定位抄过来的（只把"实测高度"换成"估算高度"）：
   *  - 页级重复区 `placeBlock(b, b.xMm, b.yMm)` —— 绝对定位，每页克隆一份，offset = 0
   *  - 循环区 `rowTop = max(b.y + loopOffset, 游标)`、游标起点 = headerReserve
   *    （`render/layout.ts:343-345`、`:357`、`:360`）—— offset = loopOffset，floor = headerReserve
   *  - 表尾区 `top = max(0, contentH - footerReserve)`、`placeBlock(b, b.xMm, top + b.y)`
   *    （`render/layout.ts:409-410`）—— 整组从版心**底部**往上量
   */
  const bandGeom = useCallback(
    (band: BandKey): { offsetMm: number; floorMm: number } => {
      if (band === 'loop') return { offsetMm: loopOffsetMm, floorMm: headerReserveMm }
      // 表尾区：打印时贴在版心底部，画布这里**故意不照抄**那个位移。
      //
      // 底部锚定 = `画布 y = contentH - footerReserve + el.y`，而 `footerReserve`
      // 又是 `max(el.y + h)`。于是当前最靠下的那条表尾元素画出来恒等于
      // `contentH - h` —— 与它自己的 y 毫无关系：拖动它，画布上**纹丝不动**，
      // 反倒是同区其它元素跟着往上跑。表尾在这种定位下没有可编辑的空间。
      // 所以画布按"版式区自上而下"的顺序堆叠，把表尾画在它自己的分界线之下，
      // 打印时的真实落点由 `.bp-band__note` 明说。
      if (band === 'footer') return { offsetMm: layout.footerTopMm, floorMm: layout.footerTopMm }
      return { offsetMm: 0, floorMm: 0 }
    },
    [headerReserveMm, layout.footerTopMm, loopOffsetMm],
  )

  /**
   * 元素在画布上的 y（**版心内** mm，不含页边距）。
   *
   * ⚠️ 曾经这里是直接 `el.y`，于是「通用清单」的列头表（每页重复区）与数据表（循环区）
   * 在画布上**完全叠在一起**：循环区那张表既看不见、也只能靠撒点采样才点得到，
   * 刚做的「多记录并成一张大表」开关几乎不可达。根因是 `el.y` 一律从版心顶部算，
   * 而循环区元素的真正落点还要叠加版式区的起点（见上面 headerReserveMm 的注释）。
   */
  const bandTopMm = useCallback(
    (band: BandKey, el: AnyElement): number => {
      const { offsetMm, floorMm } = bandGeom(band)
      return Math.max(nz(el.y, 0) + offsetMm, floorMm)
    },
    [bandGeom],
  )

  /**
   * 某个版式区里所有元素的**画出来的**盒子（mm）。
   *
   * y 一律过一遍 `bandTopMm`（不是模型里的 `el.y`）：循环区元素会被页级重复区顶下去 20mm，
   * 拿模型 y 去比，算出来的线和重叠区都会落在离两个元素都不对的地方。
   * 高度与 `renderBand` 里写 CSS 用的是同一个表达式（`elementHeightMm` / `heightOf`）。
   *
   * 对齐线（guidesFor）与重叠区（overlaps）都从这里取 —— 两处各建一套坐标的话，
   * "同一个量两处各写一套"这个坑就又要踩一次（这个文件已经栽过三次）。
   */
  const bandBoxes = useCallback(
    (band: BandKey): BoxMm[] =>
      readBand(doc, band).map((e) => ({
        id: e.id,
        x: nz(e.x, 0),
        y: bandTopMm(band, e),
        w: Math.max(1, nz(e.w, 20)),
        h: e.h === 'auto' ? Math.max(1, elementHeightMm(e)) : Math.max(1, heightOf(e.h, 10)),
      })),
    [bandTopMm, doc],
  )

  /**
   * 文档级参考线（2026-09-22 新增）：版心左 / **版心水平居中** / 版心右 / 纸张居中 /
   * 分区边界。用户原话："需要更加适用、智能，**不仅仅和其他元素关联，能识别整个文档居中等位置**"。
   *
   * 与元素间对齐线**同一套容差、同一条渲染路径**（都从 `computeGuides` 出来），
   * 唯一区别是渲染时多挂一个 `is-doc` 类（画得实一点）+ 一枚小标签（写清是哪条基准线）。
   */
  const docRefs = useMemo(
    () =>
      buildDocRefs({
        contentW: content.w,
        contentH: content.h,
        margin,
        bandTopsMm: { loop: layout.loopTopMm, footer: layout.footerTopMm },
      }),
    [content.w, content.h, margin, layout.loopTopMm, layout.footerTopMm],
  )

  /**
   * 拖 / 缩放过程中算一次对齐参考线。**只在同一版式区里比**。
   *
   * 三件事都只在调用方看得见，所以写在这里：
   *   ① y 用"画出来的位置"（过一遍 `bandTopMm`）而不是 `el.y`。循环区的元素会被页级
   *      重复区顶下去 20mm，拿模型 y 去比，线会画在离两个元素都不对的地方；
   *   ② 只在同一 band 内比。跨版式区比"对齐"没有意义（它们本来就不在一个坐标系里跑）；
   *   ③ 只画线、**不吸附**。吸附已经由网格那条路负责（`snapMm`），两套吸附同时生效会打架 ——
   *      指针往左一点，网格吸到 5mm，对齐线又把它拽回 6mm，手感是"拖不动"。
   *      ⚠️ 文档级参考线**同样遵守这条**：本次只让它们参与"画线"，不参与吸附。
   *         （`computeGuides` 会顺带算出 `snapped`，这里刻意不取 —— 见上面那条理由。）
   *
   * mm → px 的换算只在渲染那一行（`pxOf`），这里从头到尾是 mm。
   */
  const guidesFor = useCallback(
    (band: BandKey, box: BoxMm): GuideLine[] => {
      const others = bandBoxes(band).filter((b) => b.id !== box.id)
      return dedupeGuides(computeGuides({ moving: box, others, refs: docRefs }).guides)
    },
    [bandBoxes, docRefs],
  )

  /**
   * 任意两个元素的**重叠区**（mm，画出来的坐标），在全模板范围内两两求交。
   *
   * 需求 ⑨ 取消了"元素不能重叠"的拦截，重叠本身不再被阻止 —— 于是"哪里叠了"
   * 必须看得见，否则用户只能靠肉眼在一堆框里找（需求 ⑩：重叠区域用另一种颜色展示）。
   *
   * 性能取舍（刻意**不**做的东西写在这里，免得下次有人"优化"）：
   *   · 全是 mm 空间的纯算术，**一次 DOM 测量都没有**（所以每次 doc 变化重算也不疼）；
   *     真正的坐标只有渲染那一行的 `pxOf` 才转成 px —— 与全文件的约定一致。
   *   · 两两相交是 O(n²)，但 n 是"一页上的元素个数"，几十个也就是几百次浮点比较，
   *     比一次 React 重渲染便宜得多。因此**不引入**虚拟化 / 网格索引 / 空间哈希这类东西。
   *   · `useMemo` 只认 `bandBoxes`（= doc + 版式区几何），拖动时每帧重算的代价即上面那点算术。
   */
  const overlaps = useMemo(() => {
    const boxes = (['header', 'loop', 'footer'] as BandKey[]).flatMap((b) => bandBoxes(b))
    const out: { x: number; y: number; w: number; h: number }[] = []
    for (let i = 0; i < boxes.length; i += 1) {
      for (let j = i + 1; j < boxes.length; j += 1) {
        const a = boxes[i]
        const b = boxes[j]
        const x = Math.max(a.x, b.x)
        const y = Math.max(a.y, b.y)
        const w = Math.min(a.x + a.w, b.x + b.w) - x
        const h = Math.min(a.y + a.h, b.y + b.h) - y
        // 0.05mm 才认：紧挨着的两个元素会因为取整差出千分之几毫米，不该画成"重叠了一条线"
        if (w > 0.05 && h > 0.05) out.push({ x, y, w, h })
      }
    }
    return out
  }, [bandBoxes])

  // ---- 命中测试 ----
  /**
   * 屏幕坐标 → 版心坐标(mm) 的**唯一一份**换算，`onPaper` 顺带报出"在不在纸张里"。
   *
   * 为什么要抽出来：`hitTest` 要的是"夹进版心之后的落点"，`resolveDrop` 要的是
   * **夹之前**的原始位置（下页边距里的落点必须被拒，见 ⑪ 那段）。两处各写一套
   * pxPerMm / margin 换算的话，改了一处另一处不会跟着变 —— 这个文件已经栽过三次。
   */
  const toContent = useCallback(
    (clientX: number, clientY: number): { xMm: number; yMm: number; onPaper: boolean } | null => {
      const paper = paperRef.current
      if (!paper) return null
      const r = paper.getBoundingClientRect()
      if (!Number.isFinite(r.width) || r.width <= 0) return null
      // r.width 是缩放后的视觉宽度，除以纸张 mm 宽即得"每 mm 多少屏幕像素"
      const pxPerMm = r.width / Math.max(render.w, 1)
      if (!Number.isFinite(pxPerMm) || pxPerMm <= 0) return null
      // 纸张左上角为原点、还没减页边距的"原始"落点。分开成两个方向各一份，
      // 是因为下面 `onPaper` 还要按屏幕矩形判一次，横纵两轴的参照边不同。
      const rawX = (px: number): number => (px - r.left) / pxPerMm
      const rawY = (px: number): number => (px - r.top) / pxPerMm
      return {
        xMm: rawX(clientX) - margin.left,
        yMm: rawY(clientY) - margin.top,
        onPaper: clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom,
      }
    },
    [margin.left, margin.top, render.w],
  )

  /**
   * 指针底下是**哪一个单元格**（找不到就 null）。
   *
   * ⚠️ 必须用 `elementsFromPoint`（**整摞**命中）而不是 `elementFromPoint`：
   *    拖动时被拖的东西（元素本身 / 拖拽浮标 / 格内子元素）就压在指针底下，
   *    `elementFromPoint` 只拿最上面那一个 ⇒ `closest('td')` 恒为 null
   *    ⇒「拖进格子」这条链路上全线失灵。本项目在这一点上栽过**两次**
   *    （一次拖已有元素、一次拖格内子元素）。
   *
   * 这段"整摞穿透 + closest"的逻辑原来在本文件里**抄了三遍**（落点判定 / 拖格内子元素 /
   * 拖已有元素落格），三份的差别只有变量名 —— 任何一份漏改都会让某一条路悄悄失灵，
   * 而失灵的表现一律是"没反应"。现在只有这一份。
   */
  const cellAtPoint = useCallback((clientX: number, clientY: number): { tableId: string; cellId: string } | null => {
    for (const node of document.elementsFromPoint(clientX, clientY)) {
      const td = (node as HTMLElement | null)?.closest?.('td[data-cell-id]') as HTMLElement | null
      if (!td) continue
      const cellId = td.getAttribute('data-cell-id') ?? ''
      const tableId = td.closest('[data-el-id]')?.getAttribute('data-el-id') ?? ''
      if (cellId && tableId) return { tableId, cellId }
    }
    return null
  }, [])

  const hitTest = useCallback(
    (clientX: number, clientY: number): DropHit | null => {
      const at = toContent(clientX, clientY)
      if (!at || !at.onPaper) return null
      // 落在页边距里不拒绝，直接吸附到版心内 —— 否则"差一点点"就插不进去，体感很差。
      // 先吸附再钳制：反过来的话，吸附可能把已经钳到边界的坐标又推出去半格。
      const snapClamp = (v: number, max: number): number =>
        Math.min(Math.max(snapMm(v, grid.gridMm, grid.snapToGrid), 0), Math.max(0, max))
      return {
        xMm: snapClamp(at.xMm, content.w),
        yMm: snapClamp(at.yMm, content.h),
      }
    },
    [content.h, content.w, grid.gridMm, grid.snapToGrid, toContent],
  )

  /**
   * 投放判定。
   *
   * 为什么这一步必须由画布来做、不能放到 EditorShell：
   * "落点在哪个格子里"只有 DOM 知道 —— 表格行高是可选的（`row.heightMm` 为 0 时由浏览器按内容撑开），
   * 模型里的高度是估的、和真正画出来的差得远（实测页级列头表 9.08mm vs 估算 20mm）。
   * 与其再造第三份"单元格几何"，不如直接问真正画出来的那个 `<td>`。
   */
  const resolveDrop = useCallback(
    (clientX: number, clientY: number, probe: DropProbe): DropVerdict => {
      const at = toContent(clientX, clientY)
      if (!at) return { kind: 'reject', reason: '画布还没准备好，请再试一次' }
      if (!at.onPaper) return { kind: 'reject', reason: '松手的位置不在纸张上，没有插入' }

      /*
       * 下页边距里**不收**（需求 ⑪）。
       *
       * 落点是元素的**左上角**，元素只会往右下长。落点落在版心底边之下时，
       * `hitTest` 会把它夹到 `content.h` —— 元素整块吊在版心外、压在下页边距上，
       * 编辑期看得见，打印时那片区域什么都没有（用户原话："元素可以正常拖放过去，
       * 但实际打印预览界面不会显示内容"）。这里直接拒绝，"能放下的地方 = 能打印出来的地方"。
       *
       * 为什么只拒下面这一侧：上/左页边距里的落点会被夹到 0，元素往**里**长，落点仍然有效
       * ——"差一点点也能插进去"是刻意的体感，不能一起否掉。右侧同理
       * （`insertPayload` 按元素宽把 x 收回来，落点落在右页边距里也不会跑出版心）。
       */
      if (at.yMm > content.h) {
        return { kind: 'reject', reason: '这里是下页边距，打印时不会显示内容；请放在上面的网格区域内' }
      }

      // 1) 容器（表格单元格）优先：落点在格子里，且这东西塞得进格子
      const hitCell = cellAtPoint(clientX, clientY)
      if (hitCell) {
        const { tableId, cellId } = hitCell
        if (!probe.inline && !probe.cellBlock) {
          return {
            kind: 'reject',
            reason: `格子里能放图片 / 二维码 / 条形码 / 水平线 / 文字 / 字段，装不下「${probe.label}」；请把它放到表格外的空白处`,
          }
        }
        const table = findElement(doc, tableId)?.el
        const loc = table?.kind === 'table' ? findCell(table.rows, cellId) : null
        /*
         * 标题行 / 标题列里不放**字段**（2026-09-23 第 9 条）。
         * 在拖动过程中就拒掉，用户不必等松手才知道 —— 那不是"限制"，是提前把话说清。
         */
        if (probe.field && table?.kind === 'table' && loc && isHeaderCellAt(table, cellId)) {
          return {
            kind: 'reject',
            reason: `标题行 / 标题列里不放字段（「${probe.label}」请放到下面的数据格子里）`,
          }
        }
        const where = table && loc ? `${elementLabel(table)} ${cellLabel(loc)}` : '表格单元格'
        return { kind: 'cell', tableId, cellId, label: where }
      }

      // 2) 元素之间**允许重叠**（需求 ⑨，用户明确要求取消这条限制）：
      //    这里原来有一句"这里已经放了「X」，元素之间不能重叠"的拒绝。
      //    它只在"从左侧面板拖进来"时生效，拖动画布上已有的元素却完全不拦 ——
      //    同一个动作两种结果，本身就是不自洽的。重叠现在只提示、不阻止：
      //    重叠区域由画布上的 `.bp-overlap` 画出来（见下面的 overlaps）。
      return { kind: 'free', xMm: at.xMm, yMm: at.yMm }
    },
    // ⚠️ `cellAtPoint` 必须进依赖（`useCallback` 漏依赖 = 闭包永远停在首次渲染）
    [cellAtPoint, content.h, doc, toContent],
  )

  const scrollToElement = useCallback((id: string) => {
    const paper = paperRef.current
    if (!paper) return
    const node = paper.querySelector<HTMLElement>(`[data-el-id="${id}"]`)
    node?.scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' })
  }, [])

  useImperativeHandle(ref, () => ({ hitTest, resolveDrop, scrollToElement }), [hitTest, resolveDrop, scrollToElement])

  // ---- 指针会话（拖动 / 缩放共用） ----
  const beginSession = useCallback(
    (
      e: ReactPointerEvent,
      el: AnyElement,
      mode: 'move' | 'resize',
      band: BandKey,
      edge?: ResizeEdge,
    ) => {
      const startX = e.clientX
      const startY = e.clientY
      const ox = finite(el.x, 0)
      const oy = finite(el.y, 0)
      const ow = Math.max(1, finite(el.w, 20))
      const oh = el.h === 'auto' ? Math.max(1, elementHeightMm(el)) : Math.max(1, finite(el.h, 10))
      // 拖动/缩放的锚点取**画出来的位置**，不是模型里的 `el.y`：
      // 版式区会先把元素顶到自己的起点（`bandTopMm` 的 floor），被顶掉的这一段如果
      // 还拿 `el.y` 当锚点，元素就会和指针差一个固定偏移 —— 拖一段完全不动（循环区
      // 元素尤其明显：它被表头区顶下去 20mm，往下拖 20mm 都毫无反应）。
      // 以画出来的位置为锚点后：还能动就是 1:1 跟着指针，动不了就正好停在
      // 版式区的可见边界上，模型里也不会留下"画不出来"的 y。
      const geom = bandGeom(band)
      const oDrawn = Math.max(oy + geom.offsetMm, geom.floorMm)
      /**
       * **表头区元素的天花板**（真机反馈 2026-09-23 第 3 条）。
       *
       * 用户原话：「拖动表头区的元素时，会导致循环区的元素也一起变动……请检查其他区域有没有类似BUG」。
       * 根因：循环区起点原来取 `max(循环区声明起点, 表头区**实测内容高度**)` ⇒
       * 表头元素往下一拖，表头"变高"，整个循环区被顶下去（打印端同理）。
       *
       * 修法不是改渲染公式（那会牵动分页），而是**让表头元素出不了自己的带**：
       * 它的底边不许越过 `layout.loopTopMm`（= 表头区高度，用户可在页面属性里改）。
       * 带内自由活动，带外一步都不给 —— 于是它永远撑不破表头区，也就推不动任何人。
       *
       * 表尾区不需要同理的"地板"：它在画布上就是**贴版心底部**画的（见 computeBandLayout），
       * 往下拖只会把自己拖出可见范围（越界由检查条提示），不会推动别的区。
       */
      const ceilMm = band === 'header' ? Math.max(0, layout.loopTopMm) : Number.POSITIVE_INFINITY
      /** 表头区里，元素底边能到的最远"画出来的 y" */
      const maxDrawnY = Math.max(geom.floorMm, ceilMm - oh)
      // 反解：把"画出来的位置"换算回模型 y
      const toModelY = (drawnY: number): number => Math.max(0, drawnY - geom.offsetMm)
      // 以"另一条边固定"的方式做缩放：先把被拖动的那条边换算成 mm 并吸附，再由两条边反推 x/y/w/h。
      // 增量式（w += dx 再取整）在吸附下会抖动：每次都从已经取整的值再叠加，误差会累积。
      const rightEdge = ox + ow
      const bottomEdge = oy + oh
      /** 下边在**画布坐标系**里的位置：缩放"上边"时要拿它当不动的基准（被 floor 顶过就不等于 bottomEdge） */
      const drawnBottom = oDrawn + oh
      // 每 mm 对应多少屏幕像素：受缩放影响，必须按当前 scale 反算
      const mmPerPx = 1 / (MM_TO_PX * Math.max(scale, 0.05))
      const mergeKey = `${mode}:${el.id}`
      let moved = false

      const onMove = (ev: PointerEvent): void => {
        const dxPx = ev.clientX - startX
        const dyPx = ev.clientY - startY
        if (!moved) {
          if (Math.abs(dxPx) + Math.abs(dyPx) < 3) return
          moved = true
        }
        const dx = dxPx * mmPerPx
        const dy = dyPx * mmPerPx
        // 按住 Alt 临时不吸附：拖到"网格中间"的精确位置时用，不必先去关开关
        const snap = (v: number): number => snapMm(v, grid.gridMm, grid.snapToGrid, ev.altKey)

        if (mode === 'move') {
          /*
           * 「允许拖出页面」开关（真机反馈 2026-09-23 第 10 条）：
           * 关着（默认）时把元素**夹在版心内** —— 拖到边缘就停住；
           * 开着才允许越界（越界仍然由检查条提示，不是静默允许）。
           */
          const allowOut = doc.pageSetup.allowOutOfPage === true
          const clampX = (v: number): number => (allowOut ? v : Math.min(v, Math.max(0, content.w - ow)))
          const clampY = (v: number): number => (allowOut ? v : Math.min(v, Math.max(0, content.h - oh)))
          // x 没有版式区偏移，直接按模型 x 吸附（原点就是版心左上角，吸到的位置就是看得见的网格线）
          const nx = clampX(Math.max(0, snap(ox + dx)))
          // y 走"画出来的位置"：先算画布上的落点（夹在版式区上边界内），再反解模型 y。
          // 只钳制到版心左上角，允许拖出右下（越界由检查条提示，不阻止操作，见 F2-14）
          const nd = clampY(Math.min(Math.max(geom.floorMm, snap(oDrawn + dy)), maxDrawnY))
          setPinnedId(nd <= geom.floorMm + 0.01 ? el.id : null)
          setGuides(guidesFor(band, { id: el.id, x: nx, y: nd, w: ow, h: oh }))
          onMerge(el.id, { x: nx, y: round1(toModelY(nd)) }, mergeKey)
          /*
           * ---- 落点反馈（2026-09-23 真机反馈第 4 条）----------------------------------
           *
           * 用户原话：「元素拖到表格上时，没有吸附动画，导致不知道元素最终会落到哪个单元格」。
           *
           * 病根：单元格高亮那一套原本**只接在"从左侧面板拖"那条路**上（`beginPaletteDrag`
           * 里上报 dropTarget），拖**画布上已有的元素**时，`onMove` 从头到尾没有一个字提到单元格
           * —— 只有松手的那一刻才问一次 DOM（见 onUp）。于是整段拖动过程零反馈，
           * 用户只能靠猜。现在拖动过程中实时上报，目标格立刻亮起并脉冲
           * （`.bp-el-cell.is-drop-target` 的 `bpCellSnap` 动画 + "松开即放进这个单元格"提示）。
           *
           * `hit.tableId !== el.id`：拖表格自己时不该提示"放进本表的格子"（表格装不进格子）。
           */
          const hit = cellAtPoint(ev.clientX, ev.clientY)
          onDropTargetChange?.(hit && hit.tableId !== el.id ? { kind: 'cell', cellId: hit.cellId } : null)
          return
        }

        const dir = edge ?? 'se'
        let x = ox
        let y = oy
        let w = ow
        let h = oh
        if (dir.includes('w')) {
          x = snap(ox + dx)
          w = rightEdge - x
        } else if (dir.includes('e')) {
          w = snap(rightEdge + dx) - ox
        }
        if (dir.includes('n')) {
          // 上边同样按"画出来的位置"移动（否则这条边的吸附落点会和画布差一个版式区偏移）。
          // 不动的基准是"画出来的下边"，不是模型里的 `oy + oh` —— 元素被 floor 顶下去时两者不相等。
          const nd = Math.min(Math.max(geom.floorMm, snap(oDrawn + dy)), maxDrawnY)
          setPinnedId(nd <= geom.floorMm + 0.01 ? el.id : null)
          y = toModelY(nd)
          h = drawnBottom - y
        } else if (dir.includes('s')) {
          /* 表头区里往下拉高也要夹住（否则底边越过循环区起点，等于又去推别人） */
          h = Math.min(snap(bottomEdge + dy) - oy, ceilMm - oy)
        }

        const MIN = 4
        // 撞到最小尺寸时，让"被拖的那条边"停在 min 处，另一条边原地不动
        if (w < MIN) {
          if (dir.includes('w')) x = rightEdge - MIN
          w = MIN
        }
        if (h < MIN) {
          if (dir.includes('n')) {
            const nd = Math.max(geom.floorMm, drawnBottom - MIN)
            y = toModelY(nd)
          }
          h = MIN
        }
        // 撞到上/左边界时把宽度还原到边界外侧，保持对边不动
        if (x < 0) {
          if (dir.includes('w')) {
            w = rightEdge
            x = 0
          } else {
            w = Math.max(MIN, w + x)
            x = 0
          }
        }
        if (y < 0) {
          if (dir.includes('n')) {
            h = bottomEdge
            y = 0
          } else {
            h = Math.max(MIN, h + y)
            y = 0
          }
        }
        // 缩放时也画对齐线：拖右边时最想看到的就是"和谁一样宽"。
        // y 传画出来的位置（过 floor），与上面 move 分支同一套坐标。
        setGuides(
          guidesFor(band, {
            id: el.id,
            x,
            y: Math.max(geom.floorMm, y + geom.offsetMm),
            w,
            h,
          }),
        )
        /**
         * ⚠️ **只有真的拖了上/下边，才允许把 `h` 写成数字**（2026-09-18 真机反馈后修正）。
         *
         * 旧式无条件写 `h: round1(h)`，而 `h` 的初值来自 `elementHeightMm(el)` 的**估算值**
         * ⇒ 用户只是横向拖了一下宽度，`h: 'auto'` 就被静默改成了 `5.6`（估算值量化到 0.1mm）。
         * 后果有两个，都很隐蔽：
         *   ① 高度模式从"自动"变成"固定值"（用户在属性面板里才发现）；
         *   ② 同一个 5.6mm，固定值渲染出来比自动矮一点 ⇒ "看着缩水了"。
         * 用户原话："我发现如果手动拖动宽度，那么属性中的'高度模式'就会从自动变为固定值，
         * 这个应该就是 BUG 所在。"
         *
         * ⇒ 移动（`mode==='move'`）与纯横向缩放都**不写 h**；只有 n/s 边才写。
         * 反向对照：本来固定值的元素，横向拖也不会被改回 'auto'（我们只是不写，不是重写）。
         */
        const touchesVerticalEdge =
          mode === 'resize' && !!edge && (edge.includes('n') || edge.includes('s'))
        /**
         * 类型放宽到 `unknown`：这个 patch 里既有数字（x/y/w/h）、数组（列宽），
         * 也有**嵌套对象**（附件的 `config`，见下面"自动转固定宽高"）。
         * 调用处本来就有 `as unknown as Partial<AnyElement>`，所以放宽不影响安全性。
         */
        const patch: Record<string, unknown> = {
          x: round1(x),
          y: round1(y),
          w: round1(w),
        }
        if (touchesVerticalEdge) patch.h = round1(h)
        /**
         * **手动拖动缩放 ⇒ 自动转为「固定宽高」**（2026-09-20 用户指定）。
         *
         * 用户原话："手动去拖动缩放的话，自动转为固定宽高"。
         * 道理也很自然：用户亲手把框拖到某个尺寸，就是明确要"就这么大"；
         * 此时若还停留在「原图尺寸 / 固定高度」那些**由内容决定尺寸**的模式，
         * 框会被内容顶回去 —— 用户的手势等于白做（这正是他报"拖不小"的观感来源）。
         *
         * 只对附件元素做这件事（其它图片类元素本来就是用一个固定的框）。
         * 且只在**真的拖了上下边**时改 —— 纯横向拖动不该顺带改尺寸模式。
         */
        const autoFixedBox =
          touchesVerticalEdge && el.kind === 'attach' && el.config.sizeMode !== 'fixedBox'
        if (autoFixedBox) patch.config = { ...el.config, sizeMode: 'fixedBox' }
        /**
         * 表格：拖外框改宽度时**必须同步列宽**。
         *
         * 画布把列宽写成**绝对 mm**（`<col style="width:Nmm">`）并配 `table-layout: fixed`，
         * 按 CSS 定宽表格算法 `used width = max(W, Σ列宽)` —— 只改 `w` 不改列宽时，
         * **表格宽度纹丝不动、只有蓝框变窄**。
         * 用户原话："蓝色区域是缩小了，但实际的原表格还保持不变，这个蓝色选区和实际的表格
         * 压根就不是一体的一样。"
         * 打印侧本来就会按 `w` 压缩列宽 ⇒ 修完画布与打印口径也一致了。
         */
        if (el.kind === 'table' && Math.abs(round1(w) - finite(el.w, 0)) > 0.05) {
          Object.assign(patch, scaleColWidths(el as TableElement, round1(w)))
        }
        onMerge(el.id, patch as unknown as Partial<AnyElement>, mergeKey)
      }

      const onUp = (ev: PointerEvent): void => {
        document.removeEventListener('pointermove', onMove)
        document.removeEventListener('pointerup', onUp)
        document.removeEventListener('pointercancel', onUp)
        setPinnedId(null)
        // 参考线是"拖动过程中"的东西，松手就收
        setGuides([])
        // 落点高亮同理：松手就收（否则那一格会一直亮着，看起来像选中）
        onDropTargetChange?.(null)
        /**
         * **拖动已有元素、松手落在表格单元格上 ⇒ 交给上层"放进单元格"**（2026-09-19）。
         *
         * 只在 `mode === 'move'`（不是缩放）且**真的移动过**（`moved`）时判定 ——
         * 单纯点一下不该把元素吞进单元格里。
         *
         * 用 `elementFromPoint` 真问 DOM（而不是拿模型算）：表格行高是可选的、
         * 合并格会错位，只有真正画出来的那个 `<td>` 知道"落点在哪个格子里"
         * —— 这个口径与 `resolveDrop` 完全一致，不另造一套几何。
         */
        if (mode === 'move' && moved && onElementIntoCell) {
          /* 整摞命中交给 `cellAtPoint`（与落点判定、拖格内子元素**同一份**实现）。
             被拖的元素就压在指针下，只有 `elementsFromPoint` 才拿得到底下的 td。 */
          const hit = cellAtPoint(ev.clientX, ev.clientY)
          if (hit && hit.tableId !== el.id) onElementIntoCell(el.id, hit.tableId, hit.cellId)
        }
        // 一次拖动/缩放 = 一步撤销，不给"下一个 800ms"继续合并的机会
        if (moved) onCommitEnd?.()
      }

      document.addEventListener('pointermove', onMove)
      document.addEventListener('pointerup', onUp)
      document.addEventListener('pointercancel', onUp)
    },
    // ⚠️ `cellAtPoint` / `onDropTargetChange` / `doc` / `content` 都是被闭包引用的新项，漏进依赖 = 永久失效
    [bandGeom, cellAtPoint, content.h, content.w, doc, grid.gridMm, grid.snapToGrid, guidesFor, onCommitEnd, onDropTargetChange, onMerge, onElementIntoCell, scale],
  )

  /**
   * 拖表格的列 / 行边框线调大小。
   *
   * 列宽走 `setColWidthPatch`：它在改 `colWidthsMm[i]` 的同时把元素总宽 `w` 同步成列宽之和
   * （E-45 的约束）。与右侧面板「第 N 列」输入框调的是**同一个函数** —— 两处各写一遍，
   * 迟早会有一处忘了同步总宽，画布上就表现为"改完列宽，表格右边多出一截/少一截"。
   *
   * 行高走 `setRowHeightPatch`，它的第三态是**自适应**（`heightMm` 缺席）：
   *   · 往下拖到 6mm 以下 → 写回自适应（这一行由内容重新撑开）；
   *   · 双击行边框 → 也是写回自适应（更明确的一条路，不必先拖过头再拖回来）。
   * 写成"下限 6mm"是数据损失 —— 那一行再也长不回去，内容会溢出，所以下限处必须**换态**而不是钳值。
   *
   * 与元素缩放手柄同一套纪律：锚点取按下那一刻的值（不是增量累加），按 `scale` 反算 mm，
   * 松手调一次 `onCommitEnd` 收成一步撤销。
   */
  const onBorderPointerDown = useCallback(
    (e: ReactPointerEvent, el: TableElement, axis: 'col' | 'row', index: number) => {
      // 不冒泡：否则 .bp-el 的 pointerdown 会把这一下当成"拖整个元素"
      e.stopPropagation()
      e.preventDefault()
      if (e.button !== 0) return
      const startX = e.clientX
      const startY = e.clientY
      const mmPerPx = 1 / (MM_TO_PX * Math.max(scale, 0.05))
      const startColMm = finite(el.colWidthsMm[index], 10)
      // 起始行高：模型里写了就用它，没写（自适应）就用**画出来的**高度当锚点，
      // 否则第一次拖动会从"估的高度"跳一下
      const domTr = (e.currentTarget as HTMLElement)
        .closest('.bp-tbl-size')
        ?.parentElement?.querySelector<HTMLElement>(`tr[data-row-index="${index}"]`)
      const startRowMm = finite(el.rows[index]?.heightMm, domTr ? domTr.offsetHeight / MM_TO_PX : 8)
      const mergeKey = `${axis}:${el.id}:${index}`
      let moved = false

      const onMove = (ev: PointerEvent): void => {
        const dPx = axis === 'col' ? ev.clientX - startX : ev.clientY - startY
        if (!moved) {
          if (Math.abs(dPx) < 3) return
          moved = true
        }
        const dMm = dPx * mmPerPx
        /*
         * 预览线 + 浮层：**每帧更新**（松手才写文档）。
         * 浮层里的像素值按 96dpi 的**打印像素**算（`mm × MM_TO_PX`）—— 那才是"这一行印出来多高"，
         * 而屏幕像素会随缩放变，拿它当读数会让人以为改一次大小值就变了。
         */
        /*
         * 弱吸附（规格 三 的可选项）：新尺寸离「别的行/列已有的尺寸」在 6px 以内就吸上去。
         * ⚠️ 容差在这里从**屏幕 px 换算成 mm**（`mmPerPx` 里已经含缩放）——
         *    判定函数只认 mm，与对齐线同一套纪律。
         * ⚠️ 邻居**排除自己**：不排除的话，拖动一开始就会「吸回自己原来的尺寸」，手感像拖不动。
         */
        const rawMm = axis === 'col' ? startColMm + dMm : startRowMm + dMm
        const neighbors =
          axis === 'col'
            ? el.colWidthsMm.filter((_, i) => i !== index)
            : el.rows
                .filter((_, i) => i !== index)
                .map((r) => r.heightMm)
                .filter((h): h is number => typeof h === 'number' && h > 0)
        const snappedMm = snapSizeToNeighbors(rawMm, neighbors, 6 * mmPerPx)
        const nextMm =
          axis === 'col' ? Math.max(MIN_COL_MM, snappedMm) : Math.max(MIN_ROW_MM, snappedMm)
        setSizeGhost({
          axis,
          x: ev.clientX,
          y: ev.clientY,
          label: `${axis === 'col' ? '列宽' : '行高'} ${Math.round(nextMm * MM_TO_PX)}px`,
        })
        /* 写入和浮层读数用**同一个** nextMm（上面算好的，含弱吸附）—— 两处各算一遍必然对不上 */
        if (axis === 'col') {
          const p = setColWidthPatch(el, index, round1(nextMm))
          if (p) onMerge(el.id, p as Partial<AnyElement>, mergeKey)
          return
        }
        const p = setRowHeightPatch(el, index, snappedMm < MIN_ROW_MM ? undefined : round1(nextMm))
        if (p) onMerge(el.id, p as Partial<AnyElement>, mergeKey)
      }

      const onUp = (): void => {
        document.removeEventListener('pointermove', onMove)
        document.removeEventListener('pointerup', onUp)
        document.removeEventListener('pointercancel', onUp)
        setSizeGhost(null)
        if (moved) onCommitEnd?.()
      }

      document.addEventListener('pointermove', onMove)
      document.addEventListener('pointerup', onUp)
      document.addEventListener('pointercancel', onUp)
    },
    [onCommitEnd, onMerge, scale],
  )

  /** 双击行边框 → 这一行回到自适应（与"拖过下限"是同一个终态，但不必先拖过头） */
  const onRowBorderReset = useCallback(
    (el: TableElement, index: number) => {
      const p = setRowHeightPatch(el, index, undefined)
      if (p) onMerge(el.id, p as Partial<AnyElement>)
      onCommitEnd?.()
    },
    [onCommitEnd, onMerge],
  )

  const onElementPointerDown = useCallback(
    (e: ReactPointerEvent, el: AnyElement, band: BandKey) => {
      e.stopPropagation()
      if (e.button !== 0) return
      const editing = editingId === el.id
      // 正在就地编辑时不重选、也不清单元格：点在 textarea 里（选词、拖选）不该把
      // 右侧属性面板从"单元格"打回"整表"，否则一边打字一边面板乱跳。
      if (!editing) {
        onSelectCell(el.id, null)
        onSelect(el.id)
      }
      // 分页符/锁定元素不可拖动（PRD F2-11）
      if (editing || el.locked || el.kind === 'pagebreak') return
      beginSession(e, el, 'move', band)
    },
    [beginSession, editingId, onSelect, onSelectCell],
  )

  const onHandlePointerDown = useCallback(
    (e: ReactPointerEvent, el: AnyElement, edge: ResizeEdge, band: BandKey) => {
      e.stopPropagation()
      e.preventDefault()
      beginSession(e, el, 'resize', band, edge)
    },
    [beginSession],
  )

  // ---- 就地编辑 ----
  const stopEditing = useCallback(() => {
    setEditingId(null)
    setEditingCellId(null)
    setDraft('')
  }, [])

  const beginEditing = useCallback((elId: string, cellId: string | null, text: string) => {
    cancelledRef.current = false
    setEditingId(elId)
    setEditingCellId(cellId)
    setDraft(text)
  }, [])

  const commitEdit = useCallback(
    (el: AnyElement) => {
      if (editingId !== el.id) return
      const cellId = editingCellId
      if (cancelledRef.current) {
        cancelledRef.current = false
        stopEditing()
        return
      }
      const prevNodes =
        cellId && el.kind === 'table'
          ? el.rows.flatMap((r) => r.cells).find((c) => c.id === cellId)?.nodes
          : el.kind === 'text'
            ? el.nodes
            : undefined
      stopEditing()
      const next = textToNodes(draft, fields, prevNodes)
      // 原样关掉时短路：不写文档、不产生撤销记录（见 textToNodes 的注释）
      if (JSON.stringify(next) === JSON.stringify(prevNodes ?? [])) return
      if (cellId && el.kind === 'table') {
        onMerge(el.id, { rows: updateCell(el.rows, cellId, { nodes: next }) })
        return
      }
      onMerge(el.id, { nodes: next })
    },
    [draft, editingCellId, editingId, fields, onMerge, stopEditing],
  )

  /** 就地编辑用 textarea 的三件套：提交 / Esc 取消 / 回车行为随内容而定 */
  const inlineEditProps = (el: AnyElement) => ({
    value: draft,
    autoFocus: true,
    onChange: (ev: React.ChangeEvent<HTMLTextAreaElement>) => setDraft(ev.target.value),
    onBlur: () => commitEdit(el),
    onKeyDown: (ev: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (ev.key === 'Escape') {
        ev.preventDefault()
        cancelledRef.current = true
        stopEditing()
      }
    },
  })

  /**
   * ---- 右键菜单（2026-09-22）--------------------------------------------------
   *
   * 用户原话："全屏画布增加右键菜单，现在按右键弹出的是**飞书的兜底宿主菜单**，
   * 只有个重新加载，需要**依据元素类型**，智能弹出右键菜单。"
   *
   * 三件事一起做才算"智能"：
   *   ① `preventDefault()` 掉宿主菜单（不做这一步，我们的菜单会**和飞书那个一起弹**）；
   *   ② 命中判定分三档：单元格 / 元素 / 空白，各给各的项；
   *   ③ 右键同时**选中**命中对象 —— 这是各家编辑器的通行约定，也让"复制/剪切/对齐"
   *      这类作用在选中项上的动作有了确定对象（不必再往菜单项里塞一份 id）。
   */
  const [ctx, setCtx] = useState<{ x: number; y: number; target: CtxTarget } | null>(null)
  /**
   * 「拆分单元格」弹层（2026-09-23 第 7 条）。
   *
   * 存的是 `{tableId, cellId}` 而**不是**当次渲染的 `rows` —— 弹层开着的这段时间里用户可能改了表格
   * （加了一行、删了一列），闭包里的 `rows` 就是旧快照，一点确认就把这期间的改动整片盖掉。
   * 这与 `PendingMerge` 是同一条理由（见 MergeConfirm 的文件头）。
   */
  const [splitAsk, setSplitAsk] = useState<{ tableId: string; cellId: string } | null>(null)
  /** 上一次拆分被护栏拒掉的原因（动作层的原话）；显示在弹层里，改个数字就能重试 */
  const [splitErr, setSplitErr] = useState<string | null>(null)

  /** 元素在哪个版式区（右键菜单要知道，粘贴/移动都用得上） */
  const bandOf = useCallback(
    (id: string): BandKey => {
      for (const b of ['header', 'loop', 'footer'] as BandKey[]) {
        if (readBand(doc, b).some((e) => e.id === id)) return b
      }
      return 'loop'
    },
    [doc],
  )

  /**
   * 执行拆分（弹层点「拆分」）。
   *
   * ⚠️ 从**当前**文档重新定位：弹层开着的这段时间里表格可能已经被改过（见 `splitAsk` 的注释）。
   * 被护栏拒绝时**不关弹层**，把原因显示出来让用户改数字重试 ——
   * 关掉再让他重新点开、重新输，是把一次纠正变成三次操作。
   *
   * ⚠️ 它必须声明在 `bandOf` / `splitAsk` **之后**：`const` 箭头函数没有提升，
   *    放前面会被 tsc 判 `used before its declaration`（同作用域内的词法引用，与"何时调用"无关）。
   */
  const doSplit = useCallback(
    (rows: number, cols: number) => {
      if (!splitAsk) return
      const table = readBand(doc, bandOf(splitAsk.tableId)).find((e) => e.id === splitAsk.tableId)
      if (!table || table.kind !== 'table') {
        setSplitAsk(null)
        setSplitErr(null)
        return
      }
      const r = splitCellToGrid(table, splitAsk.cellId, rows, cols)
      if (!r.ok) {
        setSplitErr(r.reason)
        return
      }
      onMerge(splitAsk.tableId, r.patch)
      setSplitAsk(null)
      setSplitErr(null)
    },
    [bandOf, doc, onMerge, splitAsk],
  )

  const onCanvasContextMenu = useCallback(
    (ev: React.MouseEvent): void => {
      // ① 干掉飞书兜底菜单。**必须在最前面**：后面任何一步提前 return，宿主菜单都会弹出来。
      ev.preventDefault()
      if (!actions) return
      const node = ev.target as HTMLElement | null
      const cellEl = node?.closest?.('td[data-cell-id]') as HTMLElement | null
      const elEl = node?.closest?.('[data-el-id]') as HTMLElement | null
      const at = toContent(ev.clientX, ev.clientY)

      if (cellEl) {
        const tableId = cellEl.closest('[data-el-id]')?.getAttribute('data-el-id') ?? ''
        const cellId = cellEl.getAttribute('data-cell-id') ?? ''
        if (tableId && cellId) {
          // ③ 右键即选中（单元格级）
          onSelectCell(tableId, cellId)
          setCtx({ x: ev.clientX, y: ev.clientY, target: { kind: 'cell', tableId, cellId } })
          return
        }
      }
      if (elEl) {
        const id = elEl.getAttribute('data-el-id') ?? ''
        if (id) {
          onSelect(id)
          setCtx({ x: ev.clientX, y: ev.clientY, target: { kind: 'element', id, band: bandOf(id) } })
          return
        }
      }
      setCtx({
        x: ev.clientX,
        y: ev.clientY,
        target: { kind: 'blank', band: 'loop', xMm: at?.xMm ?? 0, yMm: at?.yMm ?? 0 },
      })
    },
    [actions, bandOf, onSelect, onSelectCell, toContent],
  )

  /**
   * 菜单项。**每次渲染现算**（不用 useMemo）：它依赖 `ctx` 与十来个回调，
   * 记依赖列表比现算更容易漏，而这点计算量（十来个对象字面量）完全不值得缓存。
   */
  const ctxItems: CtxItem[] = (() => {
    if (!ctx || !actions) return []
    const SEP: CtxItem = { id: '__sep', label: '', separator: true }
    const snapToGrid = grid.snapToGrid

    if (ctx.target.kind === 'child') {
      return [
        /*
         * 真机反馈第 3 条（「完全无法对单元格内的图片、二维码和条形码进行编辑」）的落地方式。
         *
         * 曾经这里只有一条「取出并编辑」—— 先取出到画布、改完再拖回格子。那是**绕路**：
         * 用户的心智是"就改格子里这个东西"。现在选中模型认复合 id（`child:<tableId>:<cellId>`），
         * 选中它右侧面板就是它自己的属性，所以第一项回到"编辑属性"。
         * 「取出到画布」保留 —— 它解决的是另一个真需求（元素要脱离表格自由摆放）。
         *
         * ⚠️ 复制/剪切**必须在这里有条目**：键盘处理器只认 Z / Y / Delete / Esc（**没有 Ctrl+C 分支**），
         *    所以"能复制格内元素"唯一可达的入口就是这条菜单。加了 `copyElement` 的子元素分支
         *    却不给入口 = 死代码（本项目在这一点上很严：要么接上，要么别写）。
         */
        { id: 'child:edit', label: '编辑属性', hint: '右侧面板' },
        SEP,
        { id: 'child:copy', label: '复制', hint: '供粘贴' },
        { id: 'child:cut', label: '剪切', hint: '取走它' },
        SEP,
        { id: 'child:takeOut', label: '取出到画布', hint: '脱离表格自由摆放' },
        SEP,
        { id: 'child:remove', label: '移除格内元素', danger: true },
      ]
    }

    if (ctx.target.kind === 'cell') {
      const { tableId, cellId } = ctx.target
      const table = readBand(doc, bandOf(tableId)).find((e) => e.id === tableId)
      const loc = table && table.kind === 'table' ? findCell(table.rows, cellId) : null
      const row = loc && table && table.kind === 'table' ? table.rows[loc.rowIdx] : null
      const canSplit = !!(table && table.kind === 'table' && loc && (loc.cell.colspan > 1 || loc.cell.rowspan > 1))
      const rowCount = table && table.kind === 'table' ? table.rows.length : 0
      const colCount = table && table.kind === 'table' ? table.colWidthsMm.length : 0
      /** 右键那一格所在的**网格列号**（标题列作用在整列上）；拿不到就是 null ⇒ 菜单项不出现 */
      const colIdxOfCell =
        table && table.kind === 'table' && loc
          ? ((tableGrid(table.rows, table.colWidthsMm.length)[loc.rowIdx] ?? []).find(
              (g) => g?.cell.id === cellId,
            )?.colStart ?? null)
          : null
      return [
        { id: 'cell:edit', label: '编辑此单元格', hint: '双击同效' },
        SEP,
        { id: 'cell:rowAbove', label: '在上方插入行' },
        { id: 'cell:rowBelow', label: '在下方插入行' },
        { id: 'cell:colLeft', label: '在左侧插入列' },
        { id: 'cell:colRight', label: '在右侧插入列' },
        SEP,
        { id: 'cell:mergeRight', label: '与右侧单元格合并' },
        { id: 'cell:mergeDown', label: '与下方单元格合并' },
        { id: 'cell:split', label: '拆分单元格', disabled: !canSplit },
        SEP,
        {
          id: 'cell:headerRow',
          label: row?.isHeader ? '取消表头行' : '设为表头行',
          checked: !!row?.isHeader,
          hint: '跨页重复',
        },
        /*
          标题列（规格 五）：作用范围是**整列**，不是右键点中的那一格。
          ⚠️ 要拿「这一格在网格里是第几列」得先摊平 —— `loc.colIdx` 是数组下标，
             span 模型下与列号不是一回事（同一个坑这个项目里已经踩过三次）。
        */
        ...(colIdxOfCell != null
          ? [
              { id: 'cell:headerCol', label: '设为标题列', hint: '整列加粗居中' } as CtxItem,
              { id: 'cell:unheaderCol', label: '取消标题列' } as CtxItem,
            ]
          : []),
        SEP,
        /* 规格 六：「单元格内的元素可以再拖出来，回到画布自由层」——这里给的是**菜单入口**
           （拖出需要"从格子里起拖"的一整套手势，本轮先用可发现的入口满足同一诉求）。 */
        ...(loc?.cell.children && loc.cell.children.length > 0
          ? [
              /* 右键落在**格子**上（不是子元素本身）时也得能进去改它 —— 否则用户得先
                 精确点在图片上；图片旁边那片留白也会被当成"这一格" */
              { id: 'cell:editChild', label: '编辑格内元素', hint: '右侧面板' } as CtxItem,
              { id: 'cell:takeOut', label: '取出到画布', hint: '放回画布' } as CtxItem,
              { id: 'cell:rmChild', label: '移除格内元素', danger: true } as CtxItem,
              SEP,
            ]
          : []),
        /* 只剩一行/一列时把菜单项**禁用**（而不是删掉）：位置稳定，用户也能看出"为什么不能删" */
        { id: 'cell:delRow', label: '删除当前行', danger: true, disabled: rowCount <= 1 },
        { id: 'cell:delCol', label: '删除当前列', danger: true, disabled: colCount <= 1 },
      ]
    }

    if (ctx.target.kind === 'element') {
      const { id, band } = ctx.target
      const list = readBand(doc, band)
      const i = list.findIndex((e) => e.id === id)
      return [
        { id: 'el:cut', label: '剪切' },
        { id: 'el:copy', label: '复制' },
        { id: 'el:paste', label: '粘贴', disabled: !actions.clipboardHas, hint: '⌘V' },
        SEP,
        {
          id: 'align',
          label: '对齐',
          sub: [
            { id: 'el:align:left', label: '左对齐' },
            { id: 'el:align:hcenter', label: '水平居中' },
            { id: 'el:align:right', label: '右对齐' },
            SEP,
            { id: 'el:align:top', label: '顶对齐' },
            { id: 'el:align:vcenter', label: '垂直居中' },
            { id: 'el:align:bottom', label: '底对齐' },
          ],
        },
        {
          id: 'zorder',
          label: '排列',
          sub: [
            { id: 'el:z:front', label: '置顶', disabled: i === list.length - 1 },
            { id: 'el:z:forward', label: '上移一层', disabled: i === list.length - 1 },
            { id: 'el:z:backward', label: '下移一层', disabled: i <= 0 },
            { id: 'el:z:back', label: '置底', disabled: i <= 0 },
          ],
        },
        SEP,
        { id: 'el:delete', label: '删除', hint: 'Del', danger: true },
      ]
    }

    return [
      { id: 'blank:paste', label: '粘贴到此处', disabled: !actions.clipboardHas, hint: '⌘V' },
      SEP,
      /*
       * ⚠️ 真机反馈（2026-09-22）：「不论网格间距设置多少，都一致提示 5mm 步进」——
       *    那句提示原来是**写死**的字符串。现在读 grid.gridMm（真实值），
       *    并按用户点名把「显示网格 / 网格间距 / 页边距」也放进菜单。
       */
      { id: 'blank:toggleGrid', label: '显示网格', checked: grid.showGrid },
      { id: 'blank:toggleSnap', label: '网格吸附', checked: grid.snapToGrid, hint: `${grid.gridMm}mm 步进` },
      {
        id: 'gridStep',
        label: '网格间距',
        hint: `${grid.gridMm}mm`,
        sub: GRID_STEPS.map((mm) => ({ id: `blank:grid:${mm}`, label: `${mm}mm`, checked: grid.gridMm === mm })),
      },
      {
        id: 'gridMargin',
        label: '页边距',
        sub: MARGIN_PRESETS.map((m) => ({ id: `blank:margin:${m.mm}`, label: `${m.name}（${m.mm}mm）` })),
      },
      SEP,
      /*
       * 「允许拖出页面」（2026-09-23 真机反馈第 10 条）。
       * 用户要求它出现在**页面属性与画布右键菜单**两处 —— 右键是"正拖不动"时最顺手的入口。
       */
      { id: 'blank:allowOut', label: '允许拖出页面', checked: doc.pageSetup.allowOutOfPage === true },
    ]
  })()

  const onCtxPick = useCallback(
    (id: string): void => {
      if (!ctx || !actions) return
      const t = ctx.target
      if (t.kind === 'child') {
        if (id === 'child:edit') {
          // 右键时已经选好了（见渲染处的 onContextMenu）；这里再落一次是为了
          // "菜单执行时对象与打开时一致"那条约束（中间可能被别的事件改过选中）
          onSelect(cellChildId(t.tableId, t.cellId))
          return
        }
        /*
         * 复制/剪切传的是**复合 id**（子元素在选中模型里的 id）。
         * `copyElement` 里专门有一段处理它：把 `w` 从"占格宽百分比"换算成 mm 再进剪贴板
         * （否则粘到画布上会变成 100mm 宽）。`cutElement` = 复制 + 摘掉它。
         */
        const childId = cellChildId(t.tableId, t.cellId)
        if (id === 'child:copy') {
          actions.copy(childId)
          return
        }
        if (id === 'child:cut') {
          actions.cut(childId)
          return
        }
        if (id === 'child:takeOut') actions.takeOutChild(t.tableId, t.cellId)
        if (id === 'child:remove') actions.removeChild(t.tableId, t.cellId)
        return
      }

      if (t.kind === 'cell') {
        if (id === 'cell:edit') {
          const table = readBand(doc, bandOf(t.tableId)).find((e) => e.id === t.tableId)
          const cell = table && table.kind === 'table' ? findCell(table.rows, t.cellId)?.cell : null
          if (cell) beginEditing(t.tableId, cell.id, nodesToText(cell.nodes))
          return
        }
        if (id === 'cell:headerCol' || id === 'cell:unheaderCol') {
          const table = readBand(doc, bandOf(t.tableId)).find((e) => e.id === t.tableId)
          if (!table || table.kind !== 'table') return
          const loc = findCell(table.rows, t.cellId)
          if (!loc) return
          const col =
            (tableGrid(table.rows, table.colWidthsMm.length)[loc.rowIdx] ?? []).find((g) => g?.cell.id === t.cellId)
              ?.colStart ?? null
          if (col == null) return
          actions.applyRange(
            t.tableId,
            { r1: 0, c1: col, r2: table.rows.length - 1, c2: col },
            { kind: 'headerCol', on: id === 'cell:headerCol' },
          )
          return
        }
        if (id === 'cell:editChild') {
          onSelectCell(t.tableId, t.cellId)
          onSelect(cellChildId(t.tableId, t.cellId))
          return
        }
        if (id === 'cell:takeOut') return actions.takeOutChild(t.tableId, t.cellId)
        if (id === 'cell:rmChild') return actions.removeChild(t.tableId, t.cellId)
        if (id === 'cell:rowAbove') return actions.insertRow(t.tableId, t.cellId, 'above')
        if (id === 'cell:rowBelow') return actions.insertRow(t.tableId, t.cellId, 'below')
        if (id === 'cell:colLeft') return actions.insertCol(t.tableId, t.cellId, 'left')
        if (id === 'cell:colRight') return actions.insertCol(t.tableId, t.cellId, 'right')
        if (id === 'cell:delRow') return actions.deleteRow(t.tableId, t.cellId)
        if (id === 'cell:delCol') return actions.deleteCol(t.tableId, t.cellId)
        if (id === 'cell:mergeRight' || id === 'cell:mergeDown') {
          actions.askMerge(t.tableId, t.cellId, id === 'cell:mergeRight' ? 'right' : 'down')
          return
        }
        if (id === 'cell:split') {
          actions.splitCell(t.tableId, t.cellId)
          return
        }
        if (id === 'cell:headerRow') {
          const table = readBand(doc, bandOf(t.tableId)).find((e) => e.id === t.tableId)
          const loc = table && table.kind === 'table' ? findCell(table.rows, t.cellId) : null
          if (loc) actions.setHeaderRow(t.tableId, loc.rowIdx)
          return
        }
        return
      }
      if (t.kind === 'element') {
        if (id === 'el:copy') return actions.copy(t.id)
        if (id === 'el:cut') return actions.cut(t.id)
        if (id === 'el:paste') return actions.paste(t.band, { x: 0, y: 0 })
        if (id === 'el:delete') return actions.remove(t.id)
        if (id.startsWith('el:align:')) return actions.align(t.id, id.slice('el:align:'.length) as AlignMode)
        if (id.startsWith('el:z:')) {
          const where = id.slice('el:z:'.length) as 'front' | 'back' | 'forward' | 'backward'
          return actions.zIndex(t.id, where)
        }
        return
      }
      if (id === 'blank:paste') actions.paste(t.band, { x: t.xMm, y: t.yMm })
      if (id === 'blank:toggleSnap') actions.toggleSnap()
      if (id === 'blank:toggleGrid') actions.setPageSetup({ showGrid: !grid.showGrid })
      if (id.startsWith('blank:grid:')) actions.setPageSetup({ gridMm: Number(id.slice('blank:grid:'.length)) })
      if (id.startsWith('blank:margin:')) actions.setPageSetup({ marginAllMm: Number(id.slice('blank:margin:'.length)) })
      if (id === 'blank:allowOut') actions.setPageSetup({ allowOutOfPage: doc.pageSetup.allowOutOfPage !== true })
    },
    [actions, bandOf, beginEditing, ctx, doc],
  )

  /**
  /**
   * ---- 矩形选区（2026-09-22，用户规格 四·核心）---------------------------------
   *
   * 用户原话："在表格内按下鼠标并拖动，形成矩形多选区域：被选中的所有单元格整体用主题色半透明高亮。
   * 支持 Shift + 点击单元格扩展选区、Esc 取消选中。"
   *
   * ⚠️ 这里**故意改变了"拖动表格"的入口**：单元格从 click-only 变成 pointerdown 起选区。
   *    原来的注释写着"用 click 而不是 pointerdown 选单元格：pointerdown 一旦拦住冒泡，
   *    整个表格就没法拖动了"—— 那是 2026-09-22 之前没有**表格手柄**时的取舍。
   *    规格 一 明确给了手柄这个角色（"表格手柄（点按后整个表格可拖动）"），
   *    而规格 四 又要求"在表格内按下鼠标并拖动" ⇒ 两者只能二选一：现在**拖表格走手柄，拖格子走选区**。
   *    点选单格仍然走 `onClick`（不受影响）。
   */
  const [cellSel, setCellSel] = useState<{
    tableId: string
    anchor: { r: number; c: number }
    head: { r: number; c: number }
  } | null>(null)

  /** 选区归一化 + 扩张（把被切到的合并块整块纳入），所有下游共用这一份 */
  const selRange = useMemo(() => {
    if (!cellSel) return null
    const found = readBand(doc, bandOf(cellSel.tableId)).find((e) => e.id === cellSel.tableId)
    if (!found || found.kind !== 'table') return null
    const raw = normalizeRange(cellSel.anchor, cellSel.head)
    return expandRangeToWholeCells(found.rows, found.colWidthsMm.length, raw)
  }, [bandOf, cellSel, doc])

  /** 单元格的网格坐标 → 是不是落在当前选区里 */
  const inSel = useCallback(
    (tableId: string, r: number, c: number, range: CellRange | null): boolean => {
      if (!cellSel || !range || cellSel.tableId !== tableId) return false
      return r >= range.r1 && r <= range.r2 && c >= range.c1 && c <= range.c2
    },
    [cellSel],
  )

  /**
   * 工具条的落点：取"所有高亮格子"的并集矩形，**浮在它上方**（规格：不遮挡选区）。
   *
   * 位置每次 `cellSel` / 文档 / 缩放变化后**量一次 DOM**（`is-rsel` 是刚渲染上去的），
   * 量不到（选区被删了/不可见）就当没有选区。
   * 上方空间不够（< 56px）时翻到下方 —— 这就是规格说的"自动避让边缘"。
   */
  const [barAt, setBarAt] = useState<{ left: number; top: number } | null>(null)
  useLayoutEffect(() => {
    if (!cellSel) {
      setBarAt(null)
      return
    }
    const nodes = Array.from(paperRef.current?.querySelectorAll<HTMLElement>('td.is-rsel') ?? [])
    if (nodes.length === 0) {
      setBarAt(null)
      return
    }
    let l = Infinity
    let t = Infinity
    let r2 = -Infinity
    for (const n of nodes) {
      const b = n.getBoundingClientRect()
      l = Math.min(l, b.left)
      t = Math.min(t, b.top)
      r2 = Math.max(r2, b.right)
    }
    const BAR_H = 30
    const below = t < BAR_H + 26
    setBarAt({
      left: Math.round(Math.min(Math.max(8, (l + r2) / 2), window.innerWidth - 12)),
      top: Math.round(below ? t + 26 : t - BAR_H - 4),
    })
  }, [cellSel, doc, scale])

  /**
   * 单元格 pointerdown：起一个"拖动扩选"会话。
   * 用 `document` 上的监听器而不是 td 自己的 —— 指针一定会移出这一格（甚至移出表格）。
   * 扩展目标靠 `elementFromPoint` 反查那一格的 `data-cell-id`，再换算成网格坐标：
   * 网格坐标不能从"渲染时的 r/ci"拿（那是数组下标，span 模型下与列号不是一回事）。
   */
  const onCellPointerDown = useCallback(
    (ev: ReactPointerEvent, el: TableElement, rowIdx: number, colIdx: number, cellId: string) => {
      if (ev.button !== 0) return
      /*
       * ⚠️ **真机反馈（2026-09-22）**：原来这里无条件 `stopPropagation`，于是"按住表格里的
       *    任何一格都拖不动表格"，只有把准心压到最外框那一圈才能拖 —— 用户原话
       *    「明明图标已经变成拖动的样式，必须要把准心放到表格最外框的中央才可以移动」。
       *
       * ⇒ 判据改成：**只有按住 Shift 才接管**（Shift + 拖 = 框选）。不按 Shift 时直接 return，
       *    事件照常冒泡到 `.bp-el` ⇒ 走"拖动整个元素"那条老路 ✓
       *    「移动元素」是最高频的动作，不该被"框选"抢走 —— 框选的入口还有表格手柄那条路。
       */
      /* 非编辑态不接管（事件冒泡 ⇒ 按住任意位置都能拖动整个表格）；编辑态才接管 = 框选。 */
      if (editTableId !== el.id) {
        /*
         * ⚠️ 顺手把**上一次的矩形选区**清掉（2026-09-23）。
         *
         * `cellSel` 只在编辑态里被维护，退出编辑态后它一直留着 ⇒ 高亮还在、右侧工具条还在，
         * 而"合并单元格"这类按钮会按那个**陈旧选区**判成可用 ——
         * 用户此刻明明只点了这一格，看到的却是"合并"亮着（真机 e2e 里就是这条先红的）。
         * 落一次新指针 = 上一次交互结束，这是最自然的清理时机。
         */
        if (cellSel) setCellSel(null)
        return
      }
      ev.stopPropagation()
      const grid = tableGrid(el.rows, el.colWidthsMm.length)
      const at = (r: number, c: number) => grid[r]?.[c] ?? null
      const anchorCell = at(rowIdx, colIdx)
      if (!anchorCell) return
      const anchor = { r: anchorCell.rowStart, c: anchorCell.colStart }

      if (ev.shiftKey && cellSel && cellSel.tableId === el.id) {
        // Shift + 点击：只改 head，锚点不动（与各家表格一致）
        setCellSel({ ...cellSel, head: anchor })
        return
      }
      setCellSel({ tableId: el.id, anchor, head: anchor })

      /** 指针位置 → 网格坐标（反查 DOM，再按 id 在网格里定位） */
      const gridAt = (x: number, y: number): { r: number; c: number } | null => {
        const node = document.elementFromPoint(x, y) as HTMLElement | null
        const id = node?.closest?.('td[data-cell-id]')?.getAttribute('data-cell-id') ?? null
        if (!id) return null
        for (let r = 0; r < el.rows.length; r += 1) {
          for (let c = 0; c < el.colWidthsMm.length; c += 1) {
            const g = grid[r]?.[c]
            if (g && g.cell.id === id && g.rowStart === r) return { r, c }
          }
        }
        return null
      }

      const onMove = (mv: PointerEvent): void => {
        const to = gridAt(mv.clientX, mv.clientY)
        if (!to) return
        setCellSel((cur) => (cur && (cur.head.r !== to.r || cur.head.c !== to.c) ? { ...cur, head: to } : cur))
      }
      const onUp = (): void => {
        document.removeEventListener('pointermove', onMove)
        document.removeEventListener('pointerup', onUp)
        document.removeEventListener('pointercancel', onUp)
      }
      document.addEventListener('pointermove', onMove)
      document.addEventListener('pointerup', onUp)
      document.addEventListener('pointercancel', onUp)
    },
    [cellSel, editTableId],
  )

  /**
   * 单元格子元素的拖动会话（规格 六 的最后一句）。
   *
   * 三种落点三种结果：
   *   · 落在**别的格子**上 ⇒ 换格（`moveChildToCell`）；
   *   · 落在纸张上、但不在任何格子里 ⇒ 取出放回自由层（`takeOutChild` 带坐标）；
   *   · 落回原地 / 落在纸外 ⇒ 什么都不做（**不弹提示**：那是用户自己取消的动作，
   *     弹一句「已取消」只会变成噪音）。
   *
   * ⚠️ 拖动**拖过 4px 才算拖**（与面板拖拽同一口径）：否则"点一下子元素"会被当成拖动，
   *    而点一下本来该是"选中这一格"。
   */
  const onChildPointerDown = useCallback(
    (ev: ReactPointerEvent, table: TableElement, cellId: string, child: AnyElement) => {
      if (ev.button !== 0 || !actions) return
      ev.stopPropagation()
      const startX = ev.clientX
      const startY = ev.clientY
      let moved = false
      let lastCell: { tableId: string; cellId: string } | null = null

      const onMove = (mv: PointerEvent): void => {
        if (!moved) {
          if (Math.abs(mv.clientX - startX) + Math.abs(mv.clientY - startY) < 4) return
          moved = true
        }
        setChildGhost({ x: mv.clientX, y: mv.clientY, label: elementLabel(child) })
        const hit = cellAtPoint(mv.clientX, mv.clientY)
        lastCell = hit && hit.tableId !== table.id ? hit : null
        onDropTargetChange?.(lastCell ? { kind: 'cell', cellId: lastCell.cellId } : null)
      }

      const onUp = (up: PointerEvent): void => {
        document.removeEventListener('pointermove', onMove)
        document.removeEventListener('pointerup', onUp)
        document.removeEventListener('pointercancel', onUp)
        setChildGhost(null)
        onDropTargetChange?.(null)
        if (!moved) {
          /*
           * 没越过 4px = **点击**（见函数头"拖过 4px 才算拖"那条）。
           *
           * ⚠️ 这里以前是 `if (!moved) return` —— 于是点格内元素**什么都不发生**，
           * 点击继续冒泡到 `<td>` 的 onClick，面板显示的是那一格的字段绑定
           * （真机反馈第 3 条："点击该单元格后，右侧属性面板显示 @image#1:… 未绑定字段"）。
           * 现在点击把选中落到**这个子元素自己**（复合 id `child:<tableId>:<cellId>`），
           * 面板据此显示它的属性；`onSelectCell` 照旧选中那一格 —— "它属于哪一格"是用户要看的信息。
           *
           * 注意 `<td>` 的 onClick 仍会跑到（pointerdown 的 stopPropagation 拦不住 click），
           * 它会再 `onSelect(el.id)` 把选中打回整表 —— 所以子元素那层加了
           * `onClick` 的 stopPropagation（见渲染处），两处必须成对，删一个就退化成原样。
           */
          onSelectCell(table.id, cellId)
          onSelect(cellChildId(table.id, cellId))
          return
        }
        const target = lastCell as { tableId: string; cellId: string } | null
        if (target && !(target.tableId === table.id && target.cellId === cellId)) {
          actions.moveChildToCell(table.id, cellId, target.tableId, target.cellId)
          return
        }
        const at = toContent(up.clientX, up.clientY)
        if (at?.onPaper && !target) {
          actions.takeOutChild(table.id, cellId, { xMm: at.xMm, yMm: at.yMm })
        }
      }

      document.addEventListener('pointermove', onMove)
      document.addEventListener('pointerup', onUp)
      document.addEventListener('pointercancel', onUp)
    },
    // ⚠️ `onSelect` / `onSelectCell` / `cellAtPoint` 是新增依赖：`useCallback` 漏依赖 = 闭包永远停在首次渲染，
    //    表现为"代码看起来完全正确但点击永不生效"（本项目在 `onCellPointerDown` 上刚栽过一次）。
    [actions, cellAtPoint, onDropTargetChange, onSelect, onSelectCell, toContent],
  )

  /** Esc 取消选区。**先于**编辑器的 Esc（取消选中元素）处理，两件事同时发生也不冲突（都只是清状态） */
  useEffect(() => {
    if (!cellSel) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setCellSel(null)
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [cellSel])

  /**
   * 工具条的动作 → 具体怎么改。
   *
   * 合并与删除行/列**会丢东西**（图片格/整行内容），所以它们走 `actions.*` 里那条带确认层的路
   * （`askMergeRange` / `deleteRow` / `deleteCol`），而不是在这里直接改文档。
   * 样式类（对齐/加粗/底纹/表头）不丢东西，直接套补丁。
   */
  const onRangeOp = useCallback(
    (op: RangeOp): void => {
      if (!cellSel || !selRange || !actions) return
      const { tableId } = cellSel
      const found = readBand(doc, bandOf(tableId)).find((e) => e.id === tableId)
      if (!found || found.kind !== 'table') return
      const el = found
      const first = tableGrid(el.rows, el.colWidthsMm.length)[selRange.r1]?.[selRange.c1]?.cell.id ?? null

      switch (op.kind) {
        case 'merge':
          actions.askMergeRange(tableId, selRange)
          return
        case 'split':
          if (first) actions.splitCell(tableId, first)
          return
        case 'bold':
          actions.applyRange(tableId, selRange, { kind: 'bold', on: op.on })
          return
        case 'align':
          actions.applyRange(tableId, selRange, op)
          return
        case 'fill':
          actions.applyRange(tableId, selRange, op)
          return
        case 'header':
          actions.applyRange(tableId, selRange, op)
          return
        case 'border':
        case 'borderFollow':
        case 'borderWidth':
        case 'borderColor':
        case 'headerCol':
        case 'color':
          actions.applyRange(tableId, selRange, op)
          return
        case 'insertRow':
          if (first) actions.insertRow(tableId, first, 'below')
          return
        case 'insertCol':
          if (first) actions.insertCol(tableId, first, 'right')
          return
        case 'deleteRow':
        case 'deleteCol': {
          // 删除要用**定位器 cellId**（行/列号在确认层开着时会变）
          const anchor = tableGrid(el.rows, el.colWidthsMm.length)[selRange.r1]?.[selRange.c1]?.cell.id
          if (!anchor) return
          if (op.kind === 'deleteRow') actions.deleteRow(tableId, anchor)
          else actions.deleteCol(tableId, anchor)
          return
        }
        default:
          return
      }
    },
    [actions, bandOf, cellSel, doc, selRange],
  )

  /**
   * 单元格里的块级子元素怎么画（规格 六）。
   *
   * 只支持"放进格子里说得通"的几种：图片 / 二维码 / 条形码 / 文本 / 水平线。
   * 其余（表格 / 附件块 / 分页符）给一句**明确的占位说明**，而不是画成空白 ——
   * 空白会让用户以为"拖进来没成功"。
   *
   * ⚠️ 与自由层元素的画法**同一套取值**（图片的 `object-fit`、码的 svg 串），
   *    否则"同一张图在格子里和在画布上长得不一样"这种事迟早出现。
   */
  const renderCellChild = (child: AnyElement): ReactNode => {
    if (child.kind === 'image') {
      /*
       * ⚠️ 还没选图时**必须给占位盒**（2026-09-23 真机反馈第 2 条）。
       * `<img src="">` 会塌成一条细线：宽度撑满、高度几乎为 0 ⇒ 用户看到的就是"格内图片是窄条"。
       * 而且细线意味着**点不中**，右键自然也就落到表格上去了（第 3 条那个"菜单还是表格设置"）。
       */
      if (!child.dataUrl) {
        return (
          <span className="bp-el-cell__child-phbox is-warn" title="还没选择图片：在右侧属性面板里选一张">
            <span className="bp-el-cell__child-phbox-title">图片</span>
            <span>在右侧属性面板选择图片</span>
          </span>
        )
      }
      return (
        <img
          className="bp-el-cell__child-img"
          src={child.dataUrl}
          alt=""
          /* 图片默认可拖拽（HTML 规范）：浏览器自己起原生 dnd，我们的 pointermove 会话就不触发了
             ⇒ 表现为「格内图片拖不动」。自由层那张早加了 draggable={false}，格内这张漏了。 */
          draggable={false}
          style={{ objectFit: child.fit === 'cover' || child.fit === 'fill' ? child.fit : 'contain' }}
        />
      )
    }
    if (child.kind === 'qrcode' || child.kind === 'barcode') {
      const p = codePreview(child, fields)
      if (p.svg) {
        return <span className="bp-el-cell__child-code" dangerouslySetInnerHTML={{ __html: p.svg }} />
      }
      /*
       * 画不出真码时（绑定字段 / 固定内容为空）给**占位盒**，与自由层同一套视觉语言
       * （`bp-el-code--ph` 的角标 + 名称 + 说明），而不是只丢一行小灰字 ——
       * 那一行字在格子里就是"窄条"，与格内其它元素完全不像同一类东西。
       */
      return (
        <span
          className={`bp-el-code bp-el-code--ph bp-el-cell__child-phbox${p.warn ? ' is-warn' : ''}`}
          title={p.hint}
        >
          <span className="bp-el-code__body">
            <span className="bp-el-code__badge">{p.badge}</span>
            <span className="bp-el-code__name">{p.text}</span>
            <span className="bp-el-code__note">
              {child.source.kind === 'field' ? '打印时逐条生成' : '在右侧属性面板填写'}
            </span>
          </span>
        </span>
      )
    }
    if (child.kind === 'attach') {
      /*
       * 附件在**画布上只知道字段、不知道值**（值是按记录取的）⇒ 画一枚说明盒。
       *
       * ⚠️ 原来是 `display:block` 的一行小胶囊（「附件 · 字段名」），在格子里就是**一条长条**
       *    （真机反馈 2026-09-23 第 7 条：「拖动附件字段到单元格内，还是显示为一个长条」）。
       *    现在与图片/二维码占位盒同一套形态：有高度、居中、三行字说清"这是什么、打印会怎样"。
       */
      return (
        <span
          className="bp-el-cell__child-phbox"
          title={`附件字段「${child.fieldName || '未绑定'}」：打印时按每条记录显示图片；非图片显示文件名`}
        >
          <span className="bp-el-cell__child-phbox-title">附件</span>
          <span>{child.fieldName || '未绑定字段'}</span>
          <span>打印时按记录出图</span>
        </span>
      )
    }
    if (child.kind === 'text') {
      return <span className="bp-el-cell__child-text">{renderInline(child.nodes, fields, child.id)}</span>
    }
    if (child.kind === 'hline') {
      return (
        <span
          className="bp-el-cell__child-hr"
          style={{ borderTopWidth: ptToPx(child.thicknessPt), borderTopColor: child.color }}
        />
      )
    }
    return <span className="bp-el-cell__child-ph">这个元素不能放进单元格</span>
  }

  // ---- 元素渲染 ----
  /**
   * 行内节点的点选上下文。`onSelectNode` 没传就不挂点击钩子 ——
   * 只读场景（预览）不该让占位符看起来可以点。
   */
  const pickFor = useCallback(
    (elementId: string, cellId: string | null): InlinePick | undefined =>
      onSelectNode ? { elementId, cellId, selectedNode, onSelectNode } : undefined,
    [onSelectNode, selectedNode],
  )

  const renderBody = (el: AnyElement): ReactNode => {
    switch (el.kind) {
      case 'text': {
        if (editingId === el.id && !editingCellId) {
          return <textarea className="bp-inline-edit" style={textCss(el)} {...inlineEditProps(el)} />
        }
        return (
          <div className="bp-el-text" style={blockCss(el.style)}>
            {renderInline(el.nodes, fields, el.id, pickFor(el.id, null))}
          </div>
        )
      }
      case 'fieldBlock': {
        const meta = fieldMeta(fields.find((f) => f.id === el.fieldId)?.type)
        const bound = !!el.fieldId && fields.some((f) => f.id === el.fieldId)
        return (
          <div className="bp-el-text" style={textCss(el)}>
            {el.prefix ? <span>{el.prefix}</span> : null}
            <span
              className={`bp-chip${bound ? '' : ' bp-chip--missing'}`}
              title={bound ? el.fieldName : `「${el.fieldName || '未绑定'}」已失效或未绑定字段`}
            >
              <span className="bp-chip__text">{el.fieldName || '未绑定字段'}</span>
            </span>
            {el.suffix ? <span>{el.suffix}</span> : null}
            <span className="bp-el-note">{meta.renderKind === 'attachment' ? '附件字段请用附件块' : ''}</span>
          </div>
        )
      }
      case 'table': {
        const { table, cell } = tableCss(el)
        const pad = mmToPx(finite(el.cellPaddingMm, 1.5))
        return (
          <table className="bp-el-table" style={table}>
            <colgroup>
              {el.colWidthsMm.map((cw, i) => (
                <col key={i} style={{ width: `${nz(cw, 10)}mm` }} />
              ))}
            </colgroup>
            <tbody>
              {el.rows.map((row, r) => (
                <tr
                  key={row.id}
                  data-row-index={r}
                  style={row.heightMm ? { height: `${nz(row.heightMm, 5)}mm` } : undefined}
                >
                  {row.cells.map((c) => {
                    const ci = row.cells.indexOf(c)
                    /**
                     * ⚠️ 判据里多了 `childSel`：选中的是**这一格里的子元素**时，这一格也要亮 ——
                     * 子元素在视觉上就在格子里，格子不亮会让人以为"什么都没选中"。
                     * 复合 id 只在这里算一次（下面渲染子元素还要用同一个值）。
                     */
                    const childKey = cellChildId(el.id, c.id)
                    const childSel = selectedId === childKey
                    const selected = (selectedId === el.id && selectedCellId === c.id) || childSel
                    const cellEditing = editingId === el.id && editingCellId === c.id
                    const empty = c.nodes.length === 0
                    const isDropTarget = dropTarget?.kind === 'cell' && dropTarget.cellId === c.id
                    return (
                      <td
                        key={c.id}
                        colSpan={Math.max(1, finite(c.colspan, 1))}
                        rowSpan={Math.max(1, finite(c.rowspan, 1))}
                        data-cell-id={c.id}
                        className={`bp-el-cell${selected ? ' is-selected' : ''}${row.isHeader ? ' is-header' : ''}${isDropTarget ? ' is-drop-target' : ''}${inSel(el.id, r, ci, selRange) ? ' is-rsel' : ''}`}
                        /* 按下即起"拖动扩选"（规格 四）。⚠️ 单元格从此不再兼任"拖整表"——
                           那个角色归表格手柄（规格 一），见 onCellPointerDown 的注释。 */
                        onPointerDown={(ev) => onCellPointerDown(ev, el, r, ci, c.id)}
                        style={{ ...cell(r, ci), padding: pad, ...(c.style ? textCss({ ...el, style: c.style }) : null) }}
                        title={`第 ${r + 1} 行 第 ${ci + 1} 列 · 双击编辑内容`}
                        // 用 click 而不是 pointerdown 选单元格：pointerdown 一旦拦住冒泡，
                        // 整个表格就没法拖动了（表格几乎被单元格铺满，没有空白处可抓）
                        onClick={(ev) => {
                          ev.stopPropagation()
                          onSelect(el.id)
                          onSelectCell(el.id, c.id)
                        }}
                        onDoubleClick={(ev) => {
                          ev.stopPropagation()
                          beginEditing(el.id, c.id, nodesToText(c.nodes))
                        }}
                      >
                        {cellEditing ? (
                          <textarea className="bp-inline-edit bp-inline-edit--cell" {...inlineEditProps(el)} />
                        ) : empty && !(c.children && c.children.length > 0) && selected ? (
                          // 空单元格给一句提示：否则用户点了半天不知道这里能打字
                          // ⚠️ 有子元素的格子**不算空** —— 不然图片上面会盖一句"双击输入"
                          <span className="bp-el-cell__ph">双击输入</span>
                        ) : (
                          <>
                            {/*
                              规格 六：单元格是**素材容器**。子元素排在文字**前面**
                              （"图片在上、说明文字在下"是这类格子的通行排版，见 TableCell.children 的注释）。
                            */}
                            {(c.children ?? []).slice(0, MAX_CELL_CHILDREN).map((child) => {
                              const pct = childWidthPct(child)
                              const boxH = childHeightMm(child)
                              return (
                                <span
                                  key={child.id}
                                  className={`bp-el-cell__child${childSel ? ' is-selected' : ''}`}
                                  /* 规格 六：「单元格内的元素可以再拖出来，回到画布自由层」——
                                     按下即起一条拖动会话（见 onChildPointerDown） */
                                  /* 绿色描边 + 右上角类型角标（CSS 用 attr(data-kind) 画） */
                                  data-kind={elementLabel(child)}
                                  /* 复合 id 落到 DOM 上：e2e 断言与"从格子拖出"都靠它定位，
                                     不去猜"第几行第几列"（合并单元格下那种下标是假的） */
                                  data-cell-child-id={childKey}
                                  /*
                                   * 宽度用百分比、高度是**固定盒子**的高度（见 types.ts 第 ④ 条）。
                                   * 这两个值必须真的生效 —— 否则右侧面板里那两个输入框就是空转的，
                                   * 而"点了没反应"比"没有这个控件"更坏（用户会以为插件坏了）。
                                   */
                                  style={{
                                    width: `${pct}%`,
                                    ...(boxH != null ? { height: `${boxH}mm`, overflow: 'hidden' } : null),
                                  }}
                                  title={`${elementLabel(child)} · 单击选中，可拖到别的格子或拖出到画布`}
                                  onPointerDown={(ev) => onChildPointerDown(ev, el, c.id, child)}
                                  /*
                                   * ⚠️ 必须吃掉 click：`<td>` 的 onClick 会把选中打回整表
                                   * （pointerdown 的 stopPropagation 管不住 click）。少了这一行，
                                   * 点一下子元素会先选中自己、再被立刻改回整表 —— 面板看起来"闪了一下就没了"。
                                   */
                                  onClick={(ev) => ev.stopPropagation()}
                                  onContextMenu={(ev) => {
                                    if (!actions) return
                                    ev.preventDefault()
                                    ev.stopPropagation()
                                    /* 先选中再弹菜单：菜单里「编辑属性」要对准这一格里的那个元素，
                                       而不是上一个被选中的东西 */
                                    onSelectCell(el.id, c.id)
                                    onSelect(childKey)
                                    setCtx({
                                      x: ev.clientX,
                                      y: ev.clientY,
                                      target: { kind: 'child', tableId: el.id, cellId: c.id },
                                    })
                                  }}
                                >
                                  {renderCellChild(child)}
                                </span>
                              )
                            })}
                            {(c.children?.length ?? 0) > 0 && c.nodes.length === 0
                              ? null
                              : renderInline(c.nodes, fields, c.id, pickFor(el.id, c.id))}
                          </>
                        )}
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        )
      }
      case 'image':
        return (
          <img
            className="bp-el-image"
            src={el.dataUrl}
            alt=""
            draggable={false}
            /* 与打印端同一套取值：fill/cover 原样，其余（含未设）退回 contain */
            style={{ objectFit: el.fit === 'cover' || el.fit === 'fill' ? el.fit : 'contain' }}
          />
        )
      case 'hline': {
        const t = Math.max(1, ptToPx(finite(el.thicknessPt, 0.75)))
        const align = el.style?.align
        const insetL = align === 'center' || align === 'right' ? undefined : mmToPx(finite(el.style?.indentLeftMm, 0))
        const insetR = align === 'center' || align === 'left' ? undefined : mmToPx(finite(el.style?.indentRightMm, 0))
        return (
          <div
            className="bp-el-hline"
            style={{
              borderTopWidth: t,
              borderTopColor: el.color || DEFAULT_TEXT_STYLE.color,
              marginLeft: insetL,
              marginRight: insetR,
            }}
          />
        )
      }
      case 'pagebreak':
        return (
          <div className="bp-el-pagebreak">
            <span className="bp-el-pagebreak__label">分页符</span>
          </div>
        )
      case 'qrcode':
      case 'barcode': {
        const code = codePreview(el, fields)
        return (
          <div
            className={`bp-el-code${code.svg ? '' : ' bp-el-code--ph'}${code.warn ? ' is-warn' : ''}`}
            // 占位框的底色交给 CSS（--pp-surface-2），真码才用用户配的背景色
            style={code.svg ? { background: code.background } : undefined}
            title={code.hint}
          >
            {code.svg ? (
              <div className="bp-el-code__svg" dangerouslySetInnerHTML={{ __html: code.svg }} />
            ) : (
              <span className="bp-el-code__body">
                <span className="bp-el-code__badge">{code.badge}</span>
                <span className="bp-el-code__name">{code.text}</span>
                <span className="bp-el-code__note">
                  {el.source.kind === 'field' ? '打印时逐条生成' : '在右侧属性面板填写'}
                </span>
              </span>
            )}
            {/* 二维码的"显示原文"由画布自己排（渲染库的 qrCodeSvg 只出码本身，没有 caption 参数），
                打印侧的留白与这里一致，都是码下方一行文字 */}
            {code.svg && el.kind === 'qrcode' && el.showText ? (
              <span className="bp-el-code__caption">{code.text}</span>
            ) : null}
          </div>
        )
      }
      case 'attach': {
        const cfg = el.config
        const bound = !!el.fieldId && fields.some((f) => f.id === el.fieldId)
        const modeText =
          cfg.mode === 'none'
            ? '不打印附件'
            : cfg.mode === 'nameOnly'
              ? '仅打印附件名称'
              : cfg.mode === 'imageOnly'
                ? '仅打印图片'
                : '打印全部附件'
        const sizeText =
          cfg.sizeMode === 'original'
            ? '原图尺寸'
            : cfg.sizeMode === 'fixedHeight'
              ? `固定高 ${finite(cfg.fixedHeightMm, 30)}mm`
              : '适配单元格'
        return (
          <div className="bp-el-attach">
            <div className="bp-el-attach__head">
              <span
                className={`bp-chip${bound ? '' : ' bp-chip--missing'}`}
                title={bound ? el.fieldName : `「${el.fieldName || '未绑定附件字段'}」已失效或未绑定字段`}
              >
                <span className="bp-chip__text">{el.fieldName || '未绑定附件字段'}</span>
              </span>
              <span className="bp-el-attach__tag">{modeText}</span>
            </div>
            <div className="bp-el-attach__meta">
              {sizeText} · {cfg.flow === 'wrap' ? '每张一行' : '并排'}
              {cfg.maxPerRow ? ` · 每行 ${cfg.maxPerRow} 张` : ''} · 间距 {finite(cfg.gapXMm, 2)}/{finite(cfg.gapYMm, 2)}mm
            </div>
            <div className="bp-el-attach__grid" aria-hidden>
              {Array.from({ length: 3 }, (_, i) => (
                <span key={i} className="bp-el-attach__ph" />
              ))}
            </div>
          </div>
        )
      }
      default:
        return null
    }
  }

  const renderBand = (band: BandKey): ReactNode =>
    readBand(doc, band).map((el) => {
      const selected = el.id === selectedId
      const isOob = oob.has(el.id)
      const pinned = pinnedId === el.id
      /**
       * 「拆分 / 合并单元格」两个按钮的**启用判据**（2026-09-23 第 7 条）。
       *
       * 都要求选中的是**这一张表**里的格子 —— 选中别的表的格子却让本表的按钮可点，
       * 点下去改的是另一张表，属于最难查的一类错。
       * 合并额外要求**两格以上**：用户明确说了"如果只选中一个单元格，则保持不可选中状态"。
       */
      /*
       * `cellSel` 存的是**网格坐标**（anchor/head），不是 cellId ⇒ 这里摊平一次取到格子 id。
       * 直接读 `cellSel.cellId` 是错的（那个字段不存在），而 tsc 会当场拦下。
       */
      const cellHereId =
        el.kind === 'table' && cellSel && cellSel.tableId === el.id
          ? (tableGrid(el.rows, el.colWidthsMm.length)[cellSel.anchor.r]?.[cellSel.anchor.c]?.cell.id ?? null)
          : null
      const canMergeSel = !!cellHereId && !!selRange && rangeArea(selRange) > 1
      return (
        <div
          key={el.id}
          data-el-id={el.id}
          className={[
            'bp-el',
            `bp-el--${el.kind}`,
            selected ? 'is-selected' : '',
            isOob ? 'is-oob' : '',
            el.locked ? 'is-locked' : '',
            pinned ? 'is-pinned' : '',
            // 让内容撑满声明框（见 FILL_KINDS 的注释：修"蓝框比内容大一圈"）
            FILL_KINDS.has(el.kind) ? 'bp-el--fill' : '',
          ]
            .filter(Boolean)
            .join(' ')}
          style={{
            // el.x / el.y 是**版心内**坐标（渲染层同样是 margin + x，见 render/html.ts），
            // 所以这里必须把页边距加回去，否则画布上的位置和导出的位置会差一个页边距。
            // y 还要过一遍版式区起点（循环区会被页级重复区顶下去，见 bandTopMm）。
            left: pxOf(nz(margin.left, 0) + nz(el.x, 0)),
            top: pxOf(nz(margin.top, 0) + bandTopMm(band, el)),
            width: pxOf(Math.max(el.w, 0.5)),
            /**
             * 高度**只有下限、不写硬高** —— 与打印侧**同一条口径**
             * （`render/html.ts` 里非表格块一律 `min-height:...`）。
             *
             * 2026-09-18 真机反馈后修正。旧式是：
             *   固定值 ⇒ 写 `height`（硬高，内容多出来就被压住）
             *   自动   ⇒ 只写 `minHeight`（内容可以把盒子撑开）
             * 于是**同一个 5.6mm**，在两种模式下渲染高度不同；用户拖动宽度时
             * `onMerge` 又把 `'auto'` 静默写成数字 ⇒ 模式被改、高度看着"缩水"。
             * 用户原话："同样高度值，固定值下就是会缩水一些……哪个才是正确的值？"
             *
             * ⇒ 答案不是"两个数里选一个"，而是**画布与打印必须用同一个语义**：
             *   都只给下限。这样"属性里显示的值"与"画布上的盒子"在结构上不可能再分叉。
             */
            /**
             * ⚠️ **图片类元素显式设了高度就写死高度**（2026-09-20 用户反馈后改）。
             *
             * 旧口径一律 `minHeight`（注释写着"高度只有下限、不写硬高"），
             * 于是"固定高度"在画布上**根本不生效**：内容只要比它高，盒子就跟着长
             * ⇒ 用户改属性里的高度、往下拖，都看不出变化（用户报的正是这个）。
             *
             * 与打印侧 `render/html.ts` 的 `heightCss` **同一套判据**（图片类 + 显式高度），
             * 两处必须一起改：只改一边会让"画布/打印"分叉，而那正是上一轮特意修掉的毛病。
             * 文字块仍然只给下限（内容换行要能撑开，写死会叠字）。
             */
            ...(PIC_LIKE.has(el.kind) && typeof el.h === 'number'
              ? { height: pxOf(Math.max(el.h, 2)), overflow: 'hidden' }
              : { minHeight: pxOf(Math.max(elementHeightMm(el), 2)) }),
          }}
          onPointerDown={(ev) => onElementPointerDown(ev, el, band)}
          /*
           * 悬停追踪（只给表格用，但挂在通用包装层上 —— 非表格元素记一下也无害，
           * 工具栏那边自己判 `kind === 'table'`，不需要在这里再分叉）。
           * enter/leave 不会在子元素间反复触发（over/out 才会），这一点很关键：
           * 表格里全是 `td`，用 over/out 会变成每格一次 setState。
           */
          onPointerEnter={() => setHoverId(el.id)}
          onPointerLeave={() => setHoverId((cur) => (cur === el.id ? null : cur))}
          onDoubleClick={(ev) => {
            ev.stopPropagation()
            if (el.kind !== 'text') return
            beginEditing(el.id, null, nodesToText(el.nodes))
          }}
        >
          {renderBody(el)}
          {/*
            表格**悬浮工具栏**（2026-09-19 用户要求，参考飞书云文档）。

            用户原话："鼠标移动到表格上方后，会出现**悬浮工具栏**，可以完成表格的一系列编辑操作。"
            并附了两个飞书云文档的 GIF 作参照（`_feishu-verify/shots/_g/g07-ref1/ref2`）。

            为什么值得做：表格的行列增删与列宽行高**本来就有**（`table-actions` 一整套），
            但入口全在右侧属性面板深处 —— 用户得先选中表格、再滚到「结构」那一节。
            悬浮工具栏把最常用的三个动作搬到鼠标当前位置，**看得到就点得到**。

            触发条件 = **悬停 or 已选中**：只挂悬停的话，鼠标一移开工具栏就没了，
            用户没法"看着工具栏去点"（这是悬停式 UI 的经典陷阱）。
          */}
          {el.kind === 'table' && (hoverId === el.id || selected) ? (
            /*
             * `stopPropagation` 是必须的：工具栏压在表格上，
             * 不拦的话点按钮会先冒泡到 `.bp-el` 的 pointerdown，触发"拖动整个表格"。
             */
            <div className="bp-table-bar" onPointerDown={(ev) => ev.stopPropagation()}>
              {editTableId === el.id ? (
                /*
                 * ---- 编辑态（真机反馈第 6 条）----
                 * 用户原话：「点击编辑表格后，不再是对某个单元格进行输入编辑，而是进入编辑状态，
                 * 此时表格可以增删行和列，可以对单元格进行合并居中等操作，悬浮菜单也刷新为
                 * 各个编辑功能和完成编辑的选项」。
                 */
                <>
                  <button
                    type="button"
                    className="bp-table-bar__btn is-primary"
                    title="退出编辑（表格回到可整体移动的状态）"
                    onClick={() => setEditTableId(null)}
                  >
                    完成编辑
                  </button>
                  {/*
                    ---- 拆分 / 合并单元格（真机反馈 2026-09-23 第 7 条）----
                    用户原话：「编辑表格的这个菜单，**删除增加行列的选项**，改为拆分单元格
                    （点击后被选中的单元格会被拆分，会出现弹窗，提示输入几行几列）、
                    合并单元格（如果只选中一个单元格，则保持不可选中状态）」。

                    ⇒ 「+ 行 / + 列」从这条浮层上撤掉（加行列改走：表格右/下边缘的「+」手柄、
                      悬浮的「表格尺寸」面板、以及单元格右键菜单里的插入行列）。
                    两个按钮都**作用于当前选中的格子**：
                      · 拆分 —— 需要有一个选中的格子；弹出输入框问几行几列；
                      · 合并 —— 需要**选中两个以上**的格子（只选一格时保持不可点，
                        这正是用户要求的那条）。
                  */}
                  <button
                    type="button"
                    className="bp-table-bar__btn"
                    title={cellHereId ? '把这一格拆成几行几列' : '先点一下要拆的那一格'}
                    disabled={!cellHereId}
                    onClick={() => {
                      if (cellHereId) setSplitAsk({ tableId: el.id, cellId: cellHereId })
                    }}
                  >
                    拆分单元格
                  </button>
                  <button
                    type="button"
                    className="bp-table-bar__btn"
                    title={canMergeSel ? '把选中的格子合并成一格' : '先按住鼠标左键拖选两个以上的格子'}
                    disabled={!canMergeSel}
                    onClick={() => {
                      if (selRange && cellSel && actions) actions.askMergeRange(cellSel.tableId, selRange)
                    }}
                  >
                    合并单元格
                  </button>
                  <button
                    type="button"
                    className="bp-table-bar__btn"
                    title={selRange ? '把选中的格子居中' : '先按住 Shift 拖出要居中的格子'}
                    disabled={!selRange || !actions}
                    onClick={() => {
                      if (selRange && actions) actions.applyRange(el.id, selRange, { kind: 'align', h: 'center' })
                    }}
                  >
                    居中
                  </button>
                  <button
                    type="button"
                    className="bp-table-bar__btn"
                    title={selRange ? '把选中的格子加粗' : '先按住 Shift 拖出要加粗的格子'}
                    disabled={!selRange || !actions}
                    onClick={() => {
                      if (selRange && actions) actions.applyRange(el.id, selRange, { kind: 'bold', on: true })
                    }}
                  >
                    加粗
                  </button>
                </>
              ) : (
                <>
                  <button
                    type="button"
                    className="bp-table-bar__btn is-primary"
                    title="进入表格编辑状态（增删行列、调尺寸、选格子合并）"
                    onClick={() => {
                      setEditTableId(el.id)
                      /*
                       * 进编辑态时**把「表格尺寸」小窗一起打开**（真机反馈 2026-09-23 第 6 条）。
                       * 用户原话：「只有在刚拖表格进来时才需要显示表格右侧的行列设置小窗，
                       * 点击空白处或者其他元素后，就自动消失，**点击编辑表格再次出现**」。
                       */
                      onOpenTableSize?.(el.id)
                    }}
                  >
                    编辑表格
                  </button>
                </>
              )}
              {/* #6a：删除整张表格 —— 原来只能右键最外框一个极窄的带子，用户说极难删除 */}
              <button
                type="button"
                className="bp-table-bar__btn is-danger is-icon"
                title="删除整张表格"
                aria-label="删除整张表格"
                disabled={!actions}
                onClick={() => actions?.remove(el.id)}
              >
                {/* 垃圾桶：自绘 SVG（项目不用 emoji、不引图标库）；真机反馈要求「不要显示文字」 */}
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden>
                  <path
                    d="M3 4.2h10M6.4 4.2V2.9h3.2v1.3M4.6 4.2l.55 8.9h5.7l.55-8.9M6.8 6.6v4.6M9.2 6.6v4.6"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>
            </div>
          ) : null}
          {/*
            ---- 表格的悬浮操作层（2026-09-22）----
            规格 一·二：表格手柄（拖整表）、顶边列手柄点、左边行手柄点、
            行首列首的「+」（点一下插一行 / 插一列）、右 / 下边缘的虚线感应区（追加行列）。

            ⚠️ 和上面那条工具栏同一个显示条件（悬停 or 选中）：只挂悬停的话鼠标一移开入口就没了，
               用户没法"看着按钮去点"。
            ⚠️ 锚点用 `tableAnchors(el)` 现算：它是纯函数、代价是几十次浮点比较，
               而"每行/每列用哪一格当定位锚点"这件事只有网格知道（span 模型下数组下标 ≠ 列号）。
          */}
          {/*
            ⚠️ 真机反馈第 6 条：「表格未编辑状态，不再显示增加行列的『+』图标」
               ⇒ 编辑手柄（+ / 行首列首 / 拖尺寸）只在**编辑态**出现；
                  平时表格就是一块可整体拖动、可点选的内容。
          */}
          {actions && el.kind === 'table' && editTableId === el.id ? (
            <TableAfford
              el={el}
              rowEdges={rowEdges}
              rowAnchorIds={tableAnchors(el).rowAnchorIds}
              colAnchorIds={tableAnchors(el).colAnchorIds}
              onGripDown={(ev) => onElementPointerDown(ev, el, band)}
              insertRow={(where, cellId) => actions.insertRow(el.id, cellId, where)}
              insertCol={(where, cellId) => actions.insertCol(el.id, cellId, where)}
            />
          ) : null}
          {/*
            选中表格时的列 / 行边框线手柄（拖它们调列宽 / 行高）。

            列手柄按**列宽占比**定位（列宽是显式给定的，换算必准）；
            行手柄用上面量出来的 `rowEdges`（行高可能是内容撑的，模型值不准）。
            刻意只做 6~7px 宽的细条、且只落在边框正中：它们是压在单元格上的，
            做宽了就会把"点这一格"抢走 —— 单元格选中是表格里最常用的动作。

            **每一条边界都有手柄，包括最外侧那两条**（需求 ⑧）：
            列手柄有 `colWidthsMm.length` 条（第 0..n-2 条是内部竖线，第 n-1 条 = 最右外框），
            行手柄有 `rowEdges.length` 条（末条 = 表底边）。以前只在内部边界上画，
            于是"贴着外框的那一列 / 那一行"的尺寸根本没法调（拖右外框 = 调最后一列列宽，
            拖下外框 = 调最后一行行高，走的是和内部竖线**同一个** `onBorderPointerDown`）。

            为什么左外 / 上外**不加**手柄：元素原点就在左上角，那两条边上的"改尺寸"语义只能是
            "移动 x/y 并改 w/h"，而列宽数组里没有"左边距"这一项 —— 拖左外框到底算改第一列列宽
            还是算移动整个元素，一个手柄表达不了。何况那两条边上已经有元素自己的 `w` / `n`
            缩放手柄压着，再放一条就是**两个视觉重复的手柄**。要调第一列 / 第一行，拖第一条
            内部竖线 / 横线即可（那条线动的正是第 1 列的列宽、第 1 行的行高）。
          */}
          {/*
            ⚠️ 条件从 `selected` 扩成 `hoverId === el.id || selected`（2026-09-22）。
            规格 三 要求"鼠标悬停在两条单元格之间的横边框/竖边框线上时，光标变为 ↕/↔"——
            只在选中时才挂手柄的话，用户得先猜"要不要先点一下"。手柄本身只有 7px 宽、
            且自带 `col-resize/row-resize` 光标，悬停时出现不会抢走"点这一格"。
          */}
          {editTableId === el.id && el.kind === 'table' ? (
            <div className="bp-tbl-size">
              {el.colWidthsMm.map((_, i) => {
                const outer = i === el.colWidthsMm.length - 1
                return (
                  <span
                    key={`c${i}`}
                    role="separator"
                    aria-label={`第 ${i + 1} 列右边框，左右拖动调列宽`}
                    title={outer ? `拖动调第 ${i + 1} 列列宽（最外侧边框）` : `拖动调第 ${i + 1} 列列宽`}
                    className="bp-tbl-size__col"
                    style={{ left: `${colEdgeFrac(el.colWidthsMm, i) * 100}%` }}
                    onPointerDown={(ev) => onBorderPointerDown(ev, el, 'col', i)}
                  />
                )
              })}
              {rowEdges.map((top, i) => (
                <span
                  key={`r${i}`}
                  role="separator"
                  aria-label={`第 ${i + 1} 行下边框，上下拖动调行高，双击恢复自适应`}
                  title={`拖动调第 ${i + 1} 行行高；双击恢复「按内容自适应」`}
                  className="bp-tbl-size__row"
                  style={{ top }}
                  onPointerDown={(ev) => onBorderPointerDown(ev, el, 'row', i)}
                  onDoubleClick={(ev) => {
                    ev.stopPropagation()
                    onRowBorderReset(el, i)
                  }}
                />
              ))}
            </div>
          ) : null}
          {isOob ? <span className="bp-el-oob" aria-hidden /> : null}
          {pinned ? (
            <span className="bp-el-pin" aria-hidden>
              已贴版式区上边
            </span>
          ) : null}
          {isOob ? (
            <span className="bp-el-warn" title="超出纸张范围">
              !
            </span>
          ) : null}
          {selected ? (
            <>
              {RESIZE_EDGES.map((c) => (
                <span
                  key={c}
                  role="presentation"
                  className={`bp-handle bp-handle--${c}`}
                  onPointerDown={(ev) => onHandlePointerDown(ev, el, c, band)}
                />
              ))}
            </>
          ) : null}
        </div>
      )
    })

  return (
    <div
      className={['bp-canvas', dropActive ? 'is-drop-active' : ''].filter(Boolean).join(' ')}
      ref={viewportRef}
      /* 右键菜单挂在**画布根节点**（不是纸张）：纸张被 `transform: scale()` 包着，
         `position: fixed` 在 transform 祖先里会相对那个祖先定位 —— 菜单会跑偏。 */
      onContextMenu={onCanvasContextMenu}
    >
      <div
        className="bp-paper-outer"
        style={{ width: pxOf(render.w) * scale, height: pxOf(render.h) * scale }}
      >
        <div
          ref={paperRef}
          // is-element-selected：选中元素时网格再淡一档。网格是**参考线**，正在摆内容时
          // 它不该和内容抢注意力 —— 但默认态也必须能和表格线分开（见 editor.css 的 .bp-grid）。
          className={`bp-paper${selectedId ? ' is-element-selected' : ''}${dropTarget?.kind === 'reject' ? ' is-drop-reject' : ''}`}
          style={
            {
              width: pxOf(render.w),
              height: pxOf(render.h),
              transform: `scale(${scale})`,
              // 给纸张内的标签/手柄一个反向缩放系数：纸张被缩小后它们仍保持可读的视觉尺寸
              '--bp-inv': String(1 / Math.max(scale, 0.05)),
            } as unknown as CSSProperties
          }
          onPointerDown={(e) => {
            // 点空白处取消选中（元素自身的 pointerdown 已经 stopPropagation）
            if (e.target === e.currentTarget) {
              onSelect(null)
              onSelectCell(null, null)
              onSelectNode?.(null)
            }
          }}
        >
          {/* 网格：**一层 CSS 背景**，不是几百个 DOM 节点（一页 A4 / 5mm 就是 40×60 条线）。
              它铺在版心范围内、原点就是版心左上角 —— 元素的 x/y 也正是从这里起算，
              所以"吸附到 5mm 的整数倍"落点必然落在可见的线上，不会出现"吸了但没对齐"。
              线色由 editor.css 的 --pp-grid-line 给（**不是** --paper-line：那是内容线的兜底色，
              和网格共用一个色时画出来一模一样，用户分不开）。也不用 UI 描边令牌：纸永远是白的，
              暗色下 --line 会翻成白色，白纸上画白线等于没画。 */}
          {grid.showGrid ? (
            <div
              className="bp-grid"
              aria-hidden
              style={{
                left: pxOf(margin.left),
                top: pxOf(margin.top),
                width: pxOf(content.w),
                height: pxOf(content.h),
                backgroundSize: `${pxOf(grid.gridMm)}px ${pxOf(grid.gridMm)}px`,
              }}
            />
          ) : null}

          {/*
            页边距区域：非打印区，用极淡的填充区别于纸张白，让"版心 = 能印出来"自己说话。

            四条带子必须**拼成完整的一圈**：上下两条铺满纸宽（顺带盖住上下两条角），
            左右两条只跨版心高（避开角）。少了这一步，四个角会留下四个白方块，
            用户会问"那四个角是不是能打印"。

            ⚠️ 这条链路上有过一次真事故，写在这里免得被写回去：
            **上边距带原来写成 `top: pxOf(margin.top)`，正确值是 `top: 0`。**
            `margin.top` 是"纸张顶边 → 版心顶边"的距离，不是版心顶边的坐标。于是那条
            带子整个落进版心里、盖在网格最上面 20mm 上：真正的上页边距是白的，而可
            打印区的头 20mm 被涂灰了 —— 和"标出非打印区"这件事**正好反着**。
            四条里只有它错，且错的量恰好等于 `margin.top`，所以肉眼很容易漏掉。

            ⚠️ 第二条：**四条带子不许互相重叠。** 半透明底叠在半透明底上会**加深**
            （alpha 合成不幂等：0.14 盖两遍 ≈ 0.26），角上会冒出四个比边更深的方块。
            所以分工是"上下两条管满宽、左右两条只跨版心高度"，恰好把环铺满且两两不交。
          */}
          <div
            className="bp-margin"
            style={{ left: 0, top: 0, width: pxOf(render.w), height: pxOf(margin.top) }}
          />
          <div
            className="bp-margin"
            style={{
              left: 0,
              top: pxOf(margin.top + content.h),
              width: pxOf(render.w),
              height: pxOf(margin.bottom),
            }}
          >
            {/*
              页边距 = **印不出来**的那一圈（可打印区 = 版心 = 纸张 − 页边距）。
              2026-09-18 用户追问"为什么超过橙线的部分就无法打印了"——
              真正的原因从来不是橙线，而是**这一圈**。它以前只是一块淡色，没有任何文字，
              所以用户只能把"印不出来"归因到唯一看得见的标记（橙线）上。
              宽度不够就干脆不写（≤6mm 塞不下，写了只会糊成一团）。
            */}
            {margin.bottom >= 6 ? (
              <span className="bp-margin__label">
                下页边距 {margin.bottom}mm · 这一圈印不出来（想让它也能印：页边距整档选「整张纸（0）」）
              </span>
            ) : null}
          </div>
          <div
            className="bp-margin"
            style={{
              left: 0,
              top: pxOf(margin.top),
              width: pxOf(margin.left),
              height: pxOf(content.h),
            }}
          />
          <div
            className="bp-margin"
            style={{
              left: pxOf(margin.left + content.w),
              top: pxOf(margin.top),
              width: pxOf(margin.right),
              height: pxOf(content.h),
            }}
          />

          {/*
            ---- 三条分区带（2026-09-22 重做）----

            用户原话："当前的画布不太好区域（区分），**只能靠右侧的属性 tab 去猜**，
            做画布分区可视化：A4 纸上直接画了三条分区带 —— 每页重复区（灰）、循环区（橙色高亮，
            因为现在在循环区）、表尾区（灰），左侧竖排小标签，不用再去右侧 tab 猜。"

            改之前的做法是**只画边界线 + 左页边距里一枚小胶囊**，于是：
              · 三条带里只有"循环区"那条有胶囊，另外两条（表头/表尾）在页面里几乎看不见
                （实测：`?tpl=N` 的模板上 `.bp-band` 只有 1 个）；
              · 而且那两个胶囊的显示条件挂的是"该区有没有元素" —— 空分区恰恰是用户最需要知道
                "这里有个区、可以往里放东西"的时候，却是**什么都不显示**。

            现在每一区都有一条**带内标签条**（real 边界 + 防重叠下推，见 band-bars.ts）
            + 一条**左侧竖排标签**（三条都有，哪怕高度是 0）。
            标签条不铺满整个区（只在顶部 18px），所以**不会盖住正文** —— 这是用户对"纸面涂色"
            最不能接受的一点（历史上因为"底色盖住正文"专门回退过一次）。
          */}
          {bandBars.map((b) => (
            <div
              key={b.key}
              className={`bp-band bp-band--${b.key}${b.key === activeBand ? ' is-active' : ''}${b.shifted ? ' is-shifted' : ''}`}
              style={{
                left: pxOf(margin.left),
                top: pxOf(margin.top) + b.topPx,
                width: pxOf(content.w),
                height: BAND_BAR_PX,
              }}
            >
              <span className="bp-band__title" title={bandTip(b.key)}>
                <span className="bp-band__dot" aria-hidden />
                {BAND_META[b.key].name} · {BAND_META[b.key].tip}
              </span>
            </div>
          ))}

          {/*
            左侧竖排标签：三条**都要有**（这正是"不用再去右侧 tab 猜"的答案）。
            `writing-mode: vertical-rl` 让文字真正竖排 —— 竖排是这里唯一不挤的排法：
            页边距槽只有 ~30px 宽，横排只能放下三四个字就省略号。
          */}
          {showGutterTags
            ? bandGutters.map((g) => (
                <span
                  key={g.key}
                  className={`bp-band__gutter bp-band__gutter--${g.key}${g.key === activeBand ? ' is-active' : ''}`}
                  /*
                   * ⚠️ `left` 必须自己减去页边距：竖排标签挂的是**纸张**（不是版心），
                   * 所以"贴到版心左边界外侧"要写成 `版心左 - 槽宽`。
                   * 我第一版直接写 `-gutterPx`（照抄旧代码 —— 那时它的父元素是 `.bp-band`，
                   * 就在版心上），结果标签整体跑到纸张左边外面去了（实测：三个竖排标签全不见）。
                   */
                  style={{ left: pxOf(margin.left) - gutterPx, width: gutterPx, top: pxOf(margin.top) + g.topPx }}
                >
                  {/*
                    ⚠️⚠️ 这一对花括号**必须**有：JSX 的**子节点位置**里，以「斜杠星号」开头的
                    块注释不是注释，它就是**字面文本** —— 会被原样渲染到页面上。

                    第一版写成裸块注释（我照抄了"属性区/代码区"的写法），结果整段注释被当成
                    竖排标签的内容画了出来：`.bp-band__gutter` 是 `writing-mode: vertical-rl`
                    的窄条，几十行注释在纸张左侧糊成一大片"乱码墙"。用户原话：
                    「当前画布左侧有一些混乱的文字，这个是什么东西，很影响页面整洁性」。

                    判据（写在这里免得再犯）：块注释在 **属性区**（标签的 `>` 之前）或
                    **代码区**（花括号里面）都合法；只有**子节点位置**必须先包一层花括号。
                  */}
                  <button
                    type="button"
                    className="bp-band__chip"
                    title={`${bandTip(g.key)}（点击定位到该区）`}
                    onClick={() => {
                      const paper = paperRef.current
                      const vp = viewportRef.current
                      if (!paper || !vp) return
                      const delta = paper.getBoundingClientRect().top - vp.getBoundingClientRect().top
                      vp.scrollTo({ top: vp.scrollTop + delta + bandGeoPx[g.key].topPx - 60, behavior: 'smooth' })
                    }}
                  >
                    {BAND_META[g.key].name}
                  </button>
                </span>
              ))
            : null}

          {/*
            ---- 三个分区的**范围框**（2026-09-23 真机反馈第 11 条）--------------------------
            用户原话：「三个分区的范围也不明显，无法一眼看出」。

            原来每个分区只有一个 18px 的细标签条 + 一条分界线 —— 标签条说明"叫什么"，
            但**范围**（这一区从哪到哪）完全看不出来，尤其表头区/表尾区几乎没有高度时。

            ⚠️ 只画**虚线边框、不填底色**：底色铺满整区会压住正文，
               这个项目在这一点上回退过一次（见 .bp-band 的历史注释）。
               虚线框不遮内容，却能一眼看出"这三块"。
            ⚠️ `pointer-events: none`（在 CSS 里）：它是标示层，绝不能吃掉单元格/元素的点击。
          */}
          {(['header', 'loop', 'footer'] as BandKey[]).map((b) => (
            <div
              key={`area-${b}`}
              className={`bp-band__area bp-band__area--${b}${b === activeBand ? ' is-active' : ''}`}
              aria-hidden
              style={{
                left: pxOf(margin.left),
                top: pxOf(margin.top) + bandGeoPx[b].topPx,
                width: pxOf(content.w),
                height: Math.max(0, bandGeoPx[b].heightPx),
              }}
            />
          ))}

          {/*
            三条带之间的**分界线**（虚线）—— 标签条互相下推之后，"真实边界在哪"只能靠它说。
            loop 那条用橙色：它是"每条记录重复一次"的分水岭，也是用户最常看的一条。
          */}
          {(['loop', 'footer'] as BandKey[]).map((k) => (
            <div
              key={k}
              className={`bp-band__divider${k === 'loop' ? ' is-loop' : ''}`}
              style={{
                top: pxOf(margin.top + (k === 'loop' ? layout.loopTopMm : layout.footerTopMm)),
                left: pxOf(margin.left),
                width: pxOf(content.w),
              }}
            />
          ))}

          {/* 表尾区在打印时是**贴着版心底部**的（render/layout.ts:409-410），
              而画布按"版式区自上而下"的顺序把它画在自己的分界线之下。
              位置对不上就必须说出来 —— 否则用户会以为导出后表尾也在这个高度。
              放在表尾元素**下面**（footerReserveMm 就是这组元素的高度），必然不会压住它们。 */}
          {doc.bands.footer.length > 0 ? (
            <span
              className="bp-band__note"
              style={{
                left: pxOf(margin.left),
                top: pxOf(margin.top + layout.footerTopMm + footerReserveMm + 1.5),
              }}
            >
              表尾打印时贴版心底部
            </span>
          ) : null}

          {/*
            版心边界线 = **真正印得出来的范围**（纸张减去上下左右页边距）。

            ⚠️ 2026-09-18 真机反馈：用户把**橙色的**左边框当成了打印范围
            （"画布左侧橙色的边框就不再往下蔓延了……元素明明还在画布内，但却无法打印出来"）。
            橙色那个是**循环区**的括弧标记（`.bp-band--loop .bp-band__bracket`），
            它结构上永远到不了版心底边 —— `computeBandLayout` 至少留 40mm 给表尾区。
            两者的关系以前**没有任何文字说明**，所以必然被误读。
            ⇒ 给真正的边界挂一枚常驻标签，直接写在它自己身上。
          */}
          {/*
            页边距丈量线 + 可点击改数值（2026-09-19 用户要求）。

            需求原话："页边距区域用虚线丈量打印区和页面边，显示当前的页边距为多少……
            点击数字后，可以修改四边的页边距，**如果页边距是 0 则不显示这个**。"

            · 红线画在**版心边界**上（= 可打印区的边），标签写在页边距那一侧；
            · 页边距为 0 ⇒ 不渲染（没有"距离"可量，画一条线只会让人以为有边距）；
            · 点击 ⇒ prompt 改这一侧，经 `onSetMargin(side, mm)` 这个**窄接口**回传，
              画布不需要知道 PageSetup 的其余字段。
          */}
          {MARGIN_SIDES.map((side) => {
            const mm = Math.max(0, finite(margin[side], 0))
            if (mm <= 0) return null
            const vertical = side === 'left' || side === 'right'
            const ruleStyle = vertical
              ? {
                  left: pxOf(side === 'left' ? margin.left : margin.left + content.w),
                  top: pxOf(margin.top),
                  height: pxOf(content.h),
                }
              : {
                  top: pxOf(side === 'top' ? margin.top : margin.top + content.h),
                  left: pxOf(margin.left),
                  width: pxOf(content.w),
                }
            /*
             * ⚠️ 真机反馈（2026-09-22）：
             *   · 原来整条**丈量线**都是按钮 ⇒ 在纸上任何地方点一下都会弹改边距；
             *     用户要求「点击『上边距 12mm』这个字体才进入修改边距的状态」⇒ 只有胶囊可点；
             *   · 原来用 `window.prompt` —— 跨源 iframe 里那是**宿主的原生弹窗**（用户截图里
             *     『localhost:5190 上的嵌入式页面显示』），而且阻塞式对话框在 iframe 里并不可靠；
             *   · 现在改成**原地编辑**：胶囊变成输入框（自动全选），回车 / 失焦提交、Esc 取消。
             */
            const editing = editMargin?.side === side
            return (
              <span
                key={side}
                className={`bp-margin-rule bp-margin-rule--${side}`}
                style={ruleStyle}
              >
                {editing ? (
                  <input
                    className="bp-margin-rule__input"
                    aria-label={`${MARGIN_SIDE_CN[side]}边距（毫米）`}
                    value={editMargin.value}
                    autoFocus
                    onFocus={(e) => e.currentTarget.select()}
                    onPointerDown={(e) => e.stopPropagation()}
                    onChange={(e) => setEditMargin({ side, value: e.target.value })}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault()
                        commitMargin(side, editMargin.value, mm)
                      } else if (e.key === 'Escape') {
                        e.preventDefault()
                        setEditMargin(null)
                      }
                    }}
                    onBlur={() => commitMargin(side, editMargin.value, mm)}
                  />
                ) : (
                  <button
                    type="button"
                    className="bp-margin-rule__chip"
                    title="点击修改这一侧的页边距"
                    aria-label={`修改${MARGIN_SIDE_CN[side]}边距，当前 ${mm} 毫米`}
                    onClick={() => setEditMargin({ side, value: String(mm) })}
                  >
                    {MARGIN_SIDE_CN[side]}边距 {mm}mm
                  </button>
                )}
              </span>
            )
          })}

          <div
            className="bp-content-box"
            style={{
              left: pxOf(margin.left),
              top: pxOf(margin.top),
              width: pxOf(content.w),
              height: pxOf(content.h),
            }}
          >
            <span className="bp-content-box__label">可打印区（虚线内）· 虚线外印不出来</span>
          </div>

          {renderBand('header')}
          {renderBand('loop')}
          {renderBand('footer')}

          {/*
            重叠区高亮（需求 ⑩）。元素之间已经**允许**重叠（需求 ⑨ 取消了拦截），
            所以"哪里叠了"必须画出来 —— 否则两个框叠在一起时，用户只能靠肉眼在密集的
            边框里找那一条缝。判定与坐标全在 mm 空间（见上面的 `overlaps`），
            **mm → px 只在这一行发生**，与全文件的约定一致（页边距同样是这里加回去的）。

            不挂 z-index：它排在所有 `.bp-el` 之后，天然压在未选中的元素之上；
            而选中元素有 `z-index: 2`（会盖住它）—— 这是**故意**的，
            选中态的强调 + 8 个手柄必须压在重叠提示之上，不能被一层底色糊住。
          */}
          {overlaps.map((o, i) => (
            <span
              key={`ov${i}`}
              className="bp-overlap"
              aria-hidden
              style={{
                left: pxOf(margin.left + o.x),
                top: pxOf(margin.top + o.y),
                width: pxOf(o.w),
                height: pxOf(o.h),
              }}
            />
          ))}

          {/*
            智能对齐线：拖动 / 缩放过程中，和别的元素边或中心对齐时画出来的那几根线。

            `mm → px` **只在这一行发生**（`pxOf` 后面才加上页边距）—— 判定层
            （align-guides.ts）整份代码里没有一个 px，这是它的硬约束，不是巧合。
            只画有位置的那一支（`edge` / `center`）；`same-size`（等高 / 等宽）按类型定义
            就没有 `atMm`，它没有"线该画在哪"这回事，硬塞一个坐标只会逼 UI 去猜。
          */}
          {guides.map((g, i) =>
            g.kind === 'same-size' ? null : (
              <span
                key={`${g.axis}-${g.kind}-${g.atMm}-${i}`}
                /* 文档级基准线多挂一个 `is-doc`（画得更实）+ 一枚写清"是哪条基准"的小标签。
                   `edge`/`center`（元素间）保持原样：它们本来就靠"两端对齐"自解释。 */
                className={`bp-guide bp-guide--${g.axis}${g.kind === 'doc' ? ' is-doc' : ''}`}
                aria-hidden
                style={
                  g.axis === 'x'
                    ? { left: pxOf(margin.left + g.atMm), top: pxOf(margin.top), height: pxOf(content.h) }
                    : { top: pxOf(margin.top + g.atMm), left: pxOf(margin.left), width: pxOf(content.w) }
                }
              >
                {g.kind === 'doc' ? <span className="bp-guide__tag">{g.label}</span> : null}
              </span>
            ),
          )}

          {/* 拖拽时的实时反馈。**松手之前**就要看出这一下成不成：
              可放置 → 绿色提示 + 目标格子高亮；会被拒绝 → 红色提示 + 直接写出理由。
              用户反复抱怨"拖了没反应"，所以这里宁可能看到"不行"，也不要安静地弹回去。 */}
          {/* 拖出矩形的预览框（规格 一 后半句）：虚线框，松手就按它的宽高换算行列数 */}
          {dropTarget?.kind === 'rect' ? (
            <span
              className="bp-rect-preview"
              aria-hidden
              style={{
                left: pxOf(margin.left + dropTarget.xMm),
                top: pxOf(margin.top + dropTarget.yMm),
                width: pxOf(Math.max(2, dropTarget.wMm)),
                height: pxOf(Math.max(2, dropTarget.hMm)),
              }}
            />
          ) : null}
          {/*
            ⚠️ 条件从 `dropActive` 扩成 `dropActive || dropTarget?.kind === 'cell'`（2026-09-23 第 4 条）：
            `dropActive` 只有"从左侧面板拖"那条路会置真；拖**画布上已有的元素**时没人置它，
            于是即使我们已经知道"要放进这一格"，这句提示也不会渲染 —— 用户依然不知道落点。
          */}
          {dropActive || dropTarget?.kind === 'cell' ? (
            dropTarget?.kind === 'reject' ? (
              <div className="bp-drop-hint is-reject">{dropTarget.reason}</div>
            ) : dropTarget?.kind === 'cell' ? (
              <div className="bp-drop-hint is-into">松开即放进这个单元格</div>
            ) : (
              <div className="bp-drop-hint">松开即插入到此处</div>
            )
          ) : null}
        </div>
      </div>
      {/*
        拖行高 / 列宽时的**预览线 + 数值浮层**（用户规格 三）。
        坐标是**视口坐标**（`position: fixed`）⇒ 只能挂在**未被 `transform: scale()` 缩放**的
        画布根节点上；挂进纸张里会跟着一起缩放、并整体偏移一个页边距。
      */}
      {/*
        矩形选区的浮动工具条（规格 四）。`position: fixed` + 视口坐标：
        与预览线同理 —— 挂进被缩放的纸张里会跟着缩放、并整体偏一个页边距。
        位置由 `barAt` 在渲染后量出来（见那个 useLayoutEffect），此处只负责画。
      */}
      {cellSel && selRange && barAt && actions ? (
        <CellRangeBar
          cellCount={rangeArea(selRange)}
          canSplit={(() => {
            const found = readBand(doc, bandOf(cellSel.tableId)).find((e) => e.id === cellSel.tableId)
            if (!found || found.kind !== 'table') return false
            const g = tableGrid(found.rows, found.colWidthsMm.length)[selRange.r1]?.[selRange.c1]
            return !!g && canSplitCell(found, g.cell.id)
          })()}
          allHeader={(() => {
            const found = readBand(doc, bandOf(cellSel.tableId)).find((e) => e.id === cellSel.tableId)
            if (!found || found.kind !== 'table') return false
            return found.rows.slice(selRange.r1, selRange.r2 + 1).every((r) => r.isHeader === true)
          })()}
          canDeleteRow={(() => {
            const found = readBand(doc, bandOf(cellSel.tableId)).find((e) => e.id === cellSel.tableId)
            return !!found && found.kind === 'table' && found.rows.length > 1
          })()}
          canDeleteCol={(() => {
            const found = readBand(doc, bandOf(cellSel.tableId)).find((e) => e.id === cellSel.tableId)
            return !!found && found.kind === 'table' && found.colWidthsMm.length > 1
          })()}
          style={{ left: barAt.left, top: barAt.top }}
          onOp={onRangeOp}
          onClose={() => setCellSel(null)}
        />
      ) : null}
      {/*
        「表格尺寸」浮层（规格 一）。挂在**画布根节点**（视口坐标，`position: fixed`），
        与右键菜单同理：放进被缩放的纸张里会跟着缩放、并偏一个页边距。
        落点直接用元素在纸上的位置换算 —— 表格刚插进来时就在视口里，不需要额外的收边逻辑。
      */}
      {newTableId && onResizeTable
        ? (() => {
            const found = readBand(doc, bandOf(newTableId)).find((e) => e.id === newTableId)
            if (!found || found.kind !== 'table') return null
            const host = paperRef.current?.querySelector<HTMLElement>(`[data-el-id="${newTableId}"]`)
            const box = host?.getBoundingClientRect()
            const style = box
              ? { left: Math.round(Math.min(box.right + 10, window.innerWidth - 190)), top: Math.round(box.top) }
              : { left: 12, top: 12 }
            return (
              <TableSizePanel
                rows={found.rows.length}
                cols={found.colWidthsMm.length}
                /*
                 * 两个开关的**回显**都从文档里读，面板自己不存状态：
                 *   · 行 → `rows[0].isHeader`（结构位，打印层也读它）；
                 *   · 列 → 第一列的样式（本项目"列的标题身份由样式表达"的既有设计，
                 *          见 table-actions 的 setHeaderStylePatch / isFirstColHeaderStyled）。
                 */
                headerRow={found.rows[0]?.isHeader === true}
                headerCol={isFirstColHeaderStyled(found)}
                style={style}
                onResize={(r, c) => onResizeTable(newTableId, r, c)}
                onHeaderRowChange={(on) => {
                  const res = setHeaderRowsPatch(found, { r1: 0, c1: 0, r2: 0, c2: Math.max(0, found.colWidthsMm.length - 1) }, on)
                  if (res) onMerge(newTableId, res.patch)
                }}
                onHeaderColChange={(on) => {
                  /* 走 setHeaderColPatch：它同时改样式与 `headerCol` 位，并且**不动角格**（见那个函数的注释） */
                  const res = setHeaderColPatch(found, on)
                  if (res) onMerge(newTableId, res.patch)
                }}
                onClose={() => onCloseTableSize?.()}
              />
            )
          })()
        : null}
      {childGhost ? (
        <span className="bp-child-ghost" style={{ left: childGhost.x + 12, top: childGhost.y + 12 }}>
          {childGhost.label}
        </span>
      ) : null}
      {/*
        「拆分单元格」的输入弹层（第 7 条）。输入框的**下限**取自目标格自己当前占的行列数 ——
        比它小没有意义（"1 行拆成 1 行"什么都没发生），直接把下限摆进输入框，用户不必先试一次才知道。
      */}
      {splitAsk
        ? (() => {
            const t = readBand(doc, bandOf(splitAsk.tableId)).find((e) => e.id === splitAsk.tableId)
            if (!t || t.kind !== 'table') return null
            const loc = findCell(t.rows, splitAsk.cellId)
            const gc = loc
              ? (tableGrid(t.rows, t.colWidthsMm.length)[loc.rowIdx] ?? []).find((x) => x?.cell.id === splitAsk.cellId)
              : null
            return (
              <SplitCellDialog
                minRows={Math.max(1, gc?.rowSpan ?? 1)}
                minCols={Math.max(1, gc?.colSpan ?? 1)}
                error={splitErr}
                onConfirm={doSplit}
                onCancel={() => {
                  setSplitAsk(null)
                  setSplitErr(null)
                }}
              />
            )
          })()
        : null}
      {sizeGhost ? (
        <>
          <span
            className={`bp-size-ghost bp-size-ghost--${sizeGhost.axis}`}
            style={sizeGhost.axis === 'col' ? { left: sizeGhost.x } : { top: sizeGhost.y }}
            aria-hidden
          />
          <span className="bp-size-ghost__tag" style={{ left: sizeGhost.x, top: sizeGhost.y }}>
            {sizeGhost.label}
          </span>
        </>
      ) : null}
      {ctx && actions ? (
        <ContextMenu x={ctx.x} y={ctx.y} items={ctxItems} onPick={onCtxPick} onClose={() => setCtx(null)} />
      ) : null}
    </div>
  )
})
