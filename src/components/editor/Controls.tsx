/**
 * 属性面板用的表单原子组件。
 *
 * 两条硬约束（PRD F7-03 / F7-04）在这里落地：
 * 1) 类型选择器（纸张、字体、绑定字段）**不能**做成"胶囊 + 下拉框并列显示同一份文字"。
 *    这里统一为"胶囊本身就是按钮"：点开原地弹出胶囊菜单（role=listbox + role=option + aria-selected），
 *    展开时三角指示符旋转 180°。
 * 2) 所有弹出层走 Popover（fixed + 视口收边 + 不透明背景 + z-index ≥ 200）。
 */

import { Fragment, useEffect, useState, type ReactNode } from 'react'
import { Popover } from './Popover'
import { IconCaret } from './Icons'

// ============================================================
// 布局
// ============================================================

export function Field({
  label,
  hint,
  children,
  inline,
}: {
  label: string
  hint?: string
  children: ReactNode
  /** 标签与控件同行（用于开关、紧凑数值） */
  inline?: boolean
}) {
  return (
    <div className={`bp-field${inline ? ' bp-field--inline' : ''}`}>
      <span className="bp-field__label" title={hint}>
        {label}
      </span>
      <div className="bp-field__body">{children}</div>
    </div>
  )
}

export function Section({
  title,
  children,
  defaultOpen = true,
}: {
  title: string
  children: ReactNode
  defaultOpen?: boolean
}) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <section className="bp-sec">
      <button type="button" className="bp-sec__head" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <span className={`bp-sec__caret${open ? ' is-open' : ''}`}>
          <IconCaret size={12} />
        </span>
        <span className="bp-sec__title">{title}</span>
      </button>
      {open ? <div className="bp-sec__body">{children}</div> : null}
    </section>
  )
}

// ============================================================
// 分段控件
// ============================================================

export interface SegOption<T extends string> {
  value: T
  label: string
  title?: string
}

export function Seg<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
  disabled,
}: {
  value: T
  options: SegOption<T>[]
  onChange(v: T): void
  ariaLabel: string
  disabled?: boolean
}) {
  return (
    <div className="bp-seg" role="radiogroup" aria-label={ariaLabel}>
      {options.map((o) => {
        const active = o.value === value
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={active}
            title={o.title ?? o.label}
            disabled={disabled}
            className={`bp-seg__item${active ? ' is-active' : ''}`}
            onClick={() => {
              if (!active) onChange(o.value)
            }}
          >
            <span className="bp-seg__text">{o.label}</span>
          </button>
        )
      })}
    </div>
  )
}

// ============================================================
// 数值输入
// ============================================================

export function Num({
  value,
  onChange,
  min,
  max,
  step = 1,
  suffix,
  ariaLabel,
  /** 输入过程中的合并 key，让连续敲数字只产生一步撤销 */
  onLiveChange,
}: {
  value: number
  onChange(v: number): void
  min: number
  max: number
  step?: number
  suffix?: string
  ariaLabel: string
  /** 存在时每次按键都回调（用于即时预览），onChange 仍只在确认时触发 */
  onLiveChange?(v: number): void
}) {
  const [text, setText] = useState(() => String(normalize(value)))

  // 外部值变化（拖动改尺寸等）要同步回输入框
  useEffect(() => {
    setText(String(normalize(value)))
  }, [value])

  const clamp = (n: number): number => Math.min(Math.max(n, min), max)
  const commit = (raw: string): void => {
    const t = raw.trim()
    if (t === '') {
      setText(String(normalize(value)))
      return
    }
    const n = Number(t)
    if (!Number.isFinite(n)) {
      setText(String(normalize(value)))
      return
    }
    const c = clamp(n)
    setText(String(normalize(c)))
    if (c !== value) onChange(c)
  }

  return (
    <div className="bp-num">
      {/* 用 text + inputMode 而不是 type=number：number 输入框会把 "1." 这种中间态
          判为非法值并清空，用户根本没法输入 0.25 / 10.5 这类小数 */}
      <input
        className="bp-num__input"
        type="text"
        inputMode="decimal"
        value={text}
        aria-label={ariaLabel}
        onChange={(e) => {
          setText(e.target.value)
          const n = Number(e.target.value)
          if (onLiveChange && e.target.value.trim() !== '' && Number.isFinite(n)) onLiveChange(clamp(n))
        }}
        onBlur={(e) => commit(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit((e.target as HTMLInputElement).value)
          if (e.key === 'Escape') setText(String(normalize(value)))
          if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            const dir = e.key === 'ArrowUp' ? 1 : -1
            e.preventDefault()
            commit(String(normalize(clamp(value + dir * step))))
          }
        }}
      />
      {suffix ? <span className="bp-num__suffix">{suffix}</span> : null}
    </div>
  )
}

