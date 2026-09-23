/**
 * 右抽屉：页面属性 / 元素属性。
 *
 * 分支规则：未选中任何元素 → 页面属性（PRD F2-25）；选中元素 → 按 kind 分支。
 *
 * 关于"默认字体 / 默认字号"：TemplateDoc 里没有这两个字段（契约归 lib/types.ts 所有，不改），
 * 而 PRD F2-25 又要求页面属性里有它们。折中做法是把它们当作**编辑器的本地偏好**存在 EditorShell，
 * 只影响"之后插入的新元素"的初始样式，不写入模板 JSON —— 这样既不污染契约，
 * 也符合 F2-28"不做样式集/主题级继承"的定调。
 */

import { useMemo, useRef, useState } from 'react'
import type { FieldMeta } from '../../lib/data-source'
import { fieldMeta } from '../../lib/field-types'
import {
  DEFAULT_PRINT_TIME_FORMAT,
  DEFAULT_TODAY_FORMAT,
  GRID_STEPS_MM,
  MARGIN_PRESETS,
  PAPER_MM,
  PAPER_PRESETS,
  TIME_FORMAT_PRESETS,
  finite,
  imageFillModeOf,
  imageFillPatch,
  pageRenderSize,
  type Align,
  type AnyElement,
  type AttachmentPrintConfig,
  type CodeSource,
  type ImageFill,
  type InlineNode,
  type MarginMm,
  type PageSetup,
  type PaperKey,
  type TableCell,
  type TableElement,
  type TemplateDoc,
  type TextStyle,
} from '../../lib/types'
import type { BandKey, BandLayout, CellLocation, NodeRef } from './useEditorState'
/* 选完本地图片后把浏览器全屏要回来（系统文件对话框会让窗口失焦、全屏被浏览器收掉） */
import { enterFullscreen } from '../../lib/fullscreen'
/* 文件选择走**单例**：面板里那个 input 会随布局档切换被重挂换掉 ⇒ change 落空（见该文件注释） */
import { pickFile } from '../../lib/file-pick'
import {
  BAND_HINT,
  DEFAULT_CODE_BG,
  DEFAULT_CODE_FG,
  SYSVAR_LABEL,
  cellLabel,
  codeSourceLabel,
  elementHeightMm,
  findCell,
  gridOptions,
  isSysVarNode,
  nodeAtRef,
  nodeKindLabel,
  nodeStyleCount,
  nodeStyleOf,
  nodesToText,
  textToNodes,
  updateCell,
} from './useEditorState'
// 格内子元素的尺寸口径（`w` = 占格宽百分比、`h` = 盒高）与百分比下限 —— 见 types.ts 第 ④ 条
import { MIN_CELL_CHILD_PCT, childHeightMm, childWidthPct } from './cell-child'
import {
  CapsuleSelect,
  ColorInput,
  Field,
  FieldPicker,
  Num,
  Section,
  Seg,
  Switch,
  type CapsuleOption,
} from './Controls'
import { IconBack, IconMerge, IconMinus, IconPlus, IconSplit, IconTrash, IconWarning } from './Icons'
import { isCode128Encodable } from '../../render/code-elements'
// `round1` 的规范实现（B 批收口：此前全项目 5 份副本、且不是同一种行为，见 round.ts 的文件头）
import { round1 } from './round'
// 表格动作的规范实现（B 批提升：原来这些动作各自关在本文件的组件闭包里，
// 顶栏的表格工具条是这些闭包的**兄弟**，够不到 —— 不提升就会各写一套。见 table-actions.ts 的文件头）
import {
  addColPatch,
  addRowPatch,
  applySplitCell,
  canSplitCell,
  delColPatch,
  delRowPatch,
  setColWidthPatch,
} from './table-actions'

/** 单元格底纹的默认值。属于**内容色**（会打印出来），不随暗色主题翻，故写死 */
const DEFAULT_CELL_BG = '#ffffff'

/** 字色色板。右侧面板与顶栏工具栏共用同一份，免得同一个颜色在两处叫不同的名字 */
export const TEXT_SWATCHES = ['#1f2329', '#646a73', '#8f959e', '#f54a45', '#ff8800', '#3370ff', '#1d9e75']

/** 字体候选。右侧面板与顶栏工具栏共用 */
export const FONT_OPTIONS = [
  { value: 'system', label: '系统默认', hint: '跟随飞书客户端的中文字体栈' },
  { value: 'serif', label: '宋体 / 衬线' },
  { value: 'mono', label: '等宽' },
  { value: 'Microsoft YaHei', label: '微软雅黑' },
  { value: 'SimSun', label: '宋体' },
  { value: 'SimHei', label: '黑体' },
  { value: 'KaiTi', label: '楷体' },
  { value: 'DengXian', label: '等线' },
]

/**
 * 纸张预设直接由 PAPER_PRESETS 摊平，不再手写一份 —— 两边各写一份的结果
 * 一定是"加了新纸型但下拉里没有"。
 * group 让弹层里出现「标准纸张 / 标签·面单」两个分组标题：
 * 标签纸的边距习惯（常常是 0）和 A4 完全不同，混在一个列表里必选错。
 */
export const PAPER_OPTIONS: CapsuleOption<PaperKey>[] = PAPER_PRESETS.map((p) => ({
  value: p.key,
  label: p.label,
  hint: p.wMm && p.hMm ? `${p.wMm} × ${p.hMm} mm` : '手动输入宽高',
  group: p.group,
}))

const GRID_OPTIONS: CapsuleOption<string>[] = GRID_STEPS_MM.map((v) => ({
  value: String(v),
  label: `${v} mm`,
  hint: v <= 1 ? '最细，适合标签纸' : v >= 10 ? '最粗，适合粗排' : undefined,
}))

/** 图片内嵌模板的上限（PRD F6-06 / D-6） */
const IMAGE_MAX_BYTES = 300 * 1024

export interface InspectorProps {
  doc: TemplateDoc
  fields: FieldMeta[]
  layout: BandLayout
  selected: AnyElement | null
  selectedBand: BandKey | null
  selectedCellId: string | null
  /**
   * 选中格内子元素时给出它所在的格子（否则 null）。
   *
   * 面板据此**换一套尺寸控件**（格内元素没有 X/Y、`w` 是百分比、`h` 是盒高，
   * 见 types.ts 的 TableCell.children 第 ④ 条）。判据只有这一个来源 ——
   * 面板里**不要**再去判 id 前缀，两处判据一定会有一天不一致。
   */
  selectedInCell?: { tableId: string; cellId: string } | null
  /** 节点级选中：字段占位符 / 系统变量 / 文字片段本身 */
  selectedNode?: NodeRef | null
  defaultTextStyle: TextStyle
  onPageSetup(patch: Partial<PageSetup>): void
  /**
   * 改**表头区高度**（= `bands.loop.offsetMm`，0 = 不要表头区）。
   *
   * 它不是 `pageSetup` 的字段（属于版式区），所以单开一个回调 —— 混进 pageSetup
   * 会造出第二个存放位置（见 `EditorApi.setLoopOffset` 的注释）。
   */
  onSetLoopOffset?(mm: number): void
  /**
   * 表头区 / 表尾区是否**参与打印**（2026-09-23 第二次反馈：「在侧边属性中选择开启或者关闭」）。
   * 关掉只影响打印与预览 —— 画布上元素照旧显示、照旧可编辑。
   */
  onSetBandEnabled?(band: 'header' | 'footer', on: boolean): void
  onDefaultTextStyle(patch: Partial<TextStyle>): void
  onMerge(id: string, patch: Partial<AnyElement>, mergeKey?: string): void
  onRemove(id: string): void
  onSetBand(id: string, band: BandKey): void
  onSelectCell(elementId: string | null, cellId: string | null): void
  /**
   * 请求合并（右合并 / 下合并）。
   *
   * 面板**不自己合并**：合并会整个丢掉被并进来那一格的内容，必须先过确认层，
   * 而确认层要能在顶栏工具条与右侧面板之间共用，所以它连同 `pending` 一起提升到了
   * `EditorShell`（弹层见 `MergeConfirm.tsx`）。这里只上报"哪一格的哪一边"。
   */
  onAskMerge(elementId: string, cellId: string, dir: 'right' | 'down'): void
  /** 改**这一处节点自己**的样式覆写；值为 undefined 表示清掉该项覆写 */
  onNodeStyle?(patch: TextStyle, mergeKey?: string): void
  /** 清掉这一处节点的全部样式覆写 */
  onClearNodeStyle?(): void
  /**
   * 改这一处节点的**非样式**属性：系统变量的时间格式 / 是否显示总页数。
   * 与 onNodeStyle 分开是故意的：那不是"样式覆写"，不该被「清除覆写」清掉。
   */
  onNodeProps?(patch: { format?: string; hideTotal?: boolean }): void
  /** 退回上一层（取消节点选中） */
  onSelectNode?(sel: NodeRef | null): void
  onNotice(message: string): void
}

export function Inspector(props: InspectorProps) {
  const { selected, selectedCellId, selectedNode } = props
  // 层级：节点 > 单元格 > 元素 > 页面。
  // 选中表格里某个单元格时，用户的心理对象是"这个格子"，此时还把所有控件都摊成表格级的
  // （行列增删、列宽……）就是他报的"点字段还是显示表格属性"那个问题。
  const cellScope = !!selected && selected.kind === 'table' && !!selectedCellId
  /**
   * 节点那一层只在"它真的属于当前选中的元素/格子"时才认。
   * 否则用户点了别的元素，面板还停在上一处字段上 —— 改的不是他看见的东西，这是最难查的一类错。
   * 定位失效（元素/格子被删、下标越界）同样自动退回上一层，不必在每条删除路径上清状态。
   */
  const node =
    selected && selectedNode && selectedNode.elementId === selected.id && (selectedNode.cellId ?? null) === (selectedCellId ?? null)
      ? nodeAtRef(props.doc, selectedNode)
      : null
  return (
    <div className="bp-panel bp-panel--inspector">
      <div className="bp-panel__scroll">
        {!selected ? (
          <PagePanel {...props} />
        ) : node && selectedNode ? (
          /*
           * ⚠️ 节点级这一块**不替代**它所在那一层的面板，而是叠在它上面。
           *
           * 一开始这里是"节点面板把单元格面板整个顶掉"，结果踩了一个真缺陷：
           * 点一下格子里那个字段占位符，单元格面板（`单元格内容` 输入框、合并拆分、底纹、
           * 单元格对齐…）就整个消失了 —— 用户想改那一格的文字，得先意识到要去按
           * 面板里那个「改这个单元格」。实测直接打断了既有链路（test/loop-table-browser 的
           * "清空循环表某一列"就是靠点格子 + 单元格内容输入框做的，改完立刻红两条）。
           *
           * 叠放之后层级是**看得出来**的：上面是"这一处"，下面就是它所在的那一格，
           * 中间一条实线分开；两个入口都还在，谁也不用先把谁关掉。
           */
          <>
            <div className={cellScope ? 'bp-node-block' : undefined}>
              <NodePanel {...props} selectedNode={selectedNode} node={node} />
            </div>
            {cellScope && selected.kind === 'table' ? (
              <CellPanel {...props} element={selected} band={props.selectedBand ?? 'loop'} />
            ) : null}
          </>
        ) : cellScope && selected.kind === 'table' ? (
          <CellPanel {...props} element={selected} band={props.selectedBand ?? 'loop'} />
        ) : (
          <ElementPanel {...props} element={selected} band={props.selectedBand ?? 'loop'} />
        )}
      </div>
    </div>
  )
}

// ============================================================
// 行内节点属性（字段占位符 / 系统变量 / 文字片段自己的样式）
// ============================================================

