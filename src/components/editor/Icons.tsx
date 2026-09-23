/**
 * 内联图标集。
 *
 * 为什么不装图标库：插件运行在飞书侧边栏 iframe 里，包体积和首屏时间都要抠；
 * 编辑器总共用不到 20 个图标，内联 SVG（stroke=currentColor）能跟着文字颜色走，
 * 暗黑模式零成本适配。
 */

import type { CSSProperties } from 'react'

export interface IconProps {
  size?: number
  className?: string
  style?: CSSProperties
}

function base(size: number, className?: string, style?: CSSProperties) {
  return {
    width: size,
    height: size,
    viewBox: '0 0 16 16',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.4,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    className,
    style,
    'aria-hidden': true,
    focusable: false,
  }
}

export function IconBack({ size = 16, className, style }: IconProps) {
  return (
    <svg {...base(size, className, style)}>
      <path d="M10 3 5 8l5 5" />
    </svg>
  )
}

export function IconUndo({ size = 16, className, style }: IconProps) {
  return (
    <svg {...base(size, className, style)}>
      <path d="M3 8h7a3.5 3.5 0 1 1 0 7H7" />
      <path d="M5.5 5.5 3 8l2.5 2.5" />
    </svg>
  )
}

export function IconRedo({ size = 16, className, style }: IconProps) {
  return (
    <svg {...base(size, className, style)}>
      <path d="M13 8H6a3.5 3.5 0 1 0 0 7h3" />
      <path d="M10.5 5.5 13 8l-2.5 2.5" />
    </svg>
  )
}

export function IconCheck({ size = 16, className, style }: IconProps) {
  return (
    <svg {...base(size, className, style)}>
      <path d="M3 8.5 6.2 12 13 4.5" />
    </svg>
  )
}

/** 「在这里看打印效果」—— 眼睛 */
export function IconEye({ size = 16, className, style }: IconProps) {
  return (
    <svg {...base(size, className, style)}>
      <path d="M1.8 8S4.2 4 8 4s6.2 4 6.2 4-2.4 4-6.2 4-6.2-4-6.2-4Z" />
      <circle cx="8" cy="8" r="1.7" />
    </svg>
  )
}

/** 「页面设置」—— 滑杆，比齿轮更贴近"这里是一组可调项" */
export function IconSliders({ size = 16, className, style }: IconProps) {
  return (
    <svg {...base(size, className, style)}>
      <path d="M2.5 5h11M2.5 11h11" />
      <circle cx="6" cy="5" r="1.7" />
      <circle cx="10.5" cy="11" r="1.7" />
    </svg>
  )
}
export function IconSearch({ size = 16, className, style }: IconProps) {
  return (
    <svg {...base(size, className, style)}>
      <circle cx="7" cy="7" r="4.2" />
      <path d="M10.2 10.2 13.5 13.5" />
    </svg>
  )
}

export function IconWarning({ size = 16, className, style }: IconProps) {
  return (
    <svg {...base(size, className, style)}>
      <path d="M8 2.4 14.2 13H1.8L8 2.4Z" />
      <path d="M8 6.4v3.2M8 11.6h.01" />
    </svg>
  )
}

export function IconCaret({ size = 16, className, style }: IconProps) {
  return (
    <svg {...base(size, className, style)}>
      <path d="M4 6.5 8 10.5l4-4" />
    </svg>
  )
}
export function IconTrash({ size = 16, className, style }: IconProps) {
  return (
    <svg {...base(size, className, style)}>
      <path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5 5.2 13h5.6l.7-8.5" />
    </svg>
  )
}

export function IconPlus({ size = 16, className, style }: IconProps) {
  return (
    <svg {...base(size, className, style)}>
      <path d="M8 3.5v9M3.5 8h9" />
    </svg>
  )
}

export function IconMinus({ size = 16, className, style }: IconProps) {
  return (
    <svg {...base(size, className, style)}>
      <path d="M3.5 8h9" />
    </svg>
  )
}

export function IconText({ size = 16, className, style }: IconProps) {
  return (
    <svg {...base(size, className, style)}>
      <path d="M3 4h10M8 4v8M6 12h4" />
    </svg>
  )
}

export function IconTable({ size = 16, className, style }: IconProps) {
  return (
    <svg {...base(size, className, style)}>
      <rect x="2.5" y="3" width="11" height="10" rx="1" />
      <path d="M2.5 6.2h11M6.3 6.2V13M2.5 9.6h11" />
    </svg>
  )
}

