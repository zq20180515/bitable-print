/**
 * 为一批记录预取**飞书自己格式化的「显示文本」**。
 *
 * ── 为什么需要它（2026-09-24 第四批第 3 条的根本解）────────────────────────
 *
 * 用户原话：「应该是**多维表格里显示什么就打印什么**，如果只修复时间，
 * 那以后其他公式是不是需要重新改」。这个判断是对的：
 *
 * 我们曾在 `renderCellValue` 里按字段类型猜"该怎么显示"，而**公式的结果类型在 API 里拿不到**
 * （只有 `formula_expression`，没有"结果是日期还是数字"）⇒ 只能靠值的形状猜
 * ⇒ 每遇到一种新公式就要再补一次代码。用户表里那个"公式"列算出来是日期，
 * 就一直印成裸时间戳 `1769126400000`。
 *
 * SDK 的 `table.getCellString(fieldId, recordId)` 返回的就是界面上那串文本 ⇒ 一劳永逸。
 *
 * ── 为什么只对"公式类"字段取 ──────────────────────────────────────────────
 *
 * `getCellString` **逐格异步、没有批量版**。600 条 × 20 字段 = 12000 次调用，
 * 预览/打印会慢到不可用。而公式恰恰是"本地算不准"的那一类；
 * 文本 / 数字 / 日期 / 选项 / 人员 / 附件走本地那套本来就准，不必多绕一趟 SDK。
 *
 * ── 为什么抽成模块 ────────────────────────────────────────────────────────
 *
 * 它有**两个调用方**（编辑器预览 `components/editor/preview.ts`、
 * 向导的打印/预览 `components/wizard/useWizardState.ts`）。
 * ⚠️ 2026-09-24 的教训：只接了编辑器那条，用户立刻发现"打印和打印预览里还是不对" ——
 * 所以这两条链**必须共用同一份实现**，不许各写一套。
 */
import type { FieldMeta, RecordItem } from './data-source'

/** `FT.Formula` —— 飞书字段类型编号（见 sdk 的 `FieldType` 枚举） */
const FORMULA_TYPE = 20

type Picker = {
  getCellString?: (tableId: string, recordId: string, fieldId: string) => Promise<string>
}

/**
 * 就地写入 `record.cellStrings`（**不抛错、不阻塞**）。
 *
 * ⚠️ 失败一律吞掉：拿不到就让渲染回落到本地格式化 ——
 * 打印不能因为某个字段取不到"显示文本"就整个失败。
 */
export async function fillCellStrings(
  ds: Picker | null | undefined,
  tableId: string,
  records: RecordItem[],
  fields: FieldMeta[],
): Promise<void> {
  if (!ds || typeof ds.getCellString !== 'function' || !tableId) return
  const formulaFields = fields.filter((f) => f.type === FORMULA_TYPE)
  if (formulaFields.length === 0 || records.length === 0) return
  const pick = ds.getCellString.bind(ds)
  await Promise.all(
    records.map(async (r) => {
      const map: Record<string, string> = {}
      for (const f of formulaFields) {
        try {
          const s = await pick(tableId, r.recordId, f.id)
          if (s) map[f.id] = s
        } catch {
          /* 单个字段失败不影响其它字段 */
        }
      }
      if (Object.keys(map).length > 0) r.cellStrings = map
    }),
  )
}
