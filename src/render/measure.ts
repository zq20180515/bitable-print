/**
 * DOM 测量：分页必须知道每个块的**真实渲染高度**，否则只能靠猜。
 *
 * 三个必须遵守的点（都是上一轮踩过的坑）：
 * 1) 容器用 `position:absolute; visibility:hidden; left:-99999px`，
 *    **绝对不能用 `display:none`** —— 那样元素根本不参与布局，量到的永远是 0。
 * 2) 参与 CSS 计算的数字全部过 `finite()`。无头环境里 getBoundingClientRect 全返回 0，
 *    一旦把 NaN 写进 style，浏览器会**整条**丢弃这个声明，页面直接错位，比报错还难查。
 * 3) 测量宽度必须**精确等于版心宽度**，否则换行位置不同、高度就不同，
 *    分页结果和实际打印结果会对不上（"预览 3 页、打印出来 4 页"就是这个原因）。
 * 4) 写完 innerHTML **不能立刻读高度**：`<img>` 在解码完成前 `complete === false`、
 *    固有尺寸未知，`height:auto` 的图片此刻高度是 0。而分页对 0 的处理是
 *    "量不到 → 走估算兜底"，一张 120mm 的图会被当成 8mm 排进页面，**打印时与下方元素重叠**。
 *    所以读之前必须 `settleImages()` 等一次图片就绪 —— 但**必须带超时**，
 *    否则一张永远加载不出来的图会把分页卡死（比量错更糟：用户连预览都看不到）。
 *
 * 本文件是唯一允许接触 DOM 的渲染模块（html.ts / layout.ts 都保持纯函数）。
 */

import { finite, mmToPx, pxToMm } from '../lib/types'
import { FONT_STACK } from './html'

export interface MeasureItem {
  elementId: string
  /** 块内部内容的 HTML（与最终打印时插入的完全一致） */
  html: string
  /** 该块的宽度（mm）。不同块宽度可以不同，测量时会按宽度分组 */
  widthMm: number
  /** 表格需要**逐行**高度（按行拆分时才可能重复表头） */
  measureRows?: boolean
}

export interface MeasuredBox {
  elementId: string
  /** 高度（mm） */
  heightMm: number
  /** 表格逐行高度（mm），与 DOM 中 <tr> 顺序一致 */
  rowHeightsMm?: number[]
  /** 是否真的量到了（无头环境下为 false，调用方需要走估算兜底） */
  ok: boolean
}

export interface MeasureHost {
  /** 测量容器；调用方可读它确认样式 */
  readonly container: HTMLElement
  readonly doc: Document
  destroy(): void
}

export interface MeasureOptions {
  /** 每处理多少个块让出一次主线程（对应 PRD E-43：不能用一次长任务把侧边栏卡死） */
  batchSize?: number
  onProgress?: (done: number, total: number) => void
  signal?: AbortSignal
  /**
   * 图片就绪等待上限（ms），默认 {@link IMAGE_SETTLE_TIMEOUT_MS}。
   * 做成可传参是为了让**超时兜底这件事本身**能被断言（断言里把 2s 压到几十 ms），
   * 而不是让测试依赖"某张图恰好慢"。
   */
  imageTimeoutMs?: number
}

/** 当前环境是否具备 DOM 测量能力（Node 里跑纯逻辑自测时为 false） */
export function canMeasure(): boolean {
  return typeof document !== 'undefined' && !!document.body
}

/** 与打印时一致的基线样式，保证"量到的"就是"打出来的" */
function baseStyle(): string {
  return [
    'position:absolute',
    'visibility:hidden',
    'left:-99999px',
    'top:0',
    'pointer-events:none',
    'z-index:-1',
    'box-sizing:border-box',
    'padding:0',
    'margin:0',
    `font-family:${FONT_STACK}`,
    'color:#1f2329',
    'line-height:1.5',
    '-webkit-print-color-adjust:exact',
    'print-color-adjust:exact',
  ].join(';')
}

export function createMeasureHost(doc: Document = document): MeasureHost {
  const container = doc.createElement('div')
  container.setAttribute('data-bp-measure-host', '')
  container.style.cssText = `${baseStyle()};width:0;`
  doc.body.appendChild(container)
  return {
    container,
    doc,
    destroy() {
      try {
        container.remove()
      } catch {
        /* 忽略：容器可能已经被别处移除 */
      }
    },
  }
}