function normalize(n: number): number {
  if (!Number.isFinite(n)) return 0
  return Math.round(n * 100) / 100
}

// ============================================================
// 开关
// ============================================================

export function Switch({
  checked,
  onChange,
  ariaLabel,
  disabled,
}: {
  checked: boolean
  onChange(v: boolean): void
  ariaLabel: string
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      className={`bp-switch${checked ? ' is-on' : ''}`}
      onClick={() => onChange(!checked)}
    >
      <span className="bp-switch__knob" />
    </button>
  )
}

// ============================================================
// 颜色
// ============================================================

/** 主题色板：这些是"内容色"（会打印出来），不属于插件 UI 主题，因此允许写死 */
const SWATCHES = ['#1f2329', '#646a73', '#8f959e', '#f54a45', '#ff8800', '#ffc60a', '#34c724', '#1d9e75', '#3370ff', '#7f77dd']
const TEXT_SWATCHES = ['#1f2329', '#646a73', '#8f959e', '#f54a45', '#ff8800', '#3370ff', '#1d9e75']

export function ColorInput({
  value,
  onChange,
  ariaLabel,
  swatches = SWATCHES,
}: {
  value: string
  onChange(v: string): void
  ariaLabel: string
  swatches?: string[]
}) {
  return (
    <div className="bp-color">
      <input
        className="bp-color__native"
        type="color"
        value={/^#[0-9a-fA-F]{6}$/.test(value) ? value : '#1f2329'}
        aria-label={ariaLabel}
        onChange={(e) => onChange(e.target.value)}
      />
      <div className="bp-color__swatches" role="group" aria-label={`${ariaLabel}·色板`}>
        {swatches.map((c) => (
          <button
            key={c}
            type="button"
            className={`bp-color__dot${c.toLowerCase() === value.toLowerCase() ? ' is-active' : ''}`}
            style={{ background: c }}
            title={c}
            aria-label={c}
            onClick={() => onChange(c)}
          />
        ))}
      </div>
    </div>
  )
}

// ============================================================
// 胶囊选择器（"胶囊即按钮"）
// ============================================================

export interface CapsuleOption<T extends string> {
  value: T
  label: string
  hint?: string
  /**
   * 分组标题（可选）。按 options 的顺序，**相邻且同组**的选项会自动合并到一个标题下；
   * 用于纸张预设这种"两类用途完全不同、混在一起必选错"的长列表。
   */
  group?: string
}

export function CapsuleSelect<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
  placeholder = '请选择',
  disabled,
  width = 200,
}: {
  value: T
  options: CapsuleOption<T>[]
  onChange(v: T): void
  ariaLabel: string
  placeholder?: string
  disabled?: boolean
  /** 弹出菜单的期望宽度（px），窄屏会自动收窄 */
  width?: number
}) {
  const current = options.find((o) => o.value === value)
  return (
    <Popover
      role="listbox"
      ariaLabel={ariaLabel}
      matchTriggerWidth
      width={width}
      renderTrigger={({ open, toggle, buttonRef }) => (
        <button
          ref={buttonRef}
          type="button"
          className={`bp-picker${open ? ' is-open' : ''}`}
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-label={ariaLabel}
          disabled={disabled}
          onClick={toggle}
        >
          <span className={`bp-picker__label${current ? '' : ' is-empty'}`}>{current ? current.label : placeholder}</span>
          <span className={`bp-picker__caret${open ? ' is-open' : ''}`}>
            <IconCaret size={12} />
          </span>
        </button>
      )}
    >
      {({ close }) => (
        <ul className="bp-picker__list">
          {options.map((o, i) => {
            const active = o.value === value
            // 只在"组变了"的地方插一个标题，同组连续项共用一个（PAPER_PRESETS 就是这么排的）
            const showGroup = !!o.group && o.group !== options[i - 1]?.group
            return (
              <Fragment key={o.value}>
                {showGroup ? (
                  <li className="bp-picker__group" aria-hidden>
                    {o.group}
                  </li>
                ) : null}
                <li className="bp-picker__opt-wrap">
                  <button
                    type="button"
                    role="option"
                    aria-selected={active}
                    className={`bp-picker__opt${active ? ' is-active' : ''}`}
                    title={o.hint ?? o.label}
                    onClick={() => {
                      onChange(o.value)
                      close()
                    }}
                  >
                    <span className="bp-picker__opt-label">{o.label}</span>
                    {active ? <span className="bp-picker__tick" aria-hidden /> : null}
                  </button>
                </li>
              </Fragment>
            )
          })}
        </ul>
      )}
    </Popover>
  )
}

