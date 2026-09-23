/**
 * 附件图片流水线。
 *
 * 这是整个项目"最容易翻车"的一块，PRD F4.4 的每条约束都在这里落地：
 *
 * 1. **链接 10 分钟过期**（F4-23）：进预览/打印前必须重新获取 URL，绝不能复用编辑阶段的链接。
 *    但"每次操作都重下一遍"又太浪费，所以这里做了一个 **8 分钟软缓存**：
 *    年龄未超 8 分钟直接复用已下载的 blob（留 2 分钟安全边际），超过则重新解析。
 *
 * 2. **并发必须自己控**（F4-25）：官方对批量接口明确禁止并发，所以下载走并发池（默认 4–5）。
 *
 * 3. **CORS 不确定性**（F4-24）：`fetch` 是否放行取决于飞书返回头，必须 try/catch，
 *    失败项要报给用户，并提供"只导出文件名"的降级开关（F4-27）。
 *
 * 4. **不拉伸**（F4-14）：等比缩放的前提是知道原图像素尺寸。这里**解析图片文件头**拿宽高，
 *    而不是用 canvas 解码 —— 这样在 Node 里也能跑测试，且不产生解码开销。
 */

import type { AttachmentPrintConfig } from './types'
import { PT_TO_MM, mmToPx } from './types'
import type { DataSource, FieldMeta, RecordItem } from './data-source'
import { FT, extOf, isImageAttachment, isVectorImage } from './field-types'
import { imageKey } from '../render/context'
import type { ResolvedImage } from '../render/context'
import { abortError, createPool, isAbortError } from './pool'

// ============================================================
// 类型
// ============================================================

export interface ImageFailure {
  recordId: string
  fieldId: string
  fieldName: string
  attachmentName: string
  token: string
  reason: string
}

export type ImageWarningCode = 'low-dpi' | 'too-large' | 'unsupported-format' | 'no-image'

export interface ImageWarning {
  code: ImageWarningCode
  message: string
  recordId?: string
  fieldId?: string
  fieldName?: string
  attachmentName?: string
  /** 有效 DPI，仅 low-dpi 时给出 */
  dpi?: number
}

export interface ResolveStats {
  /** 涉及的记录数 */
  records: number
  /** 需要处理的附件字段数 */
  fields: number
  /** 候选附件总数 */
  candidates: number
  /** 实际判定为图片的数量 */
  images: number
  /** 成功下载 */
  downloaded: number
  /** 命中缓存直接复用 */
  cached: number
  /** 失败 */
  failed: number
  /** 跳过的非图片附件 */
  skippedNonImage: number
  /** 因体积过大跳过 */
  skippedTooLarge: number
  /** 因只导文件名而整体跳过 */
  skippedTextOnly: boolean
  elapsedMs: number
}

export interface ResolveAttachmentResult {
  /** imageKey(recordId, fieldId) → 已解析图片。渲染层只认这个 Map */
  images: Map<string, ResolvedImage[]>
  failures: ImageFailure[]
  warnings: ImageWarning[]
  stats: ResolveStats
}

export interface ResolveAttachmentOptions {
  ds: DataSource
  tableId: string
  records: RecordItem[]
  fields: FieldMeta[]
  /** 只解析这些附件字段；为空表示解析全部附件字段 */
  fieldIds?: string[]
  config: AttachmentPrintConfig
  /** preview 会生成缩略图（省内存），print 用原图（保清晰度） */
  quality?: 'preview' | 'print'
  /** 无视软缓存，强制重新解析（用户点"重新加载图片"时用） */
  force?: boolean
  /** 并发上限，默认 4（官方禁止并发调用批量接口，宁慢勿错） */
  concurrency?: number
  onProgress?: (done: number, total: number, phase: 'url' | 'download') => void
  signal?: AbortSignal
}

/** 预览缩略图的最大边长（F4-26：侧边栏内存有限，全尺寸图会 OOM） */
const THUMB_MAX_PX = 400
/** 软缓存有效期。链接 10 分钟过期，留 2 分钟安全边际 */
const CACHE_TTL_MS = 8 * 60 * 1000

// ============================================================
// 软缓存
// ============================================================

interface CacheEntry {
  at: number
  blob: Blob
  /** 原图的对象 URL（打印用） */
  url: string
  /** 预览缩略图的对象 URL（仅 quality='preview' 且图片够大时生成） */
  thumbUrl?: string
  widthPx: number
  heightPx: number
  mime: string
}

