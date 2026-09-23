/**
 * 二维码 / 条形码 → **内联 SVG 字符串**（纯函数，不碰 DOM，可在 Node 里单测）。
 *
 * 为什么产物是字符串而不是图片（canvas / dataURL）：
 *   1) 打印 HTML 全是字符串拼装（见 html.ts 顶部注释），渲染器不接受任何 DOM 依赖；
 *   2) SVG 是矢量的：标签纸常用 203dpi 热敏机，位图缩放在模块边缘会产生灰边，
 *      而扫码器对模糊边缘极其敏感（"屏幕上看没事、打出来扫不出来"的经典坑）；
 *   3) 内联进 HTML 就不需要再走一条资源通道 —— 附件图片那条链路已经够复杂了。
 *
 * 两条硬约束（都是踩过坑的）：
 *   1) **必须加 `shape-rendering="crispEdges"`**。不加的话浏览器会给模块边缘做抗锯齿，
 *      模块尺寸一取整就出现灰边与半像素接缝，打印后直接扫不出来。
 *   2) **二维码必须留 4 个模块静默区**（QR 规范），不留的话相当一部分扫码器识别不了。
 *
 * 所有非法入参（空内容、尺寸 ≤ 0、条形码内容含非 ASCII）一律返回**空串**而不抛错：
 * 调用方（html.ts）会拿空串走"占位框 + 警告"分支 —— 打印一页空白而用户不知道为什么，
 * 比报一条警告糟糕得多。
 */

import qrcode from 'qrcode-generator'
import { finite } from '../lib/types'

// ============================================================
// 公共
// ============================================================

const DEFAULT_FG = '#000000'
const DEFAULT_BG = '#ffffff'

/** QR 规范的静默区：四周各留 4 个模块 */
const QR_QUIET_ZONE = 4

/**
 * 二维码内容字节数上限（约 2000 字节）。
 * EC=M 的版本 40 理论容量是 2331 字节，这里留一点余量：内容接近极限时码会密到
 * 打印后基本扫不出来，而且 DOM 体积会涨到几百 KB。超限直接给占位框 + 警告。
 */
export const QR_MAX_BYTES = 2000

function round(n: number, digits = 4): number {
  const k = 10 ** digits
  return Math.round(n * k) / k
}

/**
 * XML 属性 / 文本转义。
 * 颜色值是用户可填的字符串，直接拼进属性里，一个引号就能把 SVG 结构冲烂
 * （预览与打印用的都是 iframe，等于一个 XSS 入口），所以一律转义。
 * 不复用 html.ts 的 escapeHtml：那个文件会 import 本模块，反向引用会形成循环依赖。
 */
function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;',
  )
}

/** 颜色兜底：空串 / 纯空白都当没填，避免产出 fill="" 这种非法属性 */
function colorOf(v: string | undefined, fallback: string): string {
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : fallback
}

/** SVG 根：宽高用 mm（打印 1:1），viewBox 用内部坐标 */
function svgRoot(wMm: number, hMm: number, vbW: number, vbH: number): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${round(wMm, 3)}mm" height="${round(hMm, 3)}mm" ` +
    `viewBox="0 0 ${round(vbW)} ${round(vbH)}" shape-rendering="crispEdges">`
  )
}

/** 字符串的 UTF-8 字节数（二维码按字节模式编码，容量按字节算而不是字符数） */
export function utf8ByteLength(s: string): number {
  return new TextEncoder().encode(s).length
}

// ============================================================
// 二维码
// ============================================================

export interface QrOptions {
  /** 边长（mm）。二维码必须正方形，非正方形会被拉伸到扫不出来 */
  sizeMm: number
  /** 纠错等级，默认 'M'（约 15% 容错） */
  ecLevel?: 'L' | 'M' | 'Q' | 'H'
  foreground?: string
  background?: string
}

function normalizeEc(ec: QrOptions['ecLevel']): 'L' | 'M' | 'Q' | 'H' {
  return ec === 'L' || ec === 'Q' || ec === 'H' ? ec : 'M'
}

/**
 * 生成二维码 SVG。
 *
 * 用 `qrcode-generator` 只取它的**模块矩阵**（isDark），自己拼 SVG：
 * 库自带的 createSvgTag 不方便控 mm 尺寸、静默区与前景/背景色，也无法做行内合并。
 */
