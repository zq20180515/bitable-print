/**
 * 编辑器内的打印效果预览浮层。
 *
 * 关键约定：这里渲染的是 `renderDocument` 吐出来的**那一份** HTML（`RenderedDoc.html`），
 * 与第③步预览、以及最终打印送进打印 iframe 的是同一个字符串。
 * 所以"所见即所得"不是靠对齐两套代码换来的，而是因为压根就只有一套。
 *
 * 为什么用 `<iframe srcdoc>` 而不是把产物拆进 React 树：
 * 产物是一份自包含 HTML（含内联样式与 @page 规则），塞进 iframe 既天然 1:1，
 * 也天然隔离样式（插件的 CSS 不会污染纸张）。这段判断与 wizard 的 PreviewFrame 一致，
 * 但**不复用那个组件**：editor 反向依赖 wizard 会把两个目录的依赖绕成环。
 */

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { mmToPx } from '../../lib/types'
import { IconMinus, IconPlus } from './Icons'
import type { EditorPreviewResult } from './preview'

interface Props {
  /** null = 正在渲染 */
  result: EditorPreviewResult | null
  error: string | null
  /** 渲染进度文字（"正在测量第 12/40 块"这种），null 表示不显示 */
  busy: string | null
  onClose(): void
}

const ZOOMS = ['fit', 0.5, 0.75, 1] as const

export function PreviewPane({ result, error, busy, onClose }: Props) {
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const frameRef = useRef<HTMLIFrameElement | null>(null)
  const [availW, setAvailW] = useState(560)
  const [contentH, setContentH] = useState(0)
  const [zoom, setZoom] = useState<'fit' | number>('fit')

  // Esc 关闭：预览是覆盖层，用户的第一直觉就是按 Esc 退出
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  useLayoutEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const measure = (): void => {
      const w = el.clientWidth - 2
      setAvailW(Number.isFinite(w) && w > 0 ? w : 560)
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [result])

  const html = result?.html ?? ''
  useEffect(() => {
    setContentH(0)
  }, [html])

  const pageW = result ? Math.max(1, mmToPx(result.pageWidthMm)) : 1
  const fallbackH = result ? Math.max(1, mmToPx(result.pageHeightMm)) * Math.max(1, result.pages) : 1
  const scale = zoom === 'fit' ? Math.max(0.1, Math.min(availW / pageW, 2)) : zoom
  const naturalH = contentH > 0 ? contentH : fallbackH

  /** srcdoc 同源，可以直接读真实内容高度（不做这件事就只能按"页数 × 页高"估） */
  const measureHeight = (): void => {
    const f = frameRef.current
    if (!f) return
    try {
      const d = f.contentDocument
      if (!d) return
      const h = Math.max(d.documentElement?.scrollHeight ?? 0, d.body?.scrollHeight ?? 0)
      if (Number.isFinite(h) && h > 0) setContentH(h)
    } catch {
      /* 读不到就维持估算值 */
    }
  }

  return (
    <div className="bp-preview" role="dialog" aria-modal="true" aria-label="打印效果预览">
      <div className="bp-preview__bar">
        <span className="bp-preview__title">打印效果预览</span>
        {result ? (
          <span className="bp-preview__meta">
            {result.pages} 页
            <span className="bp-top__sep" aria-hidden>
              ·
            </span>
            {Math.round(result.pageWidthMm)}×{Math.round(result.pageHeightMm)}mm
            {result.warnings > 0 ? (
              <>
                <span className="bp-top__sep" aria-hidden>
                  ·
                </span>
                {result.warnings} 项提示
              </>
            ) : null}
          </span>
        ) : null}
        <span className="bp-preview__spacer" />
        <div className="bp-preview__zooms" role="group" aria-label="预览缩放">
          <button
            type="button"
            className="bp-iconbtn bp-iconbtn--sm"
            aria-label="缩小预览"
            title="缩小"
            onClick={() => setZoom(Math.max(0.25, Math.round((scale - 0.1) * 100) / 100))}
          >
            <IconMinus size={13} />
          </button>
          <span className="bp-preview__pct">{Math.round(scale * 100)}%</span>
          <button
            type="button"
            className="bp-iconbtn bp-iconbtn--sm"
            aria-label="放大预览"
            title="放大"
            onClick={() => setZoom(Math.min(2, Math.round((scale + 0.1) * 100) / 100))}
          >
            <IconPlus size={13} />
          </button>
          {ZOOMS.map((z) => (
            <button
              key={String(z)}
              type="button"
              className={`bp-btn bp-btn--sm${zoom === z ? ' is-on' : ''}`}
              aria-pressed={zoom === z}
              title={z === 'fit' ? '适应宽度' : `固定 ${Math.round(z * 100)}%`}
              onClick={() => setZoom(z)}
            >
              {z === 'fit' ? '适应' : `${Math.round(z * 100)}%`}
            </button>
          ))}
        </div>
        <button type="button" className="bp-btn bp-btn--sm" aria-label="关闭预览" onClick={onClose}>
          关闭
        </button>
      </div>

      <p className="bp-preview__note">
        {busy ? (
          <span className="bp-preview__busy">{busy}</span>
        ) : error ? (
          <span className="bp-preview__error">渲染失败：{error}</span>
        ) : result ? (
          <>
            这一份就是打印出去的那一份（同一套排版管线），数据：{result.source}
          </>
        ) : null}
      </p>

      <div className="bp-preview__scroll" ref={wrapRef}>
        {result ? (
          <div
            className="bp-preview__inner"
            style={{ width: `${Math.round(pageW * scale)}px`, height: `${Math.round(naturalH * scale)}px` }}
          >
            <iframe
              ref={frameRef}
              className="bp-preview__frame"
              title="打印效果"
              srcDoc={result.html}
              sandbox="allow-same-origin"
              onLoad={() => {
                measureHeight()
                setTimeout(measureHeight, 120)
                setTimeout(measureHeight, 600)
              }}
              style={{
                width: `${Math.round(pageW)}px`,
                height: `${Math.round(naturalH)}px`,
                transform: `scale(${Number.isFinite(scale) ? scale : 1})`,
                transformOrigin: 'top left',
              }}
            />
          </div>
        ) : (
          <div className="bp-preview__empty">
            <span className="bp-spinner" aria-hidden />
            <span>正在排版…</span>
          </div>
        )}
      </div>
    </div>
  )
}

export default PreviewPane
