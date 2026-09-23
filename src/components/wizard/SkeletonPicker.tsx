import { useMemo, useState } from 'react'
import type { FieldMeta } from '../../lib/data-source'
import type { TemplateDoc, TemplateKind } from '../../lib/types'
import { SKELETONS, buildSkeleton, countUnbound, findSkeleton } from '../../lib/skeletons'

/**
 * 骨架选择器：在步骤②里"新建模板"时选一个版式起点。
 *
 * 选完不是直接落库，而是**创建并进入编辑器** —— 骨架给的是版式，字段绑定还需要用户确认，
 * 直接结束会让用户以为"这就是最终效果"。
 *
 * 同时会提示骨架里有多少占位符没能自动绑到当前表的字段上（用户据此决定是先改表还是先改模板）。
 *
 * 版式缩略图是**纯 CSS 画的**（不是图片、不是图标字体）：窄侧栏里图片要么糊要么拖慢加载，
 * 而骨架之间的差别本来就只有"标题/说明行/表格/签字"这几块，用盒子摆出来比文字描述快得多。
 *
 * ⚠️ **2026-09-19 改：不再按类型过滤，改成"列出全部骨架 + 按类型分组"。**
 *
 * 起因是一个**死局**：步骤①的「打印什么」类型选择被用户要求删掉（"类型由所选模板决定"），
 * 而这个面板当时也**刻意不传 `onKindChange`**（那是为了修"同一个问题问两遍"）。
 * 两下一叠加，`kind` 就永远停在默认的 `view` ——
 * **记录模板（入库单 / 出库单 / 验收单…）在新表里再也建不出来了**，
 * 而那恰恰是这个插件最主流的用法。
 *
 * 现在改成"**选骨架即定类型**"：`SkeletonDef` 本来就自带 `kind`（入库单天然是一条记录一份），
 * 所以类型跟着所选骨架走 ——
 *   · 一个问题都不用问（比"问一次"还干净，用户的抱怨本来就是"怎么又问"）；
 *   · 用户的心智模型一致："我选的是哪张单据，它就是哪一类"；
 *   · 两个类型都看得见、都能选，死局从根上没了。
 */

interface Props {
  fields: FieldMeta[]
  onCancel(): void
  /** ⚠️ 必须把所选骨架的 `kind` 一起交出去 —— 类型就是在这里定的 */
  onCreate(name: string, doc: TemplateDoc, kind: TemplateKind): void | Promise<void>
}

/** 分组标题（顺序固定：记录在前，它是单据类的主流） */
const GROUPS: Array<{ kind: TemplateKind; title: string; note: string }> = [
  { kind: 'record', title: '记录模板', note: '一条记录一份 · 单据、档案、工牌' },
  { kind: 'view', title: '视图模板', note: '一份文档装多条记录 · 清单、台账' },
]

/** 缩略图的元素构成。键是骨架 key，缺省按类型兜底 */
interface Thumb {
  title: boolean
  /** 标题下的说明行数（单号/日期/供应商…） */
  meta: number
  /** 表格行数，0 表示不画表格 */
  rows: number
  /** 无表格时的普通文本行 */
  lines: number
  sign: boolean
  /** 行尾带勾选框（巡检这类"结果"列） */
  check: boolean
}

const THUMBS: Record<string, Thumb> = {
  'blank-record': { title: false, meta: 0, rows: 0, lines: 0, sign: false, check: false },
  'blank-view': { title: false, meta: 0, rows: 0, lines: 0, sign: false, check: false },
  'doc-general': { title: true, meta: 2, rows: 0, lines: 3, sign: true, check: false },
  'doc-inbound': { title: true, meta: 3, rows: 3, lines: 0, sign: true, check: false },
  'doc-outbound': { title: true, meta: 3, rows: 3, lines: 0, sign: true, check: false },
  'doc-acceptance': { title: true, meta: 3, rows: 3, lines: 1, sign: true, check: false },
  'doc-requisition': { title: true, meta: 2, rows: 3, lines: 0, sign: true, check: false },
  'doc-inspection': { title: true, meta: 2, rows: 3, lines: 1, sign: true, check: true },
  'list-general': { title: true, meta: 0, rows: 5, lines: 0, sign: false, check: false },
  'list-inspection': { title: true, meta: 0, rows: 5, lines: 0, sign: false, check: true },
}

