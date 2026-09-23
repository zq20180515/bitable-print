import { useEffect, useMemo, useRef, useState } from 'react'
import type {
  DataSource,
  FieldMeta,
  FieldOrderSource,
  RecordItem,
  RecordOrderSource,
  TableContext,
} from '../../lib/data-source'
import type { TemplateKind } from '../../lib/types'
// `formatDateTime`：卡片左下角"最后编辑时间"用它（项目唯一的日期格式化，不另写一份）
// `formatDateTime`：模板卡片右下角"最后编辑时间"用它（项目唯一的日期格式化，不另写一份）
// ⛔ 这里原来还有 `FT` / `fieldMeta` 与 `lib/filter` 的三条导入 —— 2026-09-21 移除「筛选条件」时
//    一并清掉：`FT` 早就没人用（遗留），`fieldMeta` 与 filter 的四个函数**只被已删的
//    `FilterEditor` / `ConditionValue` 用过**（grep 计数为 0 才删的，不是凭印象）。
import { formatDateTime } from '../../lib/field-types'
import type { TemplateListItem } from '../../lib/template-store'
// ⛔ 这里原来有 `import { EditorShell } from '../editor'` —— 它**已无用**（编辑器现在由
//    `EditorOverlay` 自己组装，且直接从 `./EditorShell` 引），2026-09-21 移除。
//    ⚠️ 移除它是**安全的**，因为 `editor.css` 的引入已经收进 `EditorOverlay` 自己身上；
//       在那之前，这一句无用 import 是整份编辑器样式的**唯一**挂载点 —— 一删就全盘失效（实测）。
import { useWizardState } from './useWizardState'
import { displayCellText, searchCellText } from './label-fields'
import type { RangeMode } from './useWizardState'
import { capabilityNote } from './record-selection'
import { PreviewFrame } from './PreviewFrame'
import { WordImportPanel } from './WordImportPanel'
import { SkeletonPicker } from './SkeletonPicker'
// 插件内全屏编辑（取代 window.open 的独立窗口，见 EditorOverlay 的文件头）
import { EditorOverlay, requestEditorFullscreen } from '../editor/EditorOverlay'
import './wizard.css'

/**
 * 四步向导（PRD BP-1）：① 选范围 → ② 选模板 → ③ 预览 → ④ 打印/导出。
 *
 * 所有状态与编排都在 useWizardState 里，这里只负责呈现与交互。
 * 子步骤都写成接收同一个 state 对象的局部组件，避免在窄侧栏里堆一大串 props 透传。
 *
 * 易用性上的三条硬规矩（窄侧栏场景反复踩过）：
 *   · 每一步都要能回答"点下去会发生什么"——数量、页数、产出物必须提前可见；
 *   · 主按钮全局只有一个，且永远在底部同一位置；
 *   · 警示默认收成一行摘要，不能把内容和预览挤出屏幕。
 */

interface Props {
  ds: DataSource
  ctx: TableContext | null
  fields: FieldMeta[]
  records: RecordItem[]
  /** `records` 的顺序来源（App 那次 fetchRecords 的结论）；视图排序读不出来时要如实告知 */
  recordOrder?: RecordOrderSource
  /** **字段**顺序的来源（App 那次 listFields 的结论）；读不到视图列序时同样要如实告知 */
  fieldOrder?: FieldOrderSource | null
  templateTableId: string | null
}

type W = ReturnType<typeof useWizardState>

const STEPS = ['选范围', '选模板', '预览', '输出'] as const

/**
 * 记录模板下「一条记录 = 一份文档」，条数超过这个量级就值得**提一句**。
 *
 * ⚠️ 它现在的**唯一**用途是**选模板页**的一句轻提醒 + 预览页那条可跳回改范围的说明。
 * 以前这里还配了一个 `RECORD_BULK_DANGER = 50`，用于在第 ① 步弹红色阻断卡 ——
 * 那条 2026-09-21 被用户要求删掉了（**不再限制数据量**，只在选模板页轻提醒）。
 * 别再恢复成"红色警告 + 动作按钮"：`预计产出` 那张事实卡已经如实写了份数。
 */
const RECORD_BULK_WARN = 10

type TplMode = 'list' | 'word' | 'skeleton'

export function Wizard({ ds, ctx, fields, records, recordOrder, fieldOrder, templateTableId }: Props) {
  const w = useWizardState({
    ds,
    ctx,
    fields,
    initialRecords: records,
    recordOrder,
    fieldOrder,
    templateTableId,
  })
  /**
   * 步骤②的子面板（骨架 / Word）由向导层持有：
   * 打开子面板时底部操作栏要让位，否则"上一步 / 下一步：预览"和面板自己的按钮会打架。
   */
  const [tplMode, setTplMode] = useState<TplMode>('list')

  // 离开步骤②时收起子面板，避免"从导航跳走再跳回来还停在上次的面板里"
  useEffect(() => {
    if (w.step !== 1) setTplMode('list')
  }, [w.step])

  /**
   * 编辑器全屏覆盖编辑器之外的一切（PRD P3）：
   * 插件本体在 app 顶栏 + mock 提示条 + 页签下面，不盖住的话编辑器白吃约 130px 高度。
   *
   * ⚠️ 判据**只有一个 `editorDoc`**（2026-09-21）。这里原来还 && 了 `!editorInWindow` ——
   * 那是"独立窗口会话"时代的补丁（窗口开着时侧边栏不许再接管整页）。
   * 独立窗口那条路整体废弃之后，`editorInWindow` 已经不存在，判据回到最简。
   */
  if (w.editorDoc) {
    /**
     * **插件内全屏编辑**（2026-09-20）。
     *
     * 原来这里只有一条"兜底"路径（`window.open` 返回 null 时才用），
     * 而现在它**就是主入口** —— 因为飞书把 `window.open` 代理掉了：
     * 窗口虽然开了，父窗口却拿不到句柄、也没有 opener，
     * postMessage / localStorage / window.name 三条回传通道同时断，
     * 结果只能靠手动复制粘贴（为此还上了一套中转服务器）。
     *
     * 换到插件内全屏之后：编辑器与数据源在**同一个文档**里 ⇒ 保存直接走 SDK 落库，
     * 整类"跨窗口"问题（以及那台服务器）一次性消失。
     * 全屏本身分两级：容器内全屏（一定能做）+ 尽力争取浏览器级真全屏，见 EditorOverlay。
     */
    // ⚠️ JSX 的**属性位不能放** `{/* */}` 注释（那是语法错误）——要写就写在元素外面，本文件踩过一次。
    /**
     * ⚠️ 名字 / 类型 / 改名**一律取 `w.editorTarget`**，不要在这里自己拼表达式。
     *
     * 这里原来是 `templateName={w.active?.name ?? w.pendingNew?.name ?? '新建模板'}` ——
     * **判据反了**：`active` 因"加载模板后自动选中第一条"几乎总是非空，
     * 于是新建模板 B 时左上角显示的是**上一个模板 A 的名字**（用户报的那个 bug）。
     * 同一段里的 `onRename` 也只认 `w.active` ⇒ 在新模板上改名会**把 A 改掉**。
     * 现在判据只有一处（`useWizardState` 的 `editorTarget`），与 `commitEditor` 落库同源。
     */
    /**
     * ⚠️ **必须把这个 promise 原样交出去**，不能写成 `() => void w.commitEditor()`（2026-09-21）。
     *
     * `void` 会把返回值抹成 `undefined`，于是容器里的 `await onDone()` **等于没等**：
     * 浏览器先退全屏、浮层切回"内联小画布"，落库还在路上 ——
     * 用户看到的就是"点完成先缩回侧边栏，然后才跳模板列表"。
     * 容器的 `finish()` 现在依赖这个 promise 才能把顺序摆正，也要靠它的
     * `{ok:false}` 决定"失败时别关编辑器"。
     */
    return (
      <EditorOverlay
        templateName={w.editorTarget?.name ?? ''}
        kind={w.editorTarget?.kind ?? w.kind}
        doc={w.editorDoc}
        fields={fields}
        dirty={w.editorDirty}
        onChange={w.changeEditorDoc}
        onDone={() => w.commitEditor()}
        onCancel={w.cancelEditor}
        onRename={(name) => w.editorTarget?.rename(name)}
      />
    )
  }

  return (
    <div className="wiz">
      <StepNav w={w} />

      <div className="wiz-content">
        {w.step === 0 && <StepRange w={w} fields={fields} />}
        {w.step === 1 && <StepTemplate w={w} fields={fields} mode={tplMode} onModeChange={setTplMode} />}
        {w.step === 2 && <StepPreview w={w} />}
        {w.step === 3 && <StepOutput w={w} />}
      </div>

      <WizardFooter w={w} panelOpen={w.step === 1 && tplMode !== 'list'} />
    </div>
  )
}

// ============================================================
// 步骤指示器（紧凑：一行 + 一条进度线）
// ============================================================

function StepNav({ w }: { w: W }) {
  // 只有已完成或当前步可点，避免用户跳到还没有数据支撑的步骤
  const reachable = (i: number): boolean => i <= w.step || (i === 1 && w.scopedRecords.length > 0)

  return (
    <nav className="wiz-steps" aria-label="打印流程">
      <ol className="wiz-steps-list">
        {STEPS.map((label, i) => {
          const state = w.step === i ? 'active' : w.step > i ? 'done' : 'todo'
          return (
            /*
             * ⚠️ `li` 上挂状态类（2026-09-21 UI 重设计），而不是让 CSS 去 `:has(> .wiz-step.done)`。
             *
             * 连接线是画在 `li::before` 上的（见 wizard.css 的「UI 重设计」段），
             * 而"这一段该不该变绿"取决于**子元素** `button` 的状态 —— CSS 里只有 `:has()`
             * 能从父级看子级，而 `:has()` 要求 Chrome 105+（飞书宿主是 Electron/CEF，
             * 版本不可控）。挂一个类名让判据留在 TS 里，任何宿主都成立。
             * ⚠️ 语义：`li.done` ⇒ **它左边那一段**变绿（正好等于"走到过这里"），与设计稿一致。
             */
            <li key={label} className={state}>
              <button
                type="button"
                className={`wiz-step ${state}`}
                onClick={() => reachable(i) && w.setStep(i as 0 | 1 | 2 | 3)}
                disabled={!reachable(i)}
                aria-current={state === 'active' ? 'step' : undefined}
              >
                <span className="wiz-step-dot">{state === 'done' ? '✓' : i + 1}</span>
                <span className="wiz-step-label">{label}</span>
              </button>
            </li>
          )
        })}
      </ol>
      <div className="wiz-rail" aria-hidden="true">
        <span className="wiz-rail-fill" style={{ width: `${((w.step + 1) / STEPS.length) * 100}%` }} />
      </div>
    </nav>
  )
}

