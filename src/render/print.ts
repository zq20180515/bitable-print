/**
 * 输出通道：系统打印 与 导出落盘（PRD F5.3 / E-47~E-49 / E-53）。
 *
 * 两条必须守住的底线：
 * 1) **绝不能直接调 `window.print()`** —— 插件跑在侧边栏 iframe 里，
 *    那样会把插件 UI、侧边栏、甚至宿主页面一起打印出来（F5-12 明确禁止）。
 *    正确做法是新建一个隐藏 iframe，把渲染结果写进去，只打印那个 iframe。
 * 2) 纯前端**不做 PDF 合成**（D-3 的决策）。html2canvas + jsPDF 对中日韩字体
 *    与分页的支持都很差，做不出 1:1 的效果。因此"导出 PDF"走两条路：
 *      - 真正要 PDF：交给浏览器的打印对话框，用户选"另存为 PDF"；
 *      - 要文件落盘：把**自包含的打印就绪 HTML** 直接写盘（双击即可用浏览器打开并打印）。
 */

import type { PageSetup } from '../lib/types'
import { finite, pageRenderSize } from '../lib/types'

// ============================================================
// 打印
// ============================================================

export interface PrintOptions {
  /** 等待图片加载的最长时间（ms）；附件 blob 图一般很快，8s 足够 */
  imageTimeoutMs?: number
  /** 兜底清理延迟（ms）。正常路径靠 afterprint 事件，这里只防事件不触发的浏览器 */
  cleanupDelayMs?: number
  /** 文档标题 */
  title?: string
}

/**
 * 打印时的兜底 `@page` 规则。
 * html.ts 产出的文档本身已经带 `@page`，这里只为"调用方传进来的是裸 HTML"这种情况兜底。
 */
function ensurePageRule(html: string, pageSetup: PageSetup): string {
  if (/@page/i.test(html)) return html
  const size = pageRenderSize(pageSetup)
  const m = pageSetup.margin
  const rule =
    `<style>@page{size:${mapped(size.w)}mm ${mapped(size.h)}mm;` +
    `margin:${mapped(finite(m?.top))}mm ${mapped(finite(m?.right))}mm ${mapped(finite(m?.bottom))}mm ${mapped(
      finite(m?.left),
    )}mm;}</style>`
  return /<\/head>/i.test(html) ? html.replace(/<\/head>/i, `${rule}</head>`) : rule + html
}

function mapped(n: number): number {
  return Math.round(finite(n) * 1000) / 1000
}

function nextFrame(): Promise<void> {
  return new Promise<void>((resolve) => {
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => resolve())
    else setTimeout(resolve, 16)
  })
}

/** 等图片解码完成，否则打印出来会有大片空白（尤其是附件图是 blob 链接时） */
async function waitForImages(doc: Document, timeoutMs: number): Promise<void> {
  const imgs = Array.from(doc.images ?? [])
  if (imgs.length === 0) return
  const all = Promise.all(
    imgs.map(
      (img) =>
        new Promise<void>((resolve) => {
          if (img.complete) {
            resolve()
            return
          }
          const done = (): void => resolve()
          img.addEventListener('load', done, { once: true })
          img.addEventListener('error', done, { once: true })
        }),
    ),
  )
  await Promise.race([all, new Promise<void>((resolve) => setTimeout(resolve, timeoutMs))])
}

/**
 * 用隐藏 iframe 打印。
 * `widthMm / heightMm` 是**实际渲染尺寸**（已应用横竖方向），仅用于日志与兜底 @page。
 */
export async function printDocument(
  html: string,
  pageSetup: PageSetup,
  widthMm: number,
  heightMm: number,
  opts: PrintOptions = {},
): Promise<void> {
  if (typeof document === 'undefined') throw new Error('当前环境不支持打印（没有 DOM）')
  void widthMm
  void heightMm

  const iframe = document.createElement('iframe')
  iframe.setAttribute('aria-hidden', 'true')
  iframe.setAttribute('title', opts.title ?? '打印')
  // 用 0 尺寸 + visibility:hidden：不能 display:none（那样部分浏览器不会渲染内容，打印出来是空白）
  iframe.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden;'
  document.body.appendChild(iframe)

  const win = iframe.contentWindow
  const doc = win?.document
  if (!win || !doc) {
    iframe.remove()
    // E-54：弹窗/iframe 被拦截
    throw new Error('无法创建打印框架，请允许本站弹出窗口后重试')
  }

  try {
    doc.open()
    doc.write(ensurePageRule(html, pageSetup))
    doc.close()
  } catch (e) {
    iframe.remove()
    throw new Error(`写入打印内容失败：${e instanceof Error ? e.message : String(e)}`)
  }

  await waitForImages(doc, opts.imageTimeoutMs ?? 8000)
  await nextFrame()

  let cleaned = false
  const cleanup = (): void => {
    if (cleaned) return
    cleaned = true
    try {
      iframe.remove() // E-40 / E-53：打印结束后立刻回收，避免 iframe 常驻导致内存泄漏
    } catch {
      /* 忽略 */
    }
  }

  // 用户取消打印也会触发 afterprint（E-53：取消时静默清理，不提示）
  const onAfterPrint = (): void => {
    setTimeout(cleanup, 200)
  }
  try {
    win.addEventListener('afterprint', onAfterPrint, { once: true })
  } catch {
    /* 个别环境不支持，忽略 */
  }
  // 兜底：某些浏览器（或用户把对话框晾着）不会触发 afterprint
  setTimeout(cleanup, opts.cleanupDelayMs ?? 60000)

  try {
    win.focus()
    win.print()
  } catch (e) {
    cleanup()
    throw new Error(`调起打印失败：${e instanceof Error ? e.message : String(e)}。请允许本站弹出窗口后重试`)
  }
}

