/**
 * 「勾选记录」列表里用哪两个字段做行标签。
 *
 * 规则：**从当前视图的字段里，按列序取前两个「认得出一条记录」的字段**（字段顺序 = 视图列序，
 * 来自 view.getFieldMetaList()）。
 *
 * ── 为什么不是"直接取前两个字段"（2026-09-18 真机反馈后修正）────────────────
 *
 * 上一版是 `fields.slice(0, 2)`，理由是"列对齐、可预期"，并把这个代价写进了注释：
 * "如果视图前两列恰好是附件 / 自动编号，列表里就会显示文件名或流水号"。
 *
 * 真机上这个代价真的发生了：用户的视图前两列里有一列是**附件**字段，于是勾选列表里
 * 每一行显示的是 `ID_4525EF594AE6491DB75A79…` —— 那是**飞书给的附件文件名**，
 * 不是用户能认出来的任何东西；第二槽还是空的。用户原话：
 *   **"完全看不出来，并没有按照要求显示前几个字段内容"**
 *
 * ⇒ 所以"可预期"这个理由**不成立**：一个每行都读不出是什么的表，再整齐也没用。
 *
 * ── 现在的规则（同时保住"列对齐"与"认得出"）────────────────────────────────
 *
 * **槽数仍然固定**（`LABEL_SLOT_COUNT`），列依旧对齐；
 * 变的是**挑哪些字段进这两槽**：跳过那些"在列表里读不出记录身份"的类型（见下）。
 *
 * 这与被废掉的那版"按信息量挑、空列收起来"**不是同一件事**：
 * 那版的问题是**每行显示的字段数不一样**（列不对齐），这条问题现在不存在 —— 槽数恒定。
 */

import type { FieldMeta, RecordItem } from '../../lib/data-source'
import { fieldMeta, renderCellValue } from '../../lib/field-types'

/** 一行固定显示几个字段（不随数据变化，保证列对齐） */
export const LABEL_SLOT_COUNT = 2

/**
 * 在列表里**读不出记录身份**的渲染类型 —— 挑标签槽时跳过。
 *
 * 目前只有 `attachment`：它的可读文本是**附件的自动文件名**（`ID_xxxx.jpg`），
 * 对"这是哪一条记录"零信息量。证据在 `test/range-picker.mjs` 的样例：
 * `{ name: 'ID_F65A6BA691A2487AA6629ED969CB2D6D.jpg' }`。
 *
 * 为什么只列它一个：**只跳有实测证据的那一类**。像"自动编号/日期"这类虽然是流水号，
 * 但它们是用户自己排在前面的、且**确实是这一行的一个属性**，贸然跳过反而会让
 * "列表里显示的字段"与"用户视图里看到的列"对不上 —— 那会引入新的困惑。
 */
const POOR_LABEL_RENDER_KINDS = new Set(['attachment'])


/**
 * 一格的空值占位。
 *
 * 为什么不留空：留空之后**两行的列看起来对不齐**，用户就分不清"这一格是空的"
 * 还是"这一格是另一列的内容" —— 那正是他要的那句"我都不知道显示的是什么"。
 */
export const EMPTY_CELL = '—'

/**
 * 值 → 显示：列表格子里那一串字。
 *
 * ① 值的读法仍归 `renderCellValue`（字段类型决定怎么读），这里**不重复实现一遍**；
 * ② 只补两条：**去掉首尾空白**（否则一个空格会显示成"看起来是空的、但又不是占位"），
 *    以及**空了就显式给「—」**。
 *
 * 为什么抽成纯函数：这条口径以前是写在 JSX 里的 `renderCellValue(...).trim() || '—'`，
 * 只能靠"真机上恰好有一张带空格子的表"才能验。抽出来之后，空值可以直接喂进来 —— **不需要真机**。
 */
export function displayCellText(
  value: unknown,
  type: number | undefined,
  meta?: { dateFormat?: string },
): string {
  const text = renderCellValue(value, type, meta).trim()
  return text || EMPTY_CELL
}

/**
 * 搜索用的匹配文本：**必须与显示同源**。
 *
 * 以前搜索拿的是未 trim 的原值，于是"看得见的 `—` 搜不到" —— 用户看着格子里的占位符去搜，
 * 一条都搜不出来。这正是本文件开头那句"看得到却搜不到"。
 */
export function searchCellText(
  value: unknown,
  type: number | undefined,
  meta?: { dateFormat?: string },
): string {
  return displayCellText(value, type, meta).toLowerCase()
}

/**
 * 取行标签字段：视图列序里**前两个「认得出一条记录」的字段**（不足两个就有几个用几个）。
 *
 * 槽数恒定 ⇒ 列对齐；跳过 `POOR_LABEL_RENDER_KINDS` ⇒ 认得出。两者要同时成立。
 *
 * @param fields 字段列表，顺序即界面列序（由 view.getFieldMetaList() 给出，见 sdk-source.listFields）
 */
export function pickLabelFields(fields: FieldMeta[]): FieldMeta[] {
  const usable = fields.filter((f) => !POOR_LABEL_RENDER_KINDS.has(fieldMeta(f.type).renderKind))
  // 整张表都是"读不出身份"的字段（极端情况）⇒ 退回原顺序：
  // 显示一串附件文件名总比两槽全是「—」强，而且此时用户也没有更好的选择。
  const picked = usable.length > 0 ? usable : fields
  return picked.slice(0, LABEL_SLOT_COUNT)
}

/** 一条记录在提示语里的可读文本（与列表同口径，但跳过空值 —— 提示语里不需要「—」占位） */
export function recordLabelText(rec: RecordItem, labelFields: FieldMeta[]): string {
  return labelFields
    .map((f) => renderCellValue(rec.fields[f.id], f.type).trim())
    .filter(Boolean)
    .join(' · ')
}
