import { useCallback, useEffect, useMemo, useState } from 'react'
import type { DataSource, FieldMeta, RecordItem, TableContext } from '../lib/data-source'
import { fieldMeta } from '../lib/field-types'
import { renderCellValue } from '../lib/field-types'

/**
 * 数据自检面板。
 *
 * 存在的意义：把"数据层到底通没通"变成一屏可读的事实。
 * 开发期用它验证 SDK 适配层；交付后也可以作为排障入口（用户反馈"字段不全/记录数不对"时先看这里）。
 */

interface Props {
  ds: DataSource
  ctx: TableContext | null
  fields: FieldMeta[]
  records: RecordItem[]
  templateTableId: string | null
}

export function DataSanity({ ds, ctx, fields, records, templateTableId }: Props) {
  const [templateCount, setTemplateCount] = useState<number | null>(null)
  const [templateError, setTemplateError] = useState<string | null>(null)
  const [showAllFields, setShowAllFields] = useState(false)

  /**
   * 「当前停留记录」= `ds.getActiveRecordId()` 的结果。
   * 这是步骤①「自动带入当前记录」的输入源，放在自检面板里可以**肉眼验证它到底读到了什么**
   * —— 读不到（null）是正常状态（没点过单元格、或勾选整行），不是故障，所以不当作错误上报。
   */
  const [activeRecId, setActiveRecId] = useState<string | null>(null)
  const [activeRecRead, setActiveRecRead] = useState(false)
  const readActive = useCallback(async (): Promise<void> => {
    if (typeof ds.getActiveRecordId !== 'function') {
      setActiveRecId(null)
      setActiveRecRead(true)
      return
    }
    try {
      setActiveRecId(await ds.getActiveRecordId())
    } catch {
      setActiveRecId(null)
    } finally {
      setActiveRecRead(true)
    }
  }, [ds])

  useEffect(() => {
    void readActive()
  }, [readActive])

  useEffect(() => {
    if (!templateTableId) return
    let cancelled = false
    void (async () => {
      try {
        const rows = await ds.listTemplateRows(templateTableId)
        if (!cancelled) {
          setTemplateCount(rows.length)
          setTemplateError(null)
        }
      } catch (e) {
        if (!cancelled) setTemplateError(e instanceof Error ? e.message : String(e))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [ds, templateTableId])

  /** 字段预览：拿第一条记录，展示每个字段渲染出来的字符串，直接暴露渲染矩阵的问题 */
  const preview = useMemo(() => {
    const rec = records[0]
    if (!rec) return []
    return fields.map((f) => ({
      ...f,
      rendered: renderCellValue(rec.fields[f.id], f.type),
    }))
  }, [records, fields])

  const visibleFields = showAllFields ? preview : preview.slice(0, 8)

  return (
    <div className="app-pad">
      <section className="app-section">
        <div className="app-section-head">
          <h2 className="app-section-title">数据源</h2>
          <span className={`app-chip ${ds.kind === 'sdk' ? 'ok' : 'warn'}`}>
            {ds.kind === 'sdk' ? '飞书 SDK' : '示例数据'}
          </span>
        </div>
        <div className="app-section-body">
          {ctx ? (
            <dl className="app-kv">
              <dt>数据表</dt>
              <dd>{ctx.tableName || '（未取到）'}</dd>
              <dt>视图</dt>
              <dd>{ctx.viewName || '（未取到）'}</dd>
              <dt>字段数</dt>
              <dd>{fields.length}</dd>
              <dt>记录数</dt>
              <dd>{records.length} 条（上限 600）</dd>
              <dt>模板表</dt>
              <dd>
                {templateTableId ? (
                  templateError ? (
                    <span className="app-chip danger">读取失败</span>
                  ) : (
                    <span className="app-chip ok">已就绪 · {templateCount ?? '…'} 个模板</span>
                  )
                ) : (
                  <span className="app-chip">准备中…</span>
                )}
              </dd>
              <dt>当前表 ID</dt>
              <dd className="app-mono">{ctx.tableId}</dd>
              <dt>当前停留记录</dt>
              <dd>
                <span className="app-mono">
                  {activeRecId ?? (activeRecRead ? '（未读到：未选中单元格）' : '读取中…')}
                </span>
                <button className="app-btn sm" onClick={() => void readActive()} style={{ marginLeft: 'var(--sp-3)' }}>
                  重读
                </button>
              </dd>
            </dl>
          ) : (
            <p className="app-empty">还没有拿到表上下文。</p>
          )}
          {templateError && (
            <p className="app-note danger">模板表读取失败：{templateError}</p>
          )}
        </div>
      </section>

      <section className="app-section">
        <div className="app-section-head">
          <h2 className="app-section-title">
            字段与取值（取第 1 条记录）
            <span className="wiz-count">{preview.length}</span>
          </h2>
          {preview.length > 8 && (
            <button className="app-btn sm" onClick={() => setShowAllFields((v) => !v)}>
              {showAllFields ? '收起' : `全部 ${preview.length} 个`}
            </button>
          )}
        </div>
        <div className="app-section-body">
          {visibleFields.length === 0 ? (
            <p className="app-empty">没有字段或记录。</p>
          ) : (
            <>
              <div className="san-rows">
                {visibleFields.map((f) => {
                  const meta = fieldMeta(f.type)
                  return (
                    <div className="san-row" key={f.id} title={`${f.name} · ${meta.label}（type=${f.type}）`}>
                      <span className="san-tint" style={{ background: meta.tint }} aria-hidden />
                      <span className="san-name">{f.name}</span>
                      <span className="san-type">
                        {meta.label}
                        {f.isPrimary ? ' · 主' : ''}
                        {meta.capability !== 'full' ? ' · 受限' : ''}
                      </span>
                      <span className="san-value" title={f.rendered}>
                        {f.rendered || <span className="app-dim">（空）</span>}
                      </span>
                    </div>
                  )
                })}
              </div>
              {!showAllFields && preview.length > visibleFields.length && (
                <p className="wiz-hint">还有 {preview.length - visibleFields.length} 个字段未列出。</p>
              )}
            </>
          )}
        </div>
      </section>
    </div>
  )
}
