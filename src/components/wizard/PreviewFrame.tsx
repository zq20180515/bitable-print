import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { mmToPx } from '../../lib/types'

/**
 * 打印预览容器。
 *
 * 为什么用 iframe 而不是把页面渲染进 React 树：
 * 渲染引擎产出的是一份**完整自包含 HTML**（含内联样式与 `@page` 规则），打印时原样送进打印 iframe。
 * 预览如果另起一套 DOM 结构，就必然出现"预览和打印不一样"——这正是 PRD F5-01 明令禁止的。
 * 直接把同一份 HTML 塞进 iframe，保真度天然 1:1，还能天然隔离样式（插件的 CSS 不会污染纸张）。
 *
 * 顺带说明：iframe 用 srcdoc 加载，属同源，所以能读 contentDocument 拿真实内容高度 ——
 * 不做这件事就只能靠"页数 × 页高"估算，带阴影/间隙的预览会算出偏差。
 */

interface Props {
  /** 渲染引擎产出的完整 HTML */
  html: string
  pageWidthMm: number
  pageHeightMm: number
  /** 'fit' = 适应容器宽度；数字 = 固定缩放比 */
  zoom: 'fit' | number
  /** 页数，仅用于内容高度还没测出来时的兜底估算 */
  pageCount: number
}

export function PreviewFrame({ html, pageWidthMm, pageHeightMm, zoom, pageCount }: Props) {
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const frameRef = useRef<HTMLIFrameElement | null>(null)
  const [availW, setAvailW] = useState(340)
  const [contentH, setContentH] = useState(0)

  /** 逻辑宽度：纸张的真实像素宽（缩放前） */
  const logicalW = Math.max(1, mmToPx(pageWidthMm))
  const fallbackH = Math.max(1, mmToPx(pageHeightMm)) * Math.max(1, pageCount)

  // 容器宽度变化 → "适应宽度"要跟着变
  useLayoutEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const measure = (): void => {
      const w = el.clientWidth - 2 // 减去边框，避免刚好撑出横向滚动条
      setAvailW(Number.isFinite(w) && w > 0 ? w : 340)
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const scale = zoom === 'fit' ? Math.max(0.1, Math.min(availW / logicalW, 2)) : zoom

  /** 读 iframe 里的真实内容高度。srcdoc 同源，可以直接读 */
  const measureHeight = useCallback(() => {
    const f = frameRef.current
    if (!f) return
    try {
      const d = f.contentDocument
      if (!d) return
      const root = d.documentElement
      const body = d.body
      const h = Math.max(root?.scrollHeight ?? 0, body?.scrollHeight ?? 0)
      if (Number.isFinite(h) && h > 0) setContentH(h)
    } catch {
      // 极端情况下读不到（被沙箱限制），保持兜底估算值即可，不要抛错
    }
  }, [])

  useEffect(() => {
    // html 变了要重新量：srcDoc 会重建文档
    setContentH(0)
  }, [html])

  const naturalH = contentH > 0 ? contentH : fallbackH
  const shownH = naturalH * scale

  return (
    <div className="wiz-prev" ref={wrapRef}>
      <div className="wiz-prev-inner" style={{ width: `${Math.round(logicalW * scale)}px`, height: `${Math.round(shownH)}px` }}>
        <iframe
          ref={frameRef}
          className="wiz-prev-frame"
          title="打印预览"
          srcDoc={html}
          sandbox="allow-same-origin"
          onLoad={() => {
            measureHeight()
            // 图片是 blob 链接，加载完成会改变高度，补量两次
            setTimeout(measureHeight, 120)
            setTimeout(measureHeight, 600)
          }}
          style={{
            width: `${Math.round(logicalW)}px`,
            height: `${Math.round(naturalH)}px`,
            transform: `scale(${Number.isFinite(scale) ? scale : 1})`,
            transformOrigin: 'top left',
          }}
        />
      </div>
      <p className="wiz-prev-note">
        预览与打印用的是同一份渲染结果，所见即所得。纸张 {Math.round(pageWidthMm)}×{Math.round(pageHeightMm)}mm，
        缩放 {Math.round(scale * 100)}%
      </p>
    </div>
  )
}
