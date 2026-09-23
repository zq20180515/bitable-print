/**
 * 「检查」面板（2026-09-18 用户要求新增）。
 *
 * 用户原话：
 * "左侧的工具栏内，增加一栏'检查'，可以显示当前画布上所有的元素、字段，
 *  点击后高亮显示对应元素或者字段，方便用户删除不小心拖进来的元素字段。"
 *
 * ── 与已有两个面板的分工（别混）─────────────────────────────────
 * · `Palette`（字段 / 元素）：**类型调色板** —— 拖一个出来「新增」。它列的是"能加什么"。
 * · `Inspector`（样式）：**选中项的属性** —— 改当前选中的那一个。它只认一个对象。
 * · `InspectPanel`（检查）：**已经放上去的全部** —— 列的是"现在有什么"，用来做清点与清理。
 *
 * 为什么值得单开一栏：画布上元素一多，用户看不见压在底下的、或者拖到边角忘了的；
 * 而删除的唯一入口是"先精确点中它 → 再按删除"。这一栏把"找到它"这一步变成点一下列表。
 *
 * ── 排序口径 ────────────────────────────────────────────────
 * 按**版式区 + y**（画布上从上到下的顺序）。用户眼睛找的是"那块东西在纸上哪个位置"，
 * 不是"我什么时候加的" —— 按加入顺序排会让他每找一个都要扫全表。
 */
import type { ReactNode } from 'react'
import { finite, type AnyElement, type TemplateDoc } from '../../lib/types'
import type { FieldMeta } from '../../lib/data-source'
// `BandKey` / `elementLabel` / `BAND_LABEL` 都在 useEditorState 里（版式区与"元素叫什么"的唯一出处），
// 别在这里重新声明一份 —— 重新声明就会出现"两处定义慢慢长歪"。
//
// ⚠️ 这条**真的发生过**：本文件抄过一份自己的 `BAND_LABEL`，于是 2026-09-22 那次
//    「每页重复区 → 表头区」的改名只改到一半，这一行「节点路径」还写着旧名字。
//    现在改为直接引用（下面 `BAND_LABEL[band]` 用的是同一个来源）。
import { BAND_LABEL, elementLabel, type BandKey } from './useEditorState'
import { IconTrash } from './Icons'

export interface InspectPanelProps {
  doc: TemplateDoc
  fields: FieldMeta[]
  /** 当前选中的元素 id（列表里高亮它） */
  selectedId: string | null
  /** 点一行 → 让画布选中它（画布会滚动到可视区并画上选中框） */
  onSelect: (elementId: string) => void
  /** 删除一个元素（误拖进来的那个） */
  onRemove: (elementId: string) => void
}


/**
 * 一个版式区里的元素。
 *
 * 写成三个**显式分支**而不是 `doc.bands[band]`：`bands.loop` 是 `LoopBand`（不是数组），
 * 用 `BandKey` 去索引 `TemplateBands` 取不出统一的类型；而且显式写出来，
 * "循环区的元素挂在 `.elements` 上"这条结构事实就摆在这儿，改坏了也会立刻报错。
 */
function bandElements(doc: TemplateDoc, band: BandKey): AnyElement[] {
  if (band === 'header') return doc.bands.header ?? []
  if (band === 'footer') return doc.bands.footer ?? []
  return doc.bands.loop?.elements ?? []
}

/** 该元素引用了哪些字段（去重后的 `{fieldId, fieldName}`）。用于"字段"那一节的清点 */
function fieldRefsOf(el: AnyElement): Array<{ fieldId: string | null; fieldName: string }> {
  const out: Array<{ fieldId: string | null; fieldName: string }> = []
  const push = (fieldId: string | null, fieldName: string): void => {
    if (out.some((x) => x.fieldId === fieldId && x.fieldName === fieldName)) return
    out.push({ fieldId, fieldName })
  }
  if (el.kind === 'fieldBlock') push(el.fieldId ?? null, el.fieldName ?? '')
  if (el.kind === 'text') {
    for (const n of el.nodes) if (n.type === 'field') push(n.fieldId ?? null, n.fieldName ?? '')
  }
  if (el.kind === 'table') {
    for (const r of el.rows) {
      for (const c of r.cells) {
        for (const n of c.nodes) if (n.type === 'field') push(n.fieldId ?? null, n.fieldName ?? '')
      }
    }
  }
  return out
}