// ============================================================
// 底部操作栏（主按钮唯一，位置固定）
// ============================================================

/**
 * 底部操作栏。主按钮唯一、位置固定；`hint` 是**一行跨满整栏**的反馈。
 *
 * `hint` 的来历（2026-09-19）：用户对"独立窗口打不开"给的正解是
 * "**建议直接留在（模板列表）这个界面，底部给点提示就行**"。
 * 那段提示原本落进了只在第①步渲染的 `pickerHint` ⇒ 在模板列表那里**根本看不见**，
 * 用户点完「创建并编辑」看到的是"界面没变、一句提示都没有"。
 * 现在它有一条固定的出口：这一栏。
 */
function Foot({
  back,
  main,
  note,
  hint,
}: {
  back?: { label: string; onClick: () => void }
  main?: { label: string; onClick: () => void; disabled?: boolean; pending?: boolean }
  note?: string
  hint?: { ok: boolean; text: string } | null
}) {
  return (
    <div className="wiz-foot">
      {hint && (
        <p className={`wiz-foot-hint ${hint.ok ? 'ok' : 'warn'}`} role="status">
          {hint.text}
        </p>
      )}
      {back && (
        <button type="button" className="app-btn" onClick={back.onClick} disabled={main?.pending === true}>
          {back.label}
        </button>
      )}
      {!main && note && <span className="wiz-foot-note">{note}</span>}
      {main && (
        <button type="button" className="app-btn primary" onClick={main.onClick} disabled={main.disabled === true}>
          {main.label}
        </button>
      )}
    </div>
  )
}

function WizardFooter({ w, panelOpen }: { w: W; panelOpen: boolean }) {
  const busy = w.render.phase === 'images' || w.render.phase === 'layout'
  const working = w.output.phase === 'working' || busy

  // 子面板（选骨架 / Word 导入）自带操作按钮，底部栏让位，避免两套"下一步"打架
  if (panelOpen) return null

  if (w.step === 0) {
    return (
      <Foot
        main={{
          label: '下一步：选模板',
          onClick: () => w.setStep(1),
          disabled: w.scopedRecords.length === 0,
        }}
      />
    )
  }

  if (w.step === 1) {
    return (
      <Foot
        /* 「新建 / 编辑模板」这条线上的结论（建成了没有、窗口开没开）只在这里出声 */
        hint={w.tplHint}
        back={{ label: '上一步', onClick: () => w.setStep(0) }}
        main={{ label: '下一步：预览', onClick: () => void w.gotoPreview(), disabled: !w.doc }}
      />
    )
  }

  if (w.step === 2) {
    return (
      <Foot
        back={{ label: '上一步', onClick: () => w.setStep(1) }}
        main={{
          label: busy ? '排版中…' : '下一步：输出',
          onClick: () => w.setStep(3),
          disabled: w.render.phase !== 'ready',
          pending: busy,
        }}
      />
    )
  }

  // 最后一步的主按钮在内容区里（三种输出方式需要各自说明），底部只留返回 + 状态提示
  return (
    <Foot
      back={{ label: '上一步', onClick: () => w.setStep(2) }}
      note={working ? '正在准备…' : `共 ${w.render.doc?.pages.length ?? 0} 页 · 打印前会重新获取附件图片`}
    />
  )
}

// ============================================================
// 步骤 ① 选范围
// ============================================================

const RANGE_OPTIONS: Array<[RangeMode, string]> = [
  ['all', '全部'],
  ['view', '视图筛选'],
  ['manual', '手动勾选'],
]

function StepRange({ w, fields }: { w: W; fields: FieldMeta[] }) {
  const count = w.scopedRecords.length
  /** 手动勾选下已带入的条数（= 将来实际打印的条数，见 `manualIds` 的"勾选顺序即打印顺序"） */
  const selected = w.manualIds.ids.length
  const perRecord = w.kind === 'record'
  /**
   * ⛔ 这一页原来有一条**阻断级**的批量警告（`wiz-alert danger` + 两个动作按钮：
   * 「改为手动勾选」/「改成视图模板（一份多页）」），以及支撑它的 `bulk` / `narrowed` 两个判据。
   * **2026-09-21 整体删除**（用户要求），理由值得记住：
   *
   *   用户原话："先删除这个提示，**不再限制用户打印数据量**，只在**模板选择页面轻提醒**。"
   *
   * 删掉的真正原因不只是"太吵"，而是**它在错误的时刻说话**：
   *   用户选完范围点「下一步」时**什么都不说**；等他点「上一步」或者点顶部导航回到这一步，
   *   才突然冒出"345 条 = 345 份文档"和一个红色警告 —— 那是**他刚做完的事**，
   *   而且他并没有要求重新考虑范围。用户的原话是"反而是用户如果选择了上一步或者点击顶部的
   *   导航返回到数据选择，就会提示这个"。
   * ⇒ 数据量这件事现在只在**真正做选择的那一页**（选模板）说，而且只说事实 + 一句建议，
   *   不带任何"你不该这么选"的语气、也没有按钮。
   *
   * ⚠️ 别再往这一页加回"份数太多"的警告：`预计产出` 那张事实卡（下面 `wiz-facts`）
   *    已经如实写了 "N 份文档 / 一份多页文档"，事实给够了。
   */

  return (
    <div className="wiz-block">

      <section className="wiz-group">
        <div className="wiz-group-head">
          <h3 className="wiz-group-title">打印范围</h3>
          <span className="wiz-group-note">
            {w.loadingRecords ? `已加载 ${w.records.length} 条，正在更新…` : `${count} 条`}
          </span>
        </div>
        <div className="seg" role="group" aria-label="打印范围">
          {RANGE_OPTIONS.map(([mode, label]) => (
            <button
              key={mode}
              type="button"
              className={`seg-item ${w.rangeMode === mode ? 'active' : ''}`}
              onClick={() => w.setRangeMode(mode)}
              aria-pressed={w.rangeMode === mode}
            >
              {label}
            </button>
          ))}
        </div>

        {/*
          ---- 统计条（2026-09-21 第二次降噪）----
          用户原话："有打印范围控制区域、**记录数量和文档数量展示区域**、筛选条件区域、
          记录展示区域，**太多东西导致记录展示空间被严重挤占**。"

          原来这里是两张 18px 数字的"事实卡"（各 38px 高 + 间距），外加一行"范围内 N 条记录"的说明，
          三样东西说的是同一件事。现在压成**一条 34px 的横条**：两格、中间一条分隔线。
          · 手动勾选下第一格是「已勾选 x/50」（用户给的设计稿就是这么排的）——
            它取代了原来标题行那个 `x/50` 徽标和勾选区里重复的一行说明；
          · 其余两种范围下第一格是「范围内记录」；
          · 第二格：手动勾选给「范围内记录」（设计稿口径），
            其他范围给「预计产出」—— 那是**唯一**会提示"这条范围要打多少张纸"的地方，
            选模板页那条轻提醒要靠它，所以不能省。
          ⚠️ 类名用 `.wiz-stat*` 而**不是** `.wiz-fact*`：`.wiz-fact` 是第④步那四张卡在用的，
            两者版式完全不同（卡 vs 横条格子），共用一个类名会互相污染。
        */}
        <div className="wiz-stat">
          <div className="wiz-stat-cell">
            <span className="wiz-stat-k">{w.rangeMode === 'manual' ? '已勾选' : '范围内记录'}</span>
            <span className="wiz-stat-v">
              {w.rangeMode === 'manual' ? (
                <>
                  <b>{selected}</b>
                  <span className="wiz-stat-sub">/{w.maxManual}</span>
                </>
              ) : (
                count
              )}
            </span>
          </div>
          <div className="wiz-stat-cell">
            {w.rangeMode === 'manual' ? (
              <>
                {/*
                  ⚠️ 手动勾选下这一格是「**能挑的池子有多大**」，不是"将会打印几条" ——
                    后者是第一格那个「已勾选 x/50」。
                  用户给的设计稿画的就是这一对：`已勾选 0/50` + `范围内记录 345 条`
                  （他的表里有 345 条、一条都没勾 ⇒ 两个数字必须含义不同，否则就是同一个数写两遍）。
                  `w.records` = 本页读到的记录（视图筛选模式下就是视图的命中集），
                  也就是用户能在左表里勾选的范围。
                */}
                <span className="wiz-stat-k">范围内记录</span>
                <span className="wiz-stat-v">
                  {w.records.length}
                  <span className="wiz-stat-sub"> 条</span>
                </span>
              </>
            ) : (
              <>
                <span className="wiz-stat-k">预计产出</span>
                {/*
                  ⚠️ **没有模板时不下断言**（2026-09-19 补）。

                  "一份文档装几条记录"这件事由**模板**决定，而步骤①在选模板**之前** ——
                  所以这里能说真话的前提是"已经有一个当前模板"。`kind` 平时之所以可信，
                  是因为加载完模板后会**自动选中第一条**（见 useWizardState 的加载逻辑）⇒ `active` 非空。
                  只有"这张表一个模板都没有"时 `active` 才是 null，而那时 `kind` 只是初始默认值 `view`，
                  再显示"一份多页文档"就是**对着不存在的模板下断言**。
                */}
                <span className="wiz-stat-v is-text" title={w.active ? `按当前模板「${w.active.name}」` : undefined}>
                  {!w.active ? '取决于所选模板' : perRecord ? `${count} 份文档` : '一份多页文档'}
                </span>
              </>
            )}
          </div>
        </div>

        {w.loadingRecords && (
          <p className="wiz-hint">正在加载记录… 当前已读到 {w.records.length} 条</p>
        )}
      </section>

      {w.recordError && <p className="wiz-note warn">{w.recordError}</p>}

      {/*
        ⛔ 「筛选条件」整块**已移除**（2026-09-21 用户要求）。
        用户原话："**直接移除筛选条件这个功能吧**，因为用户完全可以在新视图里，
        手动筛选需要打印的内容。"

        ⇒ 这里原来渲染的是 `FilterEditor`（条件编辑器：字段 / 操作符 / 取值 + 与或切换），
          连同它依赖的 `applyFilter` 引擎（`src/lib/filter.ts`）一起删掉了
          —— 记录范围现在只有三个来源：全部 / 视图筛选（**视图自己的筛选**）/ 手动勾选。
        ⚠️ 「视图筛选」这个档位**没有受影响**：它读的是用户在视图里配的筛选结果
          （见 `fetchRecords` 传 viewId），跟插件里那套条件从来不是一回事。
      */}

      {w.rangeMode === 'manual' && <ManualPicker w={w} fields={fields} />}

      {/* 视图筛选：列出**全部命中**的记录（用户要求："筛选成功后，应当展示所有符合条件的记录"） */}
      {w.rangeMode === 'view' && <FilteredList w={w} fields={fields} />}
    </div>
  )
}