/**
 * 这一层的存在理由：`InlineField.style` 是**节点级覆写**，只影响那一处的值；
 * 而文本元素 / 单元格的 `style` 是元素级的。用户的抱怨是"似乎无法对字段内容进行字体的设置" ——
 * 他要改的正是这一层。所以除了给出控件，还必须把"你现在改的是哪一层"写在脸上。
 */
function NodePanel(props: InspectorProps & { selectedNode: NodeRef; node: InlineNode }) {
  const { node, selectedNode, selected } = props
  const s = nodeStyleOf(node)
  const overrides = nodeStyleCount(node)
  // 覆写之上是"外层"：文本元素自己 / 表格里那一格自己的样式。写清楚继承来源，用户才知道去哪改整体
  const inCell = !!selectedNode.cellId
  const outerName = inCell ? '这个单元格' : '整个元素'
  const outerStyle: TextStyle = inCell && selected?.kind === 'table'
    ? (findCell(selected.rows, selectedNode.cellId as string)?.cell.style ?? {})
    : (selected?.style ?? {})
  const effFont = s.fontFamily ?? outerStyle.fontFamily ?? 'system'
  const effSize = finite(s.fontSizePt, finite(outerStyle.fontSizePt, 10.5))

  const patch = (p: TextStyle, key?: string): void => props.onNodeStyle?.(p, key)

  return (
    <>
      <div className="bp-panel__title">这一处的样式</div>
      <p className="bp-scope">
        <span className="bp-scope__dot" aria-hidden />
        正在改 <b>{nodeKindLabel(node)}</b>
        <span className="bp-scope__sep" aria-hidden>
          ·
        </span>
        只影响{inCell ? '这一格里的这一处' : '这个元素里的这一处'}
      </p>

      <Section title="这一处的字体">
        <Field label="字体" hint={`「跟随外层」= 用${outerName}的字体（当前 ${effFont}）`}>
          <CapsuleSelect
            value={s.fontFamily ?? ''}
            options={[{ value: '', label: '跟随外层' }, ...FONT_OPTIONS]}
            onChange={(v) => patch({ fontFamily: v || undefined })}
            ariaLabel="这一处的字体"
          />
        </Field>
        <div className="bp-grid2">
          <Field label="字号" hint={`留空跟随外层；${outerName}当前 ${effSize}pt`}>
            <Num
              value={effSize}
              min={6}
              max={72}
              step={0.5}
              suffix="pt"
              ariaLabel="这一处的字号"
              onChange={(v) => patch({ fontSizePt: v }, 'fs')}
            />
          </Field>
          <Field label="字色" hint="只改这一处的颜色；清掉覆写即跟随外层">
            <ColorInput
              value={s.color ?? outerStyle.color ?? '#1f2329'}
              swatches={TEXT_SWATCHES}
              ariaLabel="这一处的字色"
              onChange={(v) => patch({ color: v })}
            />
          </Field>
        </div>
        <Field label="字形">
          <div className="bp-btnrow" role="group" aria-label="这一处的字形">
            <button
              type="button"
              className={`bp-tgl bp-tgl--bold${s.bold ? ' is-on' : ''}`}
              aria-pressed={!!s.bold}
              title="加粗（只作用这一处）"
              onClick={() => patch({ bold: s.bold ? undefined : true })}
            >
              B
            </button>
            <button
              type="button"
              className={`bp-tgl bp-tgl--italic${s.italic ? ' is-on' : ''}`}
              aria-pressed={!!s.italic}
              title="斜体（只作用这一处）"
              onClick={() => patch({ italic: s.italic ? undefined : true })}
            >
              I
            </button>
            <button
              type="button"
              className={`bp-tgl bp-tgl--under${s.underline ? ' is-on' : ''}`}
              aria-pressed={!!s.underline}
              title="下划线（只作用这一处）"
              onClick={() => patch({ underline: s.underline ? undefined : true })}
            >
              U
            </button>
            <button
              type="button"
              className={`bp-tgl bp-tgl--strike${s.strike ? ' is-on' : ''}`}
              aria-pressed={!!s.strike}
              title="删除线（只作用这一处）"
              onClick={() => patch({ strike: s.strike ? undefined : true })}
            >
              S
            </button>
          </div>
        </Field>
      </Section>

      {/*
        系统变量**自己**的属性（不是样式）：时间类变量的显示格式、合并形态要不要带「共 N 页」。
        为什么只在这一层给入口：它们是 `InlineSysVar` 上的字段，一个占位符一份，
        和"这一处的字体"处在同一层。放到元素面板上会变成"改了整段所有变量"，
        放到页面设置里更不对（那是纸张的事）。
        渲染层早已支持（render/types.ts 的 InlineSysVar + render/html.ts 的 resolveSysVar），
        缺的只是这个入口 —— 用户报的正是"界面上找不到地方设"。
      */}
      {isSysVarNode(node) ? (
        <Section title="这一处的内容">
          {node.key === 'pageOfTotal' ? (
            <Field label="总页数" hint="关掉就只输出「第 X 页」，不再带「共 N 页」">
              <Switch
                checked={node.hideTotal !== true}
                ariaLabel="显示总页数"
                onChange={(v) => props.onNodeProps?.({ hideTotal: v ? undefined : true })}
              />
            </Field>
          ) : null}
          {node.key === 'today' || node.key === 'printTime' ? (
            <Field
              label="时间格式"
              hint={`留空用这个变量自己的默认格式（${
                node.key === 'today' ? DEFAULT_TODAY_FORMAT : DEFAULT_PRINT_TIME_FORMAT
              }）`}
            >
              <CapsuleSelect
                value={node.format ?? ''}
                options={[
                  { value: '', label: '默认' },
                  ...TIME_FORMAT_PRESETS.map((p) => ({ value: p.value, label: p.label })),
                ]}
                onChange={(v) => props.onNodeProps?.({ format: v || undefined })}
                ariaLabel="这一处的时间格式"
              />
            </Field>
          ) : null}
          {node.key === 'pageOfTotal' || node.key === 'today' || node.key === 'printTime' ? null : (
            <p className="bp-hint">
              「{SYSVAR_LABEL[node.key]}」没有额外参数，取的就是它在渲染时的值；要调它的样子用上面的字体。
            </p>
          )}
        </Section>
      ) : null}

      <Section title="层级">
        <p className="bp-hint">
          这一层的样式只盖在它自己身上，现在有 {overrides} 项覆写。要改{outerName}的字体，点「改{outerName}」，
          或用顶栏右侧的目标切换。
        </p>
        <div className="bp-btnrow">
          <button
            type="button"
            className="bp-btn bp-btn--sm"
            aria-label={`退回上一层，改${outerName}`}
            onClick={() => props.onSelectNode?.(null)}
          >
            改{outerName}
          </button>
          <button
            type="button"
            className="bp-btn bp-btn--sm bp-btn--danger"
            aria-label="清除这一处的样式覆写"
            disabled={overrides === 0}
            title="把这一处设过的字体、字号、字形、颜色全部清掉，回到跟随外层"
            onClick={() => props.onClearNodeStyle?.()}
          >
            <IconTrash size={13} /> 清除覆写
          </button>
        </div>
        {overrides === 0 ? <p className="bp-hint">这一处还没有任何覆写，当前完全跟随{outerName}。</p> : null}
      </Section>
    </>
  )
}

// ============================================================
// 页面属性
// ============================================================

/**
 * 页面属性。
 *
 * 这里**导出**不是为了让别人调用它，而是为了让顶栏「页面设置」弹层能渲染**同一份**内容
 * （用户要求："页面的相关设置也放在这个按钮内"）。抄一份到顶栏 = 以后加一个页面字段，
 * 两个入口里只有一个有 —— 这正是"同一个规则两处各写一套"的老毛病。
 */