// ============================================================
// 绑定字段选择器（带类型色块与搜索）
// ============================================================

export interface FieldPickerProps {
  /** 传入 fieldId，null 表示未绑定 */
  value: string | null
  /** 展示用的字段名（未绑定时用于回显历史名） */
  fallbackName?: string
  options: { id: string; name: string; tint: string; blocked?: boolean; group?: string; note?: string }[]
  onChange(id: string | null, name: string): void
  ariaLabel: string
  /** 允许"不绑定"选项 */
  allowEmpty?: boolean
}

export function FieldPicker({ value, fallbackName, options, onChange, ariaLabel, allowEmpty = true }: FieldPickerProps) {
  const [kw, setKw] = useState('')
  const current = options.find((o) => o.id === value)
  const filtered = kw.trim() ? options.filter((o) => o.name.toLowerCase().includes(kw.trim().toLowerCase())) : options

  return (
    <Popover
      role="dialog"
      ariaLabel={ariaLabel}
      matchTriggerWidth
      width={260}
      renderTrigger={({ open, toggle, buttonRef }) => (
        <button
          ref={buttonRef}
          type="button"
          className={`bp-picker${open ? ' is-open' : ''}${current ? '' : ' is-warn'}`}
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-label={ariaLabel}
          onClick={toggle}
        >
          {current ? <span className="bp-chip-item__dot" style={{ background: current.tint }} aria-hidden /> : null}
          <span className={`bp-picker__label${current ? '' : ' is-empty'}`}>
            {current ? current.name : fallbackName ? `⚠ ${fallbackName}` : '未绑定字段'}
          </span>
          <span className={`bp-picker__caret${open ? ' is-open' : ''}`}>
            <IconCaret size={12} />
          </span>
        </button>
      )}
    >
      {({ close }) => (
        <div className="bp-fieldpicker">
          {options.length > 8 ? (
            <input
              className="bp-fieldpicker__search"
              value={kw}
              placeholder="搜索字段"
              aria-label="搜索字段"
              onChange={(e) => setKw(e.target.value)}
            />
          ) : null}
          <ul className="bp-picker__list bp-fieldpicker__list" role="listbox" aria-label={ariaLabel}>
            {allowEmpty ? (
              <li className="bp-picker__opt-wrap">
                <button
                  type="button"
                  role="option"
                  aria-selected={value === null}
                  className={`bp-picker__opt${value === null ? ' is-active' : ''}`}
                  onClick={() => {
                    onChange(null, fallbackName ?? '')
                    close()
                  }}
                >
                  <span className="bp-picker__opt-label">不绑定（纯文本）</span>
                </button>
              </li>
            ) : null}
            {filtered.map((o) => (
              <li key={o.id} className="bp-picker__opt-wrap">
                <button
                  type="button"
                  role="option"
                  aria-selected={o.id === value}
                  className={`bp-picker__opt${o.id === value ? ' is-active' : ''}${o.blocked ? ' is-blocked' : ''}`}
                  title={o.note ?? o.name}
                  onClick={() => {
                    onChange(o.id, o.name)
                    close()
                  }}
                >
                  <span className="bp-chip-item__dot" style={{ background: o.tint }} aria-hidden />
                  <span className="bp-picker__opt-label">{o.name}</span>
                  {o.group ? <span className="bp-picker__opt-tag">{o.group}</span> : null}
                </button>
              </li>
            ))}
            {filtered.length === 0 ? <li className="bp-picker__empty">没有匹配的字段</li> : null}
          </ul>
        </div>
      )}
    </Popover>
  )
}