function ManualPicker({ w, fields }: { w: W; fields: FieldMeta[] }) {
  /**
   * 排序（2026-09-19 用户要求："所有被勾选的记录，都应该可以重新排序，
   * 比如按日期、数字、字母排序，**打印的时候按照排序好的顺序打印**"）。
   *
   * `sortKey` 是字段 id，空串表示"按带入顺序"。排序选项只给**行标签字段**
   * （`labelFields`）—— 与列表里显示的两列同源，避免"看到的和排的不是一套"。
   */
  const [sortKey, setSortKey] = useState('')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc')

  /** 行标签字段由 useWizardState 统一挑（当前视图前两个字段，搜索/排序共用同一份） */
  const labelFields = w.labelFields
  /** 列表**显示**用的槽位：取前 3 个（与筛选结果同一套，见 DETAIL_SLOT_COUNT 的注释） */
  const slots = fields.slice(0, DETAIL_SLOT_COUNT)

  /**
   * **只算"已带入的记录"**（2026-09-19 用户要求重构勾选列表）。
   *
   * 用户原话："插件内**不再显示所有的记录**，不再从插件内勾选要打印的记录，
   * **只显示已经被勾选的要打印的记录**。"
   *
   * ⇒ 原来那套「列出前 300 条 / 未勾选段 / 按行数勾选 / 全选前 N / 搜索框」整块删掉：
   * 它们全都是"在插件里勾选"的手段，而勾选本身应该在飞书表格里做
   * （读左表勾选 / 读光标行）。留着只会让用户以为"插件里勾的才算数"。
   *
   * 必须用 `manualIds.ids` 的顺序（= 打印顺序）去取，**不能**按 `records` 的顺序 ——
   * 否则用户排的序在列表里看不出来。
   */
  const chosen = useMemo(() => {
    const byId = new Map(w.records.map((r) => [r.recordId, r]))
    // flatMap 而不是 filter：TS 能把 undefined 直接滤掉，不用写类型谓词
    return w.manualIds.ids.flatMap((id) => {
      const r = byId.get(id)
      return r ? [r] : []
    })
  }, [w.manualIds, w.records])

  const selected = w.manualIds.ids.length

  /**
   * 排序变化 ⇒ **真的重排已选顺序**，而不是只改本地显示顺序。
   *
   * 用户要求："打印的时候按照排序好的顺序打印。" 而打印顺序取自 `manualIds.ids`
   * （`selectFirstN` 的注释写明"勾选顺序即打印顺序"）⇒ 必须回写。
   * 只在本地排一遍显示，会出现"列表看着是排好的、打出来还是老顺序"——
   * 那正是本项目最忌讳的"两件不一样的事长成一个样子"。
   *
   * 末尾那句 `if (sorted.some(...))` 是**防循环**的关键：已经排好的顺序不会再触发回写，
   * 所以 `manualIds` 变化 → effect 再跑一次 → 发现无需改动 → 停。
   */
  useEffect(() => {
    if (!sortKey) return
    const ids = w.manualIds.ids
    if (ids.length < 2) return
    const field = labelFields.find((f) => f.id === sortKey)
    if (!field) return
    const byId = new Map(w.records.map((r) => [r.recordId, r]))
    const sorted = [...ids].sort((a, b) => {
      const ra = byId.get(a)
      const rb = byId.get(b)
      if (!ra || !rb) return 0
      const ta = displayCellText(ra.fields[field.id], field.type)
      const tb = displayCellText(rb.fields[field.id], field.type)
      // 两边都能当数字 ⇒ 按**数值**比（否则 "10" 会排在 "9" 前面）；
      // 否则按本地化字符串比，并开 numeric 让混排更符合直觉
      const na = Number(ta)
      const nb = Number(tb)
      const bothNum =
        ta.trim() !== '' && tb.trim() !== '' && Number.isFinite(na) && Number.isFinite(nb)
      const cmp = bothNum ? na - nb : ta.localeCompare(tb, 'zh-Hans-CN', { numeric: true })
      return sortDir === 'asc' ? cmp : -cmp
    })
    if (sorted.some((id, i) => id !== ids[i])) w.reorderManual(sorted)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只认这几个输入；带上 w 会每渲染必跑
  }, [sortKey, sortDir, w.manualIds, w.records, labelFields])

  return (
    <section className="app-section wiz-picker">
      {/*
        ---- 面板头（2026-09-21 第二次降噪，按用户给的设计稿）----
        设计稿的标题行只有「要打印的记录」+ 右侧一个「清空」；
        原来挂在标题上的 0/50 徽标**移到了上面的统计条**里（"已勾选 0/50"）——
        同一个数字在一屏里出现两遍，正是用户说的"太多东西"。
      */}
      <div className="app-section-head">
        <h3 className="app-section-title">要打印的记录</h3>
        <button className="app-btn sm" onClick={() => w.clearManual()} disabled={selected === 0}>
          清空
        </button>
      </div>

      <div className="app-section-body">
        {/* 两个读取入口**并排等宽**（设计稿：各占一半，主按钮在左） */}
        <div className="wiz-read-row">
          <button
            className="app-btn primary"
            onClick={() => void w.readSelectedRecords()}
            title="读取你在多维表格里勾选的那些行（读不到会自动退回读取光标所在的那一行）"
          >
            读取左表勾选（多条）
          </button>
          <button
            className="app-btn"
            onClick={() => w.readActiveRecord()}
            title="只读取你光标停留的那一条记录"
          >
            读取光标所在行
          </button>
        </div>

        {w.activeHint && <p className={`wiz-note ${w.activeHint.ok ? 'ok' : 'warn'}`}>{w.activeHint.text}</p>}
        {w.pickerHint && <p className={`wiz-note ${w.pickerHint.ok ? 'ok' : 'warn'}`}>{w.pickerHint.text}</p>}
        {w.orderNote && <p className="wiz-note">{w.orderNote}</p>}
        {/* 字段顺序读不到 ⇒ 行标签可能取错字段。**必须**在这里说，用户才知道该信哪一部分 */}
        {w.fieldOrderNote && <p className="wiz-note warn">{w.fieldOrderNote}</p>}
        {/* 连视图 id 都没有 ⇒ 份数/标签/顺序三样一起错，比上面两条都严重 */}
        {w.viewlessNote && <p className="wiz-note warn">{w.viewlessNote}</p>}

        {selected === 0 ? (
          /*
            空状态（设计稿）：一个浅色盒子 = 图标 + 标题 + 一句"怎么做"。
            ⚠️ 原来这里是**两处**说同一件事：盒子外面一行 hint（"勾选在多维表格里做…"）
               + 盒子里面一行（"还没有带入任何记录"）。现在只留盒子里那一句 ——
               有记录了以后那句话也不再需要（用户已经勾过了）。
          */
          <div className="wiz-empty-box">
            <span className="wiz-empty-icon" aria-hidden="true">
              {/* 内联 SVG：项目统一不用图标字体，stroke=currentColor ⇒ 暗色零成本 */}
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <rect x="4" y="3.5" width="16" height="17" rx="2.5" />
                <path d="M8 8.5h8M8 12h8M8 15.5h5" />
              </svg>
            </span>
            <p className="wiz-empty-title">还没有带入记录</p>
            <p className="wiz-empty-hint">在左侧表格勾选整行后，点击上方「读取左表勾选」即可加入。</p>
          </div>
        ) : (
          <>
            {/* 排序（用户要求："所有被勾选的记录都应该可以重新排序…打印的时候按照排序好的顺序打印"） */}
            <div className="wiz-tool-row">
              <label className="wiz-tool-field" htmlFor="wiz-sort">
                排序
              </label>
              <select
                id="wiz-sort"
                className="wiz-input"
                value={sortKey}
                onChange={(e) => setSortKey(e.target.value)}
                aria-label="按哪个字段排序"
              >
                <option value="">按带入顺序</option>
                {labelFields.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name}
                  </option>
                ))}
              </select>
              <button
                className="app-btn sm"
                onClick={() => setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))}
                disabled={!sortKey}
                title="切换升序 / 降序"
              >
                {sortDir === 'asc' ? '升序' : '降序'}
              </button>
            </div>

            <div className="wiz-pick">
              {chosen.map((r, i) => (
                <div key={r.recordId} className="wiz-pick-row on">
                  <span className="wiz-pick-no">{i + 1}</span>
                  {/* 显示槽位 3 个（见 DETAIL_SLOT_COUNT 的注释：第一个固定是索引列） */}
                  {/* 单元格结构与筛选结果**完全一致**（卡片 = 字段名 + 取值），见那边那段注释 */}
                  <span className="wiz-pick-text">
                    {slots.length === 0 ? (
                      <span className="wiz-pick-empty">（这张表还没有可用字段）</span>
                    ) : (
                      slots.map((f) => (
                        <span key={f.id} className="wiz-pick-cell">
                          <span className="wiz-pick-k" title={f.name}>
                            {f.name}
                          </span>
                          <span className="wiz-pick-v">{displayCellText(r.fields[f.id], f.type)}</span>
                        </span>
                      ))
                    )}
                  </span>
                </div>
              ))}
            </div>

            <p className="wiz-hint">
              <b>打印顺序就是上面列表的顺序</b>（共 {selected} 条，单次最多 {w.maxManual} 条）。
            </p>
          </>
        )}

        <p className="wiz-note">{capabilityNote(w.selectCapability)}</p>
      </div>
    </section>
  )
}