export function PagePanel({ doc, layout, defaultTextStyle, onPageSetup, onDefaultTextStyle, onSetLoopOffset, onSetBandEnabled }: InspectorProps) {
  const ps = doc.pageSetup
  const render = pageRenderSize(ps)
  const grid = gridOptions(ps)
  // 边距上限：保证版心至少还剩 10mm，否则会出现"版心宽度为负"（E-20）
  const maxMargin = Math.max(0, Math.min(render.w, render.h) / 2 - 5)
  const marginOverflow = ps.margin.top > maxMargin || ps.margin.bottom > maxMargin || ps.margin.left > maxMargin || ps.margin.right > maxMargin
  /**
   * 四边一致时返回那个值，否则 `null`（自定义）。
   * 快捷档要用它**回显当前档** —— 否则胶囊永远显示第一个选项（"整张纸"），
   * 用户会以为"我现在就是整张纸"，而实际边距是 20mm。
   */
  const uniformMargin: number | null = (() => {
    const m = ps.margin
    return m.top === m.right && m.right === m.bottom && m.bottom === m.left ? m.top : null
  })()
  /** 上/下、左/右 是否联动（连续镜像编辑，比"点一次四边相同"更好用） */
  const [linkV, setLinkV] = useState(false)
  const [linkH, setLinkH] = useState(false)

  // 非自定义纸张时，真实尺寸以 PAPER_MM 为准（pageRenderSize 也是这么算的）。
  // 直接读 ps.widthMm 会显示上一次自定义留下的旧值，和纸面不符。
  const presetMm = ps.paper === 'custom' ? null : PAPER_MM[ps.paper]
  const curW = presetMm ? presetMm.w : ps.widthMm
  const curH = presetMm ? presetMm.h : ps.heightMm

  const setPaper = (paper: PaperKey): void => {
    if (paper === 'custom') {
      onPageSetup({ paper })
      return
    }
    const mm = PAPER_MM[paper]
    onPageSetup({ paper, widthMm: mm.w, heightMm: mm.h })
  }

  /**
   * 直接改宽/高。
   * 手改了尺寸就自动落到"自定义"：留着 A4 的标签却按 200mm 出图，是更难排查的错。
   * 改回与预设一致的值时也顺手切回该预设，用户不用去下拉里再选一次。
   */
  const setDim = (key: 'w' | 'h', v: number): void => {
    const widthMm = key === 'w' ? v : curW
    const heightMm = key === 'h' ? v : curH
    const match = PAPER_PRESETS.find(
      (p) => p.key !== 'custom' && p.wMm === widthMm && p.hMm === heightMm,
    )
    onPageSetup({ widthMm, heightMm, paper: match ? match.key : 'custom' })
  }

  const setMargin = (key: keyof MarginMm, v: number): void => {
    const next: MarginMm = { ...ps.margin, [key]: v }
    if (linkV && (key === 'top' || key === 'bottom')) {
      next.top = v
      next.bottom = v
    }
    if (linkH && (key === 'left' || key === 'right')) {
      next.left = v
      next.right = v
    }
    onPageSetup({ margin: next })
  }

  const sameAll = (): void => {
    const v = ps.margin.top
    onPageSetup({ margin: { top: v, right: v, bottom: v, left: v } })
    setLinkV(true)
    setLinkH(true)
  }

  return (
    <>
      <div className="bp-panel__title">页面属性</div>

      <Section title="纸张">
        <Field label="尺寸">
          <CapsuleSelect value={ps.paper} options={PAPER_OPTIONS} onChange={setPaper} ariaLabel="纸张尺寸" />
        </Field>
        <div className="bp-grid2">
          <Field label="宽" hint="成品纸张的宽（mm）。改这里会自动切到自定义尺寸">
            <Num value={curW} min={10} max={1000} step={1} suffix="mm" ariaLabel="纸张宽度" onChange={(v) => setDim('w', v)} />
          </Field>
          <Field label="高" hint="成品纸张的高（mm）。横向时这两个值会自动对调显示">
            <Num value={curH} min={10} max={1000} step={1} suffix="mm" ariaLabel="纸张高度" onChange={(v) => setDim('h', v)} />
          </Field>
        </div>
        <Field label="方向">
          <Seg
            value={ps.orientation}
            ariaLabel="纸张方向"
            onChange={(v) => onPageSetup({ orientation: v })}
            options={[
              { value: 'portrait', label: '纵向' },
              { value: 'landscape', label: '横向' },
            ]}
          />
        </Field>
        <p className="bp-hint">
          成品尺寸 {round1(render.w)}×{round1(render.h)}mm · 版心 {round1(layout.contentWMm)}×{round1(layout.contentHMm)}mm
          {ps.paper === 'custom' ? ' · 自定义尺寸' : ''}
        </p>
      </Section>

      <Section title="网格与吸附">
        <Field label="网格间距">
          <CapsuleSelect
            value={String(grid.gridMm)}
            options={GRID_OPTIONS}
            onChange={(v) => onPageSetup({ gridMm: Number(v) })}
            ariaLabel="网格间距"
          />
        </Field>
        <Field label="显示网格" inline>
          <Switch checked={grid.showGrid} ariaLabel="显示网格" onChange={(v) => onPageSetup({ showGrid: v })} />
        </Field>
        <Field label="吸附到网格" inline>
          <Switch checked={grid.snapToGrid} ariaLabel="拖拽时吸附到网格" onChange={(v) => onPageSetup({ snapToGrid: v })} />
        </Field>
        <p className="bp-hint">
          拖动与缩放都会吸附到网格；按住 Alt 拖动可临时不吸附。X / Y / 宽 / 高 输入框的上下箭头也按这个步长走。
        </p>
        {/*
          「允许拖出页面」（2026-09-23 真机反馈第 10 条）。
          用户要求这个开关落在**页面属性 + 画布右键菜单**两处；这里是与网格/吸附同类的"编辑辅助"，放这一节最合适。
        */}
        <Field label="允许拖出页面" inline>
          <Switch
            checked={doc.pageSetup.allowOutOfPage === true}
            ariaLabel="允许拖出页面"
            onChange={(v) => onPageSetup({ allowOutOfPage: v })}
          />
        </Field>
        <p className="bp-hint">
          {doc.pageSetup.allowOutOfPage === true
            ? '现在可以把元素拖到纸张外（越界会被检查条点名，打印时印不出来）。'
            : '现在元素会被夹在版心内 —— 拖到边缘就停住，避免不小心把内容拖到纸外。'}
        </p>
      </Section>

      {/*
        ---- 分区（2026-09-23 真机反馈第 2 条）------------------------------------------
        用户原话：「当前表头区、循环区、表尾区的默认大小是多少？表头区改为可以删除或者增加，
        在页面属性中设置」。

        三个区的**大小口径**在这里一次说清（也顺便标出各自可调的入口）：
          · 表头区 = 这个输入框（`bands.loop.offsetMm`）；0 = 不要表头区；
          · 循环区 = 表头区之下、表尾区之上的**剩余空间**（不用填，自动）；
          · 表尾区 = 它自己内容的高度，**打印时贴版心底部**（元素越多，它往上长得越多）。
      */}
      {onSetLoopOffset ? (
        <Section title="分区">
          <Field label="表头区高度" hint="mm；0 = 不要表头区">
            <Num
              value={finite(doc.bands.loop.offsetMm, 0)}
              min={0}
              max={Math.max(0, Math.round(layout.contentHMm / 2))}
              step={1}
              suffix="mm"
              ariaLabel="表头区高度"
              onChange={(v) => onSetLoopOffset(v)}
            />
          </Field>
          {onSetBandEnabled ? (
            <>
              <Field label="表头区" hint="关掉后该区元素不参与打印（画布上仍然可以编辑）">
                <Switch
                  checked={doc.bands.headerEnabled !== false}
                  ariaLabel="表头区参与打印"
                  onChange={(v) => onSetBandEnabled('header', v)}
                />
              </Field>
              <Field label="表尾区" hint="关掉后该区元素不参与打印（画布上仍然可以编辑）">
                <Switch
                  checked={doc.bands.footerEnabled !== false}
                  ariaLabel="表尾区参与打印"
                  onChange={(v) => onSetBandEnabled('footer', v)}
                />
              </Field>
            </>
          ) : null}
          <p className="bp-hint">
            循环区自动从表头区下面开始（高度自动）；**表头区与表尾区都每页重复**（相当于 Word 的页眉 / 页脚）。
            三个分区的范围在画布上都有虚线框；表头区里的元素出不了这个高度，所以拖它不会推动别的分区。
          </p>
        </Section>
      ) : null}

      <Section title="页边距">
        {/*
          快捷档（2026-09-18 用户提问后补）：
          "打印范围应该强制和纸张大小一致，纸张大小设置多少，打印范围就是多少才对。"
          —— 可打印范围 = 版心 = 纸张 − 页边距，所以"整张纸"就是**四个边距都设 0**。
          以前只有四个数字框，没人会想到这条等价关系 ⇒ 直接把档位摆出来。
        */}
        <Field label="整档">
          <CapsuleSelect
            value={String(uniformMargin ?? 'custom')}
            options={MARGIN_PRESETS.map((p) => ({ value: String(p.mm), label: p.label, hint: p.hint }))}
            onChange={(v) => {
              const mm = Number(v)
              onPageSetup({ margin: { top: mm, right: mm, bottom: mm, left: mm } })
            }}
            ariaLabel="页边距快捷档"
          />
        </Field>
        {uniformMargin === null && (
          <p className="bp-hint">当前四边不一致（自定义）。选上面任意一档会四边一起改。</p>
        )}
        <div className="bp-grid2">
          <Field label="上">
            <Num value={ps.margin.top} min={0} max={maxMargin} step={1} suffix="mm" ariaLabel="上边距" onChange={(v) => setMargin('top', v)} />
          </Field>
          <Field label="下">
            <Num value={ps.margin.bottom} min={0} max={maxMargin} step={1} suffix="mm" ariaLabel="下边距" onChange={(v) => setMargin('bottom', v)} />
          </Field>
          <Field label="左">
            <Num value={ps.margin.left} min={0} max={maxMargin} step={1} suffix="mm" ariaLabel="左边距" onChange={(v) => setMargin('left', v)} />
          </Field>
          <Field label="右">
            <Num value={ps.margin.right} min={0} max={maxMargin} step={1} suffix="mm" ariaLabel="右边距" onChange={(v) => setMargin('right', v)} />
          </Field>
        </div>
        <div className="bp-btnrow" role="group" aria-label="页边距联动">
          <button
            type="button"
            className={`bp-minibtn${linkV ? ' is-on' : ''}`}
            aria-pressed={linkV}
            title="开启后，改上边距会同步改下边距（反之亦然）"
            onClick={() => setLinkV((v) => !v)}
          >
            上下联动
          </button>
          <button
            type="button"
            className={`bp-minibtn${linkH ? ' is-on' : ''}`}
            aria-pressed={linkH}
            title="开启后，改左边距会同步改右边距（反之亦然）"
            onClick={() => setLinkH((v) => !v)}
          >
            左右联动
          </button>
          <button type="button" className="bp-minibtn" title="把上边距的值应用到四边" onClick={sameAll}>
            四边相同
          </button>
        </div>
        {marginOverflow ? (
          <p className="bp-alert bp-alert--danger">
            <IconWarning size={13} /> 页边距超出纸张尺寸，已自动收窄
          </p>
        ) : null}
        <div className="bp-grid2">
          <Field label="页眉距边">
            <Num value={ps.headerMm} min={0} max={maxMargin} step={1} suffix="mm" ariaLabel="页眉距上边缘" onChange={(v) => onPageSetup({ headerMm: v })} />
          </Field>
          <Field label="页脚距边">
            <Num value={ps.footerMm} min={0} max={maxMargin} step={1} suffix="mm" ariaLabel="页脚距下边缘" onChange={(v) => onPageSetup({ footerMm: v })} />
          </Field>
        </div>
        <p className="bp-hint">v1 不渲染页眉页脚内容，仅保留距边距离供参考</p>
      </Section>

      <Section title="默认字体（影响之后插入的元素）" defaultOpen={false}>
        <Field label="字体">
          <CapsuleSelect
            value={defaultTextStyle.fontFamily ?? 'system'}
            options={FONT_OPTIONS}
            onChange={(v) => onDefaultTextStyle({ fontFamily: v })}
            ariaLabel="默认字体"
          />
        </Field>
        <Field label="字号">
          <Num
            value={finite(defaultTextStyle.fontSizePt, 10.5)}
            min={8}
            max={72}
            step={0.5}
            suffix="pt"
            ariaLabel="默认字号"
            onChange={(v) => onDefaultTextStyle({ fontSizePt: v })}
          />
        </Field>
        <Field label="颜色">
          <ColorInput
            value={defaultTextStyle.color ?? '#1f2329'}
            swatches={TEXT_SWATCHES}
            ariaLabel="默认字色"
            onChange={(v) => onDefaultTextStyle({ color: v })}
          />
        </Field>
      </Section>

      <div className="bp-note">
        <p>没有选中元素时这里是页面属性。选中画布上的元素即可编辑它的样式与内容。</p>
      </div>
    </>
  )
}

// ============================================================
// 元素属性
// ============================================================

