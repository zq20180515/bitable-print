/**
 * 占位符识别与**跨 run 映射**
 *
 * ⚠️ 这是整个导入器最容易踩、也最致命的坑（PRD F3-13 明确点名）：
 * Word 会把一段连续文本切碎到多个 `<w:r>` 里。典型情况：
 *
 *   <w:r><w:t>${</w:t></w:r>
 *   <w:r><w:t>客户名称</w:t></w:r>
 *   <w:r><w:t>}</w:t></w:r>
 *
 * 逐 run 做正则匹配 → 三个 run 谁都不含完整占位符 → **全部漏掉**。
 * 而且 Word 的切分点非常随机（拼写检查、格式变化、修订记录都会切），
 * 所以这不是"偶发情况"，而是"默认情况"。
 *
 * 正确做法（本文件的实现）：
 * 1) 先把该段落所有 run 的文本**按顺序拼接**成 `fullText`；
 * 2) 在 `fullText` 上做一次匹配，得到字符区间 `[start, end)`；
 * 3) 再用 run 的累计长度表把区间**映射回 run 边界**，记下 `startRun/startOffset/endRun/endOffset`；
 * 4) 上层据此把占位符那几段 run 合并成一个 `InlineField`，并沿用起始 run 的样式。
 *
 * 这样既不会漏，也不会因为拼接而丢失"占位符前后文字各自的样式"。
 */

import type { IRPlaceholder, PlaceholderSyntax } from './ir'

// ============================================================
// 开关（PRD F3-15：{{}} / [] 为兼容格式，可开关，默认关闭）
// ============================================================

export interface PlaceholderOptions {
  /** `${字段名}`（F3-13） */
  dollar: boolean
  /** `«字段名»`（F3-14） */
  guillemet: boolean
  /** `{{字段名}}`（F3-15，默认关） */
  mustache: boolean
  /** `[字段名]`（F3-15，默认关；开启后误报率高，因为正文里的方括号很常见） */
  bracket: boolean
}

export const DEFAULT_PLACEHOLDER_OPTIONS: PlaceholderOptions = {
  dollar: true,
  guillemet: true,
  mustache: false,
  bracket: false,
}

export function resolvePlaceholderOptions(partial?: Partial<PlaceholderOptions>): PlaceholderOptions {
  return { ...DEFAULT_PLACEHOLDER_OPTIONS, ...(partial ?? {}) }
}

// ============================================================
// 匹配
// ============================================================

/** 字段名允许的字符：不跨行、不包含各种壳子符号、长度 1–40 */
const NAME = '([^\\n\\r{}<>\\[\\]«»$]{1,40})'

interface SyntaxDef {
  syntax: PlaceholderSyntax
  re: RegExp
  /** 名字是否合法（进一步排除明显不是字段名的东西） */
  accept: (name: string) => boolean
}

const SYNTAX_DEFS: readonly SyntaxDef[] = [
  { syntax: 'dollar', re: new RegExp(`\\$\\{${NAME}\\}`, 'g'), accept: okName },
  { syntax: 'guillemet', re: new RegExp(`«${NAME}»`, 'g'), accept: okName },
  {
    syntax: 'mustache',
    re: new RegExp(`\\{\\{${NAME}\\}\\}`, 'g'),
    // 排除 mustache 家族的"标签"语法（{{#each}} / {{/each}} / {{^}} / {{!注释}}），
    // 它们属于循环标签而不是字段占位符（见 loop.ts）
    accept: (n) => okName(n) && !/^[#/^!>&{]/.test(n.trim()),
  },
  {
    syntax: 'bracket',
    re: new RegExp(`\\[${NAME}\\]`, 'g'),
    accept: (n) => okName(n) && !/^\s*\d+\s*$/.test(n),
  },
]

/**
 * 保留名：这些词是**循环标签**的关键字，不能当成字段占位符。
 * 例：如果官方用 `«循环开始»` 标记循环区，那么 `«»` 同时也是字段壳，
 * 不做排斥就会把它们误识别成两个叫"循环开始/循环结束"的字段。
 */
const RESERVED_NAMES = new Set([
  '循环开始',
  '循环结束',
  '开始循环',
  '结束循环',
  '循环',
  '重复开始',
  '重复结束',
  'each',
  '/each',
  '#each',
])

function okName(raw: string): boolean {
  const n = raw.trim()
  if (n.length === 0) return false
  if (RESERVED_NAMES.has(n)) return false
  // 纯符号/纯空白不算字段名
  if (!/[\p{L}\p{N}_]/u.test(n)) return false
  return true
}

export interface RawPlaceholderMatch {
  raw: string
  name: string
  syntax: PlaceholderSyntax
  start: number
  end: number
}

/**
 * 在**已拼接好的段落文本**上匹配占位符。
 * 返回结果按出现顺序排列，且**互不重叠**（多个语法命中同一区间时取更长的那个）。
 */
export function matchPlaceholdersInText(
  fullText: string,
  options: PlaceholderOptions = DEFAULT_PLACEHOLDER_OPTIONS,
): RawPlaceholderMatch[] {
  if (!fullText) return []
  const found: RawPlaceholderMatch[] = []

  for (const def of SYNTAX_DEFS) {
    if (!options[def.syntax]) continue
    def.re.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = def.re.exec(fullText)) !== null) {
      const raw = m[0]
      const name = m[1]
      if (!def.accept(name)) continue
      found.push({
        raw,
        name: name.trim(),
        syntax: def.syntax,
        start: m.index,
        end: m.index + raw.length,
      })
      // 空匹配保护（NAME 至少 1 字符，理论上不会发生）
      if (m.index === def.re.lastIndex) def.re.lastIndex++
    }
  }

  found.sort((a, b) => a.start - b.start || b.end - a.end)
  const out: RawPlaceholderMatch[] = []
  let cursor = -1
  for (const f of found) {
    if (f.start < cursor) continue // 与前一个重叠 → 丢弃
    out.push(f)
    cursor = f.end
  }
  return out
}

