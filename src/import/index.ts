/**
 * Word 模板导入的公共 API（PRD F3 / P4）
 *
 * 典型用法（导入向导 4.2 → 4.3 → 4.5）：
 *
 *   const r = await parseDocx(file, {
 *     fields,                                   // 当前表字段元数据（F1.1）
 *     onStage: (s) => setProgress(s),           // 三阶段进度（F3-04）
 *   })
 *   // r.match    → P4 的字段匹配确认页
 *   // r.report   → P4 的兼容性报告页
 *   // r.template → 直接进在线编辑器（P3）
 *
 * 解析全程在浏览器本地完成，不上传文件（F3-03）。
 */

import type { FieldMeta } from '../lib/data-source'
import type { TemplateDoc } from '../lib/types'
import {
  DocxReadError,
  buildIr,
  loadDocxParts,
  readDocx,
  toBase64,
  type BuildIrOptions,
  type DocxParts,
} from './docx-read'
import type { IRDoc, IRLoopRange } from './ir'
import type { LoopScanOptions } from './loop'
import { applyManualLoop, createEmptyLoopDetection, detectLoops, manualLoop } from './loop'
import {
  DEFAULT_PLACEHOLDER_OPTIONS,
  collectPlaceholderNames,
  findParagraphPlaceholders,
  matchPlaceholdersInText,
  resolvePlaceholderOptions,
  type PlaceholderOptions,
} from './placeholders'
import {
  ignoredPlaceholderNames,
  matchPlaceholders,
  normalizeExact,
  normalizeFuzzy,
  summarizeMatches,
  toBindingMap,
  toHalfWidth,
  type MatchResult,
  type MatchSummary,
} from './match'
import {
  addDegraded,
  addIgnored,
  addIssueOnce,
  createReport,
  finalizeReport,
  formatReportText,
  issueCount,
  summarize,
  type CompatItem,
  type CompatReport,
} from './report'
import { toTemplate, type ToTemplateOptions } from './to-template'

// ============================================================
// 进度（F3-04：解压 → 解析版式 → 提取图片与占位符）
// ============================================================

export type ParseStageKey = 'unzip' | 'layout' | 'assets' | 'done'

export interface ParseStage {
  stage: ParseStageKey
  /** 展示文案 */
  label: string
  /** 0–1 */
  progress: number
}

const STAGES: Record<ParseStageKey, { label: string; progress: number }> = {
  unzip: { label: '解压文档', progress: 0.15 },
  layout: { label: '解析版式', progress: 0.5 },
  assets: { label: '提取图片与占位符', progress: 0.85 },
  done: { label: '完成', progress: 1 },
}

// ============================================================
// 选项与结果
// ============================================================

export interface ParseOptions extends BuildIrOptions {
  /** 当前数据表的字段元数据；缺省时所有占位符都会落到"未绑定" */
  fields?: readonly FieldMeta[]
  /** 用户在导入向导里手动圈定的循环区（优先级高于自动识别） */
  loopRanges?: readonly IRLoopRange[]
  /** 额外循环标签（E-2 未实测期间的兜底） */
  loopTags?: LoopScanOptions
  onStage?: (stage: ParseStage) => void
}

export interface ParseResult {
  /** 中间表示：便于调试、二次加工，也用于"手动圈定循环区"后重新映射 */
  ir: IRDoc
  /** 可直接进在线编辑器的模板 */
  template: TemplateDoc
  /** 兼容性报告（F3-28） */
  report: CompatReport
  /** 字段匹配结果（F3.3） */
  match: MatchResult[]
  /** relId → dataURL 的图片表 */
  media: Map<string, string>
}

// ============================================================
// 主入口
// ============================================================

export async function parseDocx(file: File, opts: ParseOptions = {}): Promise<ParseResult> {
  const buf = await file.arrayBuffer()
  return parseDocxArrayBuffer(buf, opts)
}

