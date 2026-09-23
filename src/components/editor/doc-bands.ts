/**
 * 版式区的**读 / 写 / 查找**原语：`readBand` / `withBand` / `findElement` / `dropElement` / `moveElementToBand`。
 *
 * ## 为什么要有这个文件（与 `table-query.ts` 同一理由）
 *
 * 这几个函数原来住在 `useEditorState.ts`（1500+ 行的 hooks 模块）。
 * 新的 `cell-child.ts`（格内子元素的定位与写回）也需要它们，于是只有两条路：
 *
 *   a. 从 `useEditorState` import —— 会把 **React 拖进纯函数层**，
 *      而那一层必须能被 Node 直接加载（`__selftest.mts` / `test/*.mjs` 都跑在 Node 下）；
 *      更要紧的是会形成 `useEditorState ⇄ cell-child` 的**循环依赖**。
 *   b. 自己再写一份 —— 同一套版式区寻址逻辑两份，**会静默分叉**。
 *
 * 两条都不能接受，所以走第三条：**把原语下沉到这里**（只依赖 `lib/types`，运行时零依赖），
 * `useEditorState.ts` 改成从这里 re-export。全项目仍然只剩一份实现，
 * 而所有 `from './useEditorState'` 的老引用（Canvas / EditorShell / index.ts …）一行都不用改。
 *
 * ⚠️ 不要把带状态的、或依赖 React 的东西搬进来 —— 这里必须保持"给个 doc 就给个结果"。
 */

import type { AnyElement, TemplateDoc } from '../../lib/types'

/** 版式区：表头区 / 循环区 / 表尾区 */
export type BandKey = 'header' | 'loop' | 'footer'

/** 遍历顺序固定为 header → loop → footer，`findElement` 等依赖它的确定性 */
export const BAND_ORDER: readonly BandKey[] = ['header', 'loop', 'footer'] as const

/** 读一个版式区的元素列表 */
export function readBand(doc: TemplateDoc, band: BandKey): AnyElement[] {
  if (band === 'loop') return doc.bands.loop.elements
  if (band === 'header') return doc.bands.header
  return doc.bands.footer
}

/** 把元素列表写回一个版式区（其余原样） */
export function withBand(doc: TemplateDoc, band: BandKey, els: AnyElement[]): TemplateDoc {
  if (band === 'loop') {
    return { ...doc, bands: { ...doc.bands, loop: { ...doc.bands.loop, elements: els } } }
  }
  if (band === 'header') {
    return { ...doc, bands: { ...doc.bands, header: els } }
  }
  return { ...doc, bands: { ...doc.bands, footer: els } }
}

export interface FoundElement {
  el: AnyElement
  band: BandKey
}

/**
 * 按 id 找元素。**只扫版式区** —— 格内子元素不在这里（见 `cell-child.ts` 的说明），
 * 所以调用方不要拿 `findElement(...) === null` 当作"这个 id 不存在"的判据。
 */
export function findElement(doc: TemplateDoc, id: string): FoundElement | null {
  for (const band of BAND_ORDER) {
    const hit = readBand(doc, band).find((e) => e.id === id)
    if (hit) return { el: hit, band }
  }
  return null
}

/** 从任意 band 中移除；找不到就原样返回（幂等，便于级联删除） */
export function dropElement(doc: TemplateDoc, id: string): TemplateDoc {
  let next = doc
  for (const band of BAND_ORDER) {
    const els = readBand(next, band)
    if (els.some((e) => e.id === id)) next = withBand(next, band, els.filter((e) => e.id !== id))
  }
  return next
}

/** 把元素换一个版式区（保留原坐标，越界交由"模板检查"提示） */
export function moveElementToBand(doc: TemplateDoc, id: string, to: BandKey): TemplateDoc {
  const found = findElement(doc, id)
  if (!found || found.band === to) return doc
  return withBand(dropElement(doc, id), to, [...readBand(doc, to), found.el])
}