function ElementPanel(props: InspectorProps & { element: AnyElement; band: BandKey }) {
  const { element, band } = props
  const inCell = props.selectedInCell ?? null
  const grid = gridOptions(props.doc.pageSetup)
  /**
   * 数值输入的步长跟着网格走：吸附开着时，按一次上下箭头正好走一格，
   * 于是"用键盘微调"和"用鼠标拖"得到的是同一套坐标，不会互相打架。
   */
  const step = grid.snapToGrid ? grid.gridMm : 1
  return (
    <>
      <div className="bp-elbar">
        <span className="bp-elbar__name">{KIND_LABEL[element.kind]}</span>
        <button
          type="button"
          className="bp-iconbtn bp-iconbtn--danger"
          aria-label="删除该元素"
          title="删除（Delete）"
          onClick={() => props.onRemove(element.id)}
        >
          <IconTrash size={14} />
        </button>
      </div>

      {inCell ? (
        /* 在格子里时，位置与尺寸**整套换掉**，不是禁用：
           禁用能让用户看出"为什么不能改"，但这里不是"不能改"，而是"可改的东西不一样"——
           格内元素的宽是百分比、没有 X/Y。摆一个灰掉的 mm 输入框反而在教他错的口径。 */
        <Section title="尺寸">
          <div className="bp-grid2">
            <Field label="占格宽" hint="占单元格内容宽度的百分比，100 = 撑满">
              <Num
                value={childWidthPct(element)}
                min={MIN_CELL_CHILD_PCT}
                max={100}
                step={5}
                suffix="%"
                ariaLabel="占单元格宽度"
                onChange={(v) => props.onMerge(element.id, { w: v }, `cw:${element.id}`)}
              />
            </Field>
            <Field label="高" hint="0 = 由内容决定">
              <Num
                value={childHeightMm(element) ?? 0}
                min={0}
                max={800}
                step={1}
                suffix="mm"
                ariaLabel="固定高度"
                onChange={(v) => props.onMerge(element.id, { h: v > 0 ? v : 'auto' }, `ch:${element.id}`)}
              />
            </Field>
          </div>
          <p className="bp-hint">
            格内元素跟着文字流排，位置由单元格决定；宽度按百分比（100 = 撑满这一格），高度按 mm，0 = 由内容决定（图片按原比例）。
          </p>
          {element.kind === 'qrcode' || element.kind === 'barcode' ? (
            /* 「填充方式」这一项**故意不给码**：变形的二维码扫不出来（见 qrCodeSvg 的注释）。
               与其给一个会让产物不可用的档位，不如把"它只能等比缩放"写清楚。 */
            <p className="bp-hint">码会**等比缩放**到你给的这个框里，不会拉伸或裁剪 —— 变形的二维码是扫不出来的。</p>
          ) : null}
        </Section>
      ) : (
        <>
          {/* 这个标签**不缩短**：已有的断言（editor-interaction 第 [1] 节）是靠面板可见文字里
              有没有「所属版式区」来判断"面板切到了元素属性层"的，改成「版式区」会把那条判据弄丢。
              它 5 个字放不进 56px 的标签列，就让它换两行 —— 换行不丢字，省略号才丢字。 */}
          <Field label="所属版式区">
            <Seg
              value={band}
              ariaLabel="所属版式区"
              onChange={(v) => props.onSetBand(element.id, v)}
              options={[
                { value: 'header', label: '表头区', title: BAND_HINT.header },
                { value: 'loop', label: '循环区', title: BAND_HINT.loop },
                { value: 'footer', label: '表尾区', title: BAND_HINT.footer },
              ]}
            />
          </Field>

          <Section title="位置与尺寸">
            <div className="bp-grid2">
              <Field label="X">
                <Num value={finite(element.x, 0)} min={0} max={Math.max(0, props.layout.contentWMm)} step={step} suffix="mm" ariaLabel="水平位置" onChange={(v) => props.onMerge(element.id, { x: v }, `posx:${element.id}`)} />
              </Field>
              <Field label="Y">
                <Num value={finite(element.y, 0)} min={0} max={Math.max(0, props.layout.contentHMm)} step={step} suffix="mm" ariaLabel="垂直位置" onChange={(v) => props.onMerge(element.id, { y: v }, `posy:${element.id}`)} />
              </Field>
              <Field label="宽">
                <Num value={finite(element.w, 20)} min={4} max={Math.max(4, props.layout.contentWMm * 2)} step={step} suffix="mm" ariaLabel="宽度" onChange={(v) => props.onMerge(element.id, { w: v }, `w:${element.id}`)} />
              </Field>
              <Field label="高">
                <Num
                  value={element.h === 'auto' ? round1(elementHeightMm(element)) : finite(element.h, 20)}
                  min={1}
                  max={800}
                  step={step}
                  suffix="mm"
                  ariaLabel="高度"
                  onChange={(v) => props.onMerge(element.id, { h: v }, `h:${element.id}`)}
                />
              </Field>
            </div>
            <Field label="高度模式" hint="自动 = 高度由内容测量决定（循环区内有效）；固定 = 用手填的值">
              <Seg
                value={element.h === 'auto' ? 'auto' : 'fixed'}
                ariaLabel="高度模式"
                onChange={(v) =>
                  // 切回固定值时用当前估算高度打底，而不是硬塞一个 20 —— 否则一切换高度就跳一下
                  props.onMerge(element.id, { h: v === 'auto' ? 'auto' : round1(elementHeightMm(element)) }, `hmode:${element.id}`)
                }
                options={[
                  { value: 'fixed', label: '固定值' },
                  { value: 'auto', label: '自动' },
                ]}
              />
            </Field>
            <p className="bp-hint">输入框上下箭头按网格 {grid.gridMm}mm 步进{grid.snapToGrid ? '' : '（当前已关闭吸附）'}。</p>
          </Section>
        </>
      )}

      {element.kind === 'text' ? <TextAttrs {...props} element={element} /> : null}
      {element.kind === 'table' ? <TableAttrs {...props} element={element} /> : null}
      {element.kind === 'attach' ? <AttachAttrs {...props} element={element} /> : null}
      {element.kind === 'fieldBlock' ? <FieldBlockAttrs {...props} element={element} /> : null}
      {element.kind === 'image' ? <ImageAttrs {...props} element={element} /> : null}
      {element.kind === 'hline' ? <HLineAttrs {...props} element={element} /> : null}
      {element.kind === 'qrcode' || element.kind === 'barcode' ? <CodeAttrs {...props} element={element} /> : null}
      {element.kind === 'pagebreak' ? (
        <p className="bp-hint">分页符不可编辑内容与尺寸，导出时会在该位置强制另起一页。</p>
      ) : null}
    </>
  )
}

const KIND_LABEL: Record<AnyElement['kind'], string> = {
  text: '文本段落',
  table: '表格',
  image: '固定图片',
  attach: '附件字段块',
  fieldBlock: '字段块',
  hline: '水平线',
  pagebreak: '分页符',
  qrcode: '二维码',
  barcode: '条形码',
}

// ---- 文本 ----

function TextAttrs(props: InspectorProps & { element: Extract<AnyElement, { kind: 'text' }> }) {
  const { element } = props
  const s = element.style ?? {}
  const text = useMemo(() => nodesToText(element.nodes), [element.nodes])
  // 文本输入走 800ms 合并（F2-04）：连着敲字只产生一步撤销
  const mergeKey = `text:${element.id}`

  const patchStyle = (patch: TextStyle, key?: string): void =>
    props.onMerge(element.id, { style: { ...s, ...patch } }, key)

  return (
    <>
      <Section title="内容">
        <textarea
          className="bp-textarea"
          value={text}
          rows={3}
          aria-label="文本内容"
          placeholder="输入文字；${字段名} 会变成字段占位符"
          onChange={(e) => props.onMerge(element.id, { nodes: textToNodes(e.target.value, props.fields, element.nodes) }, mergeKey)}
        />
        {/* 文本里出现反斜杠转义时才解释一句：否则用户会以为是自己手滑打错了。
            提示文案必须用字符串字面量包住——JSX 文本里的 `{` 会被当成表达式容器。 */}
        {(text.includes('\\${') || text.includes('\\【')) && (
          <p className="bp-hint">
            {'带反斜杠的 \\${…} 与 \\【…】 表示按普通文字原样输出（Word 导入时选了「忽略」的占位符、正文里本就写着的「【页码】」字样都会变成这样）；删掉反斜杠即可重新变回活的字段占位符 / 系统变量。'}
          </p>
        )}
        <Field label="插入占位符">
          <FieldPicker
            value={null}
            options={fieldOptions(props.fields)}
            ariaLabel="插入字段占位符"
            allowEmpty={false}
            onChange={(id, name) => {
              if (!id) return
              props.onMerge(element.id, { nodes: [...element.nodes, { type: 'field', fieldId: id, fieldName: name }] })
            }}
          />
        </Field>
      </Section>

      <Section title="字体">
        <Field label="字体">
          <CapsuleSelect value={s.fontFamily ?? 'system'} options={FONT_OPTIONS} onChange={(v) => patchStyle({ fontFamily: v })} ariaLabel="字体" />
        </Field>
        <div className="bp-grid2">
          <Field label="字号">
            <Num value={finite(s.fontSizePt, 10.5)} min={8} max={72} step={0.5} suffix="pt" ariaLabel="字号" onChange={(v) => patchStyle({ fontSizePt: v }, `fs:${element.id}`)} />
          </Field>
          <Field label="行距">
            <Num value={finite(s.lineHeight, 1.5)} min={1} max={3} step={0.05} suffix="倍" ariaLabel="倍数行距" onChange={(v) => patchStyle({ lineHeight: v, lineHeightPt: undefined }, `lh:${element.id}`)} />
          </Field>
          <Field label="固定行距">
            <Num value={finite(s.lineHeightPt, 0)} min={0} max={80} step={0.5} suffix="pt" ariaLabel="固定行距" onChange={(v) => patchStyle(v > 0 ? { lineHeightPt: v } : { lineHeightPt: undefined }, `lhp:${element.id}`)} />
          </Field>
          <Field label="首行缩进" hint="字距缩进（首行）">
            <Num value={finite(s.indentFirstLineMm, 0)} min={0} max={40} step={1} suffix="mm" ariaLabel="首行缩进" onChange={(v) => patchStyle({ indentFirstLineMm: v }, `ind:${element.id}`)} />
          </Field>
          <Field label="段前">
            <Num value={finite(s.spaceBeforePt, 0)} min={0} max={60} step={0.5} suffix="pt" ariaLabel="段前间距" onChange={(v) => patchStyle({ spaceBeforePt: v }, `sb:${element.id}`)} />
          </Field>
          <Field label="段后">
            <Num value={finite(s.spaceAfterPt, 0)} min={0} max={60} step={0.5} suffix="pt" ariaLabel="段后间距" onChange={(v) => patchStyle({ spaceAfterPt: v }, `sa:${element.id}`)} />
          </Field>
        </div>
        <Field label="字形">
          <div className="bp-btnrow" role="group" aria-label="字形">
            <button type="button" className={`bp-tgl bp-tgl--bold${s.bold ? ' is-on' : ''}`} aria-pressed={!!s.bold} onClick={() => patchStyle({ bold: !s.bold })} title="加粗">
              B
            </button>
            <button type="button" className={`bp-tgl bp-tgl--italic${s.italic ? ' is-on' : ''}`} aria-pressed={!!s.italic} onClick={() => patchStyle({ italic: !s.italic })} title="斜体">
              I
            </button>
            <button type="button" className={`bp-tgl bp-tgl--under${s.underline ? ' is-on' : ''}`} aria-pressed={!!s.underline} onClick={() => patchStyle({ underline: !s.underline })} title="下划线">
              U
            </button>
            <button type="button" className={`bp-tgl bp-tgl--strike${s.strike ? ' is-on' : ''}`} aria-pressed={!!s.strike} onClick={() => patchStyle({ strike: !s.strike })} title="删除线">
              S
            </button>
          </div>
        </Field>
        <Field label="字色">
          <ColorInput value={s.color ?? '#1f2329'} swatches={TEXT_SWATCHES} ariaLabel="字体颜色" onChange={(v) => patchStyle({ color: v })} />
        </Field>
        <Field label="底纹">
          <ColorInput value={s.background ?? '#ffffff'} ariaLabel="背景色" onChange={(v) => patchStyle({ background: v })} />
        </Field>
        <Field label="对齐">
          <Seg
            value={(s.align ?? 'left') as Align}
            ariaLabel="水平对齐"
            onChange={(v) => patchStyle({ align: v })}
            options={[
              { value: 'left', label: '左' },
              { value: 'center', label: '中' },
              { value: 'right', label: '右' },
              { value: 'justify', label: '两端' },
            ]}
          />
        </Field>
        <Field label="垂直对齐">
          <Seg
            value={(s.vAlign ?? 'top') as 'top' | 'middle' | 'bottom'}
            ariaLabel="垂直对齐"
            onChange={(v) => patchStyle({ vAlign: v })}
            options={[
              { value: 'top', label: '顶' },
              { value: 'middle', label: '中' },
              { value: 'bottom', label: '底' },
            ]}
          />
        </Field>
      </Section>
    </>
  )
}

// ---- 表格 ----

