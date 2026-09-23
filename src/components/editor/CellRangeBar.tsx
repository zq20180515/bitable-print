/**
 * 表格**矩形选区**的浮动工具条（2026-09-22，用户规格 四·核心）。
 *
 * 用户原话："选区 ≥ 2 个单元格时，选区上方浮出一个浮动工具条（**不遮挡选区，自动避让边缘**），
 * 工具条包含：合并单元格 / 拆分单元格、文字对齐（左中右、上中下）、文字加粗、文字颜色、
 * 单元格底纹色、插入行 / 插入列 / 删除行 / 删除列、设为标题行"。
 *
 * ── 为什么单独一个组件 ──────────────────────────────────────────
 * 与 `TableAfford` 同理：它是**纯展示 + 纯回调**（不知道表格怎么改、不知道选中怎么来），
 * 而 `Canvas.tsx` 已经很长。放这里之后，"工具条上有哪些动作"一眼能看全。
 *
 * ── 两条约束 ────────────────────────────────────────────────────
 *   ① **不遮住选区**：工具条浮在选区**上方**（`top: -h`）；上方空间不够时翻到下方
 *      （`flip` 由调用方按几何算好传进来，这里不猜）。
 *   ② 尺寸乘 `--bp-inv`（画布整体有 transform: scale）—— 否则 50% 缩放下按钮点不着。
 */
import type { ReactNode } from 'react'

/** 工具条能发出的动作。**语义**在这里定义，具体怎么落库由调用方决定 */
export type RangeOp =
  | { kind: 'merge' }
  | { kind: 'split' }
  | { kind: 'bold'; on: boolean }
  | { kind: 'align'; h?: 'left' | 'center' | 'right'; v?: 'top' | 'middle' | 'bottom' }
  | { kind: 'fill'; color: string | undefined }
  /** 单边边框：规格 八「任意单元格的上 / 下 / 左 / 右单条边显隐」 */
  | { kind: 'border'; edge: 'top' | 'right' | 'bottom' | 'left'; on: boolean }
  /** 清掉这一区的边框覆盖 ⇒ 回到「跟随整表」 */
  | { kind: 'borderFollow' }
  /** 边框粗细（pt）与颜色 —— 规格 八：「边框粗细与颜色」 */
  | { kind: 'borderWidth'; pt: number }
  | { kind: 'borderColor'; color: string | undefined }
  /** 标题列（规格 五）：只套样式 —— 列没有「跨页重复」这回事，所以不带标记位 */
  | { kind: 'headerCol'; on: boolean }
  /** 文字颜色（规格 四） */
  | { kind: 'color'; color: string | undefined }
  | { kind: 'header'; on: boolean }
  | { kind: 'insertRow' }
  | { kind: 'deleteRow' }
  | { kind: 'insertCol' }
  | { kind: 'deleteCol' }

export interface CellRangeBarProps {
  /** 选区涵盖的格数（用来决定"合并"能不能点） */
  cellCount: number
  /** 选区里是否有跨行/跨列的合并格（决定"拆分"能不能点） */
  canSplit: boolean
  /** 当前选区是否已经是表头行（按钮显示"取消表头行"） */
  allHeader: boolean
  /** 表格只剩一行 / 一列时对应按钮置灰 */
  canDeleteRow: boolean
  canDeleteCol: boolean
  /** 浮层落点（相对画布容器的 px）与是否翻到选区下方 */
  style: { left: number; top: number }
  onOp(op: RangeOp): void
  /** 关闭（Esc 或点击空白） */
  onClose(): void
}

/** 边框粗细档位（pt）。规格没定档，这里给的是 Word 里最常用的那几个 */
const BORDER_WIDTHS = [0.25, 0.5, 0.75, 1, 1.5, 2]

/** 文字颜色（规格 四）：与边框色共用同一套墨色，**内容色**，不跟 UI 主题翻 */
const TEXT_COLORS: { label: string; value: string | undefined }[] = [
  { label: '默认', value: undefined },
  { label: '黑', value: '#1f2329' },
  { label: '灰', value: '#8f959e' },
  { label: '深蓝', value: '#1f4e79' },
  { label: '红', value: '#c1352b' },
]