export function SkeletonPicker({ fields, onCancel, onCreate }: Props) {
  /**
   * 全部骨架，按类型分组。**不过滤**（过滤就是那个死局的来源，见文件头注释）。
   */
  const groups = useMemo(
    () =>
      GROUPS.map((g) => ({ ...g, items: SKELETONS.filter((s) => s.kind === g.kind) })).filter(
        (g) => g.items.length > 0,
      ),
    [],
  )
  /**
   * 默认高亮**第一组的首项**（记录模板 → 空白）。
   *
   * 原来这里是"优先高亮当前 `kind` 的首项"，而 `kind` 初值是 `view` ⇒
   * 选中项落在**第二组**、首屏根本看不见（要往下滚一屏才知道自己选中了什么）。
   * 既然类型现在由所选骨架决定，默认停在"列表第一项"才是最可预期的 ——
   * 而且它与面板的视觉顺序一致，不会出现"选中的东西不在眼前"。
   * （顺带把 `kind` 入参删了：它只剩这一个用途，留着就是死参数。）
   */
  const [activeKey, setActiveKey] = useState<string>(() => groups[0]?.items[0]?.key ?? 'blank-record')
  /**
   * 顶部标签页（2026-09-20 用户要求）。
   *
   * 用户原话："当前两个模板类型垂直排列，用户要下滑很久才能看到所有内容，
   * 改为在一个屏幕内，顶部显示两个标签页「记录模板」「视图模板」，点击可以切换"。
   * 10 个骨架纵向铺开确实要滑很久，而且"记录/视图"的差别本来就只有一处 ——
   * 分成两页看，一屏就能选完。
   */
  const [tab, setTab] = useState<TemplateKind>(() => groups[0]?.kind ?? 'record')
  /** 当前页的那一组。`groups` 已经过滤掉空组，所以这里一定有值（除非一个骨架都没有） */
  const shown = groups.find((g) => g.kind === tab) ?? groups[0]
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)

  /** 直接按 key 查，不再 `list.find` —— 现在已经没有"当前过滤列表"这个概念了 */
  const active = findSkeleton(activeKey)

  /** 实时算一遍未绑定数量，让用户在创建前就知道要改多少 */
  const preview = useMemo(() => {
    if (!active) return null
    try {
      const doc = buildSkeleton(active.key, fields)
      const { total, unbound } = countUnbound(doc)
      return { doc, total, unbound }
    } catch {
      return null
    }
  }, [active, fields])

  /**
   * 创建并进入编辑。
   *
   * `keyOverride` 是给**双击**用的：双击时要把那一个骨架直接建出来，
   * 不能只依赖 `active`（虽然双击前必然先有过一次单击，但显式传更稳，
   * 也免得以后有人把 onClick 去掉就悄悄失灵）。
   */
  const create = async (keyOverride?: string): Promise<void> => {
    const sk = keyOverride ? findSkeleton(keyOverride) : active
    if (!sk) return
    let doc = active?.key === sk.key ? preview?.doc : undefined
    if (!doc) {
      try {
        doc = buildSkeleton(sk.key, fields)
      } catch {
        return
      }
    }
    if (keyOverride) setActiveKey(sk.key)
    setBusy(true)
    try {
      // ⚠️ 类型 = 所选骨架的类型。这就是全流程里**唯一**一次决定记录/视图的地方。
      await onCreate(name.trim() || sk.name, doc, sk.kind)
    } finally {
      setBusy(false)
    }
  }

  /**
   * 切换标签页时**顺带把选中项落到新那一组里**（2026-09-21 UI 重设计时补的一个真坑）。
   *
   * 原问题：`tab`（看哪一组）与 `activeKey`（选中的骨架）是两份独立状态 ⇒
   * 切到「视图模板」页之后，选中的仍是上一页那条 `blank-record`，
   * 于是输入框的 placeholder 写着「空白（记录模板）」、底下的说明写着
   * "类型随所选骨架：**记录模板**（一条记录一份）" —— 而用户**明明正看着视图模板那一页**。
   * 他一按「创建并编辑」，建出来的是个**记录模板**。这不只是文案不齐，是**建错了东西**。
   *
   * ⚠️ 只在"当前选中项不属于这一页"时才改选（而不是无条件选第一条）：
   *    来回切页不该把用户已经挑好的骨架丢掉。
   */
  const pickTab = (k: TemplateKind): void => {
    setTab(k)
    const g = groups.find((x) => x.kind === k)
    if (g && !g.items.some((s) => s.key === activeKey)) {
      const first = g.items[0]?.key
      if (first) setActiveKey(first)
    }
  }

  return (
    <div className="wiz-block">
      <section className="app-section">
        {/*
          标题行（UI 重设计 2026-09-21）：**只有标题**，右上角那个「返回」已经撤掉。
          原来标题行和底部各有一个"退回去"的入口（返回 / 取消），而两者做的事**完全一样** ——
          同一个动作两个入口必然带来"到底有区别吗"的疑惑。设计稿的答案：
          标题行不放动作，底部只留「返回 + 创建并编辑」这一组（见文件末尾的 `.wiz-foot`）。
        */}
        <div className="app-section-head">
          <h3 className="app-section-title">选择版式骨架</h3>
        </div>

        <div className="app-section-body">
          {/*
            ⛔ 原来的「记录模板 / 视图模板」切换段**已删除**（2026-09-19）。
            它存在的意义是"在面板内改类型"，而类型现在已经由所选骨架决定，
            再摆一个开关只会制造"我到底选了哪个"的歧义；
            而当初删掉它又是造成"记录模板建不出来"的那个死局。
            分组标题同时承担了"说明两类是什么"的职责 —— 比一个开关信息量更大。
          */}
          {/*
            顶部标签页取代了原来的纵向分组标题（2026-09-20 用户要求）。
            ⚠️ UI 重设计（2026-09-21）把它**做成"分段控制器"的样子**，但**类名仍是
               `.sk-tabs` / `.sk-tab`，不用 `.seg`**。原因有两层：
                 · `.seg` 在本项目里是"**在改向导模式**"的控件（打印范围 / 排版方式），
                   而这里的标签页只是**浏览哪一组骨架**，语义不同；
                 · e2e 有一条守卫数的是"骨架面板正文里的 `.seg` 个数必须是 0"
                   （它守的是"面板不许再问一遍类型"那个死局）—— 借用 `.seg` 会把那条守卫变成假红。
            ⚠️ 分组说明（"一份文档装多条记录 · 清单、台账"）**不能丢** ——
               它是这两类骨架唯一的差别所在，所以留在标签下面当副标题，一屏内仍然看得到。
          */}
          <div className="sk-tabs" role="tablist" aria-label="模板类型">
            {groups.map((g) => {
              const on = g.kind === (shown?.kind ?? 'record')
              return (
                <button
                  key={g.kind}
                  type="button"
                  role="tab"
                  aria-selected={on}
                  className={`sk-tab${on ? ' on' : ''}`}
                  onClick={() => pickTab(g.kind)}
                >
                  <span className={`wiz-kind ${g.kind}`}>{g.kind === 'record' ? '记录模板' : '视图模板'}</span>
                  <span className="sk-tab-count">{g.items.length}</span>
                </button>
              )
            })}
          </div>
          {shown ? <p className="sk-tab-note">{shown.note}</p> : null}

          {/*
            骨架列表：每行 = 缩略图（56×44）+ 名称/说明 + 右侧单选圈（UI 重设计）。
            ⚠️ 单选圈仍是 `.sk-item-mark`（不是新加的 `.radio`）：它已经是这套语义的元素，
               位置、层级、`aria-pressed` 都在，只是尺寸/描边按设计稿收敛。
          */}
          <div className="sk-list">
            {(shown?.items ?? []).map((s) => {
              const on = s.key === activeKey
              return (
                <button
                  key={s.key}
                  className={`sk-item ${on ? 'on' : ''}`}
                  onClick={() => setActiveKey(s.key)}
                  /** 双击 = 就用这个骨架立刻建模板进编辑（用户要求："双击对应模板直接进入编辑状态"） */
                  onDoubleClick={() => void create(s.key)}
                  aria-pressed={on}
                  title={`${s.name}｜双击即可用它开始编辑`}
                >
                  <SkeletonThumb spec={thumbOf(s.key, s.kind)} />
                  <span className="sk-item-body">
                    <span className="sk-item-name">{s.name}</span>
                    <span className="sk-item-desc">{s.desc}</span>
                  </span>
                  <span className="sk-item-mark" aria-hidden="true" />
                </button>
              )
            })}
          </div>

          {preview && preview.total > 0 && (
            <p className="wiz-hint">
              这个骨架有 <b>{preview.total}</b> 个字段占位符
              {preview.unbound === 0 ? (
                <span className="sk-tag ok">全部已自动绑上当前表的字段</span>
              ) : (
                <span className="sk-tag warn">{preview.unbound} 个没找到对应字段，进去后手动绑</span>
              )}
            </p>
          )}
          {preview && preview.total === 0 && <p className="wiz-hint">空白骨架，进去自己拖元素。</p>}

          {/* 模板名称：设计稿的 36px 高输入框（`.sk-name`，见 wizard.css） */}
          <div className="sk-field">
            <label className="sk-label" htmlFor="sk-name">
              模板名称
            </label>
            <input
              id="sk-name"
              className="wiz-input sk-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={active?.name ?? '模板名称'}
            />
          </div>
          <p className="wiz-hint">
            留空就用骨架名「{active?.name ?? '—'}」。类型随所选骨架：
            <b>{active?.kind === 'record' ? '记录模板（一条记录一份）' : '视图模板（一份文档装多条记录）'}</b>
          </p>
          {/*
            原来这句话和主按钮并排放在 `.wiz-actions` 里（按钮下面一行小字）。
            设计稿把它当成**正文里的一条弱注释**：主按钮那块只留按钮，
            说明性文字归正文 —— 否则底栏高度会随文案长度变化，按钮位置就飘了。
          */}
          <p className="sk-note">创建后会直接打开编辑器：骨架只负责版式，字段绑定还需要你确认一次。</p>
        </div>
      </section>

      {/*
        ⚠️ 底栏**必须在子面板自己的作用域里**（不能指望 `WizardFooter`）：
           `WizardFooter` 在子面板展开时整块 `return null`（避免两套"下一步"打架），
           所以骨架面板得自带一组 —— 而且它得是 `.wiz-foot`（`position: sticky; bottom: 0`），
           否则骨架一多，"创建并编辑"就被挤到列表底下要滚很久才看得见
           （用户这次点名要求的第一条：**主按钮永远钉在面板底部**）。

        按钮构成 = 设计稿：左「返回」次要（88px）+ 右「创建并编辑」主按钮（flex:1）。
        原来那个「取消」**已删除** —— 它与「返回」是同一个动作（都是 `onCancel`）。
      */}
      <div className="wiz-foot">
        <button type="button" className="app-btn" onClick={onCancel} disabled={busy}>
          返回
        </button>
        <button
          type="button"
          className="app-btn primary"
          onClick={() => void create()}
          disabled={busy || !active}
        >
          {busy ? '创建中…' : '创建并编辑'}
        </button>
      </div>
    </div>
  )
}