function TableAttrs(props: InspectorProps & { element: TableElement }) {
  const { element } = props
  const cols = element.colWidthsMm.length
  /**
   * 有没有"标题行 / 标题列"。
   *
   * 第 8 条（2026-09-23）：「增加一个功能，设置了标题行或者列后，允许设置标题行或列跨页重新打印……
   * 该功能仅在设置了标题行或者列后才可以勾选」。渲染层的 `tableRepeatHeader`（`render/html.ts`）
   * 内部本来就有 `hasHeader && repeatHeader !== false` 这条闸门，这里只是让 **UI 也如实反映**它 ——
   * 不然就是一个"勾了但打印出来没变化"的控件。
   */
  const hasHeaderAxis = element.rows[0]?.isHeader === true || element.headerCol === true

  /*
   * 「多条记录排进同一张表」的判据必须与渲染层（`render/pipeline.ts` 的 `mergedLoopTableOf`）
   * 是**同一把尺子**。
   *
   * ⚠️ 2026-09-23 第二次反馈第 7 条**砍掉了"循环区恰好一个元素"这条限制**。
   * 那条限制的后果很隐蔽：表格下方一放东西，开关就变灰，用户既改不了、也看不出为什么，
   * 于是把现象归因成「标题行没起作用」（他原话是"不论是否设置了标题行，只要表格下方无元素
   * 就是台账、有元素就是一份份"—— 其实跟标题行毫无关系）。
   *
   * 现在只剩两条：**这张表在循环区里** + 循环区里**没有第二张也开了该选项的表**。
   */
  const loopEls = props.doc.bands.loop?.elements ?? []
  const inLoop = loopEls.some((el) => el.id === element.id)
  const otherDeclared = loopEls.some(
    (el) => el.id !== element.id && el.kind === 'table' && el.rowsFromRecords === true,
  )
  const rowsFromRecordsOk = inLoop && !otherDeclared
  const rowsFromRecordsWhy = inLoop
    ? '循环区里已经有另一张表格开启了这一项 —— 两张表同时按记录铺行，无法确定先后'
    : '这张表不在循环区里，多记录铺行只在循环区生效'

  // ---- 结构动作：一律**薄转发**到 `./table-actions`（纯函数层）----
  // 为什么不再留在这里：顶栏的表格工具条是本组件的**兄弟**，够不到这里的闭包。
  // 不先提升，工具条那边顺手就会再写一套 —— 这个项目在"同一个逻辑两处各写一套"
  // 上已经栽过三次。动作层返回 `null` 的语义是"这一下不该发生"，与按钮禁用同一把尺子。
  const addRow = (): void => {
    props.onMerge(element.id, addRowPatch(element).patch)
  }
  const delRow = (): void => {
    const r = delRowPatch(element)
    if (r) props.onMerge(element.id, r.patch)
  }
  const addCol = (): void => {
    const r = addColPatch(element)
    if (r) props.onMerge(element.id, r.patch)
  }
  const delCol = (): void => {
    const r = delColPatch(element)
    if (r) props.onMerge(element.id, r.patch)
  }

  const setColWidth = (i: number, v: number): void => {
    const p = setColWidthPatch(element, i, v)
    if (p) props.onMerge(element.id, p, `colw:${element.id}:${i}`)
  }

  const totalColW = element.colWidthsMm.reduce((a, b) => a + b, 0)
  const overflow = totalColW > props.layout.contentWMm + 0.5

  return (
    <>
      <Section title="结构">
        <div className="bp-btnrow" role="group" aria-label="行列增删">
          <button type="button" className="bp-minibtn" onClick={addRow} aria-label="增加一行">
            <IconPlus size={13} /> 行
          </button>
          <button type="button" className="bp-minibtn" onClick={delRow} disabled={element.rows.length <= 1} aria-label="减少一行">
            <IconMinus size={13} /> 行
          </button>
          <button type="button" className="bp-minibtn" onClick={addCol} disabled={cols >= 12} aria-label="增加一列">
            <IconPlus size={13} /> 列
          </button>
          <button type="button" className="bp-minibtn" onClick={delCol} disabled={cols <= 1} aria-label="减少一列">
            <IconMinus size={13} /> 列
          </button>
        </div>
        <p className="bp-hint">
          当前 {element.rows.length} 行 × {cols} 列
        </p>
        <Field label="表头行" hint="首行作为表头，可加粗并每页重复">
          <Switch
            checked={!!element.rows[0]?.isHeader}
            ariaLabel="首行作为表头"
            onChange={(v) =>
              props.onMerge(element.id, { rows: element.rows.map((r, i) => (i === 0 ? { ...r, isHeader: v } : r)) })
            }
          />
        </Field>
        <Field label="表头重复" hint="表头行每页重复打印（需要先打开「表头行」或「表头列」）">
          <Switch
            checked={!!element.repeatHeader}
            ariaLabel="表头每页重复"
            disabled={!hasHeaderAxis}
            onChange={(v) => props.onMerge(element.id, { repeatHeader: v })}
          />
        </Field>
        <Field label="连续打印" hint="多条记录排进同一张表：各条记录各占一行、表头只出一次">
          <Switch
            checked={!!element.rowsFromRecords}
            ariaLabel="连续打印"
            disabled={!rowsFromRecordsOk}
            onChange={(v) => props.onMerge(element.id, { rowsFromRecords: v })}
          />
        </Field>
        {rowsFromRecordsOk ? (
          <p className="bp-hint">
            各条记录各占一行、表头只出一次。导出时按记录铺开；画布上仍按模板原样显示。
            {loopEls.length > 1
              ? '⚠️ 循环区里表格之外的其它元素只会按第一条记录渲染一次（排在表格下方）；想让它们每条记录都重复，请把那些元素移到「表尾区」。'
              : ''}
          </p>
        ) : (
          <p className="bp-hint">开关不生效：{rowsFromRecordsWhy}</p>
        )}
      </Section>

      <Section title="单元格">
        {/* 选中单元格后整个面板会换成"单元格属性"，所以这里永远走不到 cellPos 分支。
            这儿的职责是**把用户指过去**：不给入口，用户根本不知道单元格能点。 */}
        <p className="bp-hint">
          在画布上点选某个单元格 → 面板会切到该单元格（改内容、绑字段、合并拆分、内边距、底纹）；
          双击单元格可直接打字。选中后按 Esc 或点面包屑上的「表格」回到这里。
        </p>
        <Field label="内边距" hint="表格默认单元格内边距">
          <Num value={finite(element.cellPaddingMm, 1.5)} min={0} max={12} step={0.5} suffix="mm" ariaLabel="表格默认单元格内边距" onChange={(v) => props.onMerge(element.id, { cellPaddingMm: v }, `cpad:${element.id}`)} />
        </Field>
      </Section>

      <Section title="边框">
        <Field label="框线">
          <Seg
            value={element.border.mode}
            ariaLabel="表格边框模式"
            onChange={(v) => props.onMerge(element.id, { border: { ...element.border, mode: v } })}
            options={[
              { value: 'none', label: '无' },
              { value: 'all', label: '全框线' },
              { value: 'outer', label: '仅外框' },
              { value: 'horizontal', label: '仅横线' },
            ]}
          />
        </Field>
        {/* 线宽与线色**不并排**：排成两列时每个控件只剩 ~58px，
            10 个色块（需要 ~167px）会被挤成一竖条 —— 用户原话是"线色的色板挤成一竖条、
            与线宽不在一个视觉行上"。改成各自占一行后，色板一行放得下全部 10 个。
            代价是线宽那行右侧空着，但"控件左边缘对齐成一条线"这条更值。 */}
        <Field label="线宽">
          <Num
            value={finite(element.border.widthPt, 0.75)}
            min={0.25}
            max={3}
            step={0.25}
            suffix="pt"
            ariaLabel="框线宽度"
            onChange={(v) => props.onMerge(element.id, { border: { ...element.border, widthPt: v } }, `bw:${element.id}`)}
          />
        </Field>
        <Field label="线色">
          <ColorInput value={element.border.color} ariaLabel="框线颜色" onChange={(v) => props.onMerge(element.id, { border: { ...element.border, color: v } })} />
        </Field>
      </Section>

      <Section title="列宽与行高" defaultOpen={false}>
        {overflow ? (
          <p className="bp-alert bp-alert--warn">
            <IconWarning size={13} /> 列宽合计 {round1(totalColW)}mm 超过版心 {round1(props.layout.contentWMm)}mm，打印时将按比例压缩
          </p>
        ) : null}
        <div className="bp-grid2">
          {element.colWidthsMm.map((cw, i) => (
            <Field key={i} label={`第 ${i + 1} 列`}>
              <Num value={cw} min={4} max={400} step={1} suffix="mm" ariaLabel={`第 ${i + 1} 列宽`} onChange={(v) => setColWidth(i, v)} />
            </Field>
          ))}
        </div>
        <div className="bp-grid2">
          {element.rows.map((r, i) => (
            <Field key={r.id} label={`第 ${i + 1} 行`}>
              <Num
                value={finite(r.heightMm, 0)}
                min={0}
                max={300}
                step={1}
                suffix="mm"
                ariaLabel={`第 ${i + 1} 行高`}
                onChange={(v) =>
                  props.onMerge(
                    element.id,
                    { rows: element.rows.map((row, ri) => (ri === i ? { ...row, heightMm: v > 0 ? v : undefined } : row)) },
                    `rh:${element.id}:${i}`,
                  )
                }
              />
            </Field>
          ))}
        </div>
        <p className="bp-hint">行高填 0 表示自适应内容高度。</p>
      </Section>
    </>
  )
}

// ---- 单元格（表格的第二级） ----
//
// 为什么要有这一级：用户点进表格里的某个格子时，他要改的是"这个格子"——
// 内容、这个格子里的字段、这个格子的内边距。此时还把行列增删 / 列宽 / 表头行全摊在面板上，
// 就是他反馈的"点字段还是显示表格属性"。整表面板仍然完整保留，靠面包屑 / Esc 回去。