// ============================================================
// 筛选条件编辑器
// ============================================================

/**
 * 列表里一行显示几个字段（**2026-09-21 第二次收紧**）。
 *
 * 演进（两次方向相反，都记着，免得来回改）：
 *   · 2026-09-19："筛选结果和已勾选的结果，**能不能多显示几个字段**……第一个字段固定显示
 *     多维表格内的索引列" ⇒ 从两槽放宽到 **6 个**（两行 × 三列）；
 *   · 2026-09-21："**把筛选结果改为只显示前三个字段，一行显示，不然卡片太大了**"
 *     ⇒ 收回到 **3 个**。
 *     用户的原话理由很实在：一屏里已经有"打印范围 + 统计条 + 记录列表"三块，
 *     两行字段的卡片（91px）把记录展示区挤得只剩三四条可见。
 *
 * ⇒ 现在一条记录 = **一行三个字段**（第 1 个仍是视图第 1 列，即表上最左边那列）。
 *   字段更多时靠 CSS 省略号收尾 —— 想看全字段，表格里本来就有。
 */
const DETAIL_SLOT_COUNT = 3

/**
 * 视图筛选模式下**列出全部命中的记录**（2026-09-19 用户要求）。
 *
 * ⚠️ 用的是 **`w.scopedRecords`（范围内的记录）**，不是 `w.records`（本页全部记录）。
 * 我第一版写成了 `w.records` ⇒ 真机表现就是用户报的：
 * "明明提示『范围内 2 条记录，但**筛选结果那里却显示所有记录**"。
 *
 * 刻意做成**只读**（没有复选框、没有排序）：
 * 这里的记录不是"挑出来的"，而是**用户在多维表格的视图里筛出来的** ——
 * 打印范围由视图自己的筛选决定。插件侧那套条件编辑器 2026-09-21 已整体移除。
 */
function FilteredList({ w, fields }: { w: W; fields: FieldMeta[] }) {
  const slots = fields.slice(0, DETAIL_SLOT_COUNT)
  const rows = w.scopedRecords.slice(0, 300)
  return (
    <section className="app-section">
      <div className="app-section-head">
        <h3 className="app-section-title">
          筛选结果
          <span className="wiz-count">{w.scopedRecords.length}</span>
        </h3>
      </div>
      <div className="app-section-body">
        {/*
          这个列表同样"带行标签、按顺序"，所以顺序类的如实告知在这里也要出现 ——
          只挂在勾选列表那边的话，视图筛选下的用户看不到。
        */}
        {w.orderNote && <p className="wiz-note">{w.orderNote}</p>}
        {w.fieldOrderNote && <p className="wiz-note warn">{w.fieldOrderNote}</p>}
        {w.viewlessNote && <p className="wiz-note warn">{w.viewlessNote}</p>}
        {rows.length === 0 ? (
          <p className="wiz-hint">这个视图没有命中任何记录 —— 在表格里改一下视图的筛选条件。</p>
        ) : (
          /*
            ---- 记录卡片（2026-09-21 UI 重设计）----
            用户要求："筛选结果改成**记录卡片**：一条记录一张卡（白底 + 1px 灰边 + 圆角 10），
            卡内 3 列网格、一行三个字段；动态：取表格前 6 个字段 → 2 行 3 列，
            少于 3 个字段就只有一行，少于 6 个时最后一行自然短。"

            ⚠️ 类名仍是 `.wiz-pick*`（**不新起一套**）：
              · `.wiz-pick-text` 的三列网格是 e2e ⑤d 的判据（`colCount === 3`），改名等于把那条守卫删掉；
              · 同一份样式还被手动勾选列表复用 —— 两处的行长得一样才叫"两处都在说同一件事"。
            每格 = 字段名（10px 灰）+ 取值（12px 正文），这是"用户分不清哪个值属于哪个字段"
              那个反馈的直接解法（原来只铺一列裸值）。
          */
          <div className="wiz-pick">
            {rows.map((r, i) => (
              <div key={r.recordId} className="wiz-pick-row">
                <span className="wiz-pick-no">{i + 1}</span>
                <span className="wiz-pick-text">
                  {slots.length === 0 ? (
                    <span className="wiz-pick-empty">（这张表还没有可用字段）</span>
                  ) : (
                    slots.map((f) => (
                      <span key={f.id} className="wiz-pick-cell">
                        <span className="wiz-pick-k" title={f.name}>
                          {f.name}
                        </span>
                        <span className="wiz-pick-v">{displayCellText(r.fields[f.id], f.type)}</span>
                      </span>
                    ))
                  )}
                </span>
              </div>
            ))}
          </div>
        )}
        {w.scopedRecords.length > 300 ? (
          <p className="wiz-hint">
            只列出前 300 条（共 {w.scopedRecords.length} 条）；要更多请在视图里缩小范围。
          </p>
        ) : null}
      </div>
    </section>
  )
}

// ============================================================
// 步骤 ② 选模板
// ============================================================