export function qrCodeSvg(text: string, opts: QrOptions): string {
  const value = typeof text === 'string' ? text : String(text ?? '')
  const sizeMm = finite(opts?.sizeMm, 0)
  if (value.length === 0 || sizeMm <= 0) return ''

  let qr: ReturnType<typeof qrcode>
  try {
    qr = qrcode(0, normalizeEc(opts?.ecLevel))
    qr.addData(value)
    qr.make()
  } catch {
    // 内容超过版本 40 的容量上限时库会抛错：当作"编码不了"处理
    return ''
  }
  const n = qr.getModuleCount()
  if (!Number.isFinite(n) || n <= 0) return ''

  const total = n + QR_QUIET_ZONE * 2
  const fg = colorOf(opts?.foreground, DEFAULT_FG)
  const bg = colorOf(opts?.background, DEFAULT_BG)

  let modules = ''
  for (let r = 0; r < n; r++) {
    let c = 0
    while (c < n) {
      if (!qr.isDark(r, c)) {
        c++
        continue
      }
      // 同一行里连续的暗模块合并成一个 rect。
      // 逐模块输出的隐患：版本 40 的码有 177×177 ≈ 3.1 万个模块，逐个出 rect 会让
      // HTML 涨到近 1MB，而整篇文档还要被塞进预览 iframe 与打印窗口。
      // 行内合并后渲染结果完全一致（crispEdges 下相邻矩形无缝、无色差）。
      let run = 1
      while (c + run < n && qr.isDark(r, c + run)) run++
      modules += `<rect x="${c + QR_QUIET_ZONE}" y="${r + QR_QUIET_ZONE}" width="${run}" height="1"/>`
      c += run
    }
  }

  return (
    svgRoot(sizeMm, sizeMm, total, total) +
    `<rect x="0" y="0" width="${total}" height="${total}" fill="${esc(bg)}"/>` +
    `<g fill="${esc(fg)}">${modules}</g>` +
    '</svg>'
  )
}

// ============================================================
// 条形码：Code 128（Code Set B）
// ============================================================

export interface BarcodeOptions {
  widthMm: number
  heightMm: number
  /** 码下方是否显示原文（便于人工核对；扫码器不需要这行） */
  showText?: boolean
  foreground?: string
  background?: string
}

/**
 * Code 128 的 107 个符号模式（值 0–106）。
 *
 * 每项是各段"条 / 空"的宽度（用字符串存，逐位即谓词），段序固定为
 * 条、空、条、空、条、空；除 STOP 的多出第 7 段外，每段宽度 1–4、合计 11 个模块。
 * 数据取自 Code 128 规范（同 ISO/IEC 15417 Annex 的表）：
 *   103 = START A、104 = START B、105 = START C、106 = STOP
 */
const C128_PATTERNS: readonly string[] = [
  '212222', '222122', '222221', '121223', '121322', '131222', '122213', '122312', '132212', '221213',
  '221312', '231212', '112232', '122132', '122231', '113222', '123122', '123221', '223211', '221132',
  '221231', '213212', '223112', '312131', '311222', '321122', '321221', '312212', '322112', '322211',
  '212123', '212321', '232121', '111323', '131123', '131321', '112313', '132113', '132311', '211313',
  '231113', '231311', '112133', '112331', '132131', '113123', '113321', '133121', '313121', '211331',
  '231131', '213113', '213311', '213131', '311123', '311321', '331121', '312113', '312311', '332111',
  '314111', '221411', '431111', '111224', '111422', '121124', '121421', '141122', '141221', '112214',
  '112412', '122114', '122411', '142112', '142211', '241211', '221114', '413111', '241112', '134111',
  '111242', '121142', '121241', '114212', '124112', '124211', '411212', '421112', '421211', '212141',
  '214121', '412121', '111143', '111341', '131141', '114113', '114311', '411113', '411311', '113141',
  '114131', '311141', '411131', '211412', '211214', '211232', '2331112',
]

/** CODE B 起始符 */
const C128_START_B = 104
/** 停止符（13 个模块，其余都是 11 个） */
const C128_STOP = 106

// ⛔ 这里原来还导出了 `C128_START_B_BITS` / `C128_STOP_BITS` / `C128_MODULES_PER_CHAR`
//    三个常量，注释写的是"供自测与文档引用"。2026-09-21 清死导出时删掉 ——
//    ⚠️ **那句注释本身已经不实了**：自测里一条都没引用，文档里也没有。
//    ⇒ 别再按"这是给测试用的"去恢复它们：真要校验位串，从 `C128_PATTERNS[C128_START_B]`
//      经 `patternBits()` 算出来即可（就是 `encodeCode128B` 内部在做的同一件事）。
//
/**
 * 内容能否用 Code 128（Code Set B）编码。
 *
 * v1 只做 Code Set B：覆盖 ASCII 32–126，不需要切码集。
 * 中文等非 ASCII 一律编码不了 —— **必须显式告诉用户**，不能悄悄出一个空码。
 */