export function InspectPanel({ doc, fields, selectedId, onSelect, onRemove }: InspectPanelProps): ReactNode {
  const knownFieldIds = new Set(fields.map((f) => f.id))
  const bands: BandKey[] = ['header', 'loop', 'footer']

  // 一条记录里，字段可能被多个元素引用 ⇒ 汇总成"字段 → 用它的元素数"
  const fieldUsage = new Map<string, { name: string; fieldId: string | null; count: number }>()
  const rows: Array<{ el: AnyElement; band: BandKey; label: string }> = []
  let total = 0

  for (const band of bands) {
    const list = [...bandElements(doc, band)].sort((a, b) => finite(a.y, 0) - finite(b.y, 0))
    for (const el of list) {
      total += 1
      rows.push({ el, band, label: elementLabel(el) })
      for (const ref of fieldRefsOf(el)) {
        const key = ref.fieldId ?? `name:${ref.fieldName}`
        const cur = fieldUsage.get(key)
        if (cur) cur.count += 1
        else fieldUsage.set(key, { name: ref.fieldName || '(未命名字段)', fieldId: ref.fieldId, count: 1 })
      }
    }
  }

  const fieldRows = [...fieldUsage.values()].sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'))

  return (
    <div className="bp-panel bp-panel--inspect">
      <div className="bp-panel__scroll">
        <section className="bp-group">
          <div className="bp-group__title">
            画布上的元素<span className="bp-panel__count">{total}</span>
          </div>
          {rows.length === 0 ? (
            <p className="bp-panel__foot">画布还是空的 —— 从「字段」或「元素」拖一个进来。</p>
          ) : (
            <div className="bp-group__body bp-group__body--rows">
              {rows.map(({ el, band, label }) => (
                <div key={el.id} className={`bp-insp-row${el.id === selectedId ? ' is-on' : ''}`}>
                  {/*
                    整行是一个按钮（点哪都能选中），删除是行内第二个按钮。
                    为什么不用「行是按钮 + 里面再套一个按钮」：嵌套按钮是非法 HTML，
                    浏览器会把内层按钮挪出去，删除键会跑到别的地方（这个坑很隐蔽）。
                  */}
                  <button
                    type="button"
                    className="bp-insp-row__hit"
                    title={`在画布上选中：${label}`}
                    onClick={() => onSelect(el.id)}
                  >
                    <span className="bp-insp-row__band">{BAND_LABEL[band]}</span>
                    <span className="bp-insp-row__label">{label}</span>
                    <span className="bp-insp-row__pos">
                      {Math.round(finite(el.y, 0))}mm
                    </span>
                  </button>
                  <button
                    type="button"
                    className="bp-insp-row__del"
                    aria-label={`删除 ${label}`}
                    title="从画布上删掉这个元素"
                    onClick={() => onRemove(el.id)}
                  >
                    <IconTrash size={13} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="bp-group">
          <div className="bp-group__title">
            模板用到的字段<span className="bp-panel__count">{fieldRows.length}</span>
          </div>
          {fieldRows.length === 0 ? (
            <p className="bp-panel__foot">这份模板还没有引用任何字段。</p>
          ) : (
            <div className="bp-group__body bp-group__body--rows">
              {fieldRows.map((f) => {
                // 失效 = 有 fieldId 但当前表里找不到它（原字段被删/改名了）
                const invalid = !!f.fieldId && !knownFieldIds.has(f.fieldId)
                return (
                  <div key={f.fieldId ?? f.name} className="bp-insp-row bp-insp-row--field">
                    <span className="bp-insp-row__label">
                      {f.name}
                      {invalid ? <span className="bp-insp-row__bad">已失效</span> : null}
                    </span>
                    <span className="bp-insp-row__pos">×{f.count}</span>
                  </div>
                )
              })}
            </div>
          )}
          <p className="bp-panel__foot">
            字段本身不能在这里删（它属于数据表）；要删除的是用它的那个元素 —— 点上面元素那一行即可定位。
          </p>
        </section>
      </div>
    </div>
  )
}