function StepTemplate({
  w,
  fields,
  mode,
  onModeChange,
}: {
  w: W
  fields: FieldMeta[]
  mode: TplMode
  onModeChange(mode: TplMode): void
}) {
  const packInput = useRef<HTMLInputElement | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  /**
   * 「导入 / 导出」下拉（2026-09-21 UI 重设计）。
   *
   * 设计稿把原来**压在页面底部**的四个入口（新建模板 / 从 Word 导入 / 导入模板文件 / 导出全部模板）
   * 拆成两处：**新建**升格为卡片网格里那张虚线卡（它是最常用的动作），
   * 其余三个收进标题右侧的次级按钮 —— 选模板页的主线因此只剩"挑一张卡"这一件事。
   *
   * ⚠️ 开合必须**有出口**：本项目已经栽过两次"点空白不收起"（模板卡的「…」、
   *    App 的开发者菜单），所以这里照抄已经验证过的那套写法 ——
   *    `pointerdown` 的**捕获阶段**判"点在不在菜单容器里"，不在就收起；
   *    另外接 Esc。排除容器（含触发按钮）是必须的：不排除会变成"pointerdown 关、click 又开"。
   */
  const ioRef = useRef<HTMLDivElement | null>(null)
  const [ioOpen, setIoOpen] = useState(false)
  useEffect(() => {
    if (!ioOpen) return
    const onDown = (e: PointerEvent): void => {
      const node = e.target as Node | null
      if (!node) return
      if (ioRef.current?.contains(node)) return
      setIoOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setIoOpen(false)
    }
    document.addEventListener('pointerdown', onDown, true)
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('pointerdown', onDown, true)
      document.removeEventListener('keydown', onKey, true)
    }
  }, [ioOpen])

  /** 导出全部模板（原来在底部按钮行里，现在挂在标题的下拉菜单上） */
  const exportAll = (): void => {
    const { json, count } = w.exportPackage()
    if (count === 0) {
      setNotice('当前没有可导出的模板')
      return
    }
    downloadText(json, 'bitableprint-templates.bptpl.json')
    setNotice(`已导出 ${count} 个模板`)
  }

  const onImportPack = async (file: File): Promise<void> => {
    try {
      const json = await file.text()
      const res = await w.importPackage(json)
      const okCount = res.templates.length
      const errCount = res.errors.length
      setNotice(
        `已导入 ${okCount} 个模板` +
          (errCount > 0 ? `，${errCount} 个失败：${res.errors.map((e) => e.message).join('；')}` : ''),
      )
      // 导入可能带来字段绑定失效，提示用户去编辑器确认（F6-10）
      const rebound = res.templates.some((t) => t.bindings && t.bindings.unbound > 0)
      if (rebound) setNotice((s) => `${s ?? ''}，部分占位符未绑定到当前表字段，请在编辑器中确认`)
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e))
    }
  }

  if (mode === 'word') {
    return (
      <WordImportPanel
        fields={fields}
        kind={w.kind}
        onCancel={() => onModeChange('list')}
        onDone={async (template, name) => {
          await w.createAndEdit(name, w.kind, template)
          onModeChange('list')
        }}
      />
    )
  }

  if (mode === 'skeleton') {
    return (
      /*
       * ⚠️ **类型由所选骨架决定**（2026-09-19 再次修正）。
       *
       * 演进过程值得记一笔，同一件事绕了两圈：
       *   ① 最初：第①步问一次类型，这个面板**又问一次**（还带个过滤）⇒ 用户抱怨"怎么问两遍"；
       *   ② 我按那句话把面板里的切换删了，只留第①步；
       *   ③ 随后用户又要求把第①步的「打印什么」整块删掉（"类型由所选模板决定"）——
       *      于是**两处都没了**，`kind` 永远停在默认的 `view`，
       *      **记录模板从此建不出来**（入库单/验收单正是最主流的用法）。
       *
       * ⇒ 现在的答案：**选骨架即定类型**。`SkeletonDef` 自带 `kind`，
       *   `onCreate` 把它的 `kind` 交上来，类型就在这一次决定，全流程唯一一次。
       *   既不重复问，也不会没得选。见 `SkeletonPicker.tsx` 文件头。
       */
      <SkeletonPicker
        fields={fields}
        onCancel={() => onModeChange('list')}
        onCreate={async (name, doc, k) => {
          // 类型**交给 createAndEdit 在"真的建成"之后自己跟随**（见那里的注释）：
          // 在这里先设会让"窗口被拦、一条都没建成"的情况下 kind 也变掉，
          // 于是第①步会冒出"记录模板下 60 条 = 60 份文档"这种**对着不存在的模板**的警告。
          await w.createAndEdit(name, k, doc)
          onModeChange('list')
        }}
      />
    )
  }

  /**
   * ⛔ 这里原来还有一段 `mode === 'paste'`（渲染 `PasteResultPanel`）—— **已整体移除**（2026-09-21）。
   * 它是"独立窗口 → 手动复制结果 → 回来粘贴"那条兜底链路的消费端；
   * 编辑器挪进插件内（`EditorOverlay`）之后保存直接走 SDK 落库，这条兜底不再需要。
   *
   * **只列出与上一步所选「模板种类」一致的模板**（2026-09-19 用户提问后改）。
   *
   * 用户问："在选范围的时候，会确定要记录模板还是视图模板，下一步选模板的时候，
   * 又出现一次选择记录模板还是视图模板。"
   *
   * 查证结论：`kind` 是**同一个状态**。第一步用它决定"一份文档装几条记录"；
   * 而第二步有**两处**还能再改它 —— 骨架面板里的种类切换、以及模板卡片自带的类型。
   * ⇒ 同一个问题问两遍，而且第二遍会**静默覆盖**第一遍。
   *
   * 修法：第二步不再重复问 —— 按上一步的种类**过滤**，
   * 被滤掉的用一句话说清"去哪改"，而不是让用户以为模板丢了。
   */
  /**
   * ⚠️ **不再按上一步的种类过滤**（2026-09-19 用户要求重构向导）。
   *
   * 用户原话："移除『打印什么』的选项，勾选完数据后，用户再选择打印模板，
   * **可以选择所有类型的模板**，当前这个方式有问题。"
   *
   * ⇒ 第一步不再问类型；类型由**所选的模板**决定（`w.selectTemplate` 会一起写 `kind`）。
   * ⇒ 于是这里必须把**所有模板**都列出来，否则用户会遇到"我的模板去哪了"。
   * （`sameKind`/`hiddenKind` 那套过滤逻辑随之作废，已删。）
   */
  const hasTpl = w.templates.length > 0

  /**
   * 选模板页的轻提醒（两句话，见下面 JSX 里的长注释）。
   *
   * ⚠️ 判据看的是**当前选中的那份模板**（`w.active.kind`），而不是 `w.kind`。
   * 两者现在其实同源（`loadTemplates` 会在选中之后同步 `kind`，见那里的注释），
   * 但这里刻意取 `w.active` —— 这条提示说的是"**这份模板**会打出什么"，
   * 而 `kind` 是个全局状态，读它等于把"模板的属性"和"向导的模式"混为一谈，
   * 将来一旦两者不同步（就有过），提示会指着一份模板说另一份的话。
   */
  const selKind = w.active?.kind
  const tplKindHint: { tone: string; text: string } | null = (() => {
    if (!selKind) return null
    const n = w.scopedRecords.length
    if (selKind === 'record' && n >= RECORD_BULK_WARN) {
      return {
        tone: 'warn',
        text: `已选 ${n} 条记录，用记录模板会打出约 ${n} 页纸。想省纸可以改用视图模板（一份多页）—— 在下面换一张即可。`,
      }
    }
    if (selKind === 'view' && n === 1) {
      return {
        tone: '',
        text: '范围内只有 1 条记录，视图模板「一份多页」省纸的优势用不上；只打这一条的话，记录模板更合适。',
      }
    }
    return null
  })()

  return (
    <div className="wiz-block">
      <section className="app-section">
        {/*
          标题行（2026-09-21 UI 重设计）。
          设计稿：`当前xxx的模板` + 右侧灰胶囊（模板数）+ 一个次级按钮「导入 / 导出」。
          三件事各有明确职责：标题说"这是哪张表的模板"（原来只写"当前数据表"，
          而插件会跟着用户切表 —— 不说表名的话，用户看到列表变了也不知道自己在哪张表上）、
          胶囊给数量、下拉装"搬家"这类低频操作。
        */}
        <div className="app-section-head">
          <h3 className="app-section-title">当前{w.tableName ? `${w.tableName}的` : '数据表的'}模板</h3>
          <div className="wiz-tpl-head">
            <span className="wiz-pill" title="本表的模板数量">
              {w.templates.length}
            </span>
            <div className="wiz-io" ref={ioRef}>
              <button
                type="button"
                className="app-btn sm"
                onClick={() => setIoOpen((v) => !v)}
                aria-expanded={ioOpen}
                aria-haspopup="menu"
              >
                导入 / 导出
                <span className={`wiz-io-chev${ioOpen ? ' on' : ''}`} aria-hidden="true">
                  ▾
                </span>
              </button>
              {/* ⚠️ 用 `hidden` 而不是条件渲染：与 App 的开发者菜单同一口径（DOM 始终在，测试点得到） */}
              <div className="wiz-io-menu" role="menu" hidden={!ioOpen}>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setIoOpen(false)
                    packInput.current?.click()
                  }}
                >
                  导入模板文件
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setIoOpen(false)
                    exportAll()
                  }}
                >
                  导出全部模板
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setIoOpen(false)
                    onModeChange('word')
                  }}
                >
                  从 Word 导入
                </button>
              </div>
            </div>
          </div>
        </div>
        <div className="app-section-body">
          {w.loadingTemplates && <p className="wiz-hint">正在读取模板…</p>}
          {w.templateError && <p className="wiz-note danger">{w.templateError}</p>}

          {/*
            「选模板」这一页的**轻提醒** —— 数据量这件事现在只说在这里（2026-09-21 用户口径）。

            用户原话："**不再限制用户打印数据量**，只在**模板选择页面轻提醒**，
            告知用户可能会产生 xx 页打印纸，建议使用视图类模板；比如用户只勾选了一条数据，
            却选择了视图模板，也轻提示只有一条数据、是否选择记录模板之类的。"

            ⚠️ 为什么放在**列表上方**而不是列表下面：模板一多，列表会很长，
              写在下面等于"要滚到底才看得见"，而这条提示的价值恰恰是**在用户挑之前**拦一下。
            ⚠️ 为什么**没有按钮**：它就是一句话。要换模板，下面那排卡片就是入口 ——
              再摆一个"改用视图模板"的按钮反而会喧宾夺主，而且那个按钮点了之后
              **未必存在合适的视图模板**（得用户自己挑）。这是与已删的那张红色阻断卡的
              关键区别：那张卡是"命令"，这条只是"告知"。
          */}
          {tplKindHint ? <p className={`wiz-note ${tplKindHint.tone}`}>{tplKindHint.text}</p> : null}

          {!w.loadingTemplates && !hasTpl && (
            <div className="wiz-empty">
              <span className="wiz-empty-art" aria-hidden="true">
                <i />
                <i />
                <i />
                <i />
              </span>
              <p className="wiz-empty-title">这张表还没有打印模板</p>
              <p className="wiz-hint">
                点下面那张「＋ 新建模板」选一个版式起点（入库单 / 验收单 / 领料单 / 巡检记录…），
                字段会自动尽量绑定，剩下的在编辑器里微调。
              </p>
              {w.kind === 'record' && (
                <p className="wiz-hint">
                  记录模板一条记录一份，适合单据、档案、工牌；只想打几条就回上一步改「手动勾选」。
                </p>
              )}
            </div>
          )}

          {/*
            ---- 模板卡片网格（2026-09-21 UI 重设计）----
            两列、行高下限 76px（见 wizard.css 的 `.wiz-tpl-list`），
            最后一格**恒为虚线「＋ 新建模板」**：新建是这一页最常用的动作，
            升格成"网格里的一格"之后，它永远出现在用户正在看的地方 ——
            原来那个压在页面底部的「新建 / 导入更多」按钮组因此整块删除
            （其余三个入口搬去标题的下拉菜单，见上面 `ioOpen` 那段注释）。

            ⚠️ `hasTpl` 为假时**也渲染网格**（只剩那张虚线卡）：空表不该只有一段说明文字，
              旁边那张「＋ 新建模板」就是它唯一的下一步动作。
          */}
          <div className="wiz-tpl-list">
            {!w.loadingTemplates &&
              w.templates.map((t) => <TemplateCard key={t.recordId} t={t} w={w} onNotice={setNotice} />)}
            <button type="button" className="wiz-tpl-add" onClick={() => onModeChange('skeleton')}>
              ＋ 新建模板
            </button>
          </div>

          <p className="wiz-tpl-note">
            模板按数据表隔离，存在本表的「打印模板」里；换一张表需要重建模板。
            「导入 / 导出」支持 .bptpl.json 跨表搬家，也可从 Word 解析标题与占位符。
          </p>
        </div>
      </section>

      {/*
        `packInput` 是「导入模板文件」真正的文件选择框。**必须留在 DOM 里**：
        它的触发按钮已经搬进标题的下拉菜单，只能靠 ref 点它（`packInput.current?.click()`）。
      */}
      <input
        ref={packInput}
        type="file"
        accept=".json,.bptpl.json,application/json"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0]
          if (f) void onImportPack(f)
          e.target.value = ''
        }}
      />

      {notice && <p className="wiz-note">{notice}</p>}
    </div>
  )
}