export async function parseDocxArrayBuffer(
  data: ArrayBuffer | Uint8Array,
  opts: ParseOptions = {},
): Promise<ParseResult> {
  const notify = (key: ParseStageKey): void => {
    opts.onStage?.({ stage: key, ...STAGES[key] })
  }

  notify('unzip')
  const parts = await loadDocxParts(data)
  notify('layout')

  const built = buildIr(parts, {
    ...(opts.placeholder ? { placeholder: opts.placeholder } : {}),
    ...(opts.loopTags ? { loopTags: opts.loopTags } : {}),
    ...(opts.detectLoop !== undefined ? { detectLoop: opts.detectLoop } : {}),
  })
  notify('assets')

  const result = finish(built, opts)
  notify('done')
  return result
}

function finish(
  built: { ir: IRDoc; report: CompatReport; media: Map<string, string> },
  opts: ParseOptions,
): ParseResult {
  const fields = opts.fields ?? []
  const names = collectPlaceholderNames(built.ir.placeholders)
  const match = matchPlaceholders(names, fields)
  const binding = toBindingMap(match, fields)

  const template = toTemplate(built.ir, {
    bindField: (name) => binding.get(name),
    ...(opts.loopRanges ? { loopRanges: opts.loopRanges } : {}),
    report: built.report,
    media: built.media,
  })

  finalizeReport(built.report)
  return { ir: built.ir, template, report: built.report, match, media: built.media }
}

/**
 * 用户手动圈定循环区后重算模板（F3-12b 的兜底路径）。
 * 不重新解析文档，只重跑"切版式区 + 映射"，所以必须保证 IR 已被复用。
 *
 * ⚠️ **2026-09-21 查证：全项目没有任何调用方**（连同下面的 `makeManualLoop` / `redetectLoops`）。
 *    ⇒ 这不是"可以删的死代码"，而是 **F3-12b「手动圈定循环区」这条需求没接线**：
 *      实现是齐的，UI 侧一直没做那个入口（`WordImportPanel` 只走自动检测 + 改绑）。
 *      清死导出时**特意留下它们**，就是为了不让这条缺口消失得无影无踪 ——
 *      删掉的话，将来没人会知道"这里本来还差一个入口"。
 *    ⇒ 要做这个功能：从这里接，别再写一套（`toTemplate` 的 loopRanges 通道已经铺好了）。
 */
export function rebuildWithLoop(ir: IRDoc, loopRanges: readonly IRLoopRange[], opts: ToTemplateOptions = {}): TemplateDoc {
  return toTemplate(ir, { ...opts, loopRanges })
}

/** 用新的字段绑定关系重算模板（用户在匹配页改绑后调用） */
export function rebuildWithMatches(
  ir: IRDoc,
  match: readonly MatchResult[],
  fields: readonly FieldMeta[],
  opts: ToTemplateOptions = {},
): TemplateDoc {
  const binding = toBindingMap(match, fields)
  return toTemplate(ir, {
    ...opts,
    bindField: (name) => binding.get(name),
    // F3-18 的"忽略（转纯文本）"：由 match 结果里的 ignored 标记驱动，调用方无需额外传参
    ignorePlaceholders: opts.ignorePlaceholders ?? ignoredPlaceholderNames(match),
  })
}

/**
 * 标记某个占位符为"忽略（转为纯文本）"，返回新的 match 数组（不改原数组）。
 *
 * 这里**有意连带清掉 fieldId/fieldName 并把 status 压回 unbound**：既然决定不当变量，
 * 就不该再在任何"已匹配"统计或校验里出现。代价是原绑定丢失 —— 见 unignorePlaceholder 的说明。
 *
 * 写法上用整体 `.map` 重建数组、而不是就地改那一条：调用方是 React 的
 * `setMatch((prev) => ...)`，需要**新的数组引用**才会触发重渲染，而对未命中的元素
 * `.map` 原样返回同一个对象引用，那些行组件的 memo 依然能跳过。所以"整数组替换"与
 * "逐名替换"在这个场景下行为等价，前者更贴合不可变更新的习惯，也不要求调用方先拷贝。
 */