/** 边框颜色：几个常用墨色 + 「默认」（回到整表线色）。同样是**内容色**，不跟主题翻 */
const BORDER_COLORS: { label: string; value: string | undefined }[] = [
  { label: '默认', value: undefined },
  { label: '黑', value: '#1f2329' },
  { label: '灰', value: '#8f959e' },
  { label: '深蓝', value: '#1f4e79' },
  { label: '红', value: '#c1352b' },
]

/** 底纹备选色。用固定的淡色系：它们是**内容色**（会被打印），不跟 UI 主题翻 */
const FILLS: { label: string; value: string | undefined }[] = [
  { label: '无底色', value: undefined },
  { label: '浅灰', value: '#f2f3f5' },
  { label: '浅蓝', value: '#e8f1fd' },
  { label: '浅黄', value: '#fdf6e3' },
  { label: '浅绿', value: '#eaf6ec' },
]

export function CellRangeBar({
  cellCount,
  canSplit,
  allHeader,
  canDeleteRow,
  canDeleteCol,
  style,
  onOp,
  onClose,
}: CellRangeBarProps): ReactNode {
  /** 小按钮的统一工厂：省掉 14 处重复的 className/type */
  const btn = (key: string, label: string, title: string, onClick: () => void, disabled = false, extra = ''): ReactNode => (
    <button
      key={key}
      type="button"
      className={`bp-rbar__btn${extra}`}
      title={title}
      aria-label={title}
      disabled={disabled}
      /* 不冒泡：工具条浮在画布上，冒泡下去会触发"拖动整个表格" */
      onPointerDown={(e) => e.stopPropagation()}
      onClick={onClick}
    >
      {label}
    </button>
  )

  return (
    <div className="bp-rbar" style={style} role="toolbar" aria-label="单元格选区操作" onPointerDown={(e) => e.stopPropagation()}>
      {btn('merge', '合并', `把选中的 ${cellCount} 格合并成一格`, () => onOp({ kind: 'merge' }), cellCount < 2)}
      {btn('split', '拆分', '把这个合并格拆回原来的行列结构', () => onOp({ kind: 'split' }), !canSplit)}
      <span className="bp-rbar__sep" aria-hidden />

      {btn('al', '左', '水平对齐：左', () => onOp({ kind: 'align', h: 'left' }), false, ' is-icon')}
      {btn('ac', '中', '水平对齐：居中', () => onOp({ kind: 'align', h: 'center' }), false, ' is-icon')}
      {btn('ar', '右', '水平对齐：右', () => onOp({ kind: 'align', h: 'right' }), false, ' is-icon')}
      <span className="bp-rbar__sep" aria-hidden />
      {btn('vt', '上', '垂直对齐：上', () => onOp({ kind: 'align', v: 'top' }), false, ' is-icon')}
      {btn('vm', '中', '垂直对齐：居中', () => onOp({ kind: 'align', v: 'middle' }), false, ' is-icon')}
      {btn('vb', '下', '垂直对齐：下', () => onOp({ kind: 'align', v: 'bottom' }), false, ' is-icon')}
      <span className="bp-rbar__sep" aria-hidden />

      {/*
        文字颜色（规格 四）。
        ⚠️ 色块里画的是一个 **A 字**并按该颜色上色（而不是像底纹那样把块本身填色）——
           底纹色块是「填块」、文字色块是「描字」，在同一排里一眼就能分开，不用读 tooltip。
      */}
      <span className="bp-rbar__fills" role="group" aria-label="文字颜色">
        {TEXT_COLORS.map((c) => (
          <button
            key={c.label}
            type="button"
            className="bp-rbar__fill bp-rbar__fill--text"
            title={`文字颜色：${c.label}`}
            aria-label={`文字颜色：${c.label}`}
            style={{ color: c.value ?? 'inherit' }}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => onOp({ kind: 'color', color: c.value })}
          >
            A
          </button>
        ))}
      </span>
      <span className="bp-rbar__sep" aria-hidden />

      {btn('bold', 'B', '加粗', () => onOp({ kind: 'bold', on: true }), false, ' is-bold')}
      {btn('unbold', 'B̶', '取消加粗', () => onOp({ kind: 'bold', on: false }), false, ' is-bold is-plain')}
      {btn('header', allHeader ? '取消表头' : '表头行', '整行加粗居中加底纹；打印时跨页重复', () =>
        onOp({ kind: 'header', on: !allHeader }),
      )}
      <span className="bp-rbar__sep" aria-hidden />

      {/* 底纹：一行备选色，点一下就换（不做取色器 —— 这里是模板，不是设计工具） */}
      <span className="bp-rbar__fills" role="group" aria-label="单元格底纹">
        {FILLS.map((f) => (
          <button
            key={f.label}
            type="button"
            className="bp-rbar__fill"
            title={`底纹：${f.label}`}
            aria-label={`底纹：${f.label}`}
            style={f.value ? { background: f.value } : undefined}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => onOp({ kind: 'fill', color: f.value })}
          >
            {f.value ? '' : '无'}
          </button>
        ))}
      </span>
      <span className="bp-rbar__sep" aria-hidden />

      {/*
        单边边框（规格 八）：四条边各一个开关。语义是**覆盖**整表设置。
        三态（跟随 / 强制画 / 强制不画）落在 UI 上只有两个按钮：
          加边线 → `{edge:true}`；去边线 → `{edge:false}`；跟随整表 → 清掉覆盖。
      */}
      {(['top', 'right', 'bottom', 'left'] as const).map((edge) =>
        btn(
          `bd-${edge}`,
          { top: '上边线', right: '右边线', bottom: '下边线', left: '左边线' }[edge],
          `给选区加${edge === 'top' ? '上' : edge === 'right' ? '右' : edge === 'bottom' ? '下' : '左'}边线`,
          () => onOp({ kind: 'border', edge, on: true }),
          false,
          ' is-plain',
        ),
      )}
      {btn('bd-off', '去边线', '去掉选区这四条边线', () => onOp({ kind: 'border', edge: 'top', on: false }), false, ' is-plain')}
      {btn('bd-follow', '跟随整表', '清掉这一区的边框覆盖，回到跟随整表设置', () => onOp({ kind: 'borderFollow' }), false, ' is-plain')}
      {/*
        边框粗细与颜色（规格 八）。
        粗细用 select 而不是滑杆：可选的档就是这几个（0.25~2pt），滑杆会给出 0.733pt 这种没意义的中间值。
        颜色给几个常用色块 + 「默认」——这里不做取色器：模板的线色基本就是黑/灰。
      */}
      <select
        className="bp-rbar__select"
        aria-label="边框粗细"
        defaultValue=""
        onPointerDown={(e) => e.stopPropagation()}
        onChange={(e) => {
          const v = Number(e.target.value)
          if (Number.isFinite(v) && v > 0) onOp({ kind: 'borderWidth', pt: v })
          e.target.value = ''
        }}
      >
        <option value="">粗细</option>
        {BORDER_WIDTHS.map((w) => (
          <option key={w} value={w}>
            {w}pt
          </option>
        ))}
      </select>
      <span className="bp-rbar__fills" role="group" aria-label="边框颜色">
        {BORDER_COLORS.map((c) => (
          <button
            key={c.label}
            type="button"
            className="bp-rbar__fill"
            title={`边框颜色：${c.label}`}
            aria-label={`边框颜色：${c.label}`}
            style={c.value ? { background: c.value } : undefined}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => onOp({ kind: 'borderColor', color: c.value })}
          >
            {c.value ? '' : '默认'}
          </button>
        ))}
      </span>
      <span className="bp-rbar__sep" aria-hidden />

      {btn('ir', '+行', '在选区下方插入一行', () => onOp({ kind: 'insertRow' }))}
      {btn('ic', '+列', '在选区右侧插入一列', () => onOp({ kind: 'insertCol' }))}
      {btn('dr', '−行', '删除选区覆盖的行', () => onOp({ kind: 'deleteRow' }), !canDeleteRow, ' is-danger')}
      {btn('dc', '−列', '删除选区覆盖的列', () => onOp({ kind: 'deleteCol' }), !canDeleteCol, ' is-danger')}
      {btn('close', '×', '取消选中（Esc）', onClose, false, ' is-close')}
    </div>
  )
}