/** token → 已下载的图片。跨调用共享，避免预览和打印各下一遍 */
const blobCache = new Map<string, CacheEntry>()

/** 主动释放全部缓存（F4-28）。打印结束或用户离开向导时调用 */
export function releaseAttachmentCache(): void {
  for (const entry of blobCache.values()) {
    try {
      URL.revokeObjectURL(entry.url)
    } catch {
      /* 忽略：revoke 失败不影响功能 */
    }
  }
  blobCache.clear()
}
// ============================================================
// 主流程
// ============================================================

export async function resolveAttachmentImages(opts: ResolveAttachmentOptions): Promise<ResolveAttachmentResult> {
  const t0 = now()
  const { ds, tableId, records, fields, config } = opts
  const signal = opts.signal
  const quality = opts.quality ?? 'preview'

  const images = new Map<string, ResolvedImage[]>()
  const failures: ImageFailure[] = []
  const warnings: ImageWarning[] = []

  const stats: ResolveStats = {
    records: records.length,
    fields: 0,
    candidates: 0,
    images: 0,
    downloaded: 0,
    cached: 0,
    failed: 0,
    skippedNonImage: 0,
    skippedTooLarge: 0,
    skippedTextOnly: false,
    elapsedMs: 0,
  }

  // 「只导出文件名」降级：跳过全部下载（F4-27）
  if (config.textOnlyFallback || config.mode === 'none' || config.mode === 'nameOnly') {
    stats.skippedTextOnly = Boolean(config.textOnlyFallback)
    stats.elapsedMs = now() - t0
    return { images, failures, warnings, stats }
  }

  // 1) 找出需要处理的附件字段
  const attFields = fields.filter(
    (f) => f.type === FT.Attachment && (!opts.fieldIds || opts.fieldIds.includes(f.id)),
  )
  stats.fields = attFields.length
  if (attFields.length === 0) {
    stats.elapsedMs = now() - t0
    return { images, failures, warnings, stats }
  }

  // 2) 收集待处理任务：每张图片一个任务
  interface Job {
    recordId: string
    fieldId: string
    fieldName: string
    token: string
    name: string
    size: number
    mime?: string
  }
  const jobs: Job[] = []
  const seenToken = new Set<string>()

  for (const rec of records) {
    for (const f of attFields) {
      const raw = rec.fields[f.id]
      if (!Array.isArray(raw)) continue
      for (const a of raw) {
        if (!a || typeof a !== 'object') continue
        const att = a as { name?: unknown; size?: unknown; type?: unknown; token?: unknown }
        const name = typeof att.name === 'string' ? att.name : ''
        const token = typeof att.token === 'string' ? att.token : ''
        if (!token) continue
        stats.candidates++

        if (!isImageAttachment(name, typeof att.type === 'string' ? att.type : undefined)) {
          stats.skippedNonImage++
          continue
        }
        const size = typeof att.size === 'number' ? att.size : 0
        if (size > config.maxFileSizeMb * 1024 * 1024) {
          stats.skippedTooLarge++
          warnings.push({
            code: 'too-large',
            message: `${name} 体积 ${(size / 1024 / 1024).toFixed(1)}MB 超过上限 ${config.maxFileSizeMb}MB，已跳过`,
            recordId: rec.recordId,
            fieldId: f.id,
            fieldName: f.name,
            attachmentName: name,
          })
          continue
        }
        if (seenToken.has(token)) continue
        seenToken.add(token)
        jobs.push({
          recordId: rec.recordId,
          fieldId: f.id,
          fieldName: f.name,
          token,
          name,
          size,
          mime: typeof att.type === 'string' ? att.type : undefined,
        })
      }
    }
  }
  stats.images = jobs.length

  if (jobs.length === 0) {
    stats.elapsedMs = now() - t0
    return { images, failures, warnings, stats }
  }

  // 3) 并发下载（受控），按 figure 逐个回填
  const pool = createPool(Math.max(1, Math.min(opts.concurrency ?? 4, 5)))
  let done = 0
  const bump = (phase: 'url' | 'download') => {
    done++
    opts.onProgress?.(done, jobs.length, phase)
  }

  /** 先把同一 (recordId, fieldId) 的图片归到一组，减少 getAttachmentUrls 的调用次数 */
  const byCell = new Map<string, Job[]>()
  for (const j of jobs) {
    const k = imageKey(j.recordId, j.fieldId)
    const arr = byCell.get(k)
    if (arr) arr.push(j)
    else byCell.set(k, [j])
  }

  const tasks: Array<Promise<void>> = []
  for (const [key, cellJobs] of byCell) {
    tasks.push(
      (async () => {
        // 3.1 整格一次性取 URL（SDK 内部按 5 个 token 一组切片，不用自己切）
        const fresh = opts.force ? [] : cellJobs.filter((j) => !isFresh(j.token))
        let urlByToken = new Map<string, string>()

        const needUrl = cellJobs.filter((j) => !isFresh(j.token) || !urlByToken.has(j.token))
        if (needUrl.length > 0) {
          try {
            const urls = await ds.getAttachmentUrls(
              tableId,
              cellJobs[0].recordId,
              cellJobs[0].fieldId,
              needUrl.map((j) => j.token),
            )
            needUrl.forEach((j, i) => {
              if (urls[i]) urlByToken.set(j.token, urls[i])
            })
          } catch (e) {
            const reason = isAbortError(e) ? '已取消' : `获取链接失败：${msg(e)}`
            for (const j of needUrl) {
              failures.push(toFailure(j, reason))
              stats.failed++
              bump('url')
            }
            urlByToken = new Map()
          }
        }

        void fresh

        // 3.2 逐个下载（仍受同一个池子约束）
        await Promise.all(
          cellJobs.map((j) =>
            pool
              .run(async () => {
                if (signal?.aborted) throw abortError()

                // 命中软缓存：直接复用
                const hit = !opts.force ? getFresh(j.token) : null
                if (hit) {
                  stats.cached++
                  pushImage(images, key, {
                    token: j.token,
                    name: j.name,
                    url: quality === 'print' ? hit.url : (hit.thumbUrl ?? hit.url),
                    widthPx: hit.widthPx,
                    heightPx: hit.heightPx,
                    mime: hit.mime,
                  })
                  checkDpi(warnings, j, hit.widthPx, hit.heightPx, opts.config)
                  bump('download')
                  return
                }

                const url = urlByToken.get(j.token)
                if (!url) {
                  // URL 阶段已经记过失败，这里不重复记
                  bump('download')
                  return
                }

                const result = await downloadWithRetry(url, j, signal)
                if (!result.ok) {
                  failures.push(toFailure(j, result.reason))
                  stats.failed++
                  bump('download')
                  return
                }

                const blob = result.blob
                const dims = await measureImage(blob, j.name, j.mime)
                if (dims.unsupported) {
                  warnings.push({
                    code: 'unsupported-format',
                    message: `${j.name} 的图片格式浏览器支持较弱，可能无法正常显示`,
                    recordId: j.recordId,
                    fieldId: j.fieldId,
                    fieldName: j.fieldName,
                    attachmentName: j.name,
                  })
                }

                const objectUrl = URL.createObjectURL(blob)
                const thumbUrl =
                  quality === 'preview' && !isVectorImage(j.name, j.mime)
                    ? await makeThumbnail(objectUrl, blob, dims.widthPx, dims.heightPx)
                    : undefined

                blobCache.set(j.token, {
                  at: now(),
                  blob,
                  url: objectUrl,
                  thumbUrl,
                  widthPx: dims.widthPx,
                  heightPx: dims.heightPx,
                  mime: j.mime ?? blob.type ?? '',
                })

                stats.downloaded++
                pushImage(images, key, {
                  token: j.token,
                  name: j.name,
                  url: quality === 'print' ? objectUrl : (thumbUrl ?? objectUrl),
                  widthPx: dims.widthPx,
                  heightPx: dims.heightPx,
                  mime: j.mime ?? blob.type ?? '',
                })
                checkDpi(warnings, j, dims.widthPx, dims.heightPx, opts.config)
                bump('download')
              }, signal)
              .catch((e) => {
                // 取消是正常流程（E-52），不要记成失败
                if (!isAbortError(e)) {
                  failures.push(toFailure(j, msg(e)))
                  stats.failed++
                }
              }),
          ),
        )
      })(),
    )
  }

  await Promise.all(tasks)
  await pool.onIdle()

  stats.elapsedMs = now() - t0
  return { images, failures, warnings, stats }
}

