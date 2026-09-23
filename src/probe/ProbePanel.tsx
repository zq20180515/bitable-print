import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { PROBES, formatReport, runProbes } from './probes'
import type { ProbeEnv, ProbeResult, ProbeStatus } from './probes'
import { probeSelectionSource } from '../lib/sdk-source'
import type { SelectionDiag } from '../lib/sdk-source'
import './probe.css'

/**
 * M0 能力探针面板。
 *
 * 设计原则：**每条探针都能单独跑、单独重跑**。
 * 一开始只做了"运行全部"，结果用户想复测某一项时只能全量重跑一遍，
 * 既慢又会让已定案的结论被无谓地刷新。现在每条都有独立的运行按钮。
 */

interface Props {
  /** 由 App 提供：已初始化的 SDK 原始对象 */
  getEnv: () => Promise<ProbeEnv | null>
}

const STATUS_LABEL: Record<ProbeStatus, string> = {
  ok: '通过',
  warn: '需注意',
  fail: '不通过',
  skip: '跳过',
}

const STATUS_ICON: Record<ProbeStatus, string> = {
  ok: '✓',
  warn: '!',
  fail: '×',
  skip: '–',
}

/**
 * 常用组合，省得用户每次自己挑。
 *
 * ⚠️ `soloOnly` 的探针（目前只有 P12「会改面板尺寸」）**不进任何组合**：
 * 它改了用户能看到的环境，而 SDK 没有还原接口。只能由用户单独点那一条的运行按钮。
 * （`runProbes` 里还有第二道拦截，见 `ProbeDef.soloOnly` 的注释。）
 */
const QUICK_GROUPS: Array<{ label: string; ids: string[]; hint: string }> = [
  { label: '关键 3 项', ids: ['P2', 'P4', 'P6'], hint: '选中态 / KV / 附件 CORS' },
  { label: '本轮补测 P4 P5 P8', ids: ['P4', 'P5', 'P8'], hint: 'KV 作用域 / 视图直读 / 字段顺序' },
  {
    label: '全部非破坏性',
    ids: PROBES.filter((p) => !p.destructive && !p.soloOnly).map((p) => p.id),
    hint: '不含建表测试，也不含"会改面板尺寸"的 P12',
  },
  {
    label: '全部批量可跑（含建表）',
    ids: PROBES.filter((p) => !p.soloOnly).map((p) => p.id),
    hint: '会临时建表并自动删除；不含"会改面板尺寸"的 P12（它只能单独跑）',
  },
]

