/**
 * 智能字段匹配（PRD F3.3）
 *
 * 三级状态：
 * - **matched 已匹配**：精确同名（去首尾空格 + 全半角归一）→ 直接绑定，UI 绿色
 * - **pending 待确认**：归一化后一致（忽略括号内容、空格、大小写、`（）`/`()` 互换）→ 建议绑定，UI 黄色
 * - **unbound 未绑定**：都不匹配 → 保留占位符，UI 红色，需用户绑定或"忽略（转纯文本）"
 *
 * 归一化函数**单独导出**，因为它是匹配质量的全部所在，必须能单测。
 */

import type { FieldMeta } from '../lib/data-source'

export type MatchStatus = 'matched' | 'pending' | 'unbound'

export interface MatchCandidate {
  fieldId: string
  fieldName: string
}

export interface MatchResult {
  /** 占位符里的原始名称（已 trim） */
  placeholder: string
  /** 精确级归一化结果，便于排查"为什么没匹配上" */
  normalized: string
  status: MatchStatus
  fieldId: string | null
  fieldName: string | null
  /** F3-19：匹配到多个同名字段，默认绑第一个并需要用户确认 */
  duplicated?: boolean
  /**
   * 用户选择"忽略该占位符（转为纯文本）"（PRD F3-18 的第二个动作）。
   * 与 status 正交：无论原本是待确认还是未绑定，用户都可以决定把它当普通文本处理。
   * 置为 true 后 `rebuildWithMatches` 会输出原文而不是 InlineField。
   */
  ignored?: boolean
  /** 展示给用户的一句话说明 */
  note?: string
  /** 可改绑的候选字段 */
  candidates: MatchCandidate[]
}

/** 收集被用户选择"忽略（转纯文本）"的占位符名，供 to-template 使用 */
export function ignoredPlaceholderNames(results: readonly MatchResult[]): Set<string> {
  const out = new Set<string>()
  for (const r of results) if (r.ignored) out.add(r.placeholder)
  return out
}

// ============================================================
// 归一化
// ============================================================

/**
 * 全角 → 半角。
 * 覆盖：全角 ASCII（！～～，含全角括号与字母数字）与全角空格（U+3000）。
 * 这是中文文档里最常见的不一致来源（输入法切换导致），必须先抹平。
 */
export function toHalfWidth(s: string): string {
  let out = ''
  for (const ch of s) {
    const code = ch.codePointAt(0) as number
    if (code === 0x3000) {
      out += ' '
    } else if (code >= 0xff01 && code <= 0xff5e) {
      out += String.fromCodePoint(code - 0xfee0)
    } else {
      out += ch
    }
  }
  return out
}

/**
 * 精确级归一化（F3-13 / F3-16）：全角转半角 + 去首尾空格。
 * **不做**内部空格/括号的删除 —— 保留"精确匹配"的严格性。
 */
export function normalizeExact(s: string): string {
  return toHalfWidth(s).replace(/^\s+|\s+$/g, '')
}

const BRACKET_PAIRS: readonly [string, string][] = [
  ['(', ')'],
  ['[', ']'],
  ['【', '】'],
  ['《', '》'],
  ['〈', '〉'],
  ['〔', '〕'],
  ['「', '」'],
]

/** 去掉成对括号及其内容（含括号本身） */
function stripBracketContent(s: string): string {
  let out = s
  for (const [open, close] of BRACKET_PAIRS) {
    const re = new RegExp(`${escapeRe(open)}[^${escapeRe(open)}${escapeRe(close)}]*${escapeRe(close)}`, 'g')
    out = out.replace(re, '')
  }
  return out
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 模糊级归一化（F3-17）：在精确归一化基础上再
 * 1) 删除**所有**空白（含内嵌空格）
 * 2) 删除成对括号及其内容（"金额(元)" 与 "金额" 视为同一字段）
 * 3) 转小写
 * 注意顺序：先去空白再删括号，否则 "( 元 )" 这类带空格的括号删不掉。
 */
export function normalizeFuzzy(s: string): string {
  let out = normalizeExact(s)
  out = out.replace(/\s+/g, '')
  out = stripBracketContent(out)
  // 删除括号后可能又出现相邻空格（理论上已无），保险起见再来一次
  out = out.replace(/\s+/g, '')
  return out.toLowerCase()
}