// ============================================================
// 下载与重试
// ============================================================

async function downloadWithRetry(
  url: string,
  job: { name: string; mime?: string },
  signal?: AbortSignal,
): Promise<{ ok: true; blob: Blob } | { ok: false; reason: string }> {
  const attempts = 2 // 首次 + 重试 1 次（F4-24）
  let lastReason = ''
  for (let i = 0; i < attempts; i++) {
    if (signal?.aborted) return { ok: false, reason: '已取消' }
    try {
      const resp = await fetch(url, { signal })
      if (!resp.ok) {
        lastReason = `HTTP ${resp.status}`
      } else {
        const blob = await resp.blob()
        if (blob.size === 0) {
          lastReason = '返回内容为空'
        } else {
          return { ok: true, blob }
        }
      }
    } catch (e) {
      if (isAbortError(e) || signal?.aborted) return { ok: false, reason: '已取消' }
      // CORS 被拦时 fetch 会抛 TypeError: Failed to fetch
      lastReason = msg(e)
    }
  }
  return {
    ok: false,
    reason: /failed to fetch|networkerror/i.test(lastReason)
      ? '网络或跨域限制（CORS）导致无法读取'
      : lastReason,
  }
}

// ============================================================
// 尺寸与清晰度
// ============================================================

interface DimResult {
  widthPx: number
  heightPx: number
  unsupported: boolean
}