export function IconImage({ size = 16, className, style }: IconProps) {
  return (
    <svg {...base(size, className, style)}>
      <rect x="2.5" y="3" width="11" height="10" rx="1" />
      <circle cx="6" cy="6.4" r="1.1" />
      <path d="M3.2 11.4 6.6 8l2 2 1.6-1.4 2.6 2.6" />
    </svg>
  )
}

export function IconHLine({ size = 16, className, style }: IconProps) {
  return (
    <svg {...base(size, className, style)}>
      <path d="M2.5 8h11" />
    </svg>
  )
}

export function IconPageBreak({ size = 16, className, style }: IconProps) {
  return (
    <svg {...base(size, className, style)}>
      <path d="M2.5 8h11" strokeDasharray="2.5 2.5" />
      <path d="M5 5V3h6v2M5 11v2h6v-2" />
    </svg>
  )
}

export function IconPaperclip({ size = 16, className, style }: IconProps) {
  return (
    <svg {...base(size, className, style)}>
      <path d="M10.8 4.6 6.2 9.2a1.6 1.6 0 0 0 2.3 2.3l4.4-4.4a3.1 3.1 0 0 0-4.4-4.4L4 7.1a4.3 4.3 0 0 0 6.1 6.1l2.6-2.6" />
    </svg>
  )
}

/** 二维码：三个定位角 + 右下角一小片模块 */
export function IconQrCode({ size = 16, className, style }: IconProps) {
  return (
    <svg {...base(size, className, style)}>
      <rect x="2.5" y="2.5" width="4.5" height="4.5" rx="0.8" />
      <rect x="9" y="2.5" width="4.5" height="4.5" rx="0.8" />
      <rect x="2.5" y="9" width="4.5" height="4.5" rx="0.8" />
      <path d="M9 9h2v2H9zM12.5 9h1.5v1.5h-1.5zM9 12.5h1.5V14H9zM12 12.5h2V14h-2z" fill="currentColor" stroke="none" />
    </svg>
  )
}

/** 条形码：粗细交替的竖条 + 下方一条原文行 */
export function IconBarcode({ size = 16, className, style }: IconProps) {
  return (
    <svg {...base(size, className, style)}>
      <path d="M3 3v7M4.8 3v7M7.2 3v7M8.6 3v7M11 3v7M12.4 3v7M14 3v7" />
      <path d="M3.5 12.5h9" strokeWidth={1.2} />
    </svg>
  )
}

export function IconSysVar({ size = 16, className, style }: IconProps) {
  return (
    <svg {...base(size, className, style)}>
      <path d="M6.2 3H4.6C3.7 3 3 3.7 3 4.6v6.8c0 .9.7 1.6 1.6 1.6h1.6M9.8 3h1.6c.9 0 1.6.7 1.6 1.6v6.8c0 .9-.7 1.6-1.6 1.6H9.8" />
      <path d="M8 6v4" />
    </svg>
  )
}
export function IconMerge({ size = 16, className, style }: IconProps) {
  return (
    <svg {...base(size, className, style)}>
      <rect x="2.5" y="3.5" width="11" height="9" rx="1" />
      <path d="M8 3.5v9" strokeDasharray="2 2" />
      <path d="M5 8h-1.5M12.5 8h-1.5" />
    </svg>
  )
}

export function IconSplit({ size = 16, className, style }: IconProps) {
  return (
    <svg {...base(size, className, style)}>
      <rect x="2.5" y="3.5" width="11" height="9" rx="1" />
      <path d="M8 3.5v9" />
    </svg>
  )
}

/** 左面板开合（宽屏三栏用） */
export function IconPanelLeft({ size = 16, className, style }: IconProps) {
  return (
    <svg {...base(size, className, style)}>
      <rect x="2" y="3" width="12" height="10" rx="1.5" />
      <path d="M6.5 3v10" />
    </svg>
  )
}

/** 右面板开合（宽屏三栏用） */
export function IconPanelRight({ size = 16, className, style }: IconProps) {
  return (
    <svg {...base(size, className, style)}>
      <rect x="2" y="3" width="12" height="10" rx="1.5" />
      <path d="M9.5 3v10" />
    </svg>
  )
}