/**
 * 循环区标签识别（PRD F3-12b + 附录 E-2）
 *
 * ⚠️⚠️ 语法待实测确认 ⚠️⚠️
 * 需求方从官方「排版打印」迁移过来时，循环区是**必需**的（官方用一对"循环开始/结束"标签
 * 圈出需要按数据行重复的区间）。但官方标签的**确切语法至今没有拿到真实样例**（PRD 附录 E-2
 * 明确列为待实测项："从官方模板库下载一份带循环的 docx，解压 word/document.xml 看标签原文"）。
 *
 * 所以本模块的策略是**保守 + 兜底**，而不是赌某一种语法：
 * 1) 宽松识别多种常见形态（见 TAG_PATTERNS），能认出来就认；
 * 2) 命中即**原样保留** `raw` 文本到 IR，UI 可以把它展示出来让用户核对；
 * 3) 认不出来的"疑似标签"单独收集到 `unrecognized`，UI 据此提示用户手动圈定；
 * 4) 提供 `manualLoop()`，让导入向导的"手动圈定循环区"步骤（P4 / F3-12b 兜底路径）
 *    直接把区间喂进来 —— 这条路径**不依赖任何语法猜测**，是保证功能可用的底线。
 *
 * 一旦 E-2 实测出真实语法，只需要往 TAG_PATTERNS 里加一条即可，其余代码不用动。
 */

import type { IRBlock, IRLoopDetection, IRLoopRange, IRLoopTag, LoopSyntax, IRUnrecognizedTag } from './ir'

export interface LoopScanOptions {
  /**
   * 额外自定义的开始/结束标签原文（用户在导入向导里如果发现官方语法不匹配，
   * 可以手工填写一对标签，这里直接注入）。
   */
  extraStartTags?: string[]
  extraEndTags?: string[]
}

interface TagPattern {
  syntax: LoopSyntax
  role: 'start' | 'end'
  re: RegExp
}

/**
 * 已识别的标签形态。**每条都要能拿到真实样例后回归验证**（见文件头 E-2 说明）。
 * `name` 捕获组用于记录循环集合名。
 */