/**
 * 拿图片像素尺寸。
 * 优先解析文件头（无解码开销、Node 可跑）；解析不了再退到 DOM 的 Image 解码。
 */
async function measureImage(blob: Blob, name: string, mime?: string): Promise<DimResult> {
  // SVG 是文本，直接找 width/height/viewBox
  if (isVectorImage(name, mime) || blob.type === 'image/svg+xml') {
    try {
      const text = await blob.slice(0, 4096).text()
      const size = parseSvgSize(text)
      if (size) return { ...size, unsupported: false }
    } catch {
      /* 落到下面的兜底 */
    }
    // 拿不到尺寸就用一个常见比例，渲染层会按"未知"处理
    return { widthPx: 0, heightPx: 0, unsupported: false }
  }

  const ext = extOf(name)
  try {
    const head = new Uint8Array(await blob.slice(0, 65536).arrayBuffer())
    const parsed = parseImageHeader(head)
    if (parsed) return { ...parsed, unsupported: false }
  } catch {
    /* 落到 DOM 兜底 */
  }

  // DOM 兜底（浏览器里才有）
  const fromDom = await measureViaImage(blob)
  if (fromDom) return { ...fromDom, unsupported: false }

  return {
    widthPx: 0,
    heightPx: 0,
    // TIFF / HEIC 这类浏览器支持弱的格式，走到这里就说明解不出来
    unsupported: ['tif', 'tiff', 'heic', 'heif', 'avif'].includes(ext),
  }
}

/** 解析 PNG / JPEG / GIF / BMP / WebP 的文件头拿宽高 */
export function parseImageHeader(b: Uint8Array): { widthPx: number; heightPx: number } | null {
  const be32 = (o: number) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0
  const le16 = (o: number) => b[o] | (b[o + 1] << 8)
  const le32 = (o: number) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0

  // PNG: 89 50 4E 47 0D 0A 1A 0A，IHDR 在偏移 16（宽）/20（高），大端
  // 注意边界是 >= 24（恰好 24 字节的最小合法 PNG 头也要能解析）
  if (b.length >= 24 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
    return { widthPx: be32(16), heightPx: be32(20) }
  }

  // GIF: "GIF87a" / "GIF89a"，宽高在偏移 6/8，小端 16 位
  if (b.length >= 10 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) {
    return { widthPx: le16(6), heightPx: le16(8) }
  }

  // BMP: "BM"，宽高在偏移 18/22，小端 32 位（有符号）
  if (b.length >= 26 && b[0] === 0x42 && b[1] === 0x4d) {
    const w = le32(18)
    const h = le32(22)
    return { widthPx: Math.abs(w | 0), heightPx: Math.abs(h | 0) }
  }

  // WebP: "RIFF"..."WEBP"，再按 VP8/VP8L/VP8X 分支
  if (
    b.length >= 30 &&
    b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
    b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50
  ) {
    const fourcc = String.fromCharCode(b[12], b[13], b[14], b[15])
    if (fourcc === 'VP8X') {
      const w = 1 + (b[24] | (b[25] << 8) | (b[26] << 16))
      const h = 1 + (b[27] | (b[28] << 8) | (b[29] << 16))
      return { widthPx: w, heightPx: h }
    }
    if (fourcc === 'VP8 ') {
      // 有损：帧头里 0x9D 0x01 0x2A 之后是 14 位宽高
      const w = le16(26) & 0x3fff
      const h = le16(28) & 0x3fff
      return { widthPx: w, heightPx: h }
    }
    if (fourcc === 'VP8L') {
      // 无损：位打包，前 14 位宽 −1，接着 14 位高 −1
      const bits = le32(21)
      return { widthPx: (bits & 0x3fff) + 1, heightPx: ((bits >> 14) & 0x3fff) + 1 }
    }
  }

  // JPEG: SOI FFD8，然后遍历段找 SOFn
  if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) {
    let o = 2
    while (o + 9 < b.length) {
      if (b[o] !== 0xff) {
        o++
        continue
      }
      const marker = b[o + 1]
      // SOF0..SOF15（跳过 DHT=C4 / JPG=C8 / DAC=CC）
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { widthPx: (b[o + 7] << 8) | b[o + 8], heightPx: (b[o + 5] << 8) | b[o + 6] }
      }
      const segLen = (b[o + 2] << 8) | b[o + 3]
      if (segLen < 2) break
      o += 2 + segLen
    }
  }

  return null
}

