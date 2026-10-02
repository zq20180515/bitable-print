/**
 * 画布右键菜单（2026-09-22）。
 *
 * ── 为什么要有它 ────────────────────────────────────────────────
 * 用户原话："**右键菜单：全屏画布增加右键菜单**，现在按右键弹出的是飞书的兜底宿主菜单，
 * 只有个重新加载，**需要依据元素类型，智能弹出右键菜单**。"
 *
 * 所以这个组件的职责有两个，缺一不可：
 *   ① **接管**右键（`preventDefault` 掉宿主菜单）—— 否则我们画的菜单和飞书那个会一起弹；
 *   ② 按命中对象给出**不同**的菜单项（空白 / 元素 / 表格单元格），这就是用户说的"智能"。
 *
 * 设计上有三条硬约束，都来自本项目踩过的坑：
 *
 *   1. **`position: fixed` + 视口收边**。画布在侧栏里滚动，`absolute` 会跟着内容跑；
 *      而贴着屏幕右侧/底部右键时菜单会溢出（`min(x, vw - w - 8)` 是必须的，不是美化）。
 *   2. **关得掉**：点空白、按 Esc、滚动、点任意一项 —— 四条出口都要有。
 *      本项目在"菜单只能再点一次才关"上栽过两次（模板卡的「…」、App 的开发者菜单）。
 *   3. **点了就关，然后执行**。执行放后面：菜单还挂着时执行动作会改选中态，
 *      于是菜单的"当前对象"和"点的时候的对象"可能不是同一个 —— 那种错位极难复现。
 */
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'

export interface CtxItem {
  /** 该项的标识（回调里判断点了哪个） */
  id: string
  label: string
  /** 右侧的补充说明：快捷键或当前值（如「⌘C」「5mm」） */
  hint?: string
  /** 危险项（删除）—— 显示为红色 */
  danger?: boolean
  /** 不可点（如"粘贴"在没有剪贴板内容时） */
  disabled?: boolean
  /** 勾选项（如"网格吸附"）—— 右侧画一个对勾 */
  checked?: boolean
  /** 分隔线：这一项只当分隔用，不渲染文字 */
  separator?: boolean
  /** 一级子菜单（对齐 ▸ / 排列 ▸） */
  sub?: CtxItem[]
  /**
   * **数字输入项**（2026-10-01 第五批 · 右键直接调字号）。
   *
   * 用户原话：「在所有可以调整字符大小的字段、元素的右键菜单中，增加调整字符大小的功能，
   * **可以直接输入**」——"直接输入"意味着菜单里得有真的输入框，不是几个预设值。
   *
   * 渲染成「标签 + 数字输入框」，回车或失焦提交。
   * ⚠️ **提交后不关菜单**：用户常常要连着试几个值，每次都得"重新右键 → 再输入"太烦。
   */
  input?: {
    value: number
    min?: number
    max?: number
    step?: number
    suffix?: string
    /** 回车 / 失焦时提交（已经夹进 `[min, max]`、并挡掉 NaN） */
    onCommit(v: number): void
    /**
     * ⚠️ **每次改动立刻回调**（2026-10-01 用户要求"实时预览"）。
     *
     * 用户原话：「字号的设置改为**实时生效**，即点击输入框中的上下调整按钮后，点一下，
     * 画布中的元素字段就立即调整到对应的大小，这样方便实时预览」。
     *
     * 与 `onCommit` 的分工：`onInput` 负责"看得见"（每按一下箭头就变），
     * `onCommit` 负责"收尾"（回车/失焦时定稿，也用于做撤销步的合并）。
     * 两个都给 ⇒ 调值过程可预览、最终状态可回退。
     */
    onInput?(v: number): void
  }
}

export interface ContextMenuProps {
  /** 触发点（视口坐标，clientX/clientY） */
  x: number
  y: number
  items: CtxItem[]
  /** 选中某项：执行动作（菜单在本组件内先关） */
  onPick(id: string): void
  onClose(): void
}

const MARGIN = 8

