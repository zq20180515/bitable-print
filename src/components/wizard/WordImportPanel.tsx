import { useMemo, useRef, useState } from 'react'
import type { FieldMeta } from '../../lib/data-source'
import type { TemplateDoc, TemplateKind } from '../../lib/types'
import { parseDocx, rebuildWithMatches, formatReportText, ignorePlaceholder, unignorePlaceholder } from '../../import'
import type { IRDoc, MatchResult } from '../../import'

/**
 * Word(.docx) 模板导入向导（PRD P4 / F3）。
 *
 * 三步走：上传 → 解析（含阶段进度）→ 字段匹配确认 → 生成模板。
 * 兼容性报告（哪些元素被忽略/降级）在最后一步统一展示，不阻断流程（F3-29）。
 *
 * 匹配页对每个占位符给三个动作（F3-18）：
 *   ① 绑定到某个字段
 *   ② 保持未绑定（渲染为空，模板检查会报警）
 *   ③ 忽略该占位符（转为纯文本）—— 走 import 模块的 ignorePlaceholder
 *
 * ⚠️ 一个必须守住的约定：**任何改绑动作都要清掉 `ignored` 标记**。
 * import 模块用 `ignoredPlaceholderNames(match)` 决定哪些占位符输出原文；
 * 如果用户先前点过"忽略"、之后又手动选了一个字段，但 `ignored` 还留着 true，
 * 这个改绑决定就会被静默回滚（用户看到的是"我明明选了字段，结果变成了纯文本"）。
 * 所以改绑统一走 applyRebind()，它会把 ignored 归位。
 */

interface Props {
  fields: FieldMeta[]
  kind: TemplateKind
  onDone(template: TemplateDoc, name: string): void | Promise<void>
  onCancel(): void
}

type Stage = { label: string; progress: number }