// ============================================================
// 匹配
// ============================================================

/**
 * 把占位符名列表与当前表字段列表做三级匹配。
 *
 * 复杂度 O(占位符数 × 字段数)，两者都是几十量级的量级，不需要更复杂的索引；
 * 但为避免重复计算，字段归一化结果只算一遍（缓存）。
 */
export function matchPlaceholders(
  placeholderNames: readonly string[],
  fields: readonly FieldMeta[],
): MatchResult[] {
  const indexExact = new Map<string, FieldMeta[]>()
  const indexFuzzy = new Map<string, FieldMeta[]>()
  for (const f of fields) {
    const ke = normalizeExact(f.name)
    const kf = normalizeFuzzy(f.name)
    if (!indexExact.has(ke)) indexExact.set(ke, [])
    ;(indexExact.get(ke) as FieldMeta[]).push(f)
    if (!indexFuzzy.has(kf)) indexFuzzy.set(kf, [])
    ;(indexFuzzy.get(kf) as FieldMeta[]).push(f)
  }

  return placeholderNames.map((raw) => {
    const placeholder = normalizeExact(raw)
    const ke = normalizeExact(placeholder)
    const kf = normalizeFuzzy(placeholder)

    const exact = indexExact.get(ke) ?? []
    if (exact.length > 0) {
      const first = exact[0]
      const dup = exact.length > 1
      return {
        placeholder,
        normalized: ke,
        status: 'matched' as MatchStatus,
        fieldId: first.id,
        fieldName: first.name,
        ...(dup ? { duplicated: true } : {}),
        ...(dup ? { note: '存在同名字段，请确认' } : {}),
        candidates: exact.map((f) => ({ fieldId: f.id, fieldName: f.name })),
      }
    }

    const fuzzy = indexFuzzy.get(kf) ?? []
    if (fuzzy.length > 0) {
      const first = fuzzy[0]
      const dup = fuzzy.length > 1
      return {
        placeholder,
        normalized: kf,
        status: 'pending' as MatchStatus,
        fieldId: first.id,
        fieldName: first.name,
        ...(dup ? { duplicated: true } : {}),
        note: dup ? '存在多个近似字段，请确认' : '名称近似，建议绑定',
        candidates: fuzzy.map((f) => ({ fieldId: f.id, fieldName: f.name })),
      }
    }

    return {
      placeholder,
      normalized: kf,
      status: 'unbound' as MatchStatus,
      fieldId: null,
      fieldName: null,
      note: '未找到同名字段，请绑定或忽略',
      candidates: [],
    }
  })
}

export interface MatchSummary {
  matched: number
  pending: number
  unbound: number
  total: number
  /** UI 顶部提示条文案 */
  text: string
}

export function summarizeMatches(results: readonly MatchResult[]): MatchSummary {
  let matched = 0
  let pending = 0
  let unbound = 0
  for (const r of results) {
    if (r.status === 'matched') matched++
    else if (r.status === 'pending') pending++
    else unbound++
  }
  const total = results.length
  const bits: string[] = []
  if (matched) bits.push(`${matched} 个已匹配`)
  if (pending) bits.push(`${pending} 个待确认`)
  if (unbound) bits.push(`${unbound} 个未绑定`)
  return {
    matched,
    pending,
    unbound,
    total,
    text: total === 0 ? '未识别到占位符。' : bits.join('、') + '。',
  }
}

/**
 * 把匹配结果转成"占位符名 → 绑定信息"的查询表，供映射层（to-template）使用。
 * 未匹配的（unbound）不绑定 fieldId，但仍保留 fieldName（F3-18）。
 */
export interface BindingInfo {
  fieldId: string | null
  fieldName: string
  fieldTypeSnapshot?: number
}

export function toBindingMap(
  results: readonly MatchResult[],
  fields: readonly FieldMeta[],
): Map<string, BindingInfo> {
  const byId = new Map<string, FieldMeta>()
  for (const f of fields) byId.set(f.id, f)
  const map = new Map<string, BindingInfo>()
  for (const r of results) {
    const meta = r.fieldId ? byId.get(r.fieldId) : undefined
    map.set(r.placeholder, {
      fieldId: r.fieldId,
      fieldName: r.fieldName ?? r.placeholder,
      ...(meta ? { fieldTypeSnapshot: meta.type } : {}),
    })
  }
  return map
}