// ============================================================
// run 边界映射
// ============================================================

export interface RunSpan {
  /** 该 run 文本在段落拼接文本中的起始偏移 */
  start: number
  end: number
  text: string
}

/** 计算每个 run 在段落拼接文本里的区间（累计长度表） */
export function buildRunSpans(runTexts: readonly string[]): RunSpan[] {
  const spans: RunSpan[] = []
  let cursor = 0
  for (const t of runTexts) {
    spans.push({ start: cursor, end: cursor + t.length, text: t })
    cursor += t.length
  }
  return spans
}

/** 找到包含字符 `charIndex` 的 run（charIndex 必须落在 [0, total) 内） */
function runOfChar(spans: readonly RunSpan[], charIndex: number): number {
  for (let i = 0; i < spans.length; i++) {
    if (charIndex >= spans[i].start && charIndex < spans[i].end) return i
  }
  return spans.length - 1
}

export interface RunLocation {
  startRun: number
  startOffset: number
  endRun: number
  endOffset: number
}

/**
 * 把 `[start, end)` 字符区间映射回 run 边界。
 * - `startOffset`：起始 run 内的偏移（含）
 * - `endOffset`：结束 run 内的偏移（**不含**，即最后一个字符的下一位）
 * 空文本不会进来（占位符至少 4 个字符），只做最小防御。
 */
export function mapRangeToRuns(spans: readonly RunSpan[], start: number, end: number): RunLocation {
  if (spans.length === 0) return { startRun: 0, startOffset: 0, endRun: 0, endOffset: 0 }
  const total = spans[spans.length - 1].end
  const s = Math.max(0, Math.min(start, Math.max(0, total - 1)))
  const e = Math.max(s + 1, Math.min(end, total))
  const startRun = runOfChar(spans, s)
  const endRun = runOfChar(spans, e - 1)
  return {
    startRun,
    startOffset: s - spans[startRun].start,
    endRun,
    endOffset: e - spans[endRun].start,
  }
}

/**
 * 对单个段落做"拼接 → 匹配 → 映射回 run"的完整流程。
 * 返回的 `IRPlaceholder` 即 IR 里保留的占位符记录。
 */
export function findParagraphPlaceholders(
  runTexts: readonly string[],
  fullText: string,
  options: PlaceholderOptions = DEFAULT_PLACEHOLDER_OPTIONS,
): IRPlaceholder[] {
  const matches = matchPlaceholdersInText(fullText, options)
  if (matches.length === 0) return []
  const spans = buildRunSpans(runTexts)
  return matches.map((m) => {
    const loc = mapRangeToRuns(spans, m.start, m.end)
    return {
      raw: m.raw,
      name: m.name,
      syntax: m.syntax,
      start: m.start,
      end: m.end,
      ...loc,
    }
  })
}

/** 从若干段落文本里收集去重后的字段名（用于字段匹配页） */
export function collectPlaceholderNames(placeholders: readonly { name: string }[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const p of placeholders) {
    if (seen.has(p.name)) continue
    seen.add(p.name)
    out.push(p.name)
  }
  return out
}