export function ignorePlaceholder(results: readonly MatchResult[], placeholder: string): MatchResult[] {
  return results.map((r) => (r.placeholder === placeholder ? { ...r, ignored: true, fieldId: null, fieldName: null, status: 'unbound' as const } : r))
}

/**
 * 取消"忽略"，把该占位符放回**未绑定**状态（fieldId 需由用户重新绑定）。
 *
 * ⚠️ 语义上**不可逆**：忽略时丢掉的 fieldId 这里不会还原，也不再尝试按名字重猜。
 * 这是刻意的交互取舍 —— "取消忽略"的合理预期就是"回到未绑定"，而"恢复到忽略前的绑定"
 * 属于撤销的职责，由编辑器的撤销栈负责（已支持）。所以请**不要**把它"修"成可逆的：
 * 那会让"取消忽略"和"撤销"两条恢复路径给出互相矛盾的结果，用户反而无从预期。
 *
 * 调用契约（隐式，写在这里免得后面靠猜）：本函数**只翻 ignored 标记**，单独调用后
 * 该占位符停在"未绑定"（渲染为空）。想让用户真正回到绑定态，得由调用方在之后紧接着
 * 重设绑定 —— 现在的唯一调用方 WordImportPanel 的改绑下拉就是先调本函数、再调
 * `applyRebind()`。这不是缺陷、也不是必须：停在未绑定本身就是合法且符合预期的状态。
 */
export function unignorePlaceholder(results: readonly MatchResult[], placeholder: string): MatchResult[] {
  return results.map((r) => (r.placeholder === placeholder ? { ...r, ignored: false, status: 'unbound' as const } : r))
}

/**
 * 手动圈定循环区（纯函数，供 UI 直接生成区间对象）。
 * ⚠️ 同 `rebuildWithLoop`：**没有任何调用方** —— F3-12b 的 UI 入口未做。见那里的说明。
 */
export function makeManualLoop(range: { startBlock: number; endBlock: number; name?: string }): IRLoopRange {
  return manualLoop(range)
}

/**
 * 对已解析的 IR 重新做一次循环检测（用户改了自定义标签后）。
 * ⚠️ 同 `rebuildWithLoop`：**没有任何调用方** —— F3-12b 的 UI 入口未做。见那里的说明。
 */
export function redetectLoops(ir: IRDoc, opts: LoopScanOptions = {}) {
  const detection = detectLoops(ir.blocks, opts)
  return { ...ir, loop: detection }
}

// ============================================================
// 重导出：调用方只需要 `from './import'` 一处入口
// ============================================================

export {
  DocxReadError,
  buildIr,
  loadDocxParts,
  readDocx,
  toTemplate,
  toBase64,
  createEmptyLoopDetection,
  applyManualLoop,
  detectLoops,
  matchPlaceholders,
  normalizeExact,
  normalizeFuzzy,
  summarizeMatches,
  toBindingMap,
  toHalfWidth,
  ignoredPlaceholderNames,
  collectPlaceholderNames,
  findParagraphPlaceholders,
  matchPlaceholdersInText,
  resolvePlaceholderOptions,
  DEFAULT_PLACEHOLDER_OPTIONS,
  finalizeReport,
  formatReportText,
  issueCount,
  summarize,
  createReport,
  addIgnored,
  addDegraded,
  addIssueOnce,
}

export type {
  BuildIrOptions,
  CompatItem,
  CompatReport,
  DocxParts,
  FieldMeta,
  IRDoc,
  IRLoopRange,
  LoopScanOptions,
  MatchResult,
  MatchSummary,
  PlaceholderOptions,
  TemplateDoc,
  ToTemplateOptions,
}