/**
 * 让出主线程一帧，避免长循环把界面冻住。
 *
 * ⚠️ **页面不可见时必须换用 `setTimeout`**（2026-09-21 修的真 bug，e2e 里实测出来的）：
 * `requestAnimationFrame` 在**隐藏页里根本不会触发**（Chrome 会挂起隐藏页的动画帧），
 * 于是这个 Promise **永远不 resolve** ⇒ 调用方的分批循环**永久停住**。
 *
 * 现场读数（e2e，headless 窗口被判为"被遮挡"）：
 *   `visibility="hidden"` / `raf="NOT-fired-within-1200ms"` / 进度卡在「正在排版 18/420」不动。
 * 真机上的等价场景：用户点了「下一步：预览」之后**切到别的标签页**（或把窗口最小化）——
 * 预览会一直停在"正在排版"，切回来才继续。隐藏期间后台定时器会被节流（约 1s/次），
 * 但**至少会往前走**，不会永远不动 —— 这是"可用"与"死掉"的区别。
 *
 * 单一来源：`pipeline.ts` 里原本**抄了一份一模一样的**（两份都会踩同一个坑，而且改一份忘一份）。
 * 现在只留这一份并导出，pipeline 从这里引。
 */
export function yieldToHost(): Promise<void> {
  return new Promise<void>((resolve) => {
    const canRaf =
      typeof requestAnimationFrame === 'function' &&
      typeof document !== 'undefined' &&
      document.visibilityState !== 'hidden'
    if (canRaf) requestAnimationFrame(() => resolve())
    else setTimeout(resolve, 0)
  })
}

/**
 * 图片就绪等待上限（ms）。
 *
 * 取 2s 的理由：这是"给一张冷启动的图一次机会"的上限，不是性能预算。真实飞书环境里
 * 附件走的是**算出来的**高度（`html.ts` 的附件容器写死 width/height，img 绝对定位），
 * 完全不受这条路径影响；会走到这里的只有老模板里 `h:'auto'` 的固定图片，而那类图是
 * **内联在模板 JSON 里的 dataURL**（单张 ≤300KB），没有网络往返，只有本地解码。
 * 本地解码 2s 已经是极端值，再长就是在替"图片坏了"陪跑。
 */
export const IMAGE_SETTLE_TIMEOUT_MS = 2000

/** 图片是否已经就绪（`complete` 覆盖"加载成功"和"加载失败"两种终态） */
function isImageReady(img: HTMLImageElement): boolean {
  return img.complete === true
}

/**
 * 等一张图片就绪。**三条路谁先到算谁**：load/error 事件、`decode()`、超时。
 *
 * 为什么不能只等 `onload`：`<img>` 的 src 可能是已经失效的临时链接，也可能压根
 * 没绑上 load 监听（就在 `innerHTML` 之后才创建）—— 只等事件会出现"永远等下去"。
 * 为什么不能只等 `decode()`：旧内核不实现 `decode()`，且它对坏图 reject 得比
 * load 事件晚。所以事件 + decode + 超时三者并存，任何一条先到就放行。
 */
function settleOneImage(img: HTMLImageElement, timeoutMs: number): Promise<void> {
  if (isImageReady(img)) return Promise.resolve()
  return new Promise<void>((resolve) => {
    let done = false
    const finish = (): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      try {
        img.removeEventListener('load', finish)
        img.removeEventListener('error', finish)
      } catch {
        /* 忽略：假 DOM / 已销毁元素 */
      }
      resolve()
    }
    const timer = setTimeout(finish, Math.max(0, timeoutMs))
    try {
      img.addEventListener('load', finish)
      img.addEventListener('error', finish)
    } catch {
      /* 忽略：没有事件能力的实现（例如测试里的假元素）直接靠 decode/超时兜底 */
    }
    // 缓存命中时可能在上面两行之间就已经就绪 —— 补一次检查，避免白等到超时
    if (isImageReady(img)) {
      finish()
      return
    }
    if (typeof img.decode === 'function') {
      try {
        img.decode().then(finish, finish)
      } catch {
        finish()
      }
    }
  })
}

