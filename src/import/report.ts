/**
 * 兼容性报告模型（PRD F3-28 / F3-29）
 *
 * 报告分两类：
 * - ignored：完全没还原的元素（OLE、图表、SmartArt、宏、脚注…）
 * - degraded：还原了但打了折扣（浮动图片→行内、多节只取第一节、编号列表→纯文本…）
 *
 * `location` 必须能定位到文档里的位置，用户才找得到（"第 3 段"、"第 2 个表格第 1 行"）。
 */

export interface CompatItem {
  /** 机器可读的分类，如 'ole' / 'chart' / 'macro' / 'floating-image' */
  kind: string
  /** 展示给用户的标签，如 "OLE 对象"、"图表" */
  label: string
  /** 位置描述，如 "第 3 段"、"第 2 个表格第 1 行" */
  location: string
  action: 'ignored' | 'degraded'
  /** 补充说明（可选，报告里作为次要文字） */
  detail?: string
}

export interface CompatReport {
  ignored: CompatItem[]
  degraded: CompatItem[]
  summary: string
}

export function createReport(): CompatReport {
  return { ignored: [], degraded: [], summary: '' }
}

export interface IssueInput {
  kind: string
  label: string
  location: string
  detail?: string
}

/** 记一条"已忽略" */
export function addIgnored(report: CompatReport, item: IssueInput): CompatItem {
  const it: CompatItem = { ...item, action: 'ignored' }
  report.ignored.push(it)
  return it
}

/** 记一条"已降级" */
export function addDegraded(report: CompatReport, item: IssueInput): CompatItem {
  const it: CompatItem = { ...item, action: 'degraded' }
  report.degraded.push(it)
  return it
}

/** 相同 kind + location 的条目去重（例如同一段落里多个宏/图表占位） */
export function addIssueOnce(
  report: CompatReport,
  action: 'ignored' | 'degraded',
  item: IssueInput,
): CompatItem {
  const list = action === 'ignored' ? report.ignored : report.degraded
  const hit = list.find((x) => x.kind === item.kind && x.location === item.location)
  if (hit) return hit
  return action === 'ignored' ? addIgnored(report, item) : addDegraded(report, item)
}

export function issueCount(report: CompatReport): number {
  return report.ignored.length + report.degraded.length
}

/** 生成一句人话摘要（F3-29 顶部黄条 / 报告标题用） */
export function summarize(report: CompatReport): string {
  const i = report.ignored.length
  const d = report.degraded.length
  if (i === 0 && d === 0) {
    return '文档中的元素已全部还原。'
  }
  const parts: string[] = []
  if (i > 0) parts.push(`${i} 项已忽略`)
  if (d > 0) parts.push(`${d} 项已降级处理`)
  return `共 ${i + d} 项未完整还原（${parts.join('、')}），不影响导入。`
}

/** 收尾：写入摘要。必须在使用报告前调用一次 */
export function finalizeReport(report: CompatReport): CompatReport {
  report.summary = summarize(report)
  return report
}

/** 生成可复制的纯文本报告（F3-28 的"复制报告"按钮） */
export function formatReportText(report: CompatReport): string {
  const lines: string[] = []
  lines.push('【Word 导入兼容性报告】')
  lines.push(report.summary || summarize(report))
  if (report.ignored.length > 0) {
    lines.push('')
    lines.push(`已忽略的元素（${report.ignored.length}）：`)
    for (const it of report.ignored) {
      lines.push(`  - ${it.label} @ ${it.location}${it.detail ? `（${it.detail}）` : ''}`)
    }
  }
  if (report.degraded.length > 0) {
    lines.push('')
    lines.push(`已降级处理的元素（${report.degraded.length}）：`)
    for (const it of report.degraded) {
      lines.push(`  - ${it.label} @ ${it.location}${it.detail ? `（${it.detail}）` : ''}`)
    }
  }
  return lines.join('\n')
}
// ============================================================
// 位置描述工具（统一措辞，避免各处手拼字符串）
// ============================================================

export function locParagraph(n: number): string {
  return `第 ${n} 段`
}

export function locTable(n: number, row?: number, cell?: number): string {
  if (row === undefined) return `第 ${n} 个表格`
  if (cell === undefined) return `第 ${n} 个表格第 ${row} 行`
  return `第 ${n} 个表格第 ${row} 行第 ${cell} 列`
}

export function locImage(n: number): string {
  return `第 ${n} 张图片`
}

export function locDocument(): string {
  return '文档整体'
}

export function locTextBox(n: number): string {
  return `第 ${n} 个文本框`
}