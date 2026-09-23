/**
 * 合并前的确认层（**共享组件**）。
 *
 * 为什么要有这个文件：确认层原来整个关在 `Inspector.tsx` 的 `CellPanel` 里 ——
 * `pending` state、判据（`discardParts`）、还有这个 portal 弹层都是它的私有物。
 * 于是只有"从单元格面板点合并"这一条路会问用户；B 批给顶栏加了表格工具条，
 * 工具条与 `CellPanel` 是**兄弟**，够不到那一份。不提升就只有两种结局：
 * 工具条那边再写一套（这个项目在"同一个逻辑两处各写一套"上已经栽过三次），
 * 或者工具条绕过确认层直接合并 —— 后者会**静默丢内容**，是这个项目修过的真实缺陷。
 *
 * 所以两半都搬出来：
 *   - **判据**跟着纯函数走，住 `./table-actions`（那样 Node 套件能直接验它）；
 *   - **状态 + UI** 住这里与 `EditorShell`（`pending` 提升到 shell，弹层在这里）。
 *
 * 判据与"怎么说"是分开的：`table-actions` 只回答"丢了什么"（结构），
 * 中文文案在 `mergeWarnText` 里拼，因为系统变量的标签表 `SYSVAR_LABEL` 在浏览器侧
 * （`./useEditorState`），而 `table-actions` 必须能被 Node 直接加载、不能 import 它。
 */

import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { discardedPartsText, type DiscardedPart } from './table-actions'
import { SYSVAR_LABEL } from './useEditorState'

/**
 * 一次"待确认的合并"。
 *
 * 存的是**定位 + 结构**，不是闭包：闭包会捕获当次渲染的 `rows`，
 * 用户在确认层弹出的这段时间里改了表格，闭包里的 `rows` 就是旧快照，
 * 一点确认就把这期间的改动整片盖掉。
 *
 * 用 `elementId + cellId` 而不是 `rowIdx + colIdx` 也是为了这件事：
 * 确认时按 id 从**当前**文档重新定位，行列表怎么动都不会认错格。
 */
export interface PendingMerge {
  elementId: string
  /**
   * 从哪一格发起 —— **既是"合并的起点"也是"删除行列的定位器"**。
   *
   * 用 id 而不是 rowIdx/colIdx：确认层开着的这段时间里用户可能改了表格（加了一行、删了一列），
   * 下标会失效，按 id 从**当前**文档重新定位才不会认错格。这是原实现的理由，
   * 2026-09-22 把"删除行列"并进同一套确认层之后**这条理由更重要了**（行/列号正是最容易变的量）。
   */
  cellId: string
  /** `right`/`down` = 相邻格合并；`range` = 矩形选区合并；`row`/`col` = 删除整行/整列 */
  dir: 'right' | 'down' | 'row' | 'col' | 'range'
  /** 只有 `dir === 'range'` 时用：确认后要重跑的那块矩形（左上行列 + 右下行列） */
  range?: { r1: number; c1: number; r2: number; c2: number }
  /** 会被丢掉的东西。结构，不是文案 —— 文案在 `mergeWarnText` 里拼 */
  parts: DiscardedPart[]
}

/**
 * 结构 → 用户看到的那句话。
 *
 * 文案与提升之前**逐字一致**（用户已经看过那句话，改措辞是行为变化、不是重构），
 * 逐字对照见 `table-actions.ts` 的 `discardedPartsText` 注释。
 */
export function mergeWarnText(parts: DiscardedPart[]): string[] {
  return discardedPartsText(parts, (k) => SYSVAR_LABEL[k])
}

/**
 * 合并前的确认弹层。
 *
 * 为什么不用 window.confirm：宿主通常是 iframe，Chrome 对跨源 iframe 的**阻塞式**对话框
 * 会直接吞掉（未必给用户看到），那就退化成"点了没反应"——和要修的缺陷同一类。
 * 项目里也没有可复用的 Modal（Popover 是贴着触发器定位的浮层，没有阻塞语义），
 * 所以这里自绘：portal 到 body，层级取 --z-modal + 250。
 * 页面级的阶梯是（见 styles/tokens.css）：--z-popover 200 ＜ 编辑器浮层 `.bp-fs` 410
 * （= --z-modal+10）＜ 编辑器自己的下拉/弹出层 500(=--z-modal+100) ＜ --z-toast 600
 * ＜ 本层 650(=--z-modal+250)。
 * 注意**不能取 +200**：那等于 600，与 toast 平级而不是压过它 —— 这个项目已经踩过一次
 * "宿主盖住下拉层"的坑，这里是同一个坑的下一个路口。
 *
 * ⚠️ 2026-09-21：这句注释以前写的是「宿主 `.wz-editor-host` 400」——
 * 那个元素连同"侧边栏内联画布"整条分支已经删掉了，现在撑起这一层的是
 * 编辑器自己的 `.bp-fs`（410）。阶梯**没变**，只是标尺换了个人，所以数字一并更新，
 * 免得后来人照着 DOM 里找不到的 `.wz-editor-host` 去核对层级。
 */
export function MergeConfirmDialog({
  parts,
  onConfirm,
  onCancel,
  /*
   * 下面四个都有默认值 ⇒ **合并那条路的 DOM 与文案逐字不变**
   * （`test/editor-interaction.mjs` 按 aria-label「确认合并」找按钮，改了会白断）。
   * 删除行列复用同一个弹层，只是把标题/正文/按钮文案换掉。
   */
  title = '合并会丢内容',
  text,
  confirmLabel = '仍然合并',
  confirmAriaLabel = '确认合并',
  cancelAriaLabel = '取消合并',
}: {
  parts: string[]
  title?: string
  text?: string
  confirmLabel?: string
  confirmAriaLabel?: string
  cancelAriaLabel?: string
  onConfirm(): void
  onCancel(): void
}) {
  // onCancel 每次渲染都是新函数（内联箭头），用了 ref 才不用每渲染重挂监听
  const cancelRef = useRef(onCancel)
  cancelRef.current = onCancel
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      // 和 Popover 一样用捕获 + stopPropagation：否则编辑器的 Esc（取消选中）会一起触发
      e.stopPropagation()
      cancelRef.current()
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [])

  return createPortal(
    <div
      className="bp-confirm-backdrop"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onCancel()
      }}
    >
      <div className="bp-merge-confirm" role="alertdialog" aria-modal="true" aria-label={title}>
        <p className="bp-merge-confirm__title">{title}</p>
        <p className="bp-merge-confirm__text">
          {text ?? `合并后 ${parts.join('、')} 会被丢弃，之后拆分也补不回来。确定合并吗？`}
        </p>
        <div className="bp-btnrow bp-merge-confirm__btns">
          <button type="button" className="bp-btn" aria-label={cancelAriaLabel} onClick={onCancel}>
            取消
          </button>
          <button type="button" className="bp-btn bp-btn--primary" aria-label={confirmAriaLabel} onClick={onConfirm}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