function thumbOf(key: string, kind: TemplateKind): Thumb {
  return (
    THUMBS[key] ?? {
      title: true,
      meta: kind === 'record' ? 2 : 0,
      rows: kind === 'record' ? 3 : 5,
      lines: 0,
      sign: kind === 'record',
      check: false,
    }
  )
}

/** 一页 A4 的极简示意：标题 / 说明行 / 表格 / 签字，全部由 CSS 盒子摆位 */
function SkeletonThumb({ spec }: { spec: Thumb }) {
  const blank = !spec.title && spec.meta === 0 && spec.rows === 0 && spec.lines === 0 && !spec.sign
  return (
    <span className="sk-thumb" aria-hidden="true">
      {blank && <span className="sk-thumb-blank" />}

      {spec.title && <span className="sk-thumb-title" />}

      {spec.meta > 0 && (
        <span className="sk-thumb-meta">
          {Array.from({ length: spec.meta }, (_, i) => (
            <i key={i} />
          ))}
        </span>
      )}

      {spec.rows > 0 && (
        <span className="sk-thumb-table">
          <i className="sk-thumb-th" />
          {Array.from({ length: spec.rows }, (_, i) => (
            <i key={i} className={spec.check && i % 2 === 1 ? 'sk-thumb-tr check' : 'sk-thumb-tr'} />
          ))}
        </span>
      )}

      {spec.lines > 0 && (
        <span className="sk-thumb-lines">
          {Array.from({ length: spec.lines }, (_, i) => (
            <i key={i} className={i === 0 ? 'long' : ''} />
          ))}
        </span>
      )}

      {spec.sign && (
        <span className="sk-thumb-sign">
          <i />
          <i />
        </span>
      )}
    </span>
  )
}