export function isCode128Encodable(text: string): boolean {
  if (typeof text !== 'string' || text.length === 0) return false
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    if (c < 32 || c > 126) return false
  }
  return true
}

/** 符号模式 → 模块位串（'1' = 条，'0' = 空） */
function patternBits(pattern: string): string {
  let out = ''
  for (let i = 0; i < pattern.length; i++) {
    const w = pattern.charCodeAt(i) - 48
    out += (i % 2 === 0 ? '1' : '0').repeat(w)
  }
  return out
}

/** Code Set B 完整位串：START B + 数据 + 校验位 + STOP */
function encodeCode128B(text: string): string {
  if (!isCode128Encodable(text)) return ''
  const values: number[] = []
  for (let i = 0; i < text.length; i++) values.push(text.charCodeAt(i) - 32)

  // 校验位 = (START B + Σ(i × value_i)) mod 103，i 从 1 开始计
  let sum = C128_START_B
  for (let i = 0; i < values.length; i++) sum += (i + 1) * values[i]
  const check = sum % 103

  let bits = patternBits(C128_PATTERNS[C128_START_B])
  for (const v of values) bits += patternBits(C128_PATTERNS[v])
  bits += patternBits(C128_PATTERNS[check])
  bits += patternBits(C128_PATTERNS[C128_STOP])
  return bits
}

/** 码下方原文行的高度（mm），随码高自适应但设上限，免得喧宾夺主 */
const BARCODE_TEXT_MAX_MM = 4
const BARCODE_TEXT_MIN_MM = 2.5

/**
 * 生成条形码（Code 128 / Code Set B）SVG。
 *
 * viewBox 直接用 mm 作内部坐标：条宽 = 元素宽 / 总模块数，最后一行文字也按 mm 定位，
 * 这样"码宽 = 元素宽"是天然成立的，不需要再做一次比例换算。
 */
export function barcodeSvg(text: string, opts: BarcodeOptions): string {
  const value = typeof text === 'string' ? text : String(text ?? '')
  const wMm = finite(opts?.widthMm, 0)
  const hMm = finite(opts?.heightMm, 0)
  if (value.length === 0 || wMm <= 0 || hMm <= 0) return ''

  const bits = encodeCode128B(value)
  if (bits.length === 0) return ''

  const total = bits.length
  const moduleW = wMm / total
  const fg = colorOf(opts?.foreground, DEFAULT_FG)
  const bg = colorOf(opts?.background, DEFAULT_BG)

  const showText = opts?.showText === true
  const textH = showText ? Math.min(BARCODE_TEXT_MAX_MM, Math.max(BARCODE_TEXT_MIN_MM, hMm * 0.22)) : 0
  const barH = Math.max(1, hMm - textH)

  // 条：位串里每个连续的 '1' 段就是一个矩形（3 个符号 ≈ 3 个 bar，节点数很少）
  let bars = ''
  let i = 0
  while (i < total) {
    if (bits[i] === '0') {
      i++
      continue
    }
    let run = 1
    while (i + run < total && bits[i + run] === '1') run++
    bars += `<rect x="${round(i * moduleW)}" y="0" width="${round(run * moduleW)}" height="${round(barH)}"/>`
    i += run
  }

  let textEl = ''
  if (showText) {
    // 字号：先按预留的文字区高度定，再按宽度收一次 —— 长内容不能横着溢出元素。
    // 0.62 是等宽字体的经验字宽系数，宁可略小也不要顶出边界。
    const byHeight = textH * 0.85
    const byWidth = (wMm * 0.98) / Math.max(1, value.length * 0.62)
    const fontSize = Math.max(0.5, Math.min(byHeight, byWidth))
    const baseline = hMm - textH * 0.12
    textEl =
      `<text x="${round(wMm / 2)}" y="${round(baseline)}" text-anchor="middle" ` +
      `font-family="ui-monospace, SFMono-Regular, Menlo, Consolas, monospace" ` +
      `font-size="${round(fontSize, 3)}" fill="${esc(fg)}">${esc(value)}</text>`
  }

  return (
    svgRoot(wMm, hMm, wMm, hMm) +
    `<rect x="0" y="0" width="${round(wMm)}" height="${round(hMm)}" fill="${esc(bg)}"/>` +
    `<g fill="${esc(fg)}">${bars}</g>` +
    textEl +
    '</svg>'
  )
}