function CellPanel(props: InspectorProps & { element: TableElement; band: BandKey }) {
  const { element } = props
  const loc = findCell(element.rows, props.selectedCellId)

  // 选中的单元格可能刚被"合并/减少一列"吃掉了：这种情况退回整表面板，
  // 而不是让面板停在一个已经不存在的对象上（会渲染出一堆 undefined）
  if (!loc) return <ElementPanel {...props} element={element} band={props.band} />

  const cell = loc.cell
  const text = nodesToText(cell.nodes)
  const backToTable = (): void => props.onSelectCell(element.id, null)
  const patchCell = (patch: Partial<TableCell>, key?: string): void =>
    props.onMerge(element.id, { rows: updateCell(element.rows, cell.id, patch) }, key)

  /** 单元格里的字段占位符。（增删改都在这一个列表里完成） */
  const fieldNodes = cell.nodes
    .map((n, idx) => ({ n, idx }))
    .filter((x): x is { n: Extract<InlineNode, { type: 'field' }>; idx: number } => x.n.type === 'field')

  const replaceNode = (idx: number, next: InlineNode): void =>
    patchCell({ nodes: cell.nodes.map((n, i) => (i === idx ? next : n)) })

  /**
   * 合并 / 拆分**一律薄转发**到 `./table-actions`（纯函数层），本组件不再自己算。
   *
   * 三个理由：
   *   ① 顶栏的表格工具条也要合并 / 拆分，而它是本组件的**兄弟** —— 动作留在闭包里
   *      就只剩"再写一套"一条路（这个项目在"同一逻辑两处各写一套"上栽过三次）；
   *   ② 确认层要**结构上绕不过去**：`applyMergeRight/Down` 强制接收 `decide`，
   *      被并掉的那一格非空时不问过它就不产生补丁 —— 不是靠调用方"记得问"；
   *   ③ 判据因此能进 Node 套件（`table-actions` 只依赖类型与纯函数）。
   *
   * `decide` 返回 false 的语义是"这一下先别做，等用户在确认层点头"；
   * 攒住这次操作的 `pending` 已经提升到 `EditorShell`（见 `MergeConfirm.tsx`）。
   */
  const mergeRight = (): void => props.onAskMerge(element.id, cell.id, 'right')
  const mergeDown = (): void => props.onAskMerge(element.id, cell.id, 'down')
  const splitCell = (): void => {
    const r = applySplitCell(element, cell.id)
    if (r) props.onMerge(element.id, r.patch)
  }

  const cs = cell.style ?? {}
  const patchCellStyle = (patch: TextStyle, key?: string): void => patchCell({ style: { ...cs, ...patch } }, key)
  const canSplit = canSplitCell(element, cell.id)

  return (
    <>
      <div className="bp-elbar">
        <div className="bp-crumb">
          <button type="button" className="bp-crumb__link" title="返回整张表格（Esc）" onClick={backToTable}>
            {KIND_LABEL.table}
          </button>
          <span className="bp-crumb__sep" aria-hidden>
            ›
          </span>
          <span className="bp-crumb__cur">{cellLabel(loc)}</span>
        </div>
        <button
          type="button"
          className="bp-iconbtn"
          aria-label="返回整表"
          title="返回整表（Esc）"
          onClick={backToTable}
        >
          <IconBack size={14} />
        </button>
      </div>

      <Field label="所在单元格" hint="内容与字段都是这一格的，不会影响别的单元格">
        <span className="bp-hint">{cellLabel(loc)} · 跨 {Math.max(1, finite(cell.colspan, 1))} 列 / 跨 {Math.max(1, finite(cell.rowspan, 1))} 行</span>
      </Field>

      <Section title="单元格内容">
        <textarea
          className="bp-textarea"
          value={text}
          rows={3}
          aria-label="单元格内容"
          placeholder="输入文字；${字段名} 会变成字段占位符"
          onChange={(e) => patchCell({ nodes: textToNodes(e.target.value, props.fields, cell.nodes) }, `celltext:${cell.id}`)}
        />
        <Field label="插入占位符">
          <FieldPicker
            value={null}
            options={fieldOptions(props.fields)}
            ariaLabel="向单元格插入字段占位符"
            allowEmpty={false}
            onChange={(id, name) => {
              if (!id) return
              patchCell({ nodes: [...cell.nodes, { type: 'field', fieldId: id, fieldName: name }] })
            }}
          />
        </Field>
        <p className="bp-hint">也可以在画布上双击这个单元格直接打字；在单元格里按 Esc 结束编辑。</p>
      </Section>

      <Section title="这一格的字段">
        {fieldNodes.length === 0 ? (
          <p className="bp-hint">
            这一格还没有字段占位符。上面「插入占位符」可以把字段放进来（打印时按每条记录取不同的值）。
          </p>
        ) : (
          fieldNodes.map(({ n, idx }) => (
            <div className="bp-fieldref" key={`${n.fieldName}:${idx}`}>
              <div className="bp-fieldref__pick">
                <FieldPicker
                  value={n.fieldId}
                  fallbackName={n.fieldName}
                  options={fieldOptions(props.fields)}
                  ariaLabel={`改绑第 ${idx + 1} 个占位符`}
                  onChange={(id, name) => replaceNode(idx, { ...n, fieldId: id, fieldName: name })}
                />
              </div>
              <button
                type="button"
                className="bp-iconbtn bp-iconbtn--danger"
                aria-label="清除这个字段占位符"
                title="清除绑定，原地留下纯文本"
                onClick={() => replaceNode(idx, { type: 'text', text: n.fieldName })}
              >
                <IconTrash size={13} />
              </button>
            </div>
          ))
        )}
        {fieldNodes.some((x) => !x.n.fieldId) ? (
          <p className="bp-alert bp-alert--danger">
            <IconWarning size={13} /> 这一格有未绑定的字段占位符，打印时会输出空白
          </p>
        ) : null}
      </Section>

      <Section title="合并与拆分">
        {/*
          ⚠️ **为什么这里保留「与右格/下格合并」，而没有按 Excel 那样"必须先框选多格"**
          （2026-09-18 用户按 Excel 逻辑提出）：

          用户原话："我如果只选择了一个单元格，那么此时合并单元格的功能就不可用，
          只能使用拆分单元格。"
          —— 那是 Excel 的**手势规定**（先框选两个格，再点合并）。本插件目前**没有框选多格**
          （只有"当前格"这一级），所以真照搬"禁用合并"的话，**合并功能会整个消失**。

          ⇒ 折中：把动作名改成**动词**（「与右格合并」而不是「合并」），
            并在 hint 里写明"不需要先框选" —— 用户一眼就知道按钮会做什么，
            也不会误以为是"只对这一格生效"（原来的名字确实含糊）。
          ⇒ 真正要做的下一步是"框选多格"（range selection），见报告里的未完成项。
        */}
        <div className="bp-btnrow" role="group" aria-label="单元格合并拆分">
          <button
            type="button"
            className="bp-minibtn"
            onClick={mergeRight}
            aria-label="与右侧单元格合并"
            title="把这一格和它右边那一格合成一格（不需要先框选多个格子）"
          >
            <IconMerge size={13} /> 与右格合并
          </button>
          <button
            type="button"
            className="bp-minibtn"
            onClick={mergeDown}
            aria-label="与下方单元格合并"
            title="把这一格和它下面那一格合成一格（不需要先框选多个格子）"
          >
            <IconMerge size={13} /> 与下格合并
          </button>
          <button
            type="button"
            className="bp-minibtn"
            onClick={splitCell}
            disabled={!canSplit}
            aria-label="拆分单元格"
            title={canSplit ? '把这一格拆回成多行多列' : '这一格本来就没合并过，不用拆'}
          >
            <IconSplit size={13} /> 拆分
          </button>
        </div>
        <p className="bp-hint">
          单格不能"合并"（那是 Excel 里先框选两格才解锁的动作）；这里给的是**与相邻格合并**，
          一步到位，不必先框选。框线属于整张表格，不在这一层 —— 点下面「返回整表」去改。
        </p>
        <Field label="内边距" hint="单元格内边距；留空则用表格的默认内边距">
          <Num
            value={finite(cell.paddingMm, finite(element.cellPaddingMm, 1.5))}
            min={0}
            max={12}
            step={0.5}
            suffix="mm"
            ariaLabel="单元格内边距"
            onChange={(v) => patchCell({ paddingMm: v }, `pad:${cell.id}`)}
          />
        </Field>
      </Section>

      <Section title="单元格样式" defaultOpen={false}>
        <Field label="底纹">
          <ColorInput value={cs.background ?? DEFAULT_CELL_BG} ariaLabel="单元格底纹" onChange={(v) => patchCellStyle({ background: v }, `cellbg:${cell.id}`)} />
        </Field>
        <Field label="水平对齐">
          <Seg
            value={(cs.align ?? 'left') as Align}
            ariaLabel="单元格水平对齐"
            onChange={(v) => patchCellStyle({ align: v })}
            options={[
              { value: 'left', label: '左' },
              { value: 'center', label: '中' },
              { value: 'right', label: '右' },
            ]}
          />
        </Field>
        <Field label="垂直对齐">
          <Seg
            value={(cs.vAlign ?? 'top') as 'top' | 'middle' | 'bottom'}
            ariaLabel="单元格垂直对齐"
            onChange={(v) => patchCellStyle({ vAlign: v })}
            options={[
              { value: 'top', label: '顶' },
              { value: 'middle', label: '中' },
              { value: 'bottom', label: '底' },
            ]}
          />
        </Field>
        <Field label="字号">
          <Num value={finite(cs.fontSizePt, 10.5)} min={6} max={72} step={0.5} suffix="pt" ariaLabel="单元格字号" onChange={(v) => patchCellStyle({ fontSizePt: v }, `cellfs:${cell.id}`)} />
        </Field>
        <Field label="字形">
          <div className="bp-btnrow" role="group" aria-label="单元格字形">
            <button type="button" className={`bp-tgl bp-tgl--bold${cs.bold ? ' is-on' : ''}`} aria-pressed={!!cs.bold} title="加粗" onClick={() => patchCellStyle({ bold: !cs.bold })}>
              B
            </button>
            <button type="button" className={`bp-tgl bp-tgl--italic${cs.italic ? ' is-on' : ''}`} aria-pressed={!!cs.italic} title="斜体" onClick={() => patchCellStyle({ italic: !cs.italic })}>
              I
            </button>
            <button type="button" className={`bp-tgl bp-tgl--under${cs.underline ? ' is-on' : ''}`} aria-pressed={!!cs.underline} title="下划线" onClick={() => patchCellStyle({ underline: !cs.underline })}>
              U
            </button>
          </div>
        </Field>
        <Field label="字色">
          <ColorInput value={cs.color ?? '#1f2329'} swatches={TEXT_SWATCHES} ariaLabel="单元格字色" onChange={(v) => patchCellStyle({ color: v })} />
        </Field>
      </Section>

      {/*
        ⛔ 这里原来有一节「表格边框」（框线 / 线宽 / 线色，`defaultOpen={false}`）。
        **已移除**（2026-09-18 用户按 Excel 逻辑指出）：

        用户原话："我任意选择一个单元格，**编辑的边框线竟然是对整个表格生效**……
        单个单元格没有内框，只有用户手动拖选了多个单元格或者整表，才会有合并、内框线的选项。"

        那节自己的 hint 就写着"框线属于整张表格，这里改了所有单元格一起变" ——
        **等于把整表控件摆进了单格面板**，用户当然会以为"我改的是这一格"。
        ⇒ 框线只保留在**整表面板**（`边框` / `表格边框` 两节都在那边），
          单格面板只留"这一格自己的"东西。
      */}
      <p className="bp-hint">
        框线和整表结构（行 / 列 / 列宽 / 表头）请点下面「返回整表」后修改 —— 单格面板只放这一格自己的设置。
      </p>

      <div className="bp-btnrow">
        <button type="button" className="bp-minibtn" onClick={backToTable}>
          ← 返回整表（可改行列 / 列宽 / 表头 / 框线）
        </button>
      </div>
    </>
  )
}

// ---- 附件块（PRD F4.2 / F4.3 全套配置） ----