function TemplateCard({ t, w, onNotice }: { t: TemplateListItem; w: W; onNotice: (s: string) => void }) {
  const [menu, setMenu] = useState(false)
  const active = w.active?.recordId === t.recordId
  /** 「…」菜单本体与它的触发按钮 —— 判定"点到外面了没有"只需要这两个 */
  const menuRef = useRef<HTMLDivElement | null>(null)
  const menuBtnRef = useRef<HTMLButtonElement | null>(null)

  /**
   * ⚠️ **点任意空白处就收起菜单**（2026-09-19 用户反馈）。
   *
   * 用户原话："点击「…」展开菜单后，需要再次点击「…」才会收纳起菜单，
   * 改为点击任意空白区域都会自动收纳。值得一提的是，整个插件还有其他地方都有类似的 BUG，
   * 必须要重复点击才会收纳，都检查下。"
   *
   * 查证：这个菜单**只有菜单项自己 `setMenu(false)`**，没有任何外部点击监听 ⇒
   * 不点菜单项就只能再点一次「…」。**这是"开合只有入口、没有出口"的典型**。
   *
   * 做法与 `Popover` 一致：`pointerdown` 的**捕获阶段**（即使目标元素稍后
   * `stopPropagation`，这里也已经先判过了）；同时排除菜单本体与触发按钮 ——
   * 不排除按钮的话会"pointerdown 关、click 又开"，看起来像点了没反应。
   */
  useEffect(() => {
    if (!menu) return
    const onDown = (e: PointerEvent): void => {
      const node = e.target as Node | null
      if (!node) return
      if (menuRef.current?.contains(node) || menuBtnRef.current?.contains(node)) return
      setMenu(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setMenu(false)
    }
    document.addEventListener('pointerdown', onDown, true)
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('pointerdown', onDown, true)
      document.removeEventListener('keydown', onKey, true)
    }
  }, [menu])

  /**
   * 菜单**朝上开**的开关（2026-09-19）。
   *
   * 修完"卡片 `overflow: hidden` 把菜单裁掉"之后还剩一层遮挡：
   * 菜单默认朝下开，而插件面板很矮（尤其飞书侧边栏），
   * 卡片靠近底部时菜单会**溢出面板可视区**被裁掉 —— 实测 `是否在视口内: false`。
   * ⇒ 打开时量一次，下方放不下就翻到上方。
   */
  const [menuUp, setMenuUp] = useState(false)
  useEffect(() => {
    if (!menu) return
    const el = menuRef.current
    if (!el) return
    // 留 8px 余量：紧贴边缘也不好点
    setMenuUp(el.getBoundingClientRect().bottom > window.innerHeight - 8)
  }, [menu])

  return (
    /*
     * 整卡可点（2026-09-19 用户要求："当前只有点击卡片上半部分才会选中卡片，
     * 改为卡片整体都可以点击选中"）⇒ 选中动作提到**卡片根节点**，
     * 右侧操作区与「…」菜单各自 `stopPropagation`，点它们不会误选。
     */
    <div className={`wiz-tpl ${active ? 'on' : ''} is-${t.kind}`} onClick={() => w.selectTemplate(t.recordId)}>
      {/*
        选中徽标（UI 重设计）：16px 蓝圆 + 白对勾，钉在**卡内右上角**。
        ⚠️ 只有选中时**渲染**（`active &&`），而不是"渲染了但 CSS 隐藏"：
           它是纯装饰（`aria-hidden`），状态已经由卡片的 `aria-pressed` 承担 ——
           给读屏软件多播一个"✓"没有任何信息增量。
        ⚠️ 位置：`right: 8px`（见 wizard.css）。设计稿把对勾与「・・・」画在同一格，
           选中时会盖住菜单 ⇒ 菜单点不到。所以徽标贴右、菜单让到它左边（right:30）。
      */}
      {active && (
        <span className="wiz-tpl-check" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
            <path d="M5 13l4 4L19 7" />
          </svg>
        </span>
      )}
      {/*
        ⚠️ 这里必须是 `<div role="button">` 而**不能**再是 `<button>`：
        卡片根节点已经是可点区域，里面再套一个按钮就是**嵌套交互元素**，
        浏览器与读屏软件都会对它做出不可预期的处理（这个项目已经栽过一次：
        检查面板的删除键差点被挪出外层按钮）。
      */}
      <div
        className="wiz-tpl-main"
        role="button"
        tabIndex={0}
        aria-pressed={active}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            w.selectTemplate(t.recordId)
          }
        }}
      >
        {/*
          ⛔ 斜向角标（`.wiz-tpl-corner-clip` / `.wiz-tpl-corner`）**已删除**（2026-09-19）。
          —— 它与"一排两个"**物理上不共存**：
          斜标签是个固定 73×73 的旋转方块，在 380px 的整宽卡片上只占角落一丁点，
          缩到 167px 后它盖住右上角一大块，还**压掉模板名**（真机 + 探针实测：
          「产品验收记录表（含抽检结果与附件）」的"含抽检结果"被盖住）。
          而且 12.8px 的旋转字在 6px 内边距里根本读不清 —— 用户说的"角标看不清"就是它。
          ⇒ 类型现在由**右下角的半透明水印**（`.wiz-kind`，UI 重设计 2026-09-21）承担，
          不在文字流里、不跟名字抢宽度。类型仍然**有字**（"记录"/"视图"）且**有颜色**
          （`--tpl-record-mark` / `--tpl-view-mark`），不靠颜色单独表意。
        */}
        <span className="wiz-tpl-mark" aria-hidden="true" />
        <span className="wiz-tpl-body">
          {/*
            `title` 给全长名字：两列网格里每张卡只有约 150px 宽，
            再长的名字也放不下（`.wiz-tpl-name` 限两行）。悬停能看到全名，
            总比"截断了又没法看全"强。
          */}
          <span className="wiz-tpl-name" title={t.name}>
            {t.name}
          </span>
          <span className="wiz-tpl-meta">
            {/*
              ⚠️ 配置损坏时**用错误标替换纸张**，不是并排显示。
              损坏的模板拿不到真纸张，`paperLabel` 会回退成空白模板的 "A4 纵向" ——
              那是个**假信息**（用户会以为"这模板就是 A4"），而并排又会把这一行挤爆。
              这个项目最忌讳"两件不一样的事长成一个样子"，所以宁可不显示纸张。
            */}
            {t.docError ? (
              <span className="app-chip danger" title={t.docError}>
                配置异常
              </span>
            ) : (
              <span className="wiz-tpl-paper">{t.paperLabel}</span>
            )}
            {/*
              时间与纸张**同一行**（UI 重设计）：设计稿的 meta 行就是「纸张胶囊 + 时间」。
              ⚠️ 格式从 `YYYY-MM-DD HH:mm:ss` 收成 `MM-DD HH:mm`（设计稿写的是 09-21 18:10）。
                 这不是"省地方"，而是**去掉一个假精度**：模板表的「更新时间」列
                 2026-09-21 已经被用户改成"日期字段，只精确到分"
                 （见 sdk-source.ts 的 `property: { dateFormat: 'yyyy-MM-dd HH:mm' }`）⇒
                 秒数永远是 :00，显示出来只是看起来更精确。完整时间挂在 title 上。
              `updatedAt` 取不到就不显示（宁可没有，也不要显示一个假时间）。
            */}
            {t.updatedAt ? (
              <span className="wiz-tpl-time" title={`最后编辑：${formatDateTime(t.updatedAt, 'YYYY-MM-DD HH:mm')}`}>
                {formatDateTime(t.updatedAt, 'MM-DD HH:mm')}
              </span>
            ) : null}
          </span>
          {/*
            类型水印：卡内右下角（CSS 绝对定位，见 wizard.css 的 `.wiz-tpl .wiz-kind`）。
            放在 body 里只是为了跟文字同源 —— 定位基准是 `.wiz-tpl`。
          */}
          <span className={`wiz-kind ${t.kind}`}>{t.kind === 'record' ? '记录' : '视图'}</span>
        </span>
      </div>

      <div className="wiz-tpl-actions" onClick={(e) => e.stopPropagation()}>
        {/*
          「选中」按钮**已删除**、「在新窗口编辑」**改名为「编辑」并收进「…」**
          （2026-09-19 用户要求："卡片上的『选中』按钮可以删除，『在新窗口编辑』改为『编辑』…
          将『编辑』收到『…』中，卡片保持整洁"）。
          整卡可点之后，"选中"这个动作本来就有入口了，再放一个按钮是重复。
        */}
        <button
          ref={menuBtnRef}
          className="app-btn sm"
          onClick={() => setMenu((v) => !v)}
          aria-expanded={menu}
          aria-haspopup="menu"
          aria-label="更多操作"
        >
          ···
        </button>
      </div>

      {menu && (
        <div className={`wiz-tpl-menu${menuUp ? ' is-up' : ''}`} ref={menuRef} role="menu">
          {/* 「编辑」= 原来的「在新窗口编辑」（2026-09-19 用户要求改名并收进菜单） */}
          <button
            role="menuitem"
            onClick={() => {
              /**
               * ⚠️ 改成**插件内全屏编辑**（2026-09-20）。不再 `window.open`：
               * 飞书代理了它（窗口开了但返回 null）⇒ 三条回传通道全断。
               * `requestEditorFullscreen()` 必须在**这个点击处理里同步调**（需要用户激活）。
               */
              requestEditorFullscreen()
              w.openEditorFor(t.recordId)
              setMenu(false)
            }}
          >
            编辑
          </button>
          {/*
            ⛔ 菜单里的「在侧边栏编辑」**已移除**（2026-09-18 用户要求）。
            在侧边栏编辑画布会让两条编辑路径同时存在，且侧边栏那次"完成"会覆盖
            独立窗口的排版。现在模板卡片上的编辑入口统一走独立窗口。
          */}
          <button
            onClick={() => {
              const name = prompt('重命名为', t.name)
              if (name != null) void w.renameTemplate(t.recordId, name)
              setMenu(false)
            }}
          >
            重命名
          </button>
          <button
            onClick={() => {
              void w.duplicateTemplate(t.recordId)
              setMenu(false)
            }}
          >
            另存为副本
          </button>
          <button
            onClick={() => {
              const { json } = w.exportPackage([t.recordId])
              downloadText(json, `${t.name || 'template'}.bptpl.json`)
              setMenu(false)
            }}
          >
            导出此模板
          </button>
          <button
            onClick={async () => {
              const res = await w.copyToTable(t.recordId, t.targetTableId, t.targetTableName)
              onNotice(
                res.targetTableMissing
                  ? '目标数据表已不存在，已复制并标记'
                  : `已复制为「${res.name}」，其中 ${res.bindings.unbound} 个占位符未绑定到目标表字段`,
              )
              setMenu(false)
            }}
          >
            复制到当前数据表
          </button>
          <button
            className="danger"
            onClick={async () => {
              if (!confirm(`删除模板「${t.name}」？此操作不可撤销。`)) return
              await w.deleteTemplates([t.recordId])
              setMenu(false)
            }}
          >
            删除
          </button>
        </div>
      )}
    </div>
  )
}

// ============================================================
// 步骤 ③ 预览
// ============================================================

