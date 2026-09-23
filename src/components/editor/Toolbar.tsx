/**
 * 顶栏工具栏：文本编辑 + 纸张/方向 + 预览 + 页面设置。
 *
 * 为什么要有这一条（用户原话）：
 *   「优化画布工具区的样式，可以参考这个官方的样式，文本的编辑可以放在上方，
 *     同时增加横向和纵向的设置，再增加直接在此页面预览打印效果的功能，页面的相关设置也放在这个按钮内」
 *
 * 设计上的一个关键决定：**工具栏改的是"当前目标"，而不是某一层**。
 *
 * 编辑器里能设字体的地方其实有四层，它们不是并列而是**嵌套**：
 *
 *     这一处字段覆写（InlineField.style）  ← 最细，只盖那一个占位符
 *       └ 单元格样式（TableCell.style）
 *           └ 元素样式（TextElement.style / FieldBlock.style）
 *               └ 默认样式（defaultTextStyle，只影响之后新插入的元素）
 *
 * 右侧属性面板是"按层显示面板"，用户得先知道自己在哪一层才能找对控件。
 * 顶栏反过来：**先认出当前最细的那一层，把控件摆在最顺手的位置**，并在左边用一枚
 * 「改：…」标签把目标写出来（「字段「产品名称」」/「单元格 第 1 行 第 2 列」/「整个文本元素」/「默认样式」）。
 * 这样"改的是哪一层"是**看得见**的，而不是靠用户记住面板层级。
 *
 * 层级判定与 Inspector 严格同源（同一个「节点必须属于当前选中」的判据在 EditorShell 里算一次），
 * 否则会出现"顶栏说在改字段、面板却在改整格"这种自相矛盾。
 */

import type { ReactNode } from 'react'
import {
  PAPER_MM,
  finite,
  pageRenderSize,
  type Align,
  type AnyElement,
  type InlineNode,
  type PageSetup,
  type TableElement,
  type TemplateDoc,
  type TextStyle,
} from '../../lib/types'
import { CapsuleSelect, ColorInput, Num, Seg } from './Controls'
import { Popover } from './Popover'
import { FONT_OPTIONS, PAPER_OPTIONS, TEXT_SWATCHES } from './Inspector'
import { IconCaret, IconEye, IconMerge, IconMinus, IconPlus, IconRedo, IconSliders, IconSplit, IconTable, IconUndo } from './Icons'
import { cellLabel, findCell, nodeKindLabel, nodeStyleOf, updateCell, type NodeRef } from './useEditorState'
// 表格结构动作：与右侧面板**同一份**实现（`./table-actions` 的纯函数）。
// 两条入口各写一套是这个项目栽过三次的坑；确认层同理，合并一律经 `onAskMerge` 走 shell。
import { MAX_COLS, addColPatch, addRowPatch, applySplitCell, canSplitCell, delColPatch, delRowPatch } from './table-actions'

/** 文本工具作用在哪一层 */
export type ToolScope = 'node' | 'cell' | 'element' | 'default' | 'none'

/** 已解析出来的节点级目标 */
export interface NodeTarget {
  ref: NodeRef
  node: InlineNode
}

export interface ToolbarProps {
  doc: TemplateDoc
  /** 当前生效的节点级目标（null = 没有）。由 EditorShell 统一判定，工具栏不自己算 */
  nodeTarget: NodeTarget | null
  selected: AnyElement | null
  selectedCellId: string | null
  defaultTextStyle: TextStyle
  /** 窄侧栏：把最占地方的字体/字号收进一个小弹层 */
  /**
   * 模板类型（`record` = 一条记录一份；`view` = 多条记录一张）。
   * 顶栏那颗「当前模式」胶囊要用它 —— 见 `Toolbar` 里 `kindChip` 的注释（2026-09-23 第 9 条）。
   * 用内联联合而不是引 `TemplateKind`：这里只需要这两个字面量，不引一整个领域类型。
   */
  kind?: 'record' | 'view'
  compact?: boolean
  canUndo: boolean
  canRedo: boolean
  onUndo(): void
  onRedo(): void
  onPatchNodeStyle(patch: TextStyle, mergeKey?: string): void
  onClearNodeStyle(): void
  /** 取消节点选中，回到上一层 */
  onClearNode(): void
  onDefaultTextStyle(patch: Partial<TextStyle>): void
  onMerge(id: string, patch: Partial<AnyElement>, mergeKey?: string): void
  /**
   * 请求合并（右合并 / 下合并）。工具条**不自己合并** —— 合并会整个丢掉被并进来那一格，
   * 必须先过确认层，而确认层归 `EditorShell` 管（弹层见 `MergeConfirm.tsx`）。
   */
  onAskMerge(elementId: string, cellId: string, dir: 'right' | 'down'): void
  onPageSetup(patch: Partial<PageSetup>): void
  onPreview(): void
  /** 页面设置弹层的内容：由 EditorShell 用右侧面板**同一份**组件渲染，这里不另写一套 */
  pageSettings: ReactNode
  /** 版心读数（和顶栏副行里那句同源） */
  contentLabel: string
}

