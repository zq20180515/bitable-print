/**
 * 「拆分单元格」的输入弹层（2026-09-23 真机反馈第 7 条）。
 *
 * 用户原话：「改为拆分单元格（点击后被选中的单元格会被拆分，**会出现弹窗，提示输入几行几列**）」。
 *
 * 三条设计约定：
 *  ① **上下限来自目标格自己**（`minRows`/`minCols` = 它当前占的行列数）：比它小没有意义
 *     ——"1 行的格子拆成 1 行"什么都没发生。下限直接摆进输入框的 `min`，用户不用先试一次才知道。
 *  ② **被拒的原因由动作层给**（`error`），弹层只负责显示。护栏（"这块区域里有别的合并格"、
 *     "「XX」里有内容"）都在 `splitCellToGrid` 里，这里不重写一份判据 ——
 *     两处各判一次，迟早会出现"弹层说能拆、点了拆不了"。
 *  ③ **不关弹层**：被拒时留在原地并把原因显示出来，用户改个数字就能重试；
 *     关掉再让他重新点开、重新输，是把一次纠正变成三次操作。
 *
 * 视觉沿用 `MergeConfirmDialog` 的同一套类名（`bp-confirm-backdrop` / `bp-merge-confirm`），
 * 保证"确认层长得都一样"。
 */

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { MAX_COLS, MAX_SPLIT_ROWS } from './table-actions'

export interface SplitCellDialogProps {
  /** 目标格当前占的行列数 —— 也就是输入的下限 */
  minRows: number
  minCols: number
  /** 上一次尝试被拒的原因（动作层的原话）；没有就是 null */
  error?: string | null
  onConfirm(rows: number, cols: number): void
  onCancel(): void
}

export function SplitCellDialog({
  minRows,
  minCols,
  error,
  onConfirm,
  onCancel,
}: SplitCellDialogProps): ReactNode {
  /* 默认值取 2：拆成"一格变两格"是最常见的意图；下限比 2 大的（合并格）就取下限 */
  const [rows, setRows] = useState(() => String(Math.max(minRows, 2)))
  const [cols, setCols] = useState(() => String(Math.max(minCols, 2)))

  const cancelRef = useRef(onCancel)
  cancelRef.current = onCancel
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      // 与 Popover / MergeConfirm 同一口径：捕获阶段 stopPropagation，否则编辑器的 Esc（取消选中）会一起触发
      e.stopPropagation()
      cancelRef.current()
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [])

  const num = (v: string, lo: number, hi: number): number => {
    const n = Math.floor(Number(v))
    if (!Number.isFinite(n)) return lo
    return Math.min(Math.max(n, lo), hi)
  }

  const field = (label: string, value: string, set: (v: string) => void, lo: number, hi: number): ReactNode => (
    <div className="bp-tsp__row">
      <span className="bp-tsp__label">{label}</span>
      <div className="bp-tsp__ctrl">
        <button
          type="button"
          className="bp-tsp__btn"
          aria-label={`减少${label}`}
          disabled={num(value, lo, hi) <= lo}
          onClick={() => set(String(num(value, lo, hi) - 1))}
        >
          −
        </button>
        <input
          className="bp-splitcell__input"
          type="text"
          inputMode="numeric"
          role="spinbutton"
          aria-label={`拆分后的${label}数`}
          aria-valuemin={lo}
          aria-valuemax={hi}
          aria-valuenow={num(value, lo, hi)}
          value={value}
          onChange={(e) => set(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              onConfirm(num(rows, minRows, MAX_SPLIT_ROWS), num(cols, minCols, MAX_COLS))
            }
          }}
        />
        <button
          type="button"
          className="bp-tsp__btn"
          aria-label={`增加${label}`}
          disabled={num(value, lo, hi) >= hi}
          onClick={() => set(String(num(value, lo, hi) + 1))}
        >
          +
        </button>
      </div>
    </div>
  )

  return createPortal(
    <div
      className="bp-confirm-backdrop"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onCancel()
      }}
    >
      <div className="bp-merge-confirm" role="dialog" aria-modal="true" aria-label="拆分单元格">
        <p className="bp-merge-confirm__title">拆分单元格</p>
        <p className="bp-merge-confirm__text">把选中的这一格拆成几行几列？</p>
        {field('行', rows, setRows, minRows, MAX_SPLIT_ROWS)}
        {field('列', cols, setCols, minCols, MAX_COLS)}
        {error ? (
          <p className="bp-alert bp-alert--warn bp-splitcell__err" role="alert">
            {error}
          </p>
        ) : null}
        <div className="bp-btnrow bp-merge-confirm__btns">
          <button type="button" className="bp-btn" aria-label="取消拆分" onClick={onCancel}>
            取消
          </button>
          <button
            type="button"
            className="bp-btn bp-btn--primary"
            aria-label="确认拆分"
            onClick={() => onConfirm(num(rows, minRows, MAX_SPLIT_ROWS), num(cols, minCols, MAX_COLS))}
          >
            拆分
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
