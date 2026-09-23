/**
 * 弹出层基元。
 *
 * 严格按 PRD F7-04 实现：
 * - `position: fixed` + 视口收边 `min(max(center, half+8), vw-half-8)`
 * - 最外层包裹元素必须是**不透明**背景（var(--surface)）+ 边框 + 阴影 + z-index ≥ 200。
 *   侧边栏里底下的画布文字会穿透半透明层，看不清内容（这是被明确点名的设计事故）。
 *
 * 为什么用 portal 挂到 body：编辑器的抽屉带有 transform 进场动画，
 * 而 transform 会让 `position: fixed` 退化成相对该祖先定位 —— 坐标会整体偏掉。
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'

/** getBoundingClientRect 的结果在无头/未布局环境下可能是 NaN，写进 style 前必须兜底 */
function safe(n: number, fallback: number): number {
  return Number.isFinite(n) ? n : fallback
}

const EDGE = 8

/**
 * 当前**所有**已打开的弹出层面板（含嵌套的那些）。
 *
 * 为什么需要这个集合：面板是 `createPortal` 挂到 `document.body` 的，
 * 所以**嵌套弹层在 DOM 上是兄弟节点，不是子节点** —— 内层的面板**不在**外层面板的
 * `panelRef.current` 里。于是外层那句"点在面板外就关"会把内层选项误判成"外面"：
 *
 *   `pointerdown`（捕获阶段）→ 外层 `setOpen(false)` → 内层面板被卸载
 *   → 内层那个按钮的 `click` **永远不会触发** → `onChange` 根本没跑。
 *
 * 真机症状（2026-09-18 用户反馈）：
 *   "点击页面设置，选择切换网格大小，选择任意选项，**页面设置界面自己关闭，更改不会生效**，
 *    页面设置的其他功能暂时正常。"
 *   —— "其他功能正常"正是因为它们不是嵌套弹层（是面板内的普通控件，`contains` 判定为真）。
 *
 * ⇒ 判定改成"点在任何一层已打开的面板里都不算外面"。**一处修全部嵌套弹层。**
 */
const OPEN_PANELS = new Set<HTMLElement>()

export interface PopoverTriggerArgs {
  open: boolean
  toggle: () => void
  buttonRef: RefObject<HTMLButtonElement>
}

export interface PopoverProps {
  renderTrigger: (args: PopoverTriggerArgs) => ReactNode
  children: (args: { close: () => void }) => ReactNode
  /** 面板期望宽度（px）；窄屏时自动收窄到 vw-16 */
  width?: number
  /** 面板对齐到触发器宽度（用于"胶囊即按钮"的菜单） */
  matchTriggerWidth?: boolean
  className?: string
  /** 面板 role，默认 dialog；传 'listbox' 时配合 role="option" 使用 */
  role?: 'dialog' | 'listbox' | 'menu'
  ariaLabel?: string
}

export function Popover({
  renderTrigger,
  children,
  width = 260,
  matchTriggerWidth = false,
  className,
  role = 'dialog',
  ariaLabel,
}: PopoverProps) {
  const [open, setOpen] = useState(false)
  const [style, setStyle] = useState<{ left: number; top: number; width: number } | null>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)

  const close = useCallback(() => setOpen(false), [])

  const place = useCallback(() => {
    const btn = buttonRef.current
    if (!btn) return
    const r = btn.getBoundingClientRect()
    const vw = window.innerWidth || 360
    const vh = window.innerHeight || 640

    const maxW = Math.max(120, vw - EDGE * 2)
    const wantW = matchTriggerWidth ? safe(r.width, width) : width
    const w = Math.min(Math.max(wantW, 120), maxW)
    const half = w / 2

    // 视口收边：先把面板中心夹到合法区间，再据中心反推 left
    const centerX = safe(r.left + r.width / 2, vw / 2)
    const center = Math.min(Math.max(centerX, half + EDGE), vw - half - EDGE)
    const left = safe(center - half, EDGE)

    const panelH = panelRef.current?.offsetHeight ?? 220
    let top = safe(r.bottom + 6, EDGE)
    if (top + panelH > vh - EDGE) {
      const above = safe(r.top - panelH - 6, EDGE)
      top = above >= EDGE ? above : Math.max(EDGE, vh - panelH - EDGE)
    }

    setStyle({ left, top, width: w })
  }, [matchTriggerWidth, width])

  useLayoutEffect(() => {
    if (!open) {
      setStyle(null)
      return
    }
    place()
    // 面板挂载后再量一次真实高度，修正"上方/下方"的选择
    const raf = requestAnimationFrame(place)
    return () => cancelAnimationFrame(raf)
  }, [open, place])

  useEffect(() => {
    if (!open) return
    const onScroll = (): void => place()
    const panel = panelRef.current
    // 登记自己，让**外层**的"点外面就关"知道内层也是自己人（见 OPEN_PANELS 的注释）
    if (panel) OPEN_PANELS.add(panel)
    const onDown = (e: PointerEvent): void => {
      const t = e.target as Node | null
      if (!t) return
      // 点在自己身上（触发器或面板）→ 不关
      if (panelRef.current?.contains(t) || buttonRef.current?.contains(t)) return
      // 点在**任意一层**已打开的面板里（典型是嵌套的子菜单）→ 也不关：
      // 那些面板是 body 下的兄弟节点，绝不能被本层当成"外面"
      for (const p of OPEN_PANELS) if (p.contains(t)) return
      setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        setOpen(false)
      }
    }
    window.addEventListener('resize', onScroll)
    window.addEventListener('scroll', onScroll, true)
    document.addEventListener('pointerdown', onDown, true)
    document.addEventListener('keydown', onKey, true)
    return () => {
      if (panel) OPEN_PANELS.delete(panel)
      window.removeEventListener('resize', onScroll)
      window.removeEventListener('scroll', onScroll, true)
      document.removeEventListener('pointerdown', onDown, true)
      document.removeEventListener('keydown', onKey, true)
    }
  }, [open, place])

  return (
    <>
      {renderTrigger({ open, toggle: () => setOpen((v) => !v), buttonRef })}
      {open
        ? createPortal(
            <div
              ref={panelRef}
              role={role}
              aria-label={ariaLabel}
              className={['bp-popover', className].filter(Boolean).join(' ')}
              style={{
                left: style ? style.left : 0,
                top: style ? style.top : 0,
                width: style ? style.width : width,
                // 定位算完之前先隐藏，避免"先闪在左上角再跳到目标位"
                visibility: style ? 'visible' : 'hidden',
              }}
            >
              {children({ close })}
            </div>,
            document.body,
          )
        : null}
    </>
  )
}