/**
 * 元素级的"字体"能不能设。
 *
 * 表格整体没有字体（它的字都在格子里），所以选中整张表时这一组要禁用并说清去哪改 ——
 * 比"点了没反应"或者"悄悄写到某个默认值上"都好。
 */
function canStyleElement(el: AnyElement | null): boolean {
  return !!el && (el.kind === 'text' || el.kind === 'fieldBlock')
}

export function Toolbar(props: ToolbarProps) {
  const { doc, nodeTarget, selected, selectedCellId, defaultTextStyle } = props
  const ps = doc.pageSetup
  const render = pageRenderSize(ps)

  /*
   * ── 顶栏那颗「当前模式」胶囊（2026-09-23 第 9 条）──────────────────────────
   * 用户原话：「画布编辑页顶部，页面设置前面，用胶囊样式显示当前模板类型」。
   *
   * ⚠️ 它显示的是**两个正交的事实**（模板类型 · 数据布局），刻意不只显示类型 ——
   * 因为在第 7 条那个 bug 里，这两者已经脱钩了：类型是"记录/视图"，
   * 而实际排法由表格自己的「多条记录排进同一张表」决定。只显示类型，
   * 用户就会继续以为"类型决定了打印成什么样" —— 那正是他踩的那个坑。
   */
  const mergedLoop = doc.bands.loop.elements.some((el) => el.kind === 'table' && el.rowsFromRecords === true)
  const kindChip = {
    kind: props.kind === 'record' ? '记录模板' : '视图模板',
    layout: mergedLoop ? '连续大表' : '一条一份',
    tip:
      (props.kind === 'record' ? '记录模板：默认一条记录一份文档' : '视图模板：默认多条记录排进同一张表') +
      (mergedLoop
        ? '；当前开启了「多条记录排进同一张表」，所有记录铺在一张表里'
        : '；当前是「一条一份」，每条记录单独渲染一份表格') +
      '。要改布局：选中那张表 → 右侧属性面板 → 表格 → 「连续打印」。',
  }

  // ---- 认出"当前最细的一层"。顺序即层级：节点 > 单元格 > 元素 > 默认 ----
  const scope: ToolScope = nodeTarget
    ? 'node'
    : selected
      ? selected.kind === 'table' && selectedCellId
        ? 'cell'
        : canStyleElement(selected)
          ? 'element'
          : 'none'
      : 'default'

  const cell = scope === 'cell' && selected?.kind === 'table' ? findCell(selected.rows, selectedCellId) : null

  // ---- 表格：当前选中的是不是一张表（工具条那一组据此启用/置灰） ----
  const table: TableElement | null = selected && selected.kind === 'table' ? selected : null
  const tableCols = table ? table.colWidthsMm.length : 0
  /** 选中的那一格在表里的位置 —— 合并 / 拆分都作用在它上面 */
  const cellLoc = table && selectedCellId ? findCell(table.rows, selectedCellId) : null
  /**
   * 右边 / 下边还有没有格子。
   *
   * 判据与动作层同一把尺子（`applyMergeRight/Down` 找不到邻居就返回 null）：
   * 界面这里是"提前置灰并说清"，动作层那边才是**权威**。
   * 只靠其中一边都不行 —— 只有置灰会被人绕过，只有 null 则是"点了没反应"。
   */
  const rightOk = !!(table && cellLoc && cellLoc.colIdx + 1 < (table.rows[cellLoc.rowIdx]?.cells.length ?? 0))
  const downOk = !!(table && cellLoc && table.rows[cellLoc.rowIdx + 1]?.cells[cellLoc.colIdx])
  const splitOk = !!(table && selectedCellId && canSplitCell(table, selectedCellId))

  const scopeText = ((): string => {
    if (scope === 'node' && nodeTarget) return nodeKindLabel(nodeTarget.node)
    if (scope === 'cell' && cell) return `单元格 ${cellLabel(cell)}`
    if (scope === 'cell') return '单元格'
    if (scope === 'element' && selected) return selected.kind === 'text' ? '整个文本元素' : '整个字段元素'
    // 窄侧栏里这句要跟 5 个控件挤一行，括号里的解释用 title 承载即可
    if (scope === 'default') return props.compact ? '默认样式' : '默认样式（只影响之后插入的元素）'
    // 「表格没有字体，字体在格子里」这件事**写在标签里**而不是另起一行说明。
    // 另起一行会让工具行的行数随选中对象变来变去，而工具行一变高，画布就会在
    // 用户按下的那一刻整体位移 —— 抬起时命中的已经是另一个元素了，单元格/占位符就点不中
    // （实测踩过：点字段占位符只会选中整张表）。布局稳定是这一类"点了没反应"的根治办法。
    return '整张表格 · 字体在格子里改'
  })()

  const style: TextStyle =
    scope === 'node'
      ? (nodeTarget ? nodeStyleOf(nodeTarget.node) : {})
      : scope === 'cell'
        ? (cell?.cell.style ?? {})
        : scope === 'element'
          ? (selected?.style ?? {})
          : defaultTextStyle

  const applyPatch = (p: TextStyle, key?: string): void => {
    if (scope === 'node') {
      props.onPatchNodeStyle(p, key)
      return
    }
    if (scope === 'cell' && selected?.kind === 'table' && cell) {
      const rows = updateCell(selected.rows, cell.cell.id, { style: { ...cell.cell.style, ...p } })
      props.onMerge(selected.id, { rows } as Partial<AnyElement>, key)
      return
    }
    if (scope === 'element' && selected) {
      props.onMerge(selected.id, { style: { ...style, ...p } } as Partial<AnyElement>, key)
      return
    }
    props.onDefaultTextStyle(p)
  }

  const disabled = scope === 'none'
  const sizeValue = finite(style.fontSizePt, finite(defaultTextStyle.fontSizePt, 10.5))

  const textTools = (
    <>
      <div className="bp-tools__group" role="group" aria-label="字形">
        <button
          type="button"
          className={`bp-tgl bp-tgl--bold${style.bold ? ' is-on' : ''}`}
          aria-label="加粗"
          aria-pressed={!!style.bold}
          disabled={disabled}
          title="加粗"
          onClick={() => applyPatch({ bold: style.bold ? undefined : true })}
        >
          B
        </button>
        <button
          type="button"
          className={`bp-tgl bp-tgl--italic${style.italic ? ' is-on' : ''}`}
          aria-label="斜体"
          aria-pressed={!!style.italic}
          disabled={disabled}
          title="斜体"
          onClick={() => applyPatch({ italic: style.italic ? undefined : true })}
        >
          I
        </button>
        <button
          type="button"
          className={`bp-tgl bp-tgl--under${style.underline ? ' is-on' : ''}`}
          aria-label="下划线"
          aria-pressed={!!style.underline}
          disabled={disabled}
          title="下划线"
          onClick={() => applyPatch({ underline: style.underline ? undefined : true })}
        >
          U
        </button>
        <button
          type="button"
          className={`bp-tgl bp-tgl--strike${style.strike ? ' is-on' : ''}`}
          aria-label="删除线"
          aria-pressed={!!style.strike}
          disabled={disabled}
          title="删除线"
          onClick={() => applyPatch({ strike: style.strike ? undefined : true })}
        >
          S
        </button>
      </div>

      <div className="bp-tools__group bp-tools__group--font">
        <CapsuleSelect
          value={style.fontFamily ?? defaultTextStyle.fontFamily ?? 'system'}
          options={FONT_OPTIONS}
          onChange={(v) => applyPatch({ fontFamily: v })}
          ariaLabel="顶栏字体"
        />
        <Num
          value={sizeValue}
          min={6}
          max={72}
          step={0.5}
          suffix="pt"
          ariaLabel="顶栏字号"
          onChange={(v) => applyPatch({ fontSizePt: v }, 'fs')}
        />
      </div>

      <div className="bp-tools__group bp-tools__group--align">
        <Seg
          value={(style.align ?? 'left') as Align}
          ariaLabel="顶栏对齐"
          disabled={disabled}
          onChange={(v) => applyPatch({ align: v })}
          options={[
            { value: 'left', label: '左', title: '左对齐' },
            { value: 'center', label: '中', title: '居中' },
            { value: 'right', label: '右', title: '右对齐' },
            { value: 'justify', label: '两端', title: '两端对齐' },
          ]}
        />
      </div>

      <div className="bp-tools__group bp-tools__group--color">
        <ColorInput
          value={style.color ?? '#1f2329'}
          swatches={TEXT_SWATCHES}
          ariaLabel="顶栏字色"
          onChange={(v) => applyPatch({ color: v })}
        />
      </div>
    </>
  )

  // ---- 表格动作：全部薄转发到 `./table-actions`（与右侧面板同一份） ----
  const addRow = (): void => {
    if (table) props.onMerge(table.id, addRowPatch(table).patch)
  }
  const delRow = (): void => {
    if (!table) return
    const r = delRowPatch(table)
    if (r) props.onMerge(table.id, r.patch)
  }
  const addCol = (): void => {
    if (!table) return
    const r = addColPatch(table)
    if (r) props.onMerge(table.id, r.patch)
  }
  const delCol = (): void => {
    if (!table) return
    const r = delColPatch(table)
    if (r) props.onMerge(table.id, r.patch)
  }
  const mergeRight = (): void => {
    if (table && cellLoc) props.onAskMerge(table.id, cellLoc.cell.id, 'right')
  }
  const mergeDown = (): void => {
    if (table && cellLoc) props.onAskMerge(table.id, cellLoc.cell.id, 'down')
  }
  const splitCell = (): void => {
    if (!table || !cellLoc) return
    const r = applySplitCell(table, cellLoc.cell.id)
    if (r) props.onMerge(table.id, r.patch)
  }

  const tableTools = table ? (
    <>
      <div className="bp-tools__group" role="group" aria-label="行列增删">
        <button type="button" className="bp-minibtn" aria-label="增加一行" title="在末尾加一行" onClick={addRow}>
          <IconPlus size={13} /> 行
        </button>
        <button
          type="button"
          className="bp-minibtn"
          aria-label="减少一行"
          title="删掉最后一行"
          disabled={table.rows.length <= 1}
          onClick={delRow}
        >
          <IconMinus size={13} /> 行
        </button>
        <button
          type="button"
          className="bp-minibtn"
          aria-label="增加一列"
          title={`在末尾加一列（上限 ${MAX_COLS} 列）`}
          disabled={tableCols >= MAX_COLS}
          onClick={addCol}
        >
          <IconPlus size={13} /> 列
        </button>
        <button
          type="button"
          className="bp-minibtn"
          aria-label="减少一列"
          title="删掉最后一列"
          disabled={tableCols <= 1}
          onClick={delCol}
        >
          <IconMinus size={13} /> 列
        </button>
      </div>

      <div className="bp-tools__group" role="group" aria-label="单元格合并拆分">
        <button
          type="button"
          className="bp-minibtn"
          aria-label="与右侧单元格合并"
          title={cellLoc ? '与右边那一格合并（会丢内容，先问你）' : '先在画布上点一下要合并的那一格'}
          disabled={!rightOk}
          onClick={mergeRight}
        >
          <IconMerge size={13} /> 右合并
        </button>
        <button
          type="button"
          className="bp-minibtn"
          aria-label="与下方单元格合并"
          title={cellLoc ? '与下面那一格合并（会丢内容，先问你）' : '先在画布上点一下要合并的那一格'}
          disabled={!downOk}
          onClick={mergeDown}
        >
          <IconMerge size={13} /> 下合并
        </button>
        <button
          type="button"
          className="bp-minibtn"
          aria-label="拆分单元格"
          title={splitOk ? '拆回合并前的格子（补回来的是空格，原内容回不来）' : '这一格没有跨行跨列，不用拆'}
          disabled={!splitOk}
          onClick={splitCell}
        >
          <IconSplit size={13} /> 拆分
        </button>
      </div>

      <div className="bp-tools__group bp-tools__group--align" role="group" aria-label="框线">
        <Seg
          value={table.border.mode}
          ariaLabel="框线"
          onChange={(mode) => props.onMerge(table.id, { border: { ...table.border, mode } } as Partial<AnyElement>)}
          options={[
            { value: 'all', label: '全框', title: '每格都有框线' },
            { value: 'outer', label: '外框', title: '只有最外面一圈' },
            { value: 'horizontal', label: '横线', title: '只有横向的分隔线（适合长表格）' },
            { value: 'none', label: '无线', title: '不打印任何框线' },
          ]}
        />
      </div>

      <p className="bp-hint">
        {cellLoc
          ? `合并 / 拆分作用在 ${cellLabel(cellLoc)}；合并会丢内容，点下去会先问你一次。`
          : '在画布上点一下某一格，合并与拆分才会亮起来。'}
      </p>
    </>
  ) : null

  return (
    <div className="bp-tools" data-tools={props.compact ? 'compact' : 'full'}>
      {/* ---- 左：作用对象 + 文本编辑 ---- */}
      <div
        className="bp-tools__scope"
        title={
          scope === 'none'
            ? '工具栏改的是这个对象。表格自己没有字体：点一下某一格，或直接点格子里那个字段占位符'
            : '工具栏改的是这个对象；点画布上的字段占位符可以改得更细'
        }
      >
        <span className="bp-tools__scope-dot" aria-hidden />
        <span className="bp-tools__scope-text">改：{scopeText}</span>
        {scope === 'node' ? (
          <button
            type="button"
            className="bp-tools__scope-back"
            aria-label="退回上一层"
            title="回到上一层（改整个元素 / 整格）"
            onClick={props.onClearNode}
          >
            上一层
          </button>
        ) : null}
      </div>

      {props.compact ? (
        <Popover
          role="dialog"
          ariaLabel="文字"
          width={252}
          renderTrigger={({ open, toggle, buttonRef }) => (
            <button
              ref={buttonRef}
              type="button"
              className={`bp-btn bp-btn--sm${open ? ' is-on' : ''}`}
              aria-label="文字设置"
              aria-haspopup="dialog"
              aria-expanded={open}
              disabled={disabled}
              title="字体 / 字号 / 字形 / 对齐 / 颜色"
              onClick={toggle}
            >
              文字
              <span className={`bp-tools__caret${open ? ' is-open' : ''}`}>
                <IconCaret size={11} />
              </span>
            </button>
          )}
        >
          {() => <div className="bp-tools__pop bp-tools__pop--text">{textTools}</div>}
        </Popover>
      ) : (
        textTools
      )}

      {/*
        ---- 表格 ----

        **常驻**一个入口（不管有没有选中表格都在这一行上），选中表格才可用。
        位置放在文本工具右边：两者都是"改当前选中对象"的工具，撤销/重做在最右。

        为什么是"一个入口 + 弹层"而不是摊成一排图标：这一行是 `flex-wrap: wrap` 的，
        摊开约 250px 会在 900px 宽的容器上把整行挤成两行 —— 工具行一变高，画布就整体下移，
        用户按下的那一刻命中的已经是另一个元素（这个坑本文件开头记过一次）。
        收成一个**定宽**按钮，行高与行宽都不随选中状态变，也就不可能引起位移。

        未选中表格时置灰，并把原因写在 title 里：静默禁用（或干脆藏起来）会让用户
        以为这个功能不存在。
      */}
      <Popover
        role="dialog"
        ariaLabel="表格"
        width={264}
        renderTrigger={({ open, toggle, buttonRef }) => (
          <button
            ref={buttonRef}
            type="button"
            className={`bp-btn bp-btn--sm bp-tools__table${open ? ' is-on' : ''}`}
            aria-label={
              table
                ? `表格工具：当前 ${table.rows.length} 行 × ${tableCols} 列`
                : '表格工具：未选中表格'
            }
            aria-haspopup="dialog"
            aria-expanded={open}
            disabled={!table}
            title={
              table
                ? '表格工具：行列增删、合并拆分、框线'
                : '先选中一张表格：点画布上任意一张表，或点它的某一格'
            }
            onClick={toggle}
          >
            <IconTable size={14} /> 表格
            {table ? (
              <span className="bp-tools__dim" aria-hidden>
                {table.rows.length}×{tableCols}
              </span>
            ) : null}
          </button>
        )}
      >
        {() => <div className="bp-tools__pop bp-tools__pop--table">{tableTools}</div>}
      </Popover>

      <div className="bp-top__spacer" />

      {/* ---- 当前模式胶囊（第 9 条）：模板类型 · 数据布局 ---- */}
      <span className="bp-kindchip" title={kindChip.tip}>
        <span className="bp-kindchip__k">{kindChip.kind}</span>
        <span className="bp-kindchip__dot" aria-hidden>
          ·
        </span>
        <span className="bp-kindchip__v">{kindChip.layout}</span>
      </span>

      {/* ---- 右：纸张 / 方向 / 页面设置 / 预览 ---- */}
      <div className="bp-tools__group bp-tools__group--paper">
        <CapsuleSelect
          value={ps.paper}
          options={PAPER_OPTIONS}
          onChange={(paper) => {
            if (paper === 'custom') {
              props.onPageSetup({ paper })
              return
            }
            const mm = PAPER_MM[paper]
            props.onPageSetup({ paper, widthMm: mm.w, heightMm: mm.h })
          }}
          ariaLabel="纸张"
        />
        <button
          type="button"
          className="bp-btn bp-btn--sm bp-tools__orient"
          aria-label={`纸张方向：当前${ps.orientation === 'portrait' ? '纵向' : '横向'}，点击切换`}
          aria-pressed={ps.orientation === 'landscape'}
          title="横向 / 纵向切换（画布纸张会跟着转）"
          onClick={() => props.onPageSetup({ orientation: ps.orientation === 'portrait' ? 'landscape' : 'portrait' })}
        >
          {ps.orientation === 'portrait' ? '纵向' : '横向'}
          <span className="bp-tools__dim" aria-hidden>
            {Math.round(render.w)}×{Math.round(render.h)}
          </span>
        </button>

        <Popover
          role="dialog"
          ariaLabel="页面设置"
          width={300}
          renderTrigger={({ open, toggle, buttonRef }) => (
            <button
              ref={buttonRef}
              type="button"
              className={`bp-iconbtn bp-iconbtn--toggle${open ? ' is-on' : ''}`}
              aria-label="页面设置"
              aria-haspopup="dialog"
              aria-expanded={open}
              title="页面设置：纸张、页边距、网格吸附"
              onClick={toggle}
            >
              <IconSliders size={15} />
            </button>
          )}
        >
          {() => <div className="bp-tools__pop bp-tools__pop--page">{props.pageSettings}</div>}
        </Popover>

        <button
          type="button"
          className="bp-btn bp-btn--sm bp-tools__preview"
          aria-label="预览打印效果"
          title="就在这个页面看打印出来的样子（走的是和第三步预览同一套排版管线）"
          onClick={props.onPreview}
        >
          <IconEye size={14} /> 预览
        </button>
        {/*
          宽屏下这句读数在副行里已经有了一份，这里就不再重复；
          中屏/窄屏的副行要留给页签与缩放，读数挪到这一行的尾巴上 —— 任何宽度下都恰好有一份。
        */}
        {props.compact ? <span className="bp-top__meta bp-tools__meta">{props.contentLabel}</span> : null}
      </div>

      {/*
        ---- 最右：撤销 / 重做 ----
        用户给的参照是官方那套工具条的排法（左边文本编辑、右边纸张与页面、最右撤销/重做）：
        "改完随手一个撤销"应当就在刚动过的那几个控件的右手边，而不是跑到上面那一行去找。
        flex:none 是必须的：它在窄侧栏里不能被压扁（压扁后 26px 的按钮会缩成一条线，点不到）。
      */}
      <div className="bp-tools__group bp-tools__group--history">
        <button
          type="button"
          className="bp-iconbtn bp-iconbtn--sm"
          aria-label="撤销"
          title="撤销 (Ctrl/Cmd+Z)"
          disabled={!props.canUndo}
          onClick={props.onUndo}
        >
          <IconUndo size={15} />
        </button>
        <button
          type="button"
          className="bp-iconbtn bp-iconbtn--sm"
          aria-label="重做"
          title="重做 (Ctrl/Cmd+Shift+Z)"
          disabled={!props.canRedo}
          onClick={props.onRedo}
        >
          <IconRedo size={15} />
        </button>
      </div>
    </div>
  )
}