// ============================================================
// 导出落盘
// ============================================================

export type ExportStatus =
  /** 由用户选定位置后直接落盘（File System Access API） */
  | 'saved'
  /** 降级为浏览器下载到「下载」文件夹 */
  | 'downloaded'
  /** 用户主动取消（E-47：静默返回，不做任何提示） */
  | 'cancelled'

export interface ExportResult {
  status: ExportStatus
  fileName: string
  /** 给 UI 用的中文提示；status === 'cancelled' 时为 undefined */
  message?: string
}

/** 真正生成 PDF 只有一种可靠方式：浏览器的打印对话框（F5-15） */
export const PDF_GUIDANCE =
  '在打开的打印对话框中选择「目标打印机 = 另存为 PDF」即可得到 1:1 保真的 PDF。不要用截图代替，截图会丢失清晰度。'

// File System Access API 的最小声明。TS 的 DOM lib 里没有这个实验性 API，
// 且我们**不能引入任何新依赖**，所以就地声明。
interface WritableLike {
  write(data: Blob | string): Promise<void>
  close(): Promise<void>
}
interface FileHandleLike {
  createWritable(): Promise<WritableLike>
}
interface SavePickerOptionsLike {
  suggestedName?: string
  types?: Array<{ description?: string; accept: Record<string, string[]> }>
}
type SaveFilePickerLike = (opts: SavePickerOptionsLike) => Promise<FileHandleLike>

function getSavePicker(): SaveFilePickerLike | null {
  if (typeof window === 'undefined') return null
  const w = window as unknown as { showSaveFilePicker?: unknown }
  return typeof w.showSaveFilePicker === 'function' ? (w.showSaveFilePicker as SaveFilePickerLike) : null
}

function isAbortError(e: unknown): boolean {
  if (!e || typeof e !== 'object') return false
  const name = (e as { name?: unknown }).name
  return name === 'AbortError'
}

/** 触发浏览器下载（降级通道，E-48） */
export function triggerDownload(blob: Blob, fileName: string): void {
  if (typeof document === 'undefined') return
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  a.rel = 'noopener'
  a.style.display = 'none'
  document.body.appendChild(a)
  a.click()
  a.remove()
  // 立刻 revoke 会让部分浏览器下载失败，延迟回收
  setTimeout(() => {
    try {
      URL.revokeObjectURL(url)
    } catch {
      /* 忽略 */
    }
  }, 2000)
}

/**
 * 把打印就绪的 HTML 落盘。
 * `fileName` 若以 `.pdf` 结尾会被改成 `.html` —— 我们不能写出真正的 PDF 字节，
 * 用一个假 `.pdf` 扩展名去骗用户是更糟糕的选择（文件打不开）。
 */
export function saveHtmlFile(html: string, fileName: string, pageSetup: PageSetup): Promise<ExportResult> {
  void pageSetup
  return savePrintableFile(html, fileName)
}

async function savePrintableFile(html: string, fileName: string): Promise<ExportResult> {
  const target = normalizeHtmlName(fileName)
  const blob = new Blob([html], { type: 'text/html;charset=utf-8' })
  const picker = getSavePicker()

  if (picker) {
    try {
      const handle = await picker({
        suggestedName: target,
        types: [{ description: '打印就绪的 HTML 文档', accept: { 'text/html': ['.html', '.htm'] } }],
      })
      const writable = await handle.createWritable()
      await writable.write(blob)
      await writable.close()
      return { status: 'saved', fileName: target, message: `已保存：${target}` }
    } catch (e) {
      if (isAbortError(e)) {
        // E-47：用户主动取消，必须静默返回，连一句提示都不要弹
        return { status: 'cancelled', fileName: target }
      }
      // E-48：沙箱拒绝 / 权限问题 → 降级为下载
      triggerDownload(blob, target)
      return {
        status: 'downloaded',
        fileName: target,
        message: '无法直接写入所选位置，已保存到『下载』文件夹，可点浏览器右上角下载按钮查看',
      }
    }
  }

  // Firefox / Safari 等不支持 File System Access API，直接走降级
  triggerDownload(blob, target)
  return {
    status: 'downloaded',
    fileName: target,
    message: '已保存到『下载』文件夹，可点浏览器右上角下载按钮查看',
  }
}

function normalizeHtmlName(fileName: string): string {
  const base = String(fileName || '打印结果').trim().replace(/[\\/:*?"<>|]/g, '_')
  if (/\.(html?|htm)$/i.test(base)) return base
  return `${base.replace(/\.pdf$/i, '')}.html`
}

/**
 * P6「生成 PDF」按钮的落点。
 *
 * 诚实说明（与 PRD D-3 一致）：浏览器里**没有**纯前端静默生成 PDF 的能力，
 * 本函数因此产出的是"打印就绪的自包含 HTML"，用户双击即可用浏览器打开并一键另存为 PDF。
 * 需要真正的 PDF 时请配合 `printDocument()` + `PDF_GUIDANCE` 文案引导用户。
 */
export function exportPdf(html: string, pageSetup: PageSetup, fileName: string): Promise<ExportResult> {
  return saveHtmlFile(html, fileName, pageSetup)
}

/** 释放 blob URL（F4-28 / E-40：打印完成后必须回收，否则大批量图片会吃满内存） */
export function releaseObjectUrls(urls: Iterable<string>): void {
  for (const u of urls) {
    if (typeof u === 'string' && u.startsWith('blob:')) {
      try {
        URL.revokeObjectURL(u)
      } catch {
        /* 忽略：可能在别处已释放 */
      }
    }
  }
}