function AttachAttrs(props: InspectorProps & { element: Extract<AnyElement, { kind: 'attach' }> }) {
  const { element } = props
  const cfg = element.config
  const patch = (p: Partial<AttachmentPrintConfig>, key?: string): void =>
    props.onMerge(element.id, { config: { ...cfg, ...p } }, key)

  return (
    <>
      <Section title="绑定字段">
        <FieldPicker
          value={element.fieldId}
          fallbackName={element.fieldName}
          options={fieldOptions(props.fields)}
          ariaLabel="更换附件字段"
          onChange={(id, name) => props.onMerge(element.id, { fieldId: id, fieldName: name })}
        />
        {!element.fieldId ? (
          <p className="bp-alert bp-alert--danger">
            <IconWarning size={13} /> 尚未绑定附件字段，打印时将输出空白
          </p>
        ) : null}
      </Section>

      <Section title="打印策略（F4.2）">
        <Field label="附件处理">
          <Seg
            value={cfg.mode}
            ariaLabel="附件打印策略"
            onChange={(v) => patch({ mode: v })}
            options={[
              { value: 'none', label: '不打印', title: '画布显示 [不打印附件]，渲染为空' },
              { value: 'imageOnly', label: '仅图片', title: '只渲染图片类附件，非图片静默跳过' },
              {
                value: 'nameOnly',
                label: '仅名称',
                title: '一行一个文件名，不嵌图、不下载 —— 适合只想要一张"附件清单"',
              },
              { value: 'all', label: '全部', title: '图片按图片渲染，非图片按文件名文本渲染' },
            ]}
          />
        </Field>
        {/*
          「显示文件名」只对**会画图**的两档有意义：
          仅名称档本来就全是文件名（无需再叠一层），不打印档什么都没有。
          以前这里无条件显示，会让"仅名称"档出现一个点了没反应的开关。
        */}
        <Field label="显示文件名" inline hint={cfg.mode === 'nameOnly' ? '「仅名称」档已经是文件名，这项不用开' : undefined}>
          <Switch
            checked={!!cfg.showFileName}
            ariaLabel="在图片下方显示文件名"
            onChange={(v) => patch({ showFileName: v })}
          />
        </Field>
        {cfg.showFileName ? (
          <Field label="含扩展名" inline hint="文件名含扩展名">
            <Switch checked={!!cfg.fileNameWithExt} ariaLabel="文件名是否含扩展名" onChange={(v) => patch({ fileNameWithExt: v })} />
          </Field>
        ) : null}
        <Field label="仅导出文件名" hint="只导出文件名（不嵌图）：大表 / 弱网时的逃生舱，跳过全部图片下载">
          <Switch checked={!!cfg.textOnlyFallback} ariaLabel="只导出文件名不嵌图" onChange={(v) => patch({ textOnlyFallback: v })} />
        </Field>
      </Section>

      <Section title="尺寸（F4.3）">
        <Field label="尺寸模式">
          <Seg
            value={cfg.sizeMode}
            ariaLabel="图片尺寸模式"
            onChange={(v) => patch({ sizeMode: v })}
            options={[
              { value: 'original', label: '原图尺寸' },
              { value: 'fixedHeight', label: '固定高度' },
              { value: 'fixedBox', label: '固定宽高' },
              { value: 'fitCell', label: '适配单元格' },
            ]}
          />
        </Field>
        {cfg.sizeMode === 'fixedHeight' ? (
          <Field label="固定高度">
            <Num value={finite(cfg.fixedHeightMm, 30)} min={5} max={200} step={1} suffix="mm" ariaLabel="图片固定高度" onChange={(v) => patch({ fixedHeightMm: v }, `fh:${element.id}`)} />
          </Field>
        ) : null}
        {/*
          固定宽高：框就是**上方「宽」「高」那两项**，这里只决定"图片怎么放进这个框"。
          ⚠️ 只有这一个模式会真正按框写死高度（见 Canvas 与 render/html.ts 的 PIC_LIKE 分支）；
          其它模式仍是"高度只作下限"，因为内容（原图比例）才是尺寸的来源。
        */}
        {cfg.sizeMode === 'fixedBox' ? (
          <>
            <Field label="图片适配" hint="框的大小用上方的「宽」「高」；这里只管图片怎么放进去">
              <Seg
                value={cfg.fit ?? 'contain'}
                ariaLabel="图片适配方式"
                onChange={(v) => patch({ fit: v })}
                options={[
                  { value: 'contain', label: '等比缩放留白' },
                  { value: 'cover', label: '等比缩放填满' },
                ]}
              />
            </Field>
            <p className="bp-hint">
              留白＝整图可见、空出来的一边留白（默认）；填满＝等比放大到铺满框，超出的部分裁掉。
              想改框的大小，直接拖画布上的缩放手柄，或改上面的「宽」「高」。
            </p>
          </>
        ) : null}
        <p className="bp-hint">所有模式都严格等比缩放，不会拉伸变形；超出容器时按较小比例缩。</p>
        <Field label="自适应单元格" inline>
          <Switch checked={!!cfg.fitCell} ariaLabel="自适应单元格大小" onChange={(v) => patch({ fitCell: v })} />
        </Field>
        <Field label="对齐">
          <Seg
            value={cfg.align}
            ariaLabel="图片组对齐方式"
            onChange={(v) => patch({ align: v })}
            options={[
              { value: 'left', label: '左' },
              { value: 'center', label: '中' },
              { value: 'right', label: '右' },
            ]}
          />
        </Field>
        <Field label="排列方式">
          <Seg
            value={cfg.flow}
            ariaLabel="多张图片排列方式"
            onChange={(v) => patch({ flow: v })}
            options={[
              { value: 'inline', label: '并排', title: '在容器宽度内依次排列，放不下自动换行' },
              { value: 'wrap', label: '换行', title: '每张图片独占一行' },
            ]}
          />
        </Field>
        <Field label="每行张数" hint="每行最多张数；留 0 表示按容器宽度自动计算">
          <Num
            value={finite(cfg.maxPerRow, 0)}
            min={0}
            max={8}
            step={1}
            suffix="张"
            ariaLabel="每行最多图片数"
            onChange={(v) => patch({ maxPerRow: v > 0 ? Math.round(v) : null }, `mpr:${element.id}`)}
          />
        </Field>
        <div className="bp-grid2">
          <Field label="水平间距">
            <Num value={finite(cfg.gapXMm, 2)} min={0} max={30} step={0.5} suffix="mm" ariaLabel="图片水平间距" onChange={(v) => patch({ gapXMm: v }, `gx:${element.id}`)} />
          </Field>
          <Field label="垂直间距">
            <Num value={finite(cfg.gapYMm, 2)} min={0} max={30} step={0.5} suffix="mm" ariaLabel="图片垂直间距" onChange={(v) => patch({ gapYMm: v }, `gy:${element.id}`)} />
          </Field>
        </div>
      </Section>

      <Section title="保护与限制" defaultOpen={false}>
        <Field label="单张上限" hint="单张图片体积上限">
          <Num value={finite(cfg.maxFileSizeMb, 10)} min={1} max={100} step={1} suffix="MB" ariaLabel="单张图片体积上限" onChange={(v) => patch({ maxFileSizeMb: v }, `mfs:${element.id}`)} />
        </Field>
        <Field label="最小 DPI">
          <Num value={finite(cfg.minDpi, 150)} min={72} max={600} step={10} suffix="dpi" ariaLabel="最小清晰度 DPI" onChange={(v) => patch({ minDpi: v }, `dpi:${element.id}`)} />
        </Field>
        <p className="bp-hint">低于该 DPI 时预览会给出清晰的黄色提示，但不阻止打印。</p>
      </Section>
    </>
  )
}

// ---- 字段块 ----

function FieldBlockAttrs(props: InspectorProps & { element: Extract<AnyElement, { kind: 'fieldBlock' }> }) {
  const { element } = props
  const s = element.style ?? {}
  return (
    <Section title="绑定字段">
      <FieldPicker
        value={element.fieldId}
        fallbackName={element.fieldName}
        options={fieldOptions(props.fields)}
        ariaLabel="更换绑定字段"
        onChange={(id, name) => props.onMerge(element.id, { fieldId: id, fieldName: name })}
      />
      {!element.fieldId ? (
        <p className="bp-alert bp-alert--danger">
          <IconWarning size={13} /> 尚未绑定字段，打印时输出为空
        </p>
      ) : null}
      <div className="bp-grid2">
        <Field label="前缀">
          <input
            className="bp-input"
            value={element.prefix ?? ''}
            aria-label="字段前缀"
            placeholder="如 金额：¥"
            onChange={(e) => props.onMerge(element.id, { prefix: e.target.value }, `pre:${element.id}`)}
          />
        </Field>
        <Field label="后缀">
          <input
            className="bp-input"
            value={element.suffix ?? ''}
            aria-label="字段后缀"
            placeholder="如 元"
            onChange={(e) => props.onMerge(element.id, { suffix: e.target.value }, `suf:${element.id}`)}
          />
        </Field>
      </div>
      <Field label="字号">
        <Num
          value={finite(s.fontSizePt, 10.5)}
          min={8}
          max={72}
          step={0.5}
          suffix="pt"
          ariaLabel="字段块字号"
          onChange={(v) => props.onMerge(element.id, { style: { ...s, fontSizePt: v } }, `fs:${element.id}`)}
        />
      </Field>
      <Field label="字形">
        <div className="bp-btnrow" role="group" aria-label="字段块字形">
          <button type="button" className={`bp-tgl bp-tgl--bold${s.bold ? ' is-on' : ''}`} aria-pressed={!!s.bold} onClick={() => props.onMerge(element.id, { style: { ...s, bold: !s.bold } })}>
            B
          </button>
          <button type="button" className={`bp-tgl bp-tgl--italic${s.italic ? ' is-on' : ''}`} aria-pressed={!!s.italic} onClick={() => props.onMerge(element.id, { style: { ...s, italic: !s.italic } })}>
            I
          </button>
          <button type="button" className={`bp-tgl bp-tgl--under${s.underline ? ' is-on' : ''}`} aria-pressed={!!s.underline} onClick={() => props.onMerge(element.id, { style: { ...s, underline: !s.underline } })}>
            U
          </button>
        </div>
      </Field>
      <Field label="字色">
        <ColorInput value={s.color ?? '#1f2329'} swatches={TEXT_SWATCHES} ariaLabel="字段块字体颜色" onChange={(v) => props.onMerge(element.id, { style: { ...s, color: v } })} />
      </Field>
      <Field label="对齐">
        <Seg
          value={(s.align ?? 'left') as Align}
          ariaLabel="字段块对齐"
          onChange={(v) => props.onMerge(element.id, { style: { ...s, align: v } })}
          options={[
            { value: 'left', label: '左' },
            { value: 'center', label: '中' },
            { value: 'right', label: '右' },
          ]}
        />
      </Field>
    </Section>
  )
}

// ---- 图片 ----

/**
 * 把图片压到 `limit` 字节以内（返回 dataURL + 实际字节数；压不动返回 null）。
 *
 * 为什么要有它（2026-09-23 真机反馈）：「固定图片元素……选择了图片后，图片不会显示，
 * 且属性里也依旧提示您还没有选择图片」。
 * 根因不是选图链路断了，而是**单张 300KB 的硬上限**：手机照片动辄 2–5MB ⇒ 被一句 toast 拒掉
 * （而这时页面刚好因为系统文件选择器退出了全屏，用户的注意力根本不在那条提示上）⇒ 读作"选了没用"。
 *
 * 策略：先把最长边限到 2400px，再从 JPEG 质量 0.85 往下试；四档都超就继续缩小最长边，最多 6 轮。
 * ⚠️ 一律转成 JPEG ⇒ **透明区会被填成白色**（打印本来就是印在白纸上，这个取舍可接受）；
 *    文件本来就小于上限的**不走这里**，PNG 的透明原样保留。
 */
async function shrinkToLimit(
  img: HTMLImageElement,
  limit: number,
): Promise<{ dataUrl: string; bytes: number } | null> {
  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d')
  if (!ctx || !img.naturalWidth || !img.naturalHeight) return null
  const longest = Math.max(img.naturalWidth, img.naturalHeight)
  let maxEdge = Math.min(2400, longest)
  const PREFIX = 'data:image/jpeg;base64,'
  for (let round = 0; round < 6; round += 1) {
    const scale = Math.min(1, maxEdge / longest)
    canvas.width = Math.max(1, Math.round(img.naturalWidth * scale))
    canvas.height = Math.max(1, Math.round(img.naturalHeight * scale))
    /* 先铺白：JPEG 没有 alpha，不铺的话透明区会变成黑块 */
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
    for (const q of [0.85, 0.7, 0.55, 0.4]) {
      const dataUrl = canvas.toDataURL('image/jpeg', q)
      const bytes = Math.round(((dataUrl.length - PREFIX.length) * 3) / 4)
      if (bytes <= limit) return { dataUrl, bytes }
    }
    maxEdge = Math.round(maxEdge * 0.7)
  }
  return null
}