function StepPreview({ w }: { w: W }) {
  const busy = w.render.phase === 'images' || w.render.phase === 'layout'
  const r = w.render.doc
  const pages = r?.pages.length ?? 0
  const tooMany = w.kind === 'record' && pages > RECORD_BULK_WARN
  /**
   * 「每 N 条」控制项该不该出现（2026-09-21 用户要求恢复）。
   *
   * 用户原话："我之前如果选择了多条数据、再选择记录模板打印的话，在预览界面**可以选择一页
   * 打印多少条数据**，现在怎么只有连续模式和默认模式了。"
   *
   * 查证结论：以前这里是 `w.kind === 'view' && !isContinuousLoopTable(w)` ——
   * **记录模板被一律排除**，理由是"记录模板一条记录一份，每页条数没意义"。
   * ⚠️ 那个理由**只对「默认模式」成立**：
   *   · 默认模式：`layout.ts` 每条记录前都 `breakPage()` ⇒ 每页恒为 1 条，
   *     `perPageN` **永远不会被触发** ⇒ 摆出来就是个骗人的控件（不能改就不显示）；
   *   · **连续模式**：多份内容连续排布、共用一张纸 ⇒ `perPageN` 正是"每页几条"，**完全有意义**。
   * ⇒ 所以拆开判：视图模板照旧；记录模板**只在连续模式下**给这套控件。
   */
  const showPerPage = w.kind === 'view' ? !isContinuousLoopTable(w) : w.batchLayout === 'continuous'
  /**
   * 自定义「每页条数」的输入框内容。
   *
   * 为什么要有它（2026-09-19 用户要求）：档位只有 自动/1/5/10 四档，
   * 但实际排版常需要 3、6、8 这种数 —— 只能凑档位等于逼用户改模板。
   * 用**受控文本**而不是直接把 `perPageN` 塞进 input：用户删空/输入一半时
   * `Number('') === 0` 会把每页条数打到 0（那是"每页 0 条"，排版会炸）。
   * 所以文本自己存，只有解析出**合法正整数**才写回 `setPerPageN`。
   */
  const [perPageText, setPerPageText] = useState('')
  useEffect(() => {
    // 档位被点掉（或换模板）时，把输入框同步成当前值；用户正在输入时不打断
    setPerPageText(w.perPageN && w.perPageN > 0 ? String(w.perPageN) : '')
  }, [w.perPageN])

  return (
    <div className="wiz-block">
      <section className="wiz-prev-head">
        <div className="wiz-group-head">
          <h3 className="wiz-group-title">{w.kind === 'record' ? '排版方式' : '每页记录数'}</h3>
          <span className="wiz-group-note">
            {w.kind === 'record' ? (w.batchLayout === 'default' ? '一页一份' : '连续不分页') : '分页规则'}
          </span>
        </div>
        <div className="seg">
          {w.kind === 'record' ? (
            <>
              <button
                type="button"
                className={`seg-item ${w.batchLayout === 'default' ? 'active' : ''}`}
                onClick={() => w.setBatchLayout('default')}
              >
                默认模式
              </button>
              <button
                type="button"
                className={`seg-item ${w.batchLayout === 'continuous' ? 'active' : ''}`}
                onClick={() => w.setBatchLayout('continuous')}
              >
                连续模式
              </button>
            </>
          ) : (
            segmentsForPerPage(w)
          )}
        </div>
        {/*
          记录模板的「每 N 条」**单独起一行**（2026-09-21）。

          为什么不并进上面那一行：它和「默认/连续」是**两个维度**
          （一个管"每份文档装几条"，一个管"要不要一份一份分页"），
          挤进同一个 `.seg` 会在 320px 侧栏里折成两行、还把两组语义混在一起。
        */}
        {w.kind === 'record' && showPerPage ? (
          <>
            <div className="wiz-group-head">
              <h4 className="wiz-group-title">每页条数</h4>
              <span className="wiz-group-note">连续模式下多条共用一张纸</span>
            </div>
            <div className="seg">{segmentsForPerPage(w)}</div>
          </>
        ) : null}
        {w.kind === 'view' && isContinuousLoopTable(w) ? (
          <p className="wiz-hint">
            本模板的循环区是一张<b>连续大表</b>：它按页高逐行铺开，行落在哪一页由内容高度决定，
            所以「每页几条」对它不起作用 —— 控制项已收起（改为按页高自动分页）。
          </p>
        ) : null}
        {/*
          ⚠️ 记录模板 + 默认模式：**不给控件，但要说清去哪改**。
          「不能改就不显示」（用户口径）与「不解释等于用户以为功能没了」这两条要同时满足 ——
          所以控件收起、原因写在这一句里。默认模式下 `perPageN` 在渲染里永远不会被触发
          （每条记录前都 breakPage），摆出来就是个点了没反应的骗人控件。
        */}
        {w.kind === 'record' && w.batchLayout === 'default' ? (
          <p className="wiz-hint">
            默认模式是「一条记录一份」，每条都从新页开始，所以这里没有「每页条数」。
            想让多张单据<b>共用一张纸</b>，把上面的排版方式切到「连续模式」。
          </p>
        ) : null}
        {/*
          自定义「每页 N 条」（2026-09-19 用户要求；2026-09-21 起记录模板的连续模式也能用）。
          档位只有 自动/1/5/10，实际排版常需要 3/6/8 这种数 ⇒ 给一个输入框。
        */}
        {showPerPage ? (
          <div className="wiz-perpage-custom">
            <label htmlFor="wiz-perpage">自定义：每</label>
            <input
              id="wiz-perpage"
              className="wiz-input wiz-num"
              type="number"
              min={1}
              max={200}
              inputMode="numeric"
              placeholder="条数"
              value={perPageText}
              aria-label="每页自定义条数"
              onChange={(e) => {
                const raw = e.target.value
                setPerPageText(raw)
                const n = Number(raw)
                // 只在**合法正整数**时才写回：空串 / 0 / 负数 / 小数都不动状态，
                // 否则 `Number('') === 0` 会把"每页条数"打成 0，排版直接炸
                if (Number.isInteger(n) && n > 0 && n <= 200) w.setPerPageN(n)
              }}
            />
            <span>条</span>
          </div>
        ) : null}
      </section>

      {w.blockingWarnings.length > 0 && <BlockingWarnings w={w} />}

      {busy && (
        <div className="wiz-progress">
          <span className="wiz-pulse" />
          <span className="wiz-progress-text">
            {w.render.phase === 'images' ? '正在加载附件图片' : '正在排版'}
            {w.render.total > 0 ? ` ${w.render.done}/${w.render.total}` : '…'}
          </span>
          <div className="wiz-bar">
            <div
              className="wiz-bar-fill"
              style={{ width: w.render.total ? `${Math.round((w.render.done / w.render.total) * 100)}%` : '30%' }}
            />
          </div>
          <button className="app-btn sm" onClick={() => w.cancelRender()}>
            取消
          </button>
        </div>
      )}

      {w.render.phase === 'error' && (
        <div className="wiz-alert danger" role="alert">
          <span className="wiz-alert-icon" aria-hidden="true">
            !
          </span>
          <div className="wiz-alert-body">
            <p className="wiz-alert-title">渲染失败</p>
            <p className="wiz-alert-text">{w.render.error}</p>
            <button
              type="button"
              className="app-btn sm"
              onClick={() => void w.runRender({ forOutput: false, forceImages: false })}
            >
              重试
            </button>
          </div>
        </div>
      )}

      {r && (
        <>
          <div className="wiz-sum">
            <p className="wiz-sum-title">
              共 <b>{pages}</b> 页
            </p>
            <p className="wiz-sum-meta">
              {w.scopedRecords.length} 条记录 · 纸张{' '}
              {paperName(r.pageWidthMm, r.pageHeightMm)
                ? `${paperName(r.pageWidthMm, r.pageHeightMm)} `
                : ''}
              {Math.round(r.pageWidthMm)}×{Math.round(r.pageHeightMm)}mm
              {w.kind === 'record' ? ' · 一条记录一份' : ''}
            </p>
          </div>

          {tooMany && (
            <div className="wiz-alert warn" role="status">
              <span className="wiz-alert-icon" aria-hidden="true">
                !
              </span>
              <div className="wiz-alert-body">
                <p className="wiz-alert-title">
                  {w.scopedRecords.length} 条记录按「一条一份」排出了 {pages} 页
                </p>
                <p className="wiz-alert-text">如果本来只想打几张，现在回去把范围改成手动勾选还来得及。</p>
                <div className="wiz-alert-actions">
                  <button
                    type="button"
                    className="app-btn sm"
                    onClick={() => {
                      w.setRangeMode('manual')
                      w.setStep(0)
                    }}
                  >
                    回去改范围
                  </button>
                </div>
              </div>
            </div>
          )}

          <PreviewFrame
            html={r.html}
            pageWidthMm={r.pageWidthMm}
            pageHeightMm={r.pageHeightMm}
            zoom="fit"
            pageCount={pages}
          />

          <WarningsPanel w={w} />
        </>
      )}
    </div>
  )
}

/** 必须修正的问题：默认收成一行摘要，不占用预览的首屏空间 */
function BlockingWarnings({ w }: { w: W }) {
  const [open, setOpen] = useState(false)
  const list = w.blockingWarnings

  return (
    <div className="wiz-alert danger">
      <span className="wiz-alert-icon" aria-hidden="true">
        !
      </span>
      <div className="wiz-alert-body">
        <button
          type="button"
          className="wiz-alert-toggle"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
        >
          <span className="wiz-alert-title">模板有 {list.length} 处必须修正的问题</span>
          <span className={`wiz-alert-chev ${open ? 'on' : ''}`} aria-hidden="true">
            ▾
          </span>
        </button>

        {open && (
          <>
            <ul className="wiz-block-list">
              {list.slice(0, 8).map((x, i) => (
                <li key={i}>{x.message}</li>
              ))}
            </ul>
            {list.length > 8 && <p className="wiz-alert-text">…另有 {list.length - 8} 处，去编辑器里一次改完。</p>}
          </>
        )}

        <div className="wiz-alert-actions">
          {/*
            「去编辑器修改」改走**独立窗口**（2026-09-18）。
            以前调 `w.openEditor()` = 在插件侧边栏里开内联画布 —— 那正是用户要求删掉的东西。
            现在与模板卡片上的编辑入口同一条路。
          */}
          <button
            type="button"
            className="app-btn sm"
            onClick={() => {
              if (w.active) {
                requestEditorFullscreen()
                w.openEditorFor(w.active.recordId)
              }
            }}
          >
            去编辑器修改
          </button>
        </div>
      </div>
    </div>
  )
}

/**
 * 当前模板是不是「循环区一张连续大表」（多记录并成一张大表）。
 *
 * 判定基于**当前模板本身**（循环区唯一元素 + 是表格 + 声明了 rowsFromRecords），
 * 不是模板类型 —— 视图模板也可以不这么排。与渲染层 mergedLoopTableOf 同一口径。
 */
function isContinuousLoopTable(w: W): boolean {
  const els = w.doc?.bands.loop?.elements ?? []
  return els.length === 1 && els[0]?.kind === 'table' && els[0].rowsFromRecords === true
}

