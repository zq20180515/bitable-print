import { useCallback, useEffect, useState } from 'react'
import type {
  DataSource,
  FieldMeta,
  FieldOrderSource,
  RecordItem,
  RecordOrderSource,
  TableContext,
} from './lib/data-source'
import {
  BootError,
  applyTheme,
  createDataSource,
  createMockDataSource,
  onFeishuThemeChange,
  readFeishuTheme,
  readStoredTheme,
} from './lib/bootstrap'
import { SdkDataSource } from './lib/sdk-source'
import { ProbePanel } from './probe/ProbePanel'
import type { ProbeEnv } from './probe/probes'
import { DataSanity } from './components/DataSanity'
import { Wizard } from './components/wizard/Wizard'

type Tab = 'wizard' | 'sanity' | 'probe'
type ThemeMode = 'auto' | 'light' | 'dark'

type BootState =
  | { phase: 'loading' }
  | { phase: 'ready'; ds: DataSource; mode: 'sdk' | 'mock'; warning?: string }
  | { phase: 'error'; message: string; hint: string }

export function App() {
  const [boot, setBoot] = useState<BootState>({ phase: 'loading' })
  // 默认落在「打印向导」——用户打开插件第一眼就该看到能用的流程。
  // `数据自检` / `探针` 是排障用的，收进标题栏的开发者入口（见 DeveloperMenu）。
  const [tab, setTab] = useState<Tab>(readInitialTab)
  // 切页时把 `?tab=` 同步回地址栏：刷新 / 复制链接能停在当前页，排查时也能"对着 URL 说哪一页"。
  // 用 replaceState（不是 pushState）—— 不给用户堆一串历史，返回键行为保持原样。
  // 只是同步、不是路由：不监听 popstate、不重新读 tab，所以不会跟 `readInitialTab` 打架。
  useEffect(() => {
    if (typeof location === 'undefined' || typeof history === 'undefined') return
    const u = new URL(location.href)
    if (u.searchParams.get('tab') === tab) return
    u.searchParams.set('tab', tab)
    history.replaceState(null, '', u.toString())
  }, [tab])
  // 深链直接落到自检/探针时，开发者菜单要处于展开态，用户才知道自己在哪一页
  const [devOpen, setDevOpen] = useState<boolean>(() => tab !== 'wizard')
  const [theme, setTheme] = useState<ThemeMode>(() => readStoredTheme())
  const [feishuTheme, setFeishuTheme] = useState<'light' | 'dark' | null>(null)
  const [ctx, setCtx] = useState<TableContext | null>(null)
  const [fields, setFields] = useState<FieldMeta[]>([])
  const [records, setRecords] = useState<RecordItem[]>([])
  /** 记录顺序的来源（见 FetchRecordsResult.orderSource）：向导据此在拿不到视图排序时如实告知用户 */
  const [recordOrder, setRecordOrder] = useState<RecordOrderSource | undefined>(undefined)
  /**
   * **字段**顺序的来源（见 `DataSource.lastFieldOrder`）。
   *
   * 与 `recordOrder` 对称：两者都可能"读不到视图级、退回表级（顺序不可信）"，
   * 都必须让用户看得见 —— 否则勾选列表里标签取错字段，用户只会觉得"这插件乱显示"。
   */
  const [fieldOrder, setFieldOrder] = useState<FieldOrderSource | null>(null)
  const [templateTableId, setTemplateTableId] = useState<string | null>(null)

  useEffect(() => {
    // 「自动」要跟随**飞书自己的主题**，而不是只看系统偏好 —— 两者可以不一致
    applyTheme(theme, feishuTheme)
  }, [theme, feishuTheme])

  // 读飞书主题 + 订阅变化。只有在真实飞书环境里才拿得到，拿不到会退回 prefers-color-scheme。
  useEffect(() => {
    let cancelled = false
    let off: null | (() => void) = null
    void (async () => {
      const t = await readFeishuTheme()
      if (!cancelled && t) setFeishuTheme(t)
      off = await onFeishuThemeChange((next) => {
        if (!cancelled) setFeishuTheme(next)
      })
    })()
    return () => {
      cancelled = true
      try {
        off?.()
      } catch {
        /* 忽略 */
      }
    }
  }, [])

  const bootWith = useCallback(async (loader: () => Promise<{ ds: DataSource; mode: 'sdk' | 'mock'; warning?: string }>) => {
    setBoot({ phase: 'loading' })
    try {
      const res = await loader()
      setBoot({ phase: 'ready', ...res })
    } catch (e) {
      if (e instanceof BootError) {
        setBoot({ phase: 'error', message: e.message, hint: e.hint })
      } else {
        setBoot({ phase: 'error', message: e instanceof Error ? e.message : String(e), hint: '请重试，或重新打开插件。' })
      }
    }
  }, [])

  useEffect(() => {
    void bootWith(createDataSource)
  }, [bootWith])

  const ds = boot.phase === 'ready' ? boot.ds : null

  /**
   * 「用户换了数据表 / 视图」触发器（2026-09-19 用户反馈后补）。
   *
   * 原问题：`ctx` 只在启动时取一次 ⇒ 插件**绑死在打开时的那张表**；
   * 切到表 B 再点"读取左表勾选"，只会得到"已勾选 0 条（N 条不在当前已加载的记录里）"。
   * `SdkDataSource` 早就在监听 `base.onSelectionChange`，但它当时**只更新自己的选中缓存、
   * 从不通知上层** ⇒ 界面这一侧永远不知道表换了。
   *
   * 这里订阅它，收到就把 `ctxEpoch` 加一；下面的加载 effect 把它列进依赖 ⇒ 整条链路（
   * 上下文 → 字段 → 记录）会按新表重跑一遍。
   */
  const [ctxEpoch, setCtxEpoch] = useState(0)
  useEffect(() => {
    if (!ds?.onContextChange) return
    return ds.onContextChange(() => setCtxEpoch((v) => v + 1))
  }, [ds])

  // 启动后先读上下文/字段/记录，作为"数据层是否真的通了"的自检
  useEffect(() => {
    if (!ds) return
    let cancelled = false
    void (async () => {
      try {
        const c = await ds.getContext()
        if (cancelled) return
        setCtx(c)

        /**
         * ⚠️ 字段与记录**必须各自 try**，不能和上面共用一个（2026-09-18 真机反馈后修正）。
         *
         * 改之前三步共用一个 `try`：`listFields` 一旦抛错，`fetchRecords` 就**根本不会被调用** ——
         * 而字段列表正是勾选列表做行标签的唯一来源。真机后果就是"列表里有行、却认不出是哪一条"。
         * 两者互不依赖（记录能单独读），就不该互相拖累。
         */
        try {
          const f = await ds.listFields(c.tableId, c.viewId)
          if (cancelled) return
          setFields(f)
          /**
           * 读完**立刻**问一次来源 —— 它记的是"这一次调用实际走了哪一级"。
           * `?.()`：mock 数据源没有视图列序这个概念，不实现本方法 ⇒ `null` ⇒ 不提示。
           */
          setFieldOrder(ds.lastFieldOrder?.() ?? null)
        } catch (e) {
          // 不阻断：勾选列表会退化成"（这张表还没有可用字段）"，但记录仍然能列出来
          console.warn('[BitablePrint] 读字段失败（勾选列表将无法显示行标签）：', e)
        }

        try {
          const r = await ds.fetchRecords({
            tableId: c.tableId,
            viewId: c.viewId,
            pageSize: 200,
            maxRecords: 600,
          })
          if (cancelled) return
          setRecords(r.records)
          setRecordOrder(r.orderSource)
        } catch (e) {
          console.warn('[BitablePrint] 读记录失败：', e)
        }
      } catch (e) {
        // 自检失败不阻断整体，由自检面板展示
        console.warn('[BitablePrint] 数据自检失败（读上下文）：', e)
      }
    })()
    return () => {
      cancelled = true
    }
    // ctxEpoch：用户切了数据表/视图就重跑这一整条链路（见上面那个订阅 effect）
  }, [ds, ctxEpoch])

  // 模板表：首次使用时按需创建（F6-01 / F6-02）
  useEffect(() => {
    if (!ds) return
    let cancelled = false
    void (async () => {
      try {
        const id = await ds.ensureTemplateTable()
        if (!cancelled) setTemplateTableId(id)
      } catch (e) {
        console.warn('[BitablePrint] 模板表准备失败：', e)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [ds])

  /** 给探针用的原始 SDK 环境 */
  const getProbeEnv = useCallback(async (): Promise<ProbeEnv | null> => {
    if (!(ds instanceof SdkDataSource)) return null
    const mods = await ds.rawModules()
    if (!mods) return null
    let tableId: string | undefined
    let viewId: string | undefined
    try {
      const c = await ds.getContext()
      tableId = c.tableId
      viewId = c.viewId
    } catch {
      /* 探针允许在没有上下文时仍跑一部分 */
    }

    // ⚠️ 实测教训：某些容器里 `getActiveView()` 会失败，导致 viewId 拿不到 ——
    // 于是 P5（视图筛选结果直读）和 P8（字段顺序对比）会误报"无法测试"，
    // 让人以为 SDK 不支持。但 `base.getSelection()` 是**能拿到 viewId 的**（P2 已验证），
    // 所以这里必须回退取值，否则是探针自己把结论堵死。
    let selection: { tableId?: string; viewId?: string; recordId?: string | null; fieldId?: string | null } | null = null
    try {
      if (typeof mods.base?.getSelection === 'function') {
        selection = await mods.base.getSelection()
      }
    } catch {
      /* 忽略：探针自己会再试一次并报告 */
    }
    if (!tableId && selection?.tableId) tableId = selection.tableId
    if (!viewId && selection?.viewId) viewId = selection.viewId

    return { sdk: null, base: mods.base, bridge: mods.bridge, ui: mods.ui, tableId, viewId, selection }
  }, [ds])

  return (
    <div className="app">
      <header className="app-bar">
        <div className="app-bar-left">
          <span className="app-logo" aria-hidden />
          <span className="app-title">排版打印</span>
          {/*
            当前作用的数据表名（2026-09-19 用户要求："是否在插件顶部增加当前作用的数据表名称"）。
            为什么必须有：插件会跟着用户切表重载（见上面 onContextChange 的注释），
            没有这行名字，用户看到列表变了也不知道"现在到底在打印哪张表"——
            "作用域不可见"正是之前"绑死在表 A"那个 bug 的另一半。
          */}
          {ctx?.tableName ? (
            <span className="app-scope" title={`当前作用于数据表「${ctx.tableName}」`}>
              {ctx.tableName}
            </span>
          ) : null}
        </div>
        <div className="app-bar-right">
          <DeveloperMenu tab={tab} open={devOpen} onToggle={() => setDevOpen((v) => !v)} onPick={setTab} />
          <ThemeSwitch value={theme} onChange={setTheme} />
        </div>
      </header>

      {boot.phase === 'ready' && boot.warning && (
        <div className="app-banner warn">
          <span className="app-banner-dot" aria-hidden />
          <span>{boot.warning}</span>
        </div>
      )}

      <nav className="app-tabs" role="tablist" aria-label="插件功能">
        <button
          role="tab"
          aria-selected={tab === 'wizard'}
          className={`app-tab ${tab === 'wizard' ? 'active' : ''}`}
          onClick={() => setTab('wizard')}
        >
          打印向导
        </button>
      </nav>

      <main className="app-body">
        {boot.phase === 'loading' && (
          <div className="app-center">
            <span className="app-spinner" aria-hidden />
            <p className="app-center-text">正在连接多维表格…</p>
          </div>
        )}

        {boot.phase === 'error' && (
          <div className="app-center">
            <div className="app-error">
              <p className="app-error-title">无法连接到多维表格</p>
              <p className="app-error-msg">{boot.message}</p>
              <p className="app-error-hint">{boot.hint}</p>
              <div className="app-error-actions">
                <button className="app-btn primary" onClick={() => void bootWith(createDataSource)}>
                  重试
                </button>
                <button className="app-btn" onClick={() => void bootWith(() => createMockDataSource(60))}>
                  用示例数据体验
                </button>
              </div>
            </div>
          </div>
        )}

        {boot.phase === 'ready' && ds && (
          <>
            {tab === 'sanity' && (
              <DataSanity
                ds={ds}
                ctx={ctx}
                fields={fields}
                records={records}
                templateTableId={templateTableId}
              />
            )}
            {tab === 'wizard' && (
              <Wizard
                ds={ds}
                ctx={ctx}
                fields={fields}
                records={records}
                recordOrder={recordOrder}
                fieldOrder={fieldOrder}
                templateTableId={templateTableId}
              />
            )}
            {tab === 'probe' && <ProbePanel getEnv={getProbeEnv} />}
          </>
        )}
      </main>
    </div>
  )
}

/**
 * `?tab=wizard|sanity|probe` 深链：自动化冒烟测试与开发时直接落到某一页都要靠它，
 * 所以**必须继续有效**（默认落到打印向导）。
 */
function readInitialTab(): Tab {
  if (typeof location === 'undefined') return 'wizard'
  const t = new URLSearchParams(location.search).get('tab')
  return t === 'wizard' || t === 'probe' || t === 'sanity' ? t : 'wizard'
}

/** 开发者入口里能到达的页面。打印向导是正常入口，不在这里列 */
const DEV_PAGES: Array<{ id: Tab; label: string }> = [
  { id: 'sanity', label: '数据自检' },
  { id: 'probe', label: '探针' },
]

/**
 * 标题栏里的开发者入口：数据自检 / 探针只是排障用的，不该占用户的第一屏
 * （用户要求：打开插件第一页必须是打印向导）。
 *
 * ⚠️ 菜单内容**始终留在 DOM 里**（收起时靠 `hidden` 隐藏，见 wizard.css 的 `[hidden]` 规则）：
 * 既有冒烟脚本（test/e2e-smoke.mjs）是按按钮文字点「探针」页的，
 * 整块不渲染会让它找不到按钮而全红。收起 = 用户看不见，功能上等同于"藏起来"。
 */
function DeveloperMenu({
  tab,
  open,
  onToggle,
  onPick,
}: {
  tab: Tab
  open: boolean
  onToggle: () => void
  onPick: (t: Tab) => void
}) {
  /**
   * **点空白处收起**（2026-09-19 用户反馈："整个插件还有其他地方都有类似的 BUG，
   * 必须要重复点击才会收纳，都检查下"）。
   *
   * 这个菜单原来只有"点自己"一个开合入口 —— 点别处它就一直杵在那儿。
   * 与模板卡片那个「…」菜单是同一类问题，改法也一致：pointerdown **捕获阶段**判定，
   * 目标不在菜单容器内就收起。
   *
   * 这里不引 useRef：App.tsx 只导入了三个 hook，为一个小菜单再加一个导入不划算，
   * 而 closest('.app-dev-wrap') 的语义更直白（"点在菜单容器里了吗"）。
   */
  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent): void => {
      const el = e.target as HTMLElement | null
      if (!el) return
      if (el.closest?.('.app-dev-wrap')) return
      onToggle()
    }
    document.addEventListener('pointerdown', onDown, true)
    return () => document.removeEventListener('pointerdown', onDown, true)
  }, [open, onToggle])
  const onDevPage = tab !== 'wizard'
  return (
    <div className="app-dev-wrap">
      <button
        type="button"
        className={`app-dev ${onDevPage ? 'on' : ''}`}
        onClick={onToggle}
        aria-expanded={open}
        aria-haspopup="menu"
        title="开发者工具（数据自检 / 探针）"
        aria-label="开发者工具"
      >
        {/* 图标沿用项目里的内联 SVG 方案（stroke=currentColor，暗黑模式零成本） */}
        <svg
          width="12"
          height="12"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          focusable="false"
        >
          <path d="M5.8 4 2.6 8l3.2 4M10.2 4l3.2 4-3.2 4" />
        </svg>
        开发者
        <span className={`app-dev-chev ${open ? 'on' : ''}`} aria-hidden="true">
          ▾
        </span>
      </button>

      <div className="app-dev-menu" role="menu" hidden={!open}>
        {DEV_PAGES.map((p) => (
          <button
            key={p.id}
            type="button"
            role="menuitemradio"
            aria-checked={tab === p.id}
            className={tab === p.id ? 'on' : ''}
            onClick={() => onPick(p.id)}
          >
            {p.label}
          </button>
        ))}
      </div>
    </div>
  )
}

/**
 * 主题切换（UI 重设计 2026-09-21）。
 *
 * 外观从"一个写着 `自动/浅色/深色` 的文字按钮"换成设计稿的**图标按钮**（半圆日月）。
 *
 * ⚠️ **三态循环照旧保留**（自动 → 浅色 → 深色），只是不再用文字表达当前值：
 *    `auto` 不是可有可无的一档 —— 它跟随**飞书自己的主题**
 *    （见上面 readFeishuTheme / onFeishuThemeChange），是 PRD F7-06 的"跟随宿主"。
 *    设计稿只画了两态，把它删掉属于**功能损失**，所以这里只换外观。
 * ⚠️ 当前值仍要**看得见**：图标本身按状态变化（空圈 / 半圆 / 实心），
 *    完整说明挂在 `title` 上（悬停可见），`aria-label` 里也带上 ——
 *    只靠图形表意是"用颜色/形状单独表意"，本项目一贯不接受。
 */
function ThemeSwitch({ value, onChange }: { value: ThemeMode; onChange: (v: ThemeMode) => void }) {
  const order: ThemeMode[] = ['auto', 'light', 'dark']
  const label: Record<ThemeMode, string> = { auto: '自动（跟随飞书）', light: '浅色', dark: '深色' }
  return (
    <button
      className="app-theme"
      onClick={() => onChange(order[(order.indexOf(value) + 1) % order.length])}
      title={`主题：${label[value]}（点击切换）`}
      aria-label={`当前主题 ${label[value]}，点击切换`}
    >
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        aria-hidden="true"
        focusable="false"
      >
        <circle cx="12" cy="12" r="9" />
        {/* 自动 = 半圆（跟随宿主）；深色 = 整圆填满；浅色 = 只有外圈 */}
        {value === 'dark' && <circle cx="12" cy="12" r="9" fill="currentColor" stroke="none" />}
        {value === 'auto' && <path d="M12 3a9 9 0 0 1 0 18z" fill="currentColor" stroke="none" />}
      </svg>
    </button>
  )
}
