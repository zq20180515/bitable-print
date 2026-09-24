/**
 * 编辑器全屏容器（2026-09-20）。
 *
 * ── 为什么要有它 ────────────────────────────────────────────────
 * 插件本体跑在飞书侧边栏里，"看得清、拖得准"的排版活在那儿怎么做都别扭。
 * 老做法是 `window.open` 开独立窗口 —— 但飞书**代理了 `window.open`**：窗口真开了、
 * 返回值却是 `null`，于是父窗口既没有句柄也没有 opener，
 * postMessage / localStorage / window.name **三条回传通道同时断掉**，结果只能靠手动复制粘贴。
 *
 * ⇒ 换成**插件内全屏**：不开新窗口、不跨文档、不做进程间通信，
 *   编辑器和数据源在**同一个文档里** —— 保存走 SDK 直接落库，
 *   整类"跨窗口"问题（含那套中转服务器）一次性消失。
 *
 * ── 关于"全屏"到底有几档（本地对照实验 + 真机双重验证）──────────
 *   · **浏览器级全屏**：`requestFullscreen()`。跨源 iframe 默认被拒，
 *     只有宿主给 iframe 加了 `allow="fullscreen"` 才可用 —— **实测飞书是给了的**。
 *   · **容器内全屏**：`position:fixed; inset:0` 覆盖插件可视区。**一定能做**，是兜底。
 *
 * ── 两种"大小"怎么切（2026-09-20 用户反馈后重做）──────────────
 * 用户报过一个很难受的 bug：**按 Esc 缩回后按钮文字还是「缩小」**，
 * 点一下既不变大也不变小（只把文字翻成「全屏」），再点才真的放大。
 *
 * 根因：我把"大小"存成了自己的 state（`mode`），而 **Esc 退的是浏览器全屏** ——
 * 它不会改我的 state ⇒ **按钮文字与真实状态分叉**，中间那次点击落在"已经是 inline"的空档上。
 *
 * ⇒ 现在**由真全屏状态驱动**（`isFullscreen` 是唯一事实来源）：
 *   能用真全屏时，`全屏 = 进真全屏`、`缩小 = 退真全屏`（Esc 天然等价于"缩小"，状态自动跟上）；
 *   宿主不给全屏权限时才退回"容器内全屏 / 内嵌"这一对做兜底。
 *   这样**不存在"点一下没反应、但文字变了"的中间态**。
 */

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { TemplateDoc, TemplateKind } from '../../lib/types'
import type { FieldMeta, RecordItem } from '../../lib/data-source'
import {
  enterFullscreen,
  exitFullscreen,
  fullscreenStatusText,
  onFullscreenChange,
  probeFullscreen,
  type FullscreenSupport,
} from '../../lib/fullscreen'
import { EditorShell } from './EditorShell'
/**
 * ⚠️ **这份 CSS 必须由本文件显式引入**（2026-09-21）。
 *
 * 事情经过（分两步，别把两步混成一句）：
 *   ① **观察到的现象**：清理独立窗口那批文件之后，e2e 里 `.bp-fs` 的三条尺寸断言红了
 *      （`474×1976 vs 视口 807`、`.bp-fs--inline` 的 `position` 变成 `static`）。
 *      直接原因是**dev server 的模块图脏了** —— 我在它运行期间删掉了 `EditorWindow.tsx`
 *      等文件，它服务的 CSS 已经不是当前文件（重启即好）。
 *   ② **顺带查出的真隐患**（这一条单独做了受控实验才敢写）：`.bp-fs` 规则在 `editor.css`，
 *      而 `editor.css` 原本**只**由 `components/editor/index.ts` 引入；`index.ts` 的唯一引入方
 *      是 `Wizard.tsx` 里一句**已经用不到的** `import { EditorShell } from '../editor'`
 *      （本组件直接引 `./EditorShell`，绕开了 index）。
 *      ⇒ 谁顺手删掉那句无用 import，**编辑器样式会静默全失效**：tsc 不报、单测不报，
 *        只有 e2e 那三条尺寸断言会红。
 *      实验：把两处挂载点都去掉后重跑 e2e ⇒ **RED（3 条尺寸断言）**，结论成立。
 * ⇒ 改成"谁用谁引"：本文件依赖 `editor.css`，就由本文件引。
 *   注意 `index.ts` 里那一句**不要删** —— 它是那个 barrel 自己的样式依赖，与本句不冲突
 *   （Vite 对同一个 CSS 模块会去重）。两处都留着，才不怕任何一处被清理掉。
 */