const TAG_PATTERNS: readonly TagPattern[] = [
  // ⚠️ 顺序有语义：同一位置被多条规则命中时，**排在前面的优先**（见 dedupeOverlapping）。
  // 所以更具体的中文关键字写法必须排在通用 `{{#...}}` 之前，
  // 否则 `{{循环开始:明细}}` 会被通用规则吃掉、集合名变成 "循环开始:明细"。

  // --- mustache + 中文关键字：{{循环开始}} / {{循环开始:列表}} / {{循环结束}} ---
  { syntax: 'mustache', role: 'start', re: /\{\{\s*循环开始\s*[:：]?\s*([^{}\n]*?)\s*\}\}/g },
  { syntax: 'mustache', role: 'end', re: /\{\{\s*循环结束\s*\}\}/g },
  // --- mustache 家族：{{#each 列表}} ... {{/each}} / {{#列表}} ... {{/列表}} ---
  { syntax: 'mustache', role: 'start', re: /\{\{\s*#\s*each\s+([^{}\n]+?)\s*\}\}/g },
  { syntax: 'mustache', role: 'end', re: /\{\{\s*\/\s*each\s*\}\}/g },
  { syntax: 'mustache', role: 'start', re: /\{\{\s*#\s*([^#/^{}!\n>][^{}\n]*?)\s*\}\}/g },
  { syntax: 'mustache', role: 'end', re: /\{\{\s*\/\s*([^#/^{}!\n>][^{}\n]*?)\s*\}\}/g },
  // --- 单花括号 + #：{#列表} ... {/列表} ---
  { syntax: 'brace', role: 'start', re: /\{\s*#\s*([^#/^{}!\n>][^{}\n]*?)\s*\}/g },
  { syntax: 'brace', role: 'end', re: /\{\s*\/\s*([^#/^{}!\n>][^{}\n]*?)\s*\}/g },
  // --- 双半角方括号：[[循环开始]] / [[循环开始：列表]] / [[循环结束]] ---
  { syntax: 'cjk-bracket', role: 'start', re: /\[\[\s*循环开始\s*[:：]?\s*([^\[\]\n]*?)\s*\]\]/g },
  { syntax: 'cjk-bracket', role: 'end', re: /\[\[\s*循环结束\s*\]\]/g },
  // --- 全角方括号 / 书名号：如果官方用 «» 做字段占位符，循环标签很可能沿用同一对壳 ---
  { syntax: 'cjk-fullwidth', role: 'start', re: /【\s*循环开始\s*[:：]?\s*([^【】\n]*?)\s*】/g },
  { syntax: 'cjk-fullwidth', role: 'end', re: /【\s*循环结束\s*】/g },
  { syntax: 'cjk-fullwidth', role: 'start', re: /«\s*循环开始\s*[:：]?\s*([^«»\n]*?)\s*»/g },
  { syntax: 'cjk-fullwidth', role: 'end', re: /«\s*循环结束\s*»/g },
]

/** 疑似标签（用于 UI 提示"可能需要手动圈定循环区"），不参与配对 */
const SUSPECT_PATTERNS: readonly { re: RegExp; reason: string }[] = [
  { re: /\{\{\s*[#/]\s*[^{}\n]{0,30}\}\}/g, reason: 'mustache 风格的块标签' },
  { re: /\[\[[^\[\]\n]{0,30}\]\]/g, reason: '双中括号包裹的标签' },
  { re: /【[^【】\n]{0,20}(循环|开始|结束|重复|明细)[^【】\n]{0,20}】/g, reason: '含循环/开始/结束关键字' },
  { re: /«[^«»\n]{0,20}(循环|开始|结束|重复|明细)[^«»\n]{0,20}»/g, reason: '含循环/开始/结束关键字' },
  { re: /\{[#/][^{}\n]{1,20}\}/g, reason: '单花括号块标签' },
]

/** 从段落文本里扫出所有标签（保持字符偏移，供后续裁剪文本用） */
export function scanLoopTagsInText(
  text: string,
  blockIndex: number,
  opts: LoopScanOptions = {},
): IRLoopTag[] {
  const tags: IRLoopTag[] = []

  const pushAll = (
    re: RegExp,
    syntax: LoopSyntax,
    role: 'start' | 'end',
  ): void => {
    re.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(text)) !== null) {
      const name = m[1] !== undefined ? m[1].trim() : undefined
      tags.push({
        role,
        raw: m[0],
        ...(name ? { name } : {}),
        syntax,
        blockIndex,
        charOffset: m.index,
      })
      if (m.index === re.lastIndex) re.lastIndex++
    }
  }

  for (const p of TAG_PATTERNS) pushAll(p.re, p.syntax, p.role)

  // 自定义标签（用户在向导里手填的）
  for (const raw of opts.extraStartTags ?? []) {
    const re = new RegExp(escapeRe(raw), 'g')
    pushAll(re, 'mustache', 'start')
  }
  for (const raw of opts.extraEndTags ?? []) {
    const re = new RegExp(escapeRe(raw), 'g')
    pushAll(re, 'mustache', 'end')
  }

  tags.sort((a, b) => a.charOffset - b.charOffset)
  return dedupeOverlapping(tags)
}

/** 同一位置被多条规则命中时只保留一条，避免配对错乱 */
function dedupeOverlapping(tags: IRLoopTag[]): IRLoopTag[] {
  const out: IRLoopTag[] = []
  let lastEnd = -1
  for (const t of tags) {
    const end = t.charOffset + t.raw.length
    if (t.charOffset < lastEnd) continue
    out.push(t)
    lastEnd = end
  }
  return out
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 段落文本里可用于取字符偏移的块（只有段落有文本） */
function blockText(b: IRBlock): string {
  return b.kind === 'paragraph' ? b.text : ''
}

/**
 * 全文档循环检测。
 *
 * 配对规则（宽松但有优先级）：后遇到的 end 与"最近的未配对 start"配对；
 * 若 end 带名字，则优先与同名 start 配对。v1 只支持**一层**循环
 * （嵌套循环在官方模板里是否存在尚未实测，先不做，遇到嵌套会退化为最外层）。
 */
export function detectLoops(blocks: readonly IRBlock[], opts: LoopScanOptions = {}): IRLoopDetection {
  const starts: IRLoopTag[] = []
  const ends: IRLoopTag[] = []
  const unrecognized: IRUnrecognizedTag[] = []

  blocks.forEach((b, idx) => {
    const text = blockText(b)
    if (!text) return
    const tags = scanLoopTagsInText(text, idx, opts)
    for (const t of tags) (t.role === 'start' ? starts : ends).push(t)

    // 疑似但未被识别的标签：从原文里扣除已识别标签的范围后再找
    const recognized = tags
      .map((t) => [t.charOffset, t.charOffset + t.raw.length] as const)
      .sort((a, b) => a[0] - b[0])
    for (const s of SUSPECT_PATTERNS) {
      s.re.lastIndex = 0
      let m: RegExpExecArray | null
      while ((m = s.re.exec(text)) !== null) {
        const start = m.index
        const end = start + m[0].length
        const hit = recognized.some(([a, b2]) => start >= a && end <= b2)
        if (!hit) {
          unrecognized.push({ raw: m[0], blockIndex: idx, reason: s.reason })
        }
        if (m.index === s.re.lastIndex) s.re.lastIndex++
      }
    }
  })

  const usedStart = new Set<IRLoopTag>()
  const usedEnd = new Set<IRLoopTag>()
  const ranges: IRLoopRange[] = []

  for (const end of ends) {
    let pick: IRLoopTag | undefined
    if (end.name) {
      pick = starts.find((s) => !usedStart.has(s) && s.name === end.name)
    }
    if (!pick) {
      // 就近配对：取最后一个还没被用的 start，且必须出现在 end 之前
      for (let i = starts.length - 1; i >= 0; i--) {
        const s = starts[i]
        if (usedStart.has(s)) continue
        if (s.blockIndex > end.blockIndex) continue
        if (s.blockIndex === end.blockIndex && s.charOffset > end.charOffset) continue
        pick = s
        break
      }
    }
    if (!pick) continue
    usedStart.add(pick)
    usedEnd.add(end)
    ranges.push({
      startBlock: pick.blockIndex,
      endBlock: end.blockIndex,
      ...(pick.name ? { name: pick.name } : {}),
      syntax: pick.syntax,
      startTagRaw: pick.raw,
      endTagRaw: end.raw,
      startTagOffset: pick.charOffset,
      endTagOffset: end.charOffset,
    })
  }

  ranges.sort((a, b) => a.startBlock - b.startBlock || a.startTagOffset - b.startTagOffset)
  const unmatched: IRLoopTag[] = [
    ...starts.filter((s) => !usedStart.has(s)),
    ...ends.filter((e) => !usedEnd.has(e)),
  ]

  return { ranges, unmatched, unrecognized }
}

/**
 * 手动圈定循环区（F3-12b 的兜底路径）。
 *
 * 语义：`startBlock..endBlock`（含两端）的块整体成为循环体。
 * 如果标签正好独占一整段，用户就是把那一段框进来即可。
 * 这个方法**不做任何语法猜测**，因此是 E-2 未验证期间唯一可靠的路径。
 */
export function manualLoop(range: {
  startBlock: number
  endBlock: number
  name?: string
}): IRLoopRange {
  const a = Math.max(0, Math.min(range.startBlock, range.endBlock))
  const b = Math.max(range.startBlock, range.endBlock)
  return {
    startBlock: a,
    endBlock: b,
    ...(range.name ? { name: range.name } : {}),
    syntax: 'manual',
    startTagRaw: '',
    endTagRaw: '',
    startTagOffset: 0,
    endTagOffset: 0,
  }
}

/** 用手动圈定的区间替换/追加检测结果（用户确认优先于自动识别） */
export function applyManualLoop(
  detection: IRLoopDetection,
  range: { startBlock: number; endBlock: number; name?: string },
): IRLoopDetection {
  const manual = manualLoop(range)
  const ranges = [...detection.ranges, manual].sort((x, y) => x.startBlock - y.startBlock)
  return { ...detection, ranges }
}
export function createEmptyLoopDetection(): IRLoopDetection {
  return { ranges: [], unmatched: [], unrecognized: [] }
}