export function ProbePanel({ getEnv }: Props) {
  const [running, setRunning] = useState<string | null>(null)
  const [envError, setEnvError] = useState<string | null>(null)
  const [results, setResults] = useState<Map<string, ProbeResult>>(() => new Map())
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [copied, setCopied] = useState(false)
  const [envInfo, setEnvInfo] = useState<Record<string, unknown> | null>(null)

  const orderedResults = useMemo(
    () => PROBES.map((p) => results.get(p.id)).filter(Boolean) as ProbeResult[],
    [results],
  )

  // 「全部」运行时要跳过被排除的探针（上面 quick group 已经决定跑哪些）
  const doRun = useCallback(
    async (ids: string[]) => {
      if (ids.length === 0) return
      setRunning(ids.length === 1 ? ids[0] : 'batch')
      setEnvError(null)
      if (ids.length > 1) setResults(new Map())
      setCopied(false)
      try {
        const env = await getEnv()
        if (!env) {
          setEnvError(
            '拿不到 SDK 环境：插件没有运行在飞书多维表格中，或当前是示例数据模式。请回到飞书里打开本插件再试。',
          )
          return
        }

        // 采集环境信息写进报告头，便于对照
        let tableName = '（未知）'
        try {
          if (env.tableId) {
            const t = await env.base.getTableById(env.tableId)
            tableName = await t.getName()
          }
        } catch {
          /* 忽略 */
        }
        setEnvInfo({
          数据表: tableName,
          tableId: env.tableId ?? '(未取到)',
          viewId: env.viewId ?? '(未取到)',
        })

        await runProbes(env, {
          only: ids,
          includeDestructive: true, // 是否包含破坏性由 quick group 的 ids 决定
          onResult: (r) => {
            setResults((prev) => {
              const next = new Map(prev)
              next.set(r.id, r)
              return next
            })
            setExpanded((prev) => (r.id in prev ? prev : { ...prev, [r.id]: r.status !== 'ok' }))
          },
        })
      } catch (e) {
        setEnvError(e instanceof Error ? e.message : String(e))
      } finally {
        setRunning(null)
      }
    },
    [getEnv],
  )

  const copyReport = useCallback(async () => {
    const md = formatReport(orderedResults, {
      插件版本: typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'dev',
      ...(envInfo ?? {}),
    })
    try {
      await navigator.clipboard.writeText(md)
      setCopied(true)
      setTimeout(() => setCopied(false), 2400)
    } catch {
      // clipboard 在 iframe 里可能被拒，退化为 textarea + execCommand
      const ta = document.createElement('textarea')
      ta.value = md
      ta.style.position = 'fixed'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.select()
      let done = false
      try {
        done = document.execCommand('copy')
      } catch {
        done = false
      }
      document.body.removeChild(ta)
      setCopied(done)
      setTimeout(() => setCopied(false), 2400)
    }
  }, [orderedResults, envInfo])

  const doneCount = orderedResults.length

  return (
    <div className="probe">
      <h2 className="sr-only">M0 能力探针：验证 SDK 的运行时行为</h2>

      <section className="probe-card probe-intro">
        <p className="probe-intro-title">这一步要验什么</p>
        <p className="probe-intro-text">
          需求文档里有几项 SDK 能力，<b>类型定义能看到签名、但运行时行为读不出来</b>（作用域、上限、
          CORS、选中态）。它们直接决定两个架构决策：模板存哪里、手动选中行怎么做。
          <b>每条探针都能单独跑、单独重跑</b> —— 复测某一项不必全量重跑。
        </p>
      </section>

      <div className="probe-groups">
        {QUICK_GROUPS.map((g) => (
          <button
            key={g.label}
            className="probe-btn probe-group-btn"
            onClick={() => void doRun(g.ids)}
            disabled={running !== null}
            title={g.hint}
          >
            {g.label}
            <span className="probe-group-count">{g.ids.length}</span>
          </button>
        ))}
      </div>

      <SelectionLiveCard getEnv={getEnv} />

      {envError && (
        <div className="probe-alert danger">
          <span className="probe-alert-icon">×</span>
          <span>{envError}</span>
        </div>
      )}

      {running && (
        <div className="probe-progress">
          <span className="probe-pulse" />
          <span className="probe-progress-text">
            {running === 'batch' ? `正在运行… 已完成 ${doneCount}` : `正在运行 ${running}`}
          </span>
          <div className="probe-bar">
            <div className="probe-bar-fill" style={{ width: running === 'batch' ? '50%' : '30%' }} />
          </div>
        </div>
      )}

      <div className="probe-results">
        {PROBES.map((def) => {
          const r = results.get(def.id)
          const status = r?.status
          const isOpen = Boolean(expanded[def.id])
          return (
            <article key={def.id} className={`probe-row ${status ? `status-${status}` : 'status-idle'}`}>
              <div className="probe-row-head-wrap">
                <button
                  className="probe-row-head"
                  onClick={() => setExpanded((p) => ({ ...p, [def.id]: !p[def.id] }))}
                  aria-expanded={isOpen}
                >
                  <span className={`probe-badge ${status ? `status-${status}` : 'status-idle'}`} aria-hidden>
                    {status ? STATUS_ICON[status] : '·'}
                  </span>
                  <span className="probe-row-titles">
                    <span className="probe-row-id">
                      {def.id}
                      {/* 短标签由探针自己声明（以前这里硬编成"会建表"，P12 一加就成了假话） */}
                      {def.caution ? ` · ${def.caution}` : ''}
                    </span>
                    <span className="probe-row-title">{def.title}</span>
                  </span>
                  <span className="probe-row-state">{status ? STATUS_LABEL[status] : '未运行'}</span>
                  <span className={`probe-chevron ${isOpen ? 'open' : ''}`} aria-hidden />
                </button>
                <button
                  className="app-btn sm probe-run-one"
                  onClick={() => void doRun([def.id])}
                  disabled={running !== null}
                  title={`单独运行 ${def.id}`}
                >
                  {running === def.id ? '…' : r ? '重跑' : '运行'}
                </button>
              </div>

              {/*
                ⚠️ 提醒必须**常驻**、在点运行**之前**就看得见 —— 所以它不放在展开区里。
                「跑完才知道会改我的面板尺寸」等于没告知：用户那时候已经改完了，
                而且 SDK 没有还原接口，我们只能提前说。
              */}
              {def.notice && (
                <p className={`probe-notice${def.soloOnly ? ' probe-notice-solo' : ''}`}>
                  <span className="probe-notice-label">{def.soloOnly ? '运行前必读' : '提醒'}</span>
                  {def.notice}
                </p>
              )}

              {r && <p className="probe-row-detail">{r.detail}</p>}

              {isOpen && (
                <div className="probe-row-body">
                  <p className="probe-note">
                    <span className="probe-note-label">为什么重要</span>
                    {def.why}
                  </p>
                  <p className="probe-note">
                    <span className="probe-note-label">对需求的影响</span>
                    {def.impact}
                  </p>
                  {r?.data !== undefined && (
                    <>
                      <p className="probe-note-label">原始数据</p>
                      <pre className="probe-pre">{safeStringify(r.data)}</pre>
                    </>
                  )}
                </div>
              )}
            </article>
          )
        })}
      </div>

      {doneCount > 0 && (
        <div className="probe-footer">
          <button className="probe-btn primary" onClick={() => void copyReport()}>
            {copied ? '已复制 ✓' : `复制探针报告（${doneCount} 项）`}
          </button>
          <p className="probe-hint">复制后直接粘贴回对话即可，我会根据结论决定要不要调整架构。</p>
        </div>
      )}
    </div>
  )
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2) ?? String(v)
  } catch {
    return `(无法序列化：${typeof v})`
  }
}