import './editor.css'

/**
 * 「完成」的落库结果。
 *
 * 为什么要有这个返回值（2026-09-21 修的真 bug）：容器必须在落库**真的结束之后**
 * 才退全屏。以前 `onDone` 返回 `void`、调用方写 `() => void w.commitEditor()`，
 * 于是 `await onDone()` 拿到的是 `undefined` —— **等于没等**：
 * 浏览器先退全屏 ⇒ `onFullscreenChange(!fs)` 把容器档收成 `inline`
 * ⇒ 用户看到"画布先缩回侧边栏展开的样子，然后才跳到模板列表"。
 *
 * `ok === false` 时容器**不许关**：留在编辑器里让用户重试，并把 `message` 显示出来
 * （否则失败提示写在向导底栏，被浮层盖着，等于静默失败）。
 */
export type EditorDoneResult = void | { ok: boolean; message?: string }

export interface EditorOverlayProps {
  templateName: string
  kind: TemplateKind
  doc: TemplateDoc
  fields: FieldMeta[]
  dirty?: boolean
  onChange(next: TemplateDoc): void
  /** 落库。**返回的 promise 会被容器 await**，别写成 `() => void commit()` */
  onDone(): EditorDoneResult | Promise<EditorDoneResult>
  onCancel(): void
  /**
   * `EditorShell` 把它的 **Esc 仲裁链**注册上来（2026-09-23 真机反馈第 5 条）。
   *
   * ⚠️ 方向是**子 → 父**：Esc 的监听器必须挂在浮层上（要先于编辑器那条冒泡处理器），
   * 而"当前能退哪一层"的状态（预览 / 单元格 / 节点 / 表格编辑态 / 元素选中）全在
   * `EditorShell` 里 ⇒ 只能让它把函数注册上来，浮层存进 ref 用。
   * 传 `null` = 注销。
   */
  onEscapeLayerReady?(fn: (() => boolean) | null): void
  /**
   * 用户在向导第①步**实际勾选**的记录。
   *
   * ⚠️ 不传的后果（2026-09-24 第四批第 2 条）：编辑器里的「预览」会**回退到读整张表**
   * （`preview.ts` 的三级取数里，第一级就是宿主注入的 `records`），
   * 于是用户只勾了 4 条、预览却把整张表的 54 条都带进来。
   * 向导第③步的预览一直是对的 —— 因为那边直接吃 `records`，没有经过这里这一层透传。
   *
   * ⇒ 这条链是 `Wizard → EditorOverlay → EditorShell → renderEditorPreview`，
   *    **任何一环漏传都会静默退回"读整表"**，而用户看到的是"数据不对"、不是"参数没传"。
   */
  records?: RecordItem[]
  onRename(name: string): void
}

/**
 * 在**点击处理里同步调用**，尽力争取浏览器级全屏。
 *
 * 单独导出（而不是让组件 mount 时自己调）的原因很实在：
 * `requestFullscreen()` 需要**用户激活**，而 mount 发生在 state 提交之后的渲染阶段 ——
 * 那条路径上激活可能已经过期，调用会被拒，症状是"偶尔能全屏、偶尔不能"，极难查。
 */
export function requestEditorFullscreen(): void {
  void enterFullscreen()
}

/** 拿不到真全屏时，退化成"容器内全屏 / 内嵌"这一对 */
type FallbackMode = 'overlay' | 'inline'