export function ContextMenu({ x, y, items, onPick, onClose }: ContextMenuProps): ReactNode {
  const ref = useRef<HTMLDivElement | null>(null)
  const [pos, setPos] = useState({ left: x, top: y })

  /* 先按原样渲染，量出真实尺寸后再收边 —— 菜单宽度是内容撑的（"与右侧单元格合并"这种长项），
     拿固定值去估会算错，而算错的后果是菜单有一截在屏幕外、点不到。 */
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const vw = window.innerWidth
    const vh = window.innerHeight
    setPos({
      left: Math.max(MARGIN, Math.min(x, vw - r.width - MARGIN)),
      top: Math.max(MARGIN, Math.min(y, vh - r.height - MARGIN)),
    })
  }, [x, y, items])

  useEffect(() => {
    /* 捕获阶段判"点在不在菜单里"：不排除容器的话会变成"pointerdown 关、click 又开"。 */
    const onDown = (e: PointerEvent): void => {
      const node = e.target as Node | null
      if (node && ref.current?.contains(node)) return
      onClose()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        /*
         * ⚠️ **必须 stopPropagation**（2026-09-23 由 e2e 抓出来）。
         *
         * 编辑器的 Esc 是"退出编辑"（`EditorOverlay` 会弹出「确定退出编辑？」）。菜单开着时按 Esc，
         * 两件事会**同时**发生：菜单关了（对），退出确认也弹出来了（错）—— 用户只是想关掉菜单，
         * 却发现整屏被"确定退出编辑？"盖住，画布点不动。
         *
         * `MergeConfirmDialog` 里早就写了这一行（那里的注释是"否则编辑器的 Esc 会一起触发"），
         * 菜单这里漏了。**同一个坑在两个组件上各写一遍的下场**：只修了一处。
         */
        e.stopPropagation()
        onClose()
      }
    }
    // 滚动/缩放时菜单会飘在错误的位置上 ⇒ 直接关掉（比重算一遍简单，且不会错）
    const onScroll = (): void => onClose()
    document.addEventListener('pointerdown', onDown, true)
    document.addEventListener('keydown', onKey, true)
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', onScroll, true)
    return () => {
      document.removeEventListener('pointerdown', onDown, true)
      document.removeEventListener('keydown', onKey, true)
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onScroll, true)
    }
  }, [onClose])

  const renderItems = (list: CtxItem[]): ReactNode[] =>
    list.map((it, i) => {
      if (it.separator) return <div key={`sep-${i}`} className="bp-ctx__sep" role="separator" />
      /*
       * ⚠️ **输入项要抢在普通项之前处理**（2026-10-01 第五批）。
       *
       * 它不能用 `<button>` 包着 —— 按钮里放 `<input>` 是**嵌套交互元素**（HTML 不允许，
       * 点输入框会先触发按钮行为）。所以单独一条渲染路径，并与 `.bp-ctx__row` 平级。
       *
       * ⚠️ 三个事件都必须 `stopPropagation`：本组件在捕获阶段挂了一个"点任何地方都关菜单"
       * 的监听器（见上面 `onDown`），不拦住的话**鼠标一点进输入框菜单就没了** ⇒ 功能不可用。
       */
      if (it.input) {
        const cfg = it.input
        /*
         * 夹进 `[min, max]` 并挡掉 NaN。
         * ⚠️ 空串与"半成品"（只输入了 `-` 或 `.`）一律返回 `null` 而不是 0 ——
         * 否则用户删空输入框准备重新打字时，元素字号会先被拽到最小值。
         */
        const clamp = (raw: string): number | null => {
          if (raw.trim() === '') return null
          const n = Number(raw)
          if (!Number.isFinite(n)) return null
          const lo = cfg.min ?? -Infinity
          const hi = cfg.max ?? Infinity
          return Math.min(hi, Math.max(lo, n))
        }
        const commit = (raw: string): void => {
          const v = clamp(raw)
          if (v !== null) cfg.onCommit(v)
        }
        return (
          <div
            key={it.id}
            className="bp-ctx__row bp-ctx__row--input"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
          >
            <span className="bp-ctx__label">{it.label}</span>
            <input
              type="number"
              className="bp-ctx__input"
              defaultValue={String(cfg.value)}
              min={cfg.min}
              max={cfg.max}
              step={cfg.step ?? 0.5}
              /*
               * ⚠️ **实时生效**（2026-10-01 用户要求）：点上下箭头、或敲字时立刻回调。
               * 这样画布上的元素**边调边看**，不必"改完回车再看对不对"。
               */
              onChange={(e) => {
                const v = clamp(e.target.value)
                if (v !== null) cfg.onInput?.(v)
              }}
              onKeyDown={(e) => {
                /* ⚠️ 放行 Esc 让它能退出输入（但不冒泡给浮层的"逐级退"，否则会连带关掉菜单） */
                e.stopPropagation()
                if (e.key === 'Enter') {
                  commit((e.target as HTMLInputElement).value)
                }
              }}
              onBlur={(e) => commit(e.target.value)}
            />
            {cfg.suffix ? <span className="bp-ctx__hint">{cfg.suffix}</span> : null}
          </div>
        )
      }
      const hasSub = !!it.sub?.length
      return (
        /*
         * ⚠️ 子菜单必须是**兄弟节点**、不能塞进 `<button>` 里：
         *    按钮里再放按钮是**嵌套交互元素**（HTML 不允许，浏览器与读屏软件行为都不确定）——
         *    本项目在"卡片里套按钮"上栽过一次。所以这里加一层 `.bp-ctx__row` 做定位上下文，
         *    父项一个按钮、子菜单一个 `<div role="menu">`，两者平级。
         *    子菜单的展开交给 CSS（`:hover >`），不开 JS 状态：多一个状态就多一种"没收起来"的可能。
         */
        <div key={it.id} className={`bp-ctx__row${hasSub ? ' has-sub' : ''}`}>
          <button
            type="button"
            role="menuitem"
            aria-haspopup={hasSub ? 'menu' : undefined}
            className={`bp-ctx__item${it.danger ? ' is-danger' : ''}`}
            disabled={it.disabled}
            onClick={() => {
              if (it.disabled || hasSub) return
              onClose()
              onPick(it.id)
            }}
          >
            <span className="bp-ctx__label">{it.label}</span>
            {it.checked ? (
              <span className="bp-ctx__check" aria-hidden>
                ✓
              </span>
            ) : null}
            {it.hint ? <span className="bp-ctx__hint">{it.hint}</span> : null}
            {hasSub ? (
              <span className="bp-ctx__arrow" aria-hidden>
                ›
              </span>
            ) : null}
          </button>
          {hasSub ? (
            <div className="bp-ctx__sub" role="menu">
              {renderItems(it.sub!)}
            </div>
          ) : null}
        </div>
      )
    })

  return (
    <div
      ref={ref}
      className="bp-ctx"
      role="menu"
      style={{ left: pos.left, top: pos.top }}
      /* 菜单自己吃掉右键：在菜单上再右键不该再弹一层 */
      onContextMenu={(e) => e.preventDefault()}
    >
      {renderItems(items)}
    </div>
  )
}