/**
 * 等这一批 wrapper 里的图片全部就绪（带超时）。
 *
 * 分组逻辑不动：按宽度分组是为了"一次设宽度、多次读高度"减少强制同步布局，
 * 图片等待插在"写完 innerHTML"和"统一读高度"之间，正是这个模式留给等待的位置。
 */
export async function settleImages(
  wrappers: ArrayLike<Element>,
  timeoutMs: number = IMAGE_SETTLE_TIMEOUT_MS,
): Promise<void> {
  const imgs: HTMLImageElement[] = []
  for (let i = 0; i < wrappers.length; i++) {
    const wrap = wrappers[i]
    const found = wrap.querySelectorAll('img')
    for (let j = 0; j < found.length; j++) imgs.push(found[j] as HTMLImageElement)
  }
  if (imgs.length === 0) return
  await Promise.all(imgs.map((img) => settleOneImage(img, timeoutMs)))
}

/**
 * 读一个元素的高度（px）。
 * 优先 getBoundingClientRect（小数精度，避免小字号块因为取整误差累积成整页偏差），
 * 拿不到再退 offsetHeight。
 */
function readHeightPx(el: Element): number {
  let h = 0
  if (typeof el.getBoundingClientRect === 'function') {
    h = el.getBoundingClientRect().height
  }
  if (!Number.isFinite(h) || h <= 0) {
    h = (el as HTMLElement).offsetHeight
  }
  return finite(h, 0)
}

/**
 * 批量测量。
 *
 * 实现上按"宽度分组"再读写：CSS 里设置宽度会触发重排，如果每个块都
 * "设宽度 → 读高度"交替进行，会产生 O(n) 次强制同步布局；分组后同一宽度只需一次。
 */
export async function measureBlocks(
  host: MeasureHost,
  items: MeasureItem[],
  opts: MeasureOptions = {},
): Promise<Map<string, MeasuredBox>> {
  const out = new Map<string, MeasuredBox>()
  const total = items.length
  if (total === 0) return out

  const batchSize = Math.max(1, opts.batchSize ?? 30)
  const doc = host.doc
  let done = 0

  for (let start = 0; start < total; start += batchSize) {
    if (opts.signal?.aborted) break
    const batch = items.slice(start, start + batchSize)

    // 同一宽度归到一组，减少重排次数
    const groups = new Map<number, MeasureItem[]>()
    for (const it of batch) {
      const w = Math.max(0, finite(it.widthMm))
      const arr = groups.get(w)
      if (arr) arr.push(it)
      else groups.set(w, [it])
    }

    for (const [widthMm, group] of groups) {
      host.container.style.width = `${Math.max(0, mmToPx(widthMm))}px`
      const wrappers = group.map((it) => {
        const wrap = doc.createElement('div')
        wrap.setAttribute('data-bp-measure', it.elementId)
        wrap.style.cssText = 'width:100%;box-sizing:border-box;'
        // 用 innerHTML 而不是 textContent：必须复现真实 DOM 结构才能量准
        wrap.innerHTML = it.html
        host.container.appendChild(wrap)
        return wrap
      })
      // 图片必须先就绪再读：解码完成前 `<img>` 的固有尺寸未知、`height:auto` 高度为 0，
      // 会把"还没解码"误判成"内容很矮"（见文件头第 4 点）。带超时，不会把分页卡死。
      await settleImages(wrappers, opts.imageTimeoutMs)
      // 上面全部写完再统一读，避免读写交替触发多次强制布局
      wrappers.forEach((wrap, i) => {
        const item = group[i]
        const hPx = readHeightPx(wrap)
        let rowHeightsMm: number[] | undefined
        if (item.measureRows) {
          const trs = wrap.querySelectorAll('tr')
          if (trs.length > 0) {
            rowHeightsMm = Array.from(trs).map((tr) => finite(pxToMm(readHeightPx(tr)), 0))
          }
        }
        out.set(item.elementId, {
          elementId: item.elementId,
          heightMm: finite(pxToMm(hPx), 0),
          rowHeightsMm,
          ok: hPx > 0,
        })
      })
      for (const w of wrappers) w.remove()
    }

    done += batch.length
    opts.onProgress?.(Math.min(done, total), total)
    // 每批让出一次主线程（PRD E-43 / F2-33：分页不能阻塞 UI）
    if (done < total) await yieldToHost()
  }

  return out
}