/**
 * 选中态实时监听卡片。
 *
 * 为什么单独做一块：P2/P3 是"一次性快照"，在固定时间窗里等用户去点表格是等不到的
 * —— 上一版探针因此报出 `recordId: null` 和 `fired: 0`，很容易被误读成"SDK 不支持"。
 * 真要把这件事测出定论，必须是"用户点行 → 实时看到计数和载荷"。
 */
function SelectionLiveCard({ getEnv }: { getEnv: () => Promise<ProbeEnv | null> }) {
  const [listening, setListening] = useState(false)
  const [count, setCount] = useState(0)
  const [lastPayload, setLastPayload] = useState<unknown>(null)
  const [snapshot, setSnapshot] = useState<unknown>(null)
  /** 向导实际会走哪条路拿到"当前停留记录"（事件缓存 / getSelection / 都没有） */
  const [diag, setDiag] = useState<SelectionDiag | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const offRef = useRef<null | (() => void)>(null)

  // 组件卸载时一定要退订，否则会往已卸载的组件里 setState
  useEffect(() => {
    return () => {
      try {
        offRef.current?.()
      } catch {
        /* 忽略 */
      }
    }
  }, [])

  const start = async (): Promise<void> => {
    setNote(null)
    const env = await getEnv()
    if (!env) {
      setNote('拿不到 SDK 环境（当前可能是示例数据模式），请回到飞书里打开本插件。')
      return
    }
    if (typeof env.base?.onSelectionChange !== 'function') {
      setNote('当前 SDK 没有 onSelectionChange，无法监听。')
      return
    }
    try {
      const off = env.base.onSelectionChange((e: any) => {
        setCount((c) => c + 1)
        setLastPayload(e ?? null)
      })
      offRef.current = typeof off === 'function' ? off : null
      setListening(true)
      setCount(0)
      setLastPayload(null)
      setNote(
        '已开始监听。去左侧表格依次试这四种操作：① 点单元格　② 点单元格里的文字　③ 切换数据表　④ 勾选整行的复选框——看哪一种会让计数增长（④ 据实测是不会增长的）。',
      )
    } catch (e) {
      setNote(`注册失败：${e instanceof Error ? e.message : String(e)}`)
    }
  }

  const stop = (): void => {
    try {
      offRef.current?.()
    } catch {
      /* 忽略 */
    }
    offRef.current = null
    setListening(false)
    setNote('已停止监听。')
  }

  const readOnce = async (): Promise<void> => {
    const env = await getEnv()
    if (!env) {
      setNote('拿不到 SDK 环境。')
      return
    }
    // 先问"产品实际走哪条路"（这一步不会抛错），它才是插件里真正生效的来源
    const d = await probeSelectionSource()
    setDiag(d)
    try {
      const sel = await env.base.getSelection()
      setSnapshot(sel ?? null)
      const gotId = d.recordId ?? (sel?.recordId as string | undefined) ?? null
      setNote(
        gotId
          ? '✅ 读到了 recordId（来源见下）—— 注意它代表"光标当前所在的那一行"，**不代表你勾选了哪几行**（勾选整行不会产生选中态）。'
          : 'recordId 仍为 null。请先在左侧表格里点一个单元格（不是勾选整行的复选框 —— 那样不会产生选中态），再点「读取当前选中态」。',
      )
    } catch (e) {
      setSnapshot(null)
      setNote(`读取失败：${e instanceof Error ? e.message : String(e)}`)
    }
  }

  return (
    <section className="probe-card probe-live">
      <p className="probe-intro-title">选中态实时监听（P2 的决定性测法）</p>
      <p className="probe-intro-text">
        读一次快照证明不了什么 —— 要判断<b>能不能跟随左表勾选</b>，必须看到"点行 → 事件到达"。
        点「开始监听」，然后去左侧表格点选几行。
      </p>

      <div className="probe-live-row">
        <span className={`probe-live-count ${count > 0 ? 'ok' : ''}`}>{count}</span>
        <span className="probe-live-label">次选中变化事件</span>
      </div>

      <div className="probe-actions">
        {!listening ? (
          <button className="probe-btn primary" onClick={() => void start()}>
            开始监听
          </button>
        ) : (
          <button className="probe-btn" onClick={stop}>
            停止监听
          </button>
        )}
        <button className="probe-btn" onClick={() => void readOnce()}>
          读取当前选中态
        </button>
      </div>

      {note && <p className="probe-note">{note}</p>}

      {diag && (
        <p className="probe-note">
          <span className="probe-note-label">来源</span>
          {diag.source === 'event' ? (
            <>
              最近一次选中事件（{diag.recordId}）—— 这条路径已被实测证实，向导优先用它。
            </>
          ) : diag.source === 'getSelection' ? (
            <>
              getSelection（{diag.recordId}）—— <b>说明 getSelection 也能读到 recordId</b>，
              事件缓存为空时由它兜底。
            </>
          ) : (
            <>都没取到 —— 请先在左侧点一个单元格再重读（只勾选整行的复选框不会产生选中态）。</>
          )}
        </p>
      )}

      {count > 0 && (
        <p className="probe-note">
          <span className="probe-note-label">结论</span>
          已收到 <b>{count}</b> 次事件。注意：<b>勾选整行的复选框不会触发事件</b>（已实测），
          所以「跟随左表多选」做不到；但事件载荷里有 recordId → 可以读取「当前光标所在记录」。
          <br />
          （自检：若只有第 ④ 种操作不动、其余三种都会让计数增长，就与本轮实测结论一致。）
        </p>
      )}

      {snapshot !== null && (
        <>
          <p className="probe-note-label">getSelection() 快照</p>
          <pre className="probe-pre">{safeStringify(snapshot)}</pre>
        </>
      )}

      {lastPayload !== null && (
        <>
          <p className="probe-note-label">最后一次事件载荷</p>
          <pre className="probe-pre">{safeStringify(lastPayload)}</pre>
        </>
      )}
    </section>
  )
}