function ImageAttrs(props: InspectorProps & { element: Extract<AnyElement, { kind: 'image' }> }) {
  const { element } = props
  /** 打开系统文件选择器之前是不是浏览器全屏（选完要还回来，见按钮 onClick） */
  const wasFullscreenRef = useRef(false)

  const pick = (file: File | undefined): void => {
    if (!file) return
    if (!file.type.startsWith('image/')) {
      props.onNotice('请选择图片文件（png / jpeg / gif / webp / svg）')
      return
    }
    /*
     * ⚠️ 超限**不再拒绝**，改成自动压缩（见 shrinkToLimit 的文件头注释）。
     * 这里只记一下"要不要压"，真正的压缩在图片解码之后（需要 naturalWidth/Height）。
     */
    const needShrink = file.size > IMAGE_MAX_BYTES
    const reader = new FileReader()
    reader.onload = () => {
      const url = typeof reader.result === 'string' ? reader.result : ''
      if (!url) return
      // 按原图比例换算 mm 尺寸，宽度不超过版心（F2-10）
      const img = new Image()
      img.onload = () => {
        const maxW = props.layout.contentWMm
        const natural = img.naturalWidth / Math.max(img.naturalHeight, 1)
        let w = maxW
        let h = maxW / Math.max(natural, 0.01)
        if (h > props.layout.contentHMm) {
          h = props.layout.contentHMm
          w = h * natural
        }
        /*
         * ⚠️ 格内子元素不能走"按原图比例换算 mm"这条路（见 types.ts 第 ④ 条）：
         * 它的 `w` 是百分比、`h` 是盒高。把 180(mm) 写进去 ⇒ 读成 180% 夹回 100%、
         * 高度被定成一个 100mm 的盒子 —— 用户只想**换张图**，尺寸却自己变了。
         * 和"放进格子"同一个默认口径：撑满格宽、高度由内容决定。
         */
        const commit = (dataUrl: string, note?: string): void => {
          props.onMerge(
            element.id,
            props.selectedInCell
              ? { dataUrl, w: 100, h: 'auto' }
              : { dataUrl, w: round1(w), h: round1(h) },
          )
          if (note) props.onNotice(note)
        }
        if (!needShrink) {
          commit(url)
          return
        }
        const kb = Math.round(file.size / 1024)
        void shrinkToLimit(img, IMAGE_MAX_BYTES).then((shrunk) => {
          if (!shrunk) {
            props.onNotice(`图片 ${kb}KB，自动压缩失败（原图太大或格式特殊）；请先手动压缩到 300KB 以内`)
            return
          }
          commit(shrunk.dataUrl, `图片 ${kb}KB 超过 300KB 上限，已自动压缩到 ${Math.round(shrunk.bytes / 1024)}KB`)
        })
      }
      img.onerror = () => props.onMerge(element.id, { dataUrl: url })
      img.src = url
    }
    reader.readAsDataURL(file)
  }

  return (
    <Section title="图片">
      {element.dataUrl ? (
        <img className="bp-img-preview" src={element.dataUrl} alt="已插入的图片" />
      ) : (
        <p className="bp-alert bp-alert--warn">
          <IconWarning size={13} /> 还没有选择图片
        </p>
      )}
      <button
        type="button"
        className="bp-btn"
        onClick={() => {
          /*
           * 先记住"打开选择器之前是不是浏览器全屏"：系统文件选择器会让窗口失焦 ⇒
           * 浏览器**自动退出全屏** ⇒ 编辑器会缩回侧边栏布局（浏览器行为，改不了）。
           * 选完文件再把全屏要回来（那一下仍算用户手势，能过 requestFullscreen 的激活要求）。
           */
          wasFullscreenRef.current = !!document.fullscreenElement
          void pickFile('image/png,image/jpeg,image/gif,image/webp,image/svg+xml').then((file) => {
            if (file) pick(file)
            if (wasFullscreenRef.current && !document.fullscreenElement) {
              wasFullscreenRef.current = false
              void enterFullscreen()
            }
          })
        }}
      >
        {element.dataUrl ? '更换图片' : '选择图片'}
      </button>
      <p className="bp-hint">图片以 base64 内嵌进模板，单张上限 300KB；超出请先压缩。</p>
      {/*
        ---- 填充方式：规格 七 要求**四种**（铺满变形 / 保持比例留白 / 原尺寸 / 自动裁剪）----
        ⚠️ 这里原来只有两档（完整显示 / 裁剪填满）。现在四档的**翻译**交给 `imageFillPatch/ModeOf`
        （在 `types.ts`，画布与打印读的是同一份）：
          · 铺满变形 ⇒ `fit:'fill'`（新增的取值，渲染端 `object-fit:fill`）
          · 原尺寸   ⇒ `h:'auto'`（渲染端 `height:auto`，按图片原始比例撑高）
        ⚠️ 传 `element.h` 进去不能省：**从"原尺寸"切走时**必须把高度从 `'auto'` 改回具体值，
           否则读回来还是"原尺寸"，用户会觉得"点了没反应"（见那个函数的注释）。
      */}
      <Field label="填充方式">
        <Seg
          value={imageFillModeOf(element, 'image')}
          ariaLabel="图片填充方式"
          onChange={(v) => props.onMerge(element.id, imageFillPatch(v as ImageFill, 'image', element.h))}
          options={[
            { value: 'fill', label: '铺满变形' },
            { value: 'contain', label: '完整显示' },
            { value: 'natural', label: '原尺寸' },
            { value: 'cover', label: '裁剪填满' },
          ]}
        />
      </Field>
    </Section>
  )
}

// ---- 二维码 / 条形码 ----

function CodeAttrs(props: InspectorProps & { element: Extract<AnyElement, { kind: 'qrcode' | 'barcode' }> }) {
  const { element } = props
  const src = element.source
  const isQr = element.kind === 'qrcode'
  const setSource = (next: CodeSource): void => props.onMerge(element.id, { source: next })

  const unbound = src.kind === 'field' && !src.fieldId
  const emptyStatic = src.kind === 'static' && !src.value.trim()
  // 条形码（Code 128 / Code Set B）只认 ASCII 32–126。中文内容渲染库会返回空串，
  // 与其让用户对着一个空白框猜，不如在这里直接说清楚。
  const badBarcode = !isQr && src.kind === 'static' && src.value.trim() !== '' && !isCode128Encodable(src.value)

  return (
    <>
      <Section title="数值来源">
        <Field label="来源">
          <Seg
            value={src.kind}
            ariaLabel="码的数值来源"
            onChange={(v) => {
              if (v === src.kind) return
              // 换来源时清空另一侧的内容：留着上一次的字段名/固定值，
              // 会出现"从字段取值"却显示着上次那个网址的迷惑状态
              setSource(v === 'field' ? { kind: 'field', fieldId: null, fieldName: '' } : { kind: 'static', value: '' })
            }}
            options={[
              { value: 'field', label: '从字段取值', title: '每条记录一个码：产品追溯码、批次码' },
              { value: 'static', label: '手动输入', title: '全篇同一个码：固定网址、设备铭牌' },
            ]}
          />
        </Field>

        {src.kind === 'field' ? (
          <>
            <Field label="字段">
              <FieldPicker
                value={src.fieldId}
                fallbackName={src.fieldName}
                options={fieldOptions(props.fields)}
                ariaLabel="选择二维码 / 条形码取值的字段"
                onChange={(id, name) => setSource({ kind: 'field', fieldId: id, fieldName: name })}
              />
            </Field>
            {unbound ? (
              <p className="bp-alert bp-alert--danger">
                <IconWarning size={13} /> 尚未绑定字段，打印时会输出空白
              </p>
            ) : (
              <p className="bp-hint">画布上显示的是占位框，真实内容在打印时按每条记录逐条生成。</p>
            )}
          </>
        ) : (
          <>
            <Field label="内容">
              <input
                className="bp-input"
                value={src.value}
                aria-label="码的固定内容"
                placeholder={isQr ? '如 https://example.com 或 SN-0001' : '如 SN-2026-0001'}
                onChange={(e) => setSource({ kind: 'static', value: e.target.value })}
              />
            </Field>
            {emptyStatic ? (
              <p className="bp-alert bp-alert--warn">
                <IconWarning size={13} /> 还没有内容，画布上是空的
              </p>
            ) : null}
            {badBarcode ? (
              <p className="bp-alert bp-alert--danger">
                <IconWarning size={13} /> 条形码只支持数字、字母与常用符号，中文等内容生成不出码
              </p>
            ) : null}
          </>
        )}
      </Section>

      <Section title={isQr ? '二维码参数' : '条形码参数'}>
        {isQr ? (
          <Field label="纠错等级" hint="等级越高越抗污损，码也更密。L≈7% M≈15% Q≈25% H≈30%">
            <Seg
              value={element.ecLevel ?? 'M'}
              ariaLabel="二维码纠错等级"
              onChange={(v) => props.onMerge(element.id, { ecLevel: v })}
              options={[
                { value: 'L', label: 'L', title: '约 7% 容错，码最疏' },
                { value: 'M', label: 'M', title: '约 15% 容错（默认）' },
                { value: 'Q', label: 'Q', title: '约 25% 容错' },
                { value: 'H', label: 'H', title: '约 30% 容错，标签易磨损时用' },
              ]}
            />
          </Field>
        ) : (
          <p className="bp-hint">v1 固定使用 Code 128（覆盖全部 ASCII 字符，不需要校验位数）。</p>
        )}
        <Field label="显示原文" inline>
          <Switch
            checked={!!element.showText}
            ariaLabel="在码下方显示原文"
            onChange={(v) => props.onMerge(element.id, { showText: v })}
          />
        </Field>
        {isQr ? <p className="bp-hint">原文显示在码的下方，便于人工核对。</p> : null}
      </Section>

      <Section title="颜色">
        <Field label="前景">
          <ColorInput
            value={element.foreground ?? DEFAULT_CODE_FG}
            ariaLabel="码的前景色"
            onChange={(v) => props.onMerge(element.id, { foreground: v })}
          />
        </Field>
        <Field label="背景">
          <ColorInput
            value={element.background ?? DEFAULT_CODE_BG}
            ariaLabel="码的背景色"
            onChange={(v) => props.onMerge(element.id, { background: v })}
          />
        </Field>
        <p className="bp-hint">前景与背景反色、或对比度太低时扫码器会读不出来，浅底深码最稳。</p>
      </Section>

      <p className="bp-hint">元素当前的取值：{codeSourceLabel(src)}</p>
    </>
  )
}

// ---- 水平线 ----

function HLineAttrs(props: InspectorProps & { element: Extract<AnyElement, { kind: 'hline' }> }) {
  const { element } = props
  const s = element.style ?? {}
  return (
    <Section title="线条">
      <Field label="线宽">
        <Num value={finite(element.thicknessPt, 0.75)} min={0.25} max={3} step={0.25} suffix="pt" ariaLabel="水平线宽度" onChange={(v) => props.onMerge(element.id, { thicknessPt: v }, `lt:${element.id}`)} />
      </Field>
      <Field label="线色">
        <ColorInput value={element.color} ariaLabel="水平线颜色" onChange={(v) => props.onMerge(element.id, { color: v })} />
      </Field>
      <div className="bp-grid2">
        <Field label="左缩进">
          <Num value={finite(s.indentLeftMm, 0)} min={0} max={100} step={1} suffix="mm" ariaLabel="水平线左缩进" onChange={(v) => props.onMerge(element.id, { style: { ...s, indentLeftMm: v } }, `li:${element.id}`)} />
        </Field>
        <Field label="右缩进">
          <Num value={finite(s.indentRightMm, 0)} min={0} max={100} step={1} suffix="mm" ariaLabel="水平线右缩进" onChange={(v) => props.onMerge(element.id, { style: { ...s, indentRightMm: v } }, `ri:${element.id}`)} />
        </Field>
      </div>
      <p className="bp-hint">宽度由元素的"宽"决定，缩进是在这个宽度内再向内收。</p>
    </Section>
  )
}

// ============================================================

function fieldOptions(fields: FieldMeta[]) {
  return fields.map((f) => {
    const meta = fieldMeta(f.type)
    return {
      id: f.id,
      name: f.name,
      tint: meta.tint,
      blocked: meta.capability === 'none',
      group: meta.label,
      note: meta.note,
    }
  })
}