/** 从 SVG 文本里抠宽高（优先 width/height，其次 viewBox） */
export function parseSvgSize(text: string): { widthPx: number; heightPx: number } | null {
  const head = text.slice(0, 2048)
  const wAttr = /\bwidth\s*=\s*["']?\s*([\d.]+)/i.exec(head)
  const hAttr = /\bheight\s*=\s*["']?\s*([\d.]+)/i.exec(head)
  if (wAttr && hAttr) {
    const w = parseFloat(wAttr[1])
    const h = parseFloat(hAttr[1])
    if (w > 0 && h > 0) return { widthPx: w, heightPx: h }
  }
  const vb = /\bviewBox\s*=\s*["']?\s*[-\d.]+\s+[-\d.]+\s+([\d.]+)\s+([\d.]+)/i.exec(head)
  if (vb) {
    const w = parseFloat(vb[1])
    const h = parseFloat(vb[2])
    if (w > 0 && h > 0) return { widthPx: w, heightPx: h }
  }
  return null
}

/** 浏览器里用 Image 解码拿尺寸（文件头解析失败时的兜底） */
function measureViaImage(blob: Blob): Promise<{ widthPx: number; heightPx: number } | null> {
  if (typeof document === 'undefined' || typeof Image === 'undefined') return Promise.resolve(null)
  return new Promise((resolve) => {
    const url = URL.createObjectURL(blob)
    const img = new Image()
    const cleanup = (v: { widthPx: number; heightPx: number } | null) => {
      URL.revokeObjectURL(url)
      resolve(v)
    }
    img.onload = () => cleanup({ widthPx: img.naturalWidth, heightPx: img.naturalHeight })
    img.onerror = () => cleanup(null)
    img.src = url
    // 兜底超时，避免某些格式一直不触发 onload/onerror 卡住整个流程
    setTimeout(() => cleanup(null), 3000)
  })
}

/**
 * 有效 DPI 校验（F4-21）。
 * 只在配置了固定打印尺寸时才有意义 —— 原图尺寸模式下"清不清晰"由用户自己看着办。
 */
function checkDpi(
  warnings: ImageWarning[],
  job: { recordId: string; fieldId: string; fieldName: string; name: string },
  widthPx: number,
  heightPx: number,
  config: AttachmentPrintConfig,
): void {
  if (!widthPx || !heightPx) return
  if (config.sizeMode !== 'fixedHeight' || !config.fixedHeightMm) return

  // 按固定高度换算实际打印高度（mm），再算 DPI
  const printedHeightMm = config.fixedHeightMm
  const printedHeightInch = printedHeightMm / 25.4
  const dpi = Math.round(heightPx / Math.max(printedHeightInch, 0.01))
  if (dpi < config.minDpi) {
    warnings.push({
      code: 'low-dpi',
      message: `${job.name} 按 ${printedHeightMm}mm 高度打印时有效清晰度约 ${dpi} DPI（低于 ${config.minDpi}），建议减小尺寸或减少每行张数`,
      recordId: job.recordId,
      fieldId: job.fieldId,
      fieldName: job.fieldName,
      attachmentName: job.name,
      dpi,
    })
  }
}

/** 供排版层查询：给定目标尺寸，图片的有效 DPI 是多少 */
export function effectiveDpi(widthPx: number, heightPx: number, targetWidthMm: number, targetHeightMm: number): number {
  if (!widthPx || !heightPx || targetWidthMm <= 0 || targetHeightMm <= 0) return 0
  const dpiX = widthPx / (targetWidthMm / 25.4)
  const dpiY = heightPx / (targetHeightMm / 25.4)
  return Math.round(Math.min(dpiX, dpiY))
}

// ============================================================
// 缩略图
// ============================================================

async function makeThumbnail(
  objectUrl: string,
  blob: Blob,
  widthPx: number,
  heightPx: number,
): Promise<string | undefined> {
  // 尺寸未知时没法判断要不要缩，直接不缩，至少不丢图
  if (!widthPx || !heightPx) return undefined
  const maxSide = Math.max(widthPx, heightPx)
  if (maxSide <= THUMB_MAX_PX) return undefined
  if (typeof document === 'undefined' || typeof createImageBitmap === 'undefined') return undefined

  try {
    const scale = THUMB_MAX_PX / maxSide
    const tw = Math.max(1, Math.round(widthPx * scale))
    const th = Math.max(1, Math.round(heightPx * scale))
    const bmp = await createImageBitmap(blob, { resizeWidth: tw, resizeHeight: th, resizeQuality: 'medium' })
    const canvas = document.createElement('canvas')
    canvas.width = tw
    canvas.height = th
    const ctx = canvas.getContext('2d')
    if (!ctx) {
      bmp.close?.()
      return undefined
    }
    ctx.drawImage(bmp, 0, 0, tw, th)
    bmp.close?.()
    const thumbBlob: Blob | null = await new Promise((resolve) =>
      canvas.toBlob((b) => resolve(b), 'image/png', 0.9),
    )
    if (!thumbBlob) return undefined
    return URL.createObjectURL(thumbBlob)
  } catch {
    // 缩略图失败不是致命问题，退回原图
    return undefined
  }
}

// ============================================================
// 缓存辅助
// ============================================================

interface CacheHit extends CacheEntry {
  thumbUrl?: string
}

function isFresh(token: string): boolean {  const e = blobCache.get(token)
  return Boolean(e && now() - e.at < CACHE_TTL_MS)
}

function getFresh(token: string): CacheHit | null {
  const e = blobCache.get(token)
  if (!e) return null
  if (now() - e.at >= CACHE_TTL_MS) {
    // 过期条目要顺手清掉，否则越攒越多
    try {
      URL.revokeObjectURL(e.url)
    } catch {
      /* 忽略 */
    }
    blobCache.delete(token)
    return null
  }
  return e
}

function pushImage(map: Map<string, ResolvedImage[]>, key: string, img: ResolvedImage): void {
  const arr = map.get(key)
  if (arr) arr.push(img)
  else map.set(key, [img])
}

function toFailure(
  job: { recordId: string; fieldId: string; fieldName: string; name: string; token: string },
  reason: string,
): ImageFailure {
  return {
    recordId: job.recordId,
    fieldId: job.fieldId,
    fieldName: job.fieldName,
    attachmentName: job.name,
    token: job.token,
    reason,
  }
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now()
}

/** 打印目标尺寸下的毫米换算，供上层 UI 展示"将按 xx mm 打印" */
export function printedSizeMm(
  widthPx: number,
  heightPx: number,
  config: AttachmentPrintConfig,
  containerMm?: { w: number; h: number },
): { w: number; h: number } {
  if (!widthPx || !heightPx) {
    const fallback = config.fixedHeightMm ?? 30
    return { w: fallback, h: fallback }
  }
  const ratio = widthPx / heightPx

  if (config.sizeMode === 'fixedHeight' && config.fixedHeightMm) {
    const h = config.fixedHeightMm
    return { w: h * ratio, h }
  }

  if (config.sizeMode === 'fitCell' && containerMm) {
    // 双向约束：取较严格的缩放比例，保证不溢出且不拉伸
    const byW = containerMm.w / (widthPx / mmToPx(1))
    const byH = containerMm.h / (heightPx / mmToPx(1))
    const s = Math.min(byW, byH)
    return { w: (widthPx / mmToPx(1)) * s, h: (heightPx / mmToPx(1)) * s }
  }

  // original：1px = 1/96 inch
  const w = widthPx / mmToPx(1)
  const h = heightPx / mmToPx(1)
  void PT_TO_MM
  return { w, h }
}
