/**
 * 「表格尺寸」浮层（2026-09-22，用户规格 一）。
 *
 * 规格原文："添加表格时弹出默认行列数选择（**默认 3 行 × 4 列**），
 * 或支持在画布上按住拖出矩形后按矩形宽高自动换算行列数。"
 *
 * ── 为什么是"插进去之后再选"而不是"插之前先问" ──────────────────────
 * 面板里的「表格」是一个**拖拽**入口：用户按住它拖到画布上松手才有落点。
 * 先弹一个"几行几列"的对话框再让他拖，等于把一次手势拆成两段，而且对话框里没有位置信息。
 * ⇒ 按默认 3×4 **先落位**（用户松手就看到结果），紧接着浮出这个小面板让他**微调**。
 * 不想要调整直接点「完成」或点画布别处即可 —— 默认值本身已经是规格要的那个。
 *
 * ⚠️ 每一步都**立即生效**（点一下加号，表格当场多一行），不做"确定/取消"的暂存态：
 *    暂存态意味着两份额外的状态要同步，而这里的操作全都可撤销（走 `commit`）。
 */
import type { ReactNode } from 'react'

export interface TableSizePanelProps {
  /** 当前（已生效的）行列数 —— 由调用方从**文档**里读，不在这儿维护第二份 */
  rows: number
  cols: number
  /** 首行是不是标题行（读 `rows[0].isHeader`） */
  headerRow: boolean
  /** 首列是不是标题列（读第一列的**样式**，见 table-actions 的 isFirstColHeaderStyled） */
  headerCol: boolean
  /** 浮层落点（相对画布容器，px） */
  style: { left: number; top: number }
  /** 行/列数变化即刻生效 */
  onResize(rows: number, cols: number): void
  /** 「设置标题行」切换 */
  onHeaderRowChange(on: boolean): void
  /** 「设置标题列」切换 */
  onHeaderColChange(on: boolean): void
  onClose(): void
}

const MAX_ROWS = 50
const MAX_COLS = 12

export function TableSizePanel({
  rows,
  cols,
  headerRow,
  headerCol,
  style,
  onResize,
  onHeaderRowChange,
  onHeaderColChange,
  onClose,
}: TableSizePanelProps): ReactNode {
  /** 小步进器：‑ 数字 + 各一个按钮。上下限与动作层保持一致（1..50 / 1..12） */
  const stepper = (key: string, label: string, value: number, max: number, apply: (v: number) => void): ReactNode => (
    <div className="bp-tsp__row" key={key}>
      <span className="bp-tsp__label">{label}</span>
      <div className="bp-tsp__ctrl">
        <button
          type="button"
          className="bp-tsp__btn"
          aria-label={`减少${label}`}
          disabled={value <= 1}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => apply(value - 1)}
        >
          −
        </button>
        <span className="bp-tsp__val" aria-live="polite">
          {value}
        </span>
        <button
          type="button"
          className="bp-tsp__btn"
          aria-label={`增加${label}`}
          disabled={value >= max}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => apply(value + 1)}
        >
          +
        </button>
      </div>
    </div>
  )

  return (
    <div className="bp-tsp" style={style} role="group" aria-label="表格尺寸" onPointerDown={(e) => e.stopPropagation()}>
      <div className="bp-tsp__head">
        <span className="bp-tsp__title">表格尺寸</span>
        <button type="button" className="bp-tsp__close" aria-label="完成" onClick={onClose}>
          ×
        </button>
      </div>
      {stepper('rows', '行', rows, MAX_ROWS, (v) => onResize(v, cols))}
      {stepper('cols', '列', cols, MAX_COLS, (v) => onResize(rows, v))}
      {/*
        两个开关（真机反馈 2026-09-23 第 9 条）：「把这个开关拆分为两个：设置标题行、设置标题列，
        默认勾选设置标题行」。

        原来只有一个「首行作为表头（跨页重复）」，而且它的 `onChange` **把 newValue 丢掉了**
        （调用方只拿行列数又调了一次 resize）—— 也就是那个复选框本来就是死的。
        文案里的"跨页重复"是**行的行为**，列没有这回事，所以原来也没法表达"标题列"。
      */}
      <label className="bp-tsp__check">
        <input type="checkbox" checked={headerRow} onChange={(e) => onHeaderRowChange(e.target.checked)} />
        <span>设置标题行</span>
      </label>
      <label className="bp-tsp__check">
        <input type="checkbox" checked={headerCol} onChange={(e) => onHeaderColChange(e.target.checked)} />
        <span>设置标题列</span>
      </label>
      <p className="bp-tsp__foot">标题行 / 标题列里不放字段。改动立即生效，可用 Ctrl+Z 撤销。</p>
    </div>
  )
}