export function EditorOverlay({
  templateName,
  kind,
  doc,
  fields,
  dirty,
  onChange,
  onDone,
  onCancel,
  onEscapeLayerReady,
  records,
  onRename,
}: EditorOverlayProps) {
  /**
   * `EditorShell` 注册上来的 **Esc 仲裁链**（2026-09-23 真机反馈第 5 条）。
   *
   * 为什么是"子注册上来"而不是 props 传下来：Esc 的监听器必须挂在**浮层**上
   * （它要早于编辑器那条冒泡处理器），而"现在能退哪一层"的状态全在 `EditorShell` 里。
   *
   * ⚠️ `registerEscapeLayer` 用 `useRef(...).current` 安装**一次**，不用 `useCallback`：
   *    `EditorShell` 的 effect 依赖它，每次渲染换新函数会导致重复注册（无害但脏）。
   */
  const escapeLayerRef = useRef<(() => boolean) | null>(null)
  const registerEscapeLayer = useRef((fn: (() => boolean) | null): void => {
    escapeLayerRef.current = fn
  }).current
  const [support] = useState<FullscreenSupport>(() => probeFullscreen())
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [confirmingClose, setConfirmingClose] = useState(false)
  const [fallbackMode, setFallbackMode] = useState<FallbackMode>('overlay')
  /* Esc 与"退出真全屏"时的档位规则见下面 `onFullscreenChange` 里那段注释（不再需要"回档"用的 ref） */
  /**
   * 正在落库（2026-09-21）。
   *
   * 两件事都要它：
   *   · **锁住「完成 / 返回 / 缩小」** —— 落库期间再点一次「完成」，
   *     新建那条路会**建出两个模板**（`commitEditor` 每次都会 `createTemplate`）；
   *   · **撑住全屏**，不要在等待期间退出去（那正是"先缩回小画布再跳转"的来源）。
   */
  const [saving, setSaving] = useState(false)
  /** 落库失败的原因。**必须显示在浮层里** —— 向导底栏那份被浮层盖着，用户看不见 */
  const [saveError, setSaveError] = useState<string | null>(null)

  /**
   * ⚠️ **真全屏状态一变，容器档也要跟着收**（2026-09-20 修的那个 bug 的正解）。
   *
   * 用户报的现象："按 Esc 会缩回插件侧边栏，但按钮文字还是「缩小」；
   * 点一次不变大也不变小、只把文字翻成「全屏」，再点才真的放大。"
   *
   * 根因：Esc 退的是**浏览器全屏**，它不会改我自己的那点 state
   * ⇒ 按钮文字与实际大小分叉，中间那次点击正好落在"已经是 inline"的空档上。
   * ⇒ 所以"退出真全屏"这件事必须被当成**缩小的同义词**：`!fs` 就把容器档收成 inline。
   */
  useEffect(
    () =>
      onFullscreenChange((fs) => {
        /*
         * ⚠️ **不要**在这里"吞掉"某次退出全屏（2026-09-23 栽过一回）。
         *
         * 曾经为了让系统文件选择器弹出的那次退出全屏不触发布局切换，这里加过
         * `if (!fs && isFileDialogOpen()) return`。后果：浏览器已经不在全屏，而
         * `isFullscreen` 还是 true ⇒ 顶部按钮写着「缩小」，点它却**什么都不发生**
         * （`exitFullscreen()` 在非全屏下是空操作）—— 用户被卡在一个既不是全屏、
         * 也退不出去的档里（真机截图里就是这么卡住的）。
         *
         * ⇒ 状态必须始终如实。文件选择那条链已经改成**单例 input**（见 `lib/file-pick.ts`），
         *   不必再怕"对话框期间重挂把 input 换掉"，所以这里不需要任何特殊照顾。
         */
        /*
         * ⚠️ **退出真全屏时不要一律收成小窗**（2026-09-23 真机反馈第 5 条）。
         *
         * 用户原话：「全屏画布下……按 Esc 会直接缩回小尺寸页面，优化一下，
         * 按 Esc 是退出预览，但不是退出全屏」。
         *
         * 浏览器级真全屏里的 Esc 是 **UA 行为**（`preventDefault` 拦不住，这是规范保证的），
         * 所以"按 Esc 完全不退出真全屏"物理上做不到。能做到的是：
         * **退出真全屏之后不要缩回去** —— 回到进真全屏之前那一档（默认 = 盖满视口的 `overlay`）。
         * 观感就是"画布纹丝不动"，而且 `isFull` 仍为 true ⇒ 顶部按钮仍是「缩小」，
         * 不会退回 2026-09-20 那个"按钮文字与实际大小分叉"的毛病。
         *
         * 「真想缩小」只有一条路：点顶部按钮（`toggleFull` 里显式设 `inline`）。
         */
        /*
         * ⚠️ 退出真全屏时**一律落到 `overlay`**（2026-09-23 第二次反馈，第 1 / 2 条）。
         *
         * 上一版写的是"回到进真全屏之前那一档"，看着合理，但在**按 Esc 退出真全屏**这条路上是错的：
         * 用户若先点过「缩小」（档位 = `inline`）、再点「全屏」进真全屏，`preFsModeRef` 记下的
         * 就是 `inline` ⇒ 一按 Esc 立刻缩回小窗。用户原话：「全屏预览状态，按 ESC……页面退回缩小状态」。
         *
         * Esc 的语义是"退一层编辑状态"，**不包括退大屏**。真要缩小只有一条路：
         * 点顶部那个按钮（`toggleFull` 里显式设 `inline`）。
         * 于是这里直接落到 `overlay` —— `isFull` 仍为 true ⇒ 画布铺满、按钮仍显示「缩小」，前后一致。
         */
        if (!fs) setFallbackMode('overlay')
        setIsFullscreen(fs)
      }),
    [],
  )

  /**
   * 到底算不算"盖满"：
   *   · 进了真全屏 —— 当然算；
   *   · 没进真全屏但容器档是 overlay —— 也算（这是宿主不给全屏权限时的兜底，**一定能成**）。
   * 刻意**不**用 `canRealFullscreen` 去覆盖默认档：那样在"真全屏恰好没成功"的环境里
   * 打开编辑器会直接是小画布，用户会觉得"点了编辑没反应"。
   */
  const isFull = isFullscreen || fallbackMode === 'overlay'

  /**
   * 锁定宿主页面滚动条：容器内全屏靠 `fixed` 盖住，底层若还能滚，
   * 用户一动鼠标就看到浮层底下的列表在动（容易被误认为没全屏）。
   * 卸载时**原样还原** —— 直接写 `overflow:hidden` 再不管，会把插件永久搞成不能滚。
   * ⚠️ 只在"盖满视口"时锁：内嵌档本来就该能滚（那正是"缩小"的意义）。
   */
  useLayoutEffect(() => {
    if (!isFull) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = prev
    }
  }, [isFull])

  /**
   * Esc：真全屏时**让给浏览器**（它退全屏 = 就是"缩小"，我们的状态会自动跟上）。
   *
   * ⚠️ 落库期间（`saving`）**整条退出路径都要关掉**：这会儿 `commitEditor` 已经在写了，
   * 再走一次"取消"会把 `pendingNew` 清掉、并在列表里留下刚建好的那一条，
   * 用户看到的是"我点了完成，结果模板多了一条、编辑器却像没保存过"。
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      /*
       * ⚠️ **先给编辑层一次机会**（2026-09-23 真机反馈第 5 条）。
       *
       * 顺序反了就是用户报的那个现象："全屏画布下，预览时按 Esc 会直接缩回小尺寸页面"。
       * 这条监听器挂在**捕获阶段**（比编辑器的冒泡早），原来它一上来就判 `!dirty ⇒ onCancel()`，
       * 于是预览还没关、编辑器先被关掉了。
       *
       * 现在 Esc 的语义是**逐级退**：预览 → 节点 → 单元格 → 表格编辑态 → 元素选中。
       * 全都没得退时，才轮到"关掉编辑器"（下面那几条）。
       */
      if (escapeLayerRef.current?.()) {
        e.preventDefault()
        return
      }
      /*
       * ⚠️ **没有任何一层可以退时，Esc 什么都不做**（2026-09-23 第二次反馈，第 1 / 2 条）。
       *
       * 原来这里会走 `!dirty ⇒ onCancel()`，也就是**把编辑器关掉**。用户看到的正是：
       * 「在画布编辑状态，只要点击 ESC，页面都会缩小」，而且侧栏那个「全屏 / 缩小」按钮
       * 还会显示成「全屏」（因为容器档被收成了 `inline`）—— 状态看起来是自相矛盾的。
       *
       * 现在**关编辑器只有一条路：点顶部的「返回 / 完成」**。
       * Esc 只负责"逐级退一层"（预览 → 节点 → 单元格 → 表格编辑态 → 元素选中），
       * 一层都没得退时就当它没被按过 —— 既不关编辑器，也不碰全屏档。
       *
       * 真全屏下的 Esc 是 **UA 行为**（`preventDefault` 拦不住），浏览器仍会退出全屏；
       * 那一半由 `onFullscreenChange` 保持 `overlay` 档来兜住，观感上画布纹丝不动。
       */
      e.preventDefault()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
    /*
     * 依赖是空的：这条路只读一个 ref（`escapeLayerRef`），不闭包任何 state ——
     * 留 `dirty` / `saving` 在这里只会让监听器被无谓地重绑。
     */
  }, [])

  /**
   * 切大小。
   *
   * ⚠️ **每一次点击都必须有可见反应**（这是那个 bug 的教训）：
   *   · 缩小 ⇒ 退真全屏 **且** 把容器档收成 inline（两步都做，少一步就会"没反应"）；
   *   · 全屏 ⇒ 请求真全屏；**万一没成功**（宿主收回了权限）就退回容器内全屏，
   *     绝不留一个"点了什么都不发生"的按钮。
   * ⚠️ 落库期间不许切：退出真全屏会把容器档收成 inline，用户就会看到
   *   "正在保存，画布却先缩回去了"——正是我们这次要修的那个观感。
   */
  const toggleFull = (): void => {
    if (saving) return
    if (isFull) {
      void exitFullscreen()
      setFallbackMode('inline')
      return
    }
    void enterFullscreen().then((r) => {
      if (r !== 'available') setFallbackMode('overlay')
    })
  }

  /** 真的退出（确认层点"放弃"、或本来就没改动时走这里） */
  const close = (): void => {
    // 顺带退出真全屏：否则浮层没了、浏览器还停在全屏，用户看到一片空白只能按 Esc 自救
    void exitFullscreen()
    onCancel()
  }
  /** 退出意图统一走这里：有未保存改动就先问一句（原来只有 Esc 会问，"返回"是直接丢） */
  const requestCancel = (): void => {
    if (saving) return
    if (!dirty) {
      close()
      return
    }
    setConfirmingClose(true)
  }
  /**
   * 「完成」：**等落库真的结束**，成功才退全屏（2026-09-21 修的那个观感 bug）。
   *
   * 用户原话："点击完成后，画布会先缩小到侧边栏展开的状态，然后才会跳转到模板选择界面，
   * 能不能直接完成后，就跳转到模板保存界面？"
   *
   * 根因是 `await onDone()` **没在等**：调用方传的是 `() => void w.commitEditor()`，
   * 箭头函数返回 `undefined` ⇒ `await` 立刻过 ⇒ 先 `exitFullscreen()` ⇒
   * `onFullscreenChange(false)` 把容器档收成 `inline` ⇒ 用户看到画布缩回小窗，
   * 而 `commitEditor` 还在等 SDK 往返。等它落完，才轮到 `setEditorDoc(null)` 关掉浮层。
   *
   * ⇒ 现在的顺序是：**保存中（画布保持全屏，按钮锁住）→ 落库成功 → 关浮层 → 退全屏**。
   *   失败则**不退全屏、不关浮层**，把原因显示在浮层里（以前提示写在向导底栏，被盖住看不见）。
   */
  const finish = async (): Promise<void> => {
    if (saving) return
    setSaving(true)
    setSaveError(null)
    let ok = true
    try {
      const res = await onDone()
      // 返回 void 视为成功（老契约）；显式 `{ok:false}` 才算失败
      ok = !res || res.ok !== false
      if (!ok) setSaveError(res && res.message ? res.message : '保存失败，请重试。')
    } catch (e) {
      ok = false
      setSaveError(`保存时出错：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setSaving(false)
    }
    // ⚠️ 只有存成了才退全屏；失败要留在原地（用户能直接重试，不用重新打开编辑器）
    if (ok) void exitFullscreen()
  }

  const status = fullscreenStatusText(support, isFullscreen)

  /**
   * 「全屏 / 缩小」按钮 —— **塞进 EditorShell 顶栏**（`topActions`），不另占一行。
   *
   * ⚠️ 状态说明**不再单独显示**（用户原话："直接移除这个字，不然用户会误以为可以点击"）——
   *   它原来是一段蓝色小字，看着像个链接。信息没丢，改挂到按钮的 `title` 上：
   *   鼠标停一下就能看到"现在是不是真全屏、为什么不是"。
   * ⚠️ 落库期间禁用：那时候切档会把画布收成小窗，用户就会看到
   *   "正在保存、画布却先缩回去"（正是这次要修的观感）。
   */
  const topActions = (
    <button
      type="button"
      className="bp-btn"
      onClick={toggleFull}
      disabled={saving}
      title={`${isFull ? '退回插件内的小画布' : '铺满整个屏幕来排版'}｜${status.detail}`}
    >
      {isFull ? '缩小' : '全屏'}
    </button>
  )

  const editorBody = (
    <div className="bp-fs-body">
      <EditorShell
        doc={doc}
        fields={fields}
        records={records}
        templateName={templateName}
        kind={kind}
        topActions={topActions}
        /** ⚠️ `busy` 见 EditorShellProps：落库期间锁「完成 / 返回」 */
        busy={saving}
        onChange={onChange}
        onDone={() => void finish()}
        onCancel={requestCancel}
        onRename={onRename}
        /* Esc 仲裁链：由子组件注册上来 —— 浮层要在**捕获阶段**先问它有没有把 Esc 用掉 */
        onEscapeLayerReady={registerEscapeLayer}
      />
    </div>
  )

  const confirmLayer = confirmingClose ? (
    <div className="bp-fs-confirm" role="dialog" aria-modal="true" aria-label="放弃未保存的改动">
      <div className="bp-fs-confirm-card">
        <p className="bp-fs-confirm-title">{dirty ? '这次编辑还没保存，确定退出？' : '确定退出编辑？'}</p>
        <div className="bp-fs-confirm-actions">
          <button type="button" className="app-btn sm" onClick={() => setConfirmingClose(false)}>
            继续编辑
          </button>
          <button type="button" className="app-btn sm danger" onClick={close}>
            {dirty ? '放弃改动并退出' : '退出'}
          </button>
        </div>
      </div>
    </div>
  ) : null

  /**
   * 落库失败的提示条（2026-09-21）。
   *
   * 为什么非要有它：`commitEditor` 失败时写的是向导底栏的 `tplHint`，而底栏**被浮层盖着**——
   * 用户看到的是"点了完成，什么都没发生"，最坏的失败方式。失败时浮层不退（见 `finish`），
   * 所以这条提示有地方显示。
   */
  const errorLayer = saveError ? (
    <div className="bp-fs-err" role="alert">
      <span className="bp-fs-err-text">{saveError}</span>
      <button type="button" className="app-btn sm" onClick={() => setSaveError(null)}>
        知道了
      </button>
    </div>
  ) : null

  /**
   * 两档**只在"挂到哪儿、占多大"上不同**，里面的 EditorShell 完全同一棵子树 ——
   * 这样来回切不丢任何编辑状态。换两棵不同的树会在切换时重挂，用户刚排的版当场消失。
   */
  if (!isFull) {
    return (
      <div className="bp-fs bp-fs--inline" role="region" aria-label={`编辑模板：${templateName}`}>
        {errorLayer}
        {editorBody}
        {confirmLayer}
      </div>
    )
  }

  /**
   * ⚠️ **portal 到 `document.body`**：`position:fixed` 的包含块会被
   * **任何有 transform/filter/perspective 的祖先**改写（飞书容器层层嵌套，很容易有一个），
   * 挂到 body 就与它们无关了。这也是本项目 Popover / MergeConfirm 已经在用的做法。
   */
  return createPortal(
    <div className="bp-fs" role="dialog" aria-modal="true" aria-label={`编辑模板：${templateName}`}>
      {errorLayer}
      {editorBody}
      {confirmLayer}
    </div>,
    document.body,
  )
}