/**
 * 「每 N 条」四个档位。
 *
 * ⚠️ **不能改就干脆不显示**（2026-09-19 用户口径）：
 * "如果不能编辑就不要显示了。"
 *
 * 以前是"保留控件但禁用 + 就地说明"，当时的理由是"直接藏起来用户会以为功能没了"。
 * 真机反馈推翻了这条：一排**灰按钮**只会让用户反复去点、怀疑自己点错了，
 * 比"看不到"更让人困惑。⇒ 冲突时返回 `null`，**由 `StepPreview` 里那句 `wiz-hint` 负责解释原因**。
 */
function segmentsForPerPage(w: W) {
  // 「每 N 条」按记录边界强制分页；连续大表按页高铺行，两者天然冲突。
  if (isContinuousLoopTable(w)) return null
  const opts: Array<[number | null, string]> = [
    [null, '自动'],
    [1, '每 1 条'],
    [5, '每 5 条'],
    [10, '每 10 条'],
  ]
  return opts.map(([n, label]) => (
    <button
      key={label}
      type="button"
      className={`seg-item ${w.perPageN === n ? 'active' : ''}`}
      onClick={() => w.setPerPageN(n)}
      aria-pressed={w.perPageN === n}
    >
      {label}
    </button>
  ))
}

function WarningsPanel({ w }: { w: W }) {
  const [open, setOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const warnings = w.render.doc?.warnings ?? []
  const failures = w.render.imageFailures
  const total = warnings.length + failures.length + w.render.imageWarnings.length
  if (total === 0) return null

  const text = buildReport(w)

  return (
    <section className="app-section">
      <div className="app-section-head">
        <button
          type="button"
          className="wiz-alert-toggle"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
        >
          <h3 className="app-section-title">
            检查结果 <span className="wiz-count">{total}</span>
          </h3>
          <span className={`wiz-alert-chev ${open ? 'on' : ''}`} aria-hidden="true">
            ▾
          </span>
        </button>
        <button
          type="button"
          className="app-btn sm"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(text)
              setCopied(true)
              setTimeout(() => setCopied(false), 2000)
            } catch {
              downloadText(text, 'bitableprint-warnings.txt')
            }
          }}
        >
          {copied ? '已复制 ✓' : '复制清单'}
        </button>
      </div>

      {open && (
        <div className="app-section-body">
          {warnings.length > 0 && (
            <>
              <p className="wiz-note-label">渲染提示（{warnings.length}）</p>
              <ul className="wiz-block-list">
                {warnings.slice(0, 30).map((x, i) => (
                  <li key={i}>
                    {x.pageIndex != null ? `第 ${x.pageIndex + 1} 页：` : ''}
                    {x.message}
                  </li>
                ))}
              </ul>
            </>
          )}
          {w.render.imageWarnings.length > 0 && (
            <>
              <p className="wiz-note-label">图片清晰度（{w.render.imageWarnings.length}）</p>
              <ul className="wiz-block-list">
                {w.render.imageWarnings.slice(0, 20).map((x, i) => (
                  <li key={i}>{x.message}</li>
                ))}
              </ul>
            </>
          )}
          {failures.length > 0 && (
            <>
              <p className="wiz-note-label">图片加载失败（{failures.length}）</p>
              <ul className="wiz-block-list">
                {failures.slice(0, 20).map((x, i) => (
                  <li key={i}>
                    {x.fieldName} · {x.attachmentName}：{x.reason}
                  </li>
                ))}
              </ul>
              <p className="wiz-hint">
                失败较多通常是跨域限制。可以在模板里把附件字段改成“不打印附件”或“只导出文件名”。
              </p>
            </>
          )}
          {w.render.imageStats && (
            <p className="wiz-hint">
              附件统计：候选 {w.render.imageStats.candidates} · 成功 {w.render.imageStats.downloaded} ·
              缓存命中 {w.render.imageStats.cached} · 失败 {w.render.imageStats.failed} · 非图片跳过{' '}
              {w.render.imageStats.skippedNonImage} · 耗时 {Math.round(w.render.imageStats.elapsedMs)}ms
            </p>
          )}
        </div>
      )}
    </section>
  )
}

// ============================================================
// 步骤 ④ 输出
// ============================================================

function StepOutput({ w }: { w: W }) {
  const busy = w.render.phase === 'images' || w.render.phase === 'layout'
  const working = w.output.phase === 'working' || busy
  const r = w.render.doc
  const pages = r?.pages.length

  return (
    <div className="wiz-block">
      <section className="wiz-facts">
        <div className="wiz-fact">
          <span className="wiz-fact-k">模板</span>
          {/*
            `is-text`：文字型取值跟数字用同一号字（18px）会显得又大又挤，
            而且模板名一长就会折成两三行、把卡片撑高（本来两列卡就别扭成一行高一行矮）。
            设计稿给文字型单独留了一档（13px/500）—— 见 wizard.css 的 `.wiz-fact-v.is-text`。
          */}
          <span className="wiz-fact-v is-text" title={w.active?.name ?? undefined}>
            {w.active?.name ?? '—'}
          </span>
        </div>
        <div className="wiz-fact">
          <span className="wiz-fact-k">页数</span>
          <span className="wiz-fact-v">{pages != null ? `${pages} 页` : '—'}</span>
        </div>
        <div className="wiz-fact">
          <span className="wiz-fact-k">记录数</span>
          <span className="wiz-fact-v">{w.scopedRecords.length} 条</span>
        </div>
        <div className="wiz-fact" title={w.kind === 'record' ? '一条记录生成一份文档' : '一份文档含多条记录'}>
          <span className="wiz-fact-k">类型</span>
          <span className="wiz-fact-v is-text">{w.kind === 'record' ? '记录模板' : '视图模板'}</span>
        </div>
      </section>

      <section className="wiz-group">
        <h3 className="wiz-group-title">输出方式</h3>
        <div className="wiz-actions">
          <div className="wiz-action">
            <button className="app-btn primary" onClick={() => void w.doPrint()} disabled={working}>
              {working ? '准备中…' : '打印（系统对话框）'}
            </button>
            <p className="wiz-action-desc">
              推荐。直接调起系统打印对话框选打印机；想存 PDF 就在那个对话框里选「另存为 PDF」。
            </p>
          </div>

          {/*
            ⛔ 「导出 PDF」已移除（2026-09-18 用户要求）：
            "既然不能静默生成 PDF，那就不要占位了，用户选择打印的时候可以自行保存。"
            它本来只是 `saveHtmlFile` 的别名 —— 真正能出 PDF 的只有
            "打印 → 浏览器对话框里选另存为 PDF"，留一个名不副实的按钮只会误导。
            需要 PDF 时走上面那个「打印」即可。
          */}

          <div className="wiz-action">
            <button className="app-btn" onClick={() => void w.doSaveHtml()} disabled={working}>
              保存打印就绪 HTML
            </button>
            <p className="wiz-action-desc">得到一个自包含的 HTML 文件，双击就能打印，适合存档或发给同事自己打。</p>
          </div>
        </div>
      </section>

      {working && (
        <div className="wiz-progress">
          <span className="wiz-pulse" />
          <span className="wiz-progress-text">
            {w.render.phase === 'images'
              ? '正在重新获取附件图片'
              : w.render.phase === 'layout'
                ? '正在排版'
                : '正在输出'}
            {w.render.total > 0 ? ` ${w.render.done}/${w.render.total}` : '…'}
          </span>
          <div className="wiz-bar">
            <div className="wiz-bar-fill" style={{ width: '60%' }} />
          </div>
        </div>
      )}

      {w.output.message && (
        <div className={`wiz-alert ${w.output.phase === 'error' ? 'danger' : 'ok'}`} role="status">
          <span className="wiz-alert-icon" aria-hidden="true">
            {w.output.phase === 'error' ? '!' : '✓'}
          </span>
          <div className="wiz-alert-body">
            <p className="wiz-alert-title">{w.output.phase === 'error' ? '操作失败' : '完成'}</p>
            <p className="wiz-alert-text">{w.output.message}</p>
            {w.output.result && (
              <p className="wiz-alert-text">
                文件：{w.output.result.fileName}（{statusLabel(w.output.result.status)}）
              </p>
            )}
          </div>
        </div>
      )}

      {w.output.guidance && <p className="wiz-note">{w.output.guidance}</p>}
    </div>
  )
}

function statusLabel(s: string): string {
  switch (s) {
    case 'saved':
      return '已保存到你选择的位置'
    case 'downloaded':
      return '已下载到『下载』文件夹'
    case 'cancelled':
      return '已取消'
    default:
      return s
  }
}

// ============================================================

/** 纸张尺寸 → 常见叫法。认不出来返回空串，由调用方只显示毫米 */
const PAPER_NAMES: Record<string, string> = {
  '105×148': 'A6',
  '148×210': 'A5',
  '176×250': 'B5',
  '210×297': 'A4',
  '216×279': 'Letter',
  '297×420': 'A3',
}

function paperName(wMm: number, hMm: number): string {
  const key = [wMm, hMm]
    .map((n) => Math.round(n))
    .sort((a, b) => a - b)
    .join('×')
  return PAPER_NAMES[key] ?? ''
}

function buildReport(w: W): string {
  const lines: string[] = ['# BitablePrint 渲染检查清单', `时间：${new Date().toLocaleString('zh-CN')}`]
  const r = w.render.doc
  if (r) {
    lines.push(`页数：${r.pages.length}`, `记录数：${w.scopedRecords.length}`, '')
  }
  lines.push('## 渲染提示')
  for (const x of r?.warnings ?? []) lines.push(`- ${x.pageIndex != null ? `[第 ${x.pageIndex + 1} 页] ` : ''}${x.message}`)
  lines.push('', '## 图片清晰度')
  for (const x of w.render.imageWarnings) lines.push(`- ${x.message}`)
  lines.push('', '## 图片加载失败')
  for (const x of w.render.imageFailures) lines.push(`- ${x.fieldName} / ${x.attachmentName}：${x.reason}`)
  return lines.join('\n')
}

function downloadText(text: string, fileName: string): void {
  try {
    const blob = new Blob([text], { type: 'application/json;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = fileName
    a.style.display = 'none'
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 2000)
  } catch {
    /* 无 DOM 环境忽略 */
  }
}

export default Wizard