export function WordImportPanel({ fields, kind, onDone, onCancel }: Props) {
  const inputRef = useRef<HTMLInputElement | null>(null)
  const [stage, setStage] = useState<Stage | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [ir, setIr] = useState<IRDoc | null>(null)
  const [match, setMatch] = useState<MatchResult[]>([])
  const [reportText, setReportText] = useState('')
  const [reportCounts, setReportCounts] = useState<{ ignored: number; degraded: number }>({ ignored: 0, degraded: 0 })
  const [fileName, setFileName] = useState('')
  /**
   * 兼容占位符写法（PRD **F3-15**，2026-10-02 接线）。
   *
   * ⚠️ 这个开关此前**只存在于代码里、没有任何入口**：`placeholders.ts` 里
   * `mustache` / `bracket` 默认 `false`，而 `WordImportPanel` 调 `parseDocx` 时
   * **从不传 `placeholder`** ⇒ 用 `{{字段}}` 或 `[字段]` 写的 Word 模板导入后
   * **一个占位符都识别不出来**，且界面上连一句"支持哪些写法"的提示都没有。
   */
  const [compatSyntax, setCompatSyntax] = useState(false)
  /**
   * 自定义循环标签（PRD **E-2**，2026-10-02 接线）。
   *
   * ⚠️ 为什么需要它：官方的循环标签语法**至今没拿到真实样例** ——
   * `loop.ts` 里那套 `TAG_PATTERNS`（`{{循环开始}}`、`{{#each}}`、`[[循环开始]]`、
   * `【循环开始】`、`«循环开始»`）**全是按经验猜的**（代码注释自己承认）。
   * 而在此之前，**用户没有任何办法告诉插件"我们的标签长这样"** ——
   * 猜不中就只能眼睁睁看着循环区识别失败。
   *
   * ⚠️ 用户填的是**标签原文**（如 `{{开始循环}}`），不是正则 ——
   * `loop.ts:107` 会 `escapeRe` 之后当字面量匹配。**别把这个细节漏给用户看**。
   */
  const [tagStart, setTagStart] = useState('')
  const [tagEnd, setTagEnd] = useState('')
  /** 记住用户选的文件：改了上面的开关要能**就地重解析**，不用让他重新选一遍文件 */
  const [pickedFile, setPickedFile] = useState<File | null>(null)
  const [name, setName] = useState('')
  const [showReport, setShowReport] = useState(false)
  const [copied, setCopied] = useState(false)

  const summary = useMemo(() => {
    const matched = match.filter((m) => m.status === 'matched' && !m.ignored).length
    const pending = match.filter((m) => m.status === 'pending' && !m.ignored).length
    const unbound = match.filter((m) => m.status === 'unbound' && !m.ignored).length
    const ignored = match.filter((m) => m.ignored).length
    return { matched, pending, unbound, ignored, total: match.length }
  }, [match])

  const handleFile = async (file: File): Promise<void> => {
    setPickedFile(file)
    await runParse(file, { compat: compatSyntax, tagStart, tagEnd })
  }

  /**
   * 真正解析。**单独抽出来**是为了让"改了设置后重解析"能复用同一条链 ——
   * 否则那段逻辑要么复制一份，要么用户得重新选文件（后者是明显的体验倒退）。
   * ⚠️ 配置**显式传参**而不是从闭包读 state：改完设置立刻重解析时，
   *    闭包里的 state 可能还是旧值（React 状态更新是异步的）。
   */
  const runParse = async (
    file: File,
    cfg: { compat: boolean; tagStart: string; tagEnd: string },
  ): Promise<void> => {
    setError(null)
    setStage({ label: '准备中', progress: 0.05 })
    try {
      /*
       * ⚠️ **E-2**：把用户填的自定义标签传下去。空串不传 ——
       * `loop.ts` 会把每一条 `extraStartTags` 都编译成正则去扫全文，
       * 塞空串进去等于加了一条"匹配空字符串"的规则（命中一切）。
       */
      const start = cfg.tagStart.trim()
      const end = cfg.tagEnd.trim()
      const res = await parseDocx(file, {
        fields,
        /*
         * ⚠️ F3-15：把开关真的传下去。
         * `dollar` / `guillemet` 保持默认开启（它们是 PRD 的主推写法）；
         * 这里只管那两个**兼容格式** —— 开了才认 `{{字段}}` / `[字段]`。
         */
        placeholder: { mustache: cfg.compat, bracket: cfg.compat },
        ...(start || end
          ? {
              loopTags: {
                ...(start ? { extraStartTags: [start] } : {}),
                ...(end ? { extraEndTags: [end] } : {}),
              },
            }
          : {}),
        onStage: (s) => setStage({ label: s.label, progress: s.progress }),
      })
      setIr(res.ir)
      setMatch(res.match)
      setReportCounts({ ignored: res.report.ignored.length, degraded: res.report.degraded.length })
      try {
        setReportText(formatReportText(res.report))
      } catch {
        setReportText(res.report.summary || '（报告生成失败，请查看下方明细）')
      }
      setFileName(file.name)
      setName(file.name.replace(/\.docx?$/i, '') || 'Word 模板')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setStage(null)
    }
  }

  const rebind = (placeholder: string, fieldId: string): void => {
    setMatch((prev) => applyRebind(prev, placeholder, fieldId, fields))
  }

  const generate = async (): Promise<void> => {
    if (!ir) return
    setStage({ label: '生成模板', progress: 0.9 })
    try {
      const template = rebuildWithMatches(ir, match, fields)
      await onDone(template, name.trim() || 'Word 模板')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setStage(null)
    }
  }

  // ---------- 上传 ----------
  if (!ir) {
    return (
      <div className="wiz-block">
        <section className="app-section">
          <div className="app-section-head">
            <h3 className="app-section-title">从 Word 导入模板</h3>
            <button className="app-btn sm" onClick={onCancel}>
              返回
            </button>
          </div>
          <div className="app-section-body">
            {/*
              ⚠️ **F3-15 的入口**（2026-10-02 接线）。
              放在拖放区**上方**：用户应该"先想清楚自己的模板用哪种写法，再选文件"。
              若已有解析结果，改开关会**就地重解析**（不必重新选文件）。
            */}
            <label className="wiz-compat">
              <input
                type="checkbox"
                checked={compatSyntax}
                onChange={(e) => {
                  const next = e.target.checked
                  setCompatSyntax(next)
                  if (pickedFile) void runParse(pickedFile, { compat: next, tagStart, tagEnd })
                }}
              />
              <span>
                兼容 <code>{'{{字段}}'}</code> 与 <code>[字段]</code> 写法
              </span>
            </label>
            <p className="wiz-hint wiz-compat-note">
              默认只识别 <code>{'${字段}'}</code> 与 <code>«字段»</code>；
              如果模板里是双大括号或方括号形式，勾上这一项。
              <strong>方括号在正文里很常见，开启后可能误判</strong>，导入后建议先看预览再保存。
            </p>
            {/*
              ⚠️ **E-2 的入口**：自定义循环标签。
              与上面的 F3-15 同属"导入前的设置"，所以放在一起。
              用 `<details>` 折叠：**多数用户不需要它**（内置那套已覆盖常见写法），
              展开着会喧宾夺主；而真正需要的人（自家模板用了私有标签）会主动去找。
              ⚠️ 触发时机用 **`onBlur`** 而不是 `onChange`：后者会在每敲一个字时重解析整个 docx。
              ⚠️ 回填值取自 `e.target.value` 而不是 state —— React 状态更新是异步的，
                  在 `onBlur` 里读 state 可能还是上一次的值。
            */}
            <details className="wiz-custom-tags">
              <summary>循环区识别不准？手动指定标签</summary>
              <div className="wiz-custom-tags-body">
                <label className="wiz-custom-tags-row">
                  <span>循环开始标签</span>
                  <input
                    type="text"
                    value={tagStart}
                    placeholder="例如 {{开始循环}}"
                    onChange={(e) => setTagStart(e.target.value)}
                    onBlur={(e) => {
                      const v = e.target.value
                      setTagStart(v)
                      if (pickedFile) void runParse(pickedFile, { compat: compatSyntax, tagStart: v, tagEnd })
                    }}
                  />
                </label>
                <label className="wiz-custom-tags-row">
                  <span>循环结束标签</span>
                  <input
                    type="text"
                    value={tagEnd}
                    placeholder="例如 {{结束循环}}"
                    onChange={(e) => setTagEnd(e.target.value)}
                    onBlur={(e) => {
                      const v = e.target.value
                      setTagEnd(v)
                      if (pickedFile) void runParse(pickedFile, { compat: compatSyntax, tagStart, tagEnd: v })
                    }}
                  />
                </label>
                <p className="wiz-hint">
                  按<strong>原文</strong>填（不用写正则），插件会把它当成一对标记圈出重复区域。
                  留空则只用内置的常见标签。
                </p>
              </div>
            </details>
            <div
              className="wiz-drop"
              onClick={() => inputRef.current?.click()}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault()
                const f = e.dataTransfer.files?.[0]
                if (f) void handleFile(f)
              }}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') inputRef.current?.click()
              }}
            >
              <p className="wiz-drop-title">拖入或点击选择 .docx 文件</p>
              <p className="wiz-hint">支持 .docx / .docm，单个文件不超过 20MB</p>
            </div>
            <ul className="wiz-block-list">
              <li>会还原：纸张尺寸、页边距、段落样式、表格结构与边框、嵌入式图片、文本框（尽力）</li>
              <li>会被忽略：VBA 宏、OLE 对象、图表、SmartArt、水印、脚注</li>
              <li>.doc / .rtf / .pdf 不支持，请先在 Word 里另存为 .docx</li>
            </ul>
            {stage && <ProgressBar label={stage.label} value={stage.progress} />}
            {error && <p className="wiz-note danger">{error}</p>}
          </div>
        </section>
        <input
          ref={inputRef}
          type="file"
          accept=".docx,.docm,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0]
            if (f) void handleFile(f)
            e.target.value = ''
          }}
        />
      </div>
    )
  }

  // ---------- 匹配确认 ----------
  return (
    <div className="wiz-block">
      <section className="app-section">
        <div className="app-section-head">
          <h3 className="app-section-title">字段匹配 · {fileName}</h3>
        </div>
        <div className="app-section-body">
          <p className="wiz-hint">
            识别到 {summary.total} 个占位符：
            <span className="wiz-tag ok">{summary.matched} 已匹配</span>
            <span className="wiz-tag warn">{summary.pending} 待确认</span>
            <span className="wiz-tag bad">{summary.unbound} 未绑定</span>
            {summary.ignored > 0 && <span className="wiz-tag">{summary.ignored} 已忽略</span>}
          </p>

          {summary.total === 0 && (
            <p className="wiz-note">
              文档里没有识别到 {'${字段名}'} 形式的占位符。你仍然可以导入，然后在编辑器里手动插入字段变量。
            </p>
          )}

          <div className="wiz-match-list">
            {match.map((m) => (
              <div key={m.placeholder} className={`wiz-match ${m.ignored ? 'ignored' : m.status}`}>
                <div className="wiz-match-head">
                  <span className={`wiz-match-ph ${m.ignored ? 'ignored' : m.status}`}>{m.placeholder}</span>
                  {m.duplicated && <span className="wiz-tag warn">同名字段</span>}
                  {m.ignored && <span className="wiz-tag">已忽略 · 作为纯文本</span>}
                </div>
                <select
                  className="wiz-input"
                  value={m.ignored ? '__ignore__' : (m.fieldId ?? '')}
                  onChange={(e) => {
                    if (e.target.value === '__ignore__') {
                      setMatch((prev) => ignorePlaceholder(prev, m.placeholder))
                    } else {
                      // 从"忽略"切回来要先解除忽略标记，否则改了绑定也不会生效
                      setMatch((prev) =>
                        applyRebind(unignorePlaceholder(prev, m.placeholder), m.placeholder, e.target.value, fields),
                      )
                    }
                  }}
                >
                  <option value="">（未绑定 · 渲染为空）</option>
                  <option value="__ignore__">忽略该占位符（转为纯文本）</option>
                  {/* 优先列出插件建议的候选，其余全部字段兜底 */}
                  {(m.candidates.length > 0 ? m.candidates : fields.map((f) => ({ fieldId: f.id, fieldName: f.name }))).map(
                    (c) => (
                      <option key={c.fieldId} value={c.fieldId}>
                        {c.fieldName}
                      </option>
                    ),
                  )}
                </select>
                {m.note && <p className="wiz-hint">{m.note}</p>}
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="app-section">
        <div className="app-section-head">
          <h3 className="app-section-title">
            兼容性报告 · 忽略 {reportCounts.ignored} / 降级 {reportCounts.degraded}
          </h3>
          <div className="wiz-inline-btns">
            <button
              className="app-btn sm"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(reportText)
                  setCopied(true)
                  setTimeout(() => setCopied(false), 2000)
                } catch {
                  setCopied(false)
                }
              }}
            >
              {copied ? '已复制 ✓' : '复制报告'}
            </button>
            <button className="app-btn sm" onClick={() => setShowReport((v) => !v)}>
              {showReport ? '收起' : '展开'}
            </button>
          </div>
        </div>
        {showReport && (
          <div className="app-section-body">
            <pre className="wiz-pre">{reportText || '（无内容）'}</pre>
          </div>
        )}
      </section>

      <section>
        <span className="wiz-label">模板名称</span>
        <input className="wiz-input" value={name} onChange={(e) => setName(e.target.value)} placeholder="模板名称" />
        <p className="wiz-hint">
          类型：{kind === 'record' ? '记录模板' : '视图模板'}（想换类型请返回上一步切换后再导入）
        </p>
      </section>

      {stage && <ProgressBar label={stage.label} value={stage.progress} />}
      {error && <p className="wiz-note danger">{error}</p>}

      {/*
        ⚠️ 底栏换成 `.wiz-foot`（UI 重设计 2026-09-21）。
        原来是 `.wiz-inline-btns`（两个按钮并排、跟着正文滚到底）——
        而这个面板的正文（字段匹配列表）可以很长，主按钮"生成模板并编辑"就被推到很下面。
        用户这次点名要求：**所有底部按钮都要钉在面板底部**（骨架面板那边已经改过）。
        ⇒ 与骨架面板同一套结构：左「取消」次要（88px）+ 右主按钮（flex:1）。

        ⚠️ 标题行那个「取消」**已删除**：底部已经有了，同一个动作留两个入口只会让人怀疑
           "这两个取消是不是不一样"。与骨架面板的处理一致（那边撤的是标题行的「返回」）。
      */}
      <div className="wiz-foot">
        <button type="button" className="app-btn" onClick={onCancel}>
          取消
        </button>
        <button type="button" className="app-btn primary" onClick={() => void generate()}>
          生成模板并编辑
        </button>
      </div>
    </div>
  )
}

function ProgressBar({ label, value }: { label: string; value: number }) {
  const pct = Math.round(Math.max(0, Math.min(1, value)) * 100)
  return (
    <div className="wiz-progress">
      <span className="wiz-pulse" />
      <span className="wiz-progress-text">
        {label} {pct}%
      </span>
      <div className="wiz-bar">
        <div className="wiz-bar-fill" style={{ width: `${pct}%` }} />
      </div>
    </div>
  )
}

/** 改绑：纯函数，便于在"先解除忽略、再改绑"的链式操作里复用 */
function applyRebind(list: MatchResult[], placeholder: string, fieldId: string, fields: FieldMeta[]): MatchResult[] {
  return list.map((m) => {
    if (m.placeholder !== placeholder) return m
    const f = fields.find((x) => x.id === fieldId)
    return {
      ...m,
      fieldId: fieldId || null,
      fieldName: f?.name ?? null,
      status: fieldId ? ('matched' as const) : ('unbound' as const),
      ignored: false,
    }
  })
}
