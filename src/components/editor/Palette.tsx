/**
 * 左抽屉：字段面板 / 元素面板。
 *
 * 两个面板共用一套"拖拽胶囊"交互：
 * pointerdown 只负责把载荷交给 EditorShell（它统一管理 ghost 浮层与落点），
 * 是否算"点击插入"由 EditorShell 在 pointerup 时按位移判断 —— 这样用户
 * 既可以直接点，也可以按住拖到画布某个精确位置，不需要学两套操作。
 *
 * 字段胶囊的色块取自 fieldMeta(type).tint（PRD 附录 A 的类型编码色），
 * 它属于"内容数据"而非 UI 主题色，因此允许写死十六进制。
 */

import { memo, useMemo, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import type { FieldMeta } from '../../lib/data-source'
import { fieldMeta } from '../../lib/field-types'
import type { SysVarKey } from '../../lib/types'
import type { NewElementSpec } from './useEditorState'
import { SYSVAR_KEYS, SYSVAR_LABEL } from './useEditorState'
import {
  IconBarcode,
  IconCaret,
  IconHLine,
  IconImage,
  IconPageBreak,
  IconPaperclip,
  IconQrCode,
  IconSearch,
  IconSysVar,
  IconTable,
  IconText,
} from './Icons'

/** 面板可以发起的"插入"语义 */
export type PaletteInsert =
  | { type: 'element'; spec: NewElementSpec }
  | { type: 'sysvar'; key: SysVarKey }

export interface PaletteDrag {
  insert: PaletteInsert
  /** ghost 浮层上显示的文字 */
  label: string
  /** ghost 上的色块（可选） */
  tint?: string
}

export type PaletteTab = 'fields' | 'elements'

export interface PaletteProps {
  tab: PaletteTab
  fields: FieldMeta[]
  onDragStart(payload: PaletteDrag, e: ReactPointerEvent): void
  /** 不可打印字段等需要提示的场景 */
  onNotice(message: string): void
}

/** 字段数超过这个量就默认折叠分组（PRD F1-03） */
const FOLD_THRESHOLD = 30

interface ElementDef {
  key: string
  label: string
  hint: string
  icon: typeof IconText
  spec: NewElementSpec
}

const ELEMENT_DEFS: ElementDef[] = [
  { key: 'text', label: '文本段落', hint: '可混排文字与字段占位符，双击即可编辑', icon: IconText, spec: { kind: 'text' } },
  { key: 'table', label: '表格', hint: '3 行 4 列 + 表头；拖到画布上即可增删行列、合并单元格', icon: IconTable, spec: { kind: 'table' } },
  { key: 'image', label: '固定图片', hint: '本地图片内嵌进模板，单张上限 300KB', icon: IconImage, spec: { kind: 'image', dataUrl: '', widthMm: 60, heightMm: 40 } },
  { key: 'hline', label: '水平线', hint: '分隔线，可配线宽、线色与左右缩进', icon: IconHLine, spec: { kind: 'hline' } },
  { key: 'pagebreak', label: '分页符', hint: '在此处强制另起一页', icon: IconPageBreak, spec: { kind: 'pagebreak' } },
  { key: 'fieldBlock', label: '字段块', hint: '整块就是一个字段值，适合大号标题', icon: IconPaperclip, spec: { kind: 'fieldBlock', fieldId: null, fieldName: '' } },
]

/**
 * 码 / 标识单独一组。
 * 它俩的配置方式（选字段 or 手填、纠错等级、前景背景）和其他元素完全不同，
 * 混在"基础元素"里会让这一组同时承担两种心智模型。
 */
const CODE_DEFS: ElementDef[] = [
  {
    key: 'qrcode',
    label: '二维码',
    hint: '取值可选多维表格字段或手填固定内容，支持纠错等级与配色',
    icon: IconQrCode,
    spec: { kind: 'qrcode' },
  },
  {
    key: 'barcode',
    label: '条形码',
    hint: 'Code 128 条形码，支持数字 / 字母 / 常用符号',
    icon: IconBarcode,
    spec: { kind: 'barcode' },
  },
]

function PaletteImpl({ tab, fields, onDragStart, onNotice }: PaletteProps) {
  const [keyword, setKeyword] = useState('')
  const foldByDefault = fields.length > FOLD_THRESHOLD
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})

  const groups = useMemo(() => {
    const kw = keyword.trim().toLowerCase()
    const map = new Map<string, FieldMeta[]>()
    for (const f of fields) {
      if (kw && !f.name.toLowerCase().includes(kw)) continue
      const label = fieldMeta(f.type).label
      const arr = map.get(label)
      if (arr) arr.push(f)
      else map.set(label, [f])
    }
    return [...map.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
  }, [fields, keyword])

  const isCollapsed = (label: string): boolean => {
    const v = collapsed[label]
    if (typeof v === 'boolean') return v
    // 搜索时强制展开：用户既然搜了，就是想看到具体字段
    return foldByDefault && !keyword.trim()
  }

  if (tab === 'fields') {
    return (
      <div className="bp-panel">
        <div className="bp-search">
          <IconSearch size={14} className="bp-search__icon" />
          <input
            className="bp-search__input"
            value={keyword}
            placeholder="搜索字段"
            aria-label="搜索字段"
            onChange={(e) => setKeyword(e.target.value)}
          />
        </div>

        {fields.length === 0 ? (
          <p className="bp-panel__empty">当前表没有可用字段</p>
        ) : groups.length === 0 ? (
          <p className="bp-panel__empty">没有匹配「{keyword}」的字段</p>
        ) : (
          <div className="bp-panel__scroll">
            {groups.map(([label, list]) => {
              const open = !isCollapsed(label)
              return (
                <section className="bp-group" key={label}>
                  <button
                    type="button"
                    className="bp-group__head"
                    aria-expanded={open}
                    onClick={() => setCollapsed((c) => ({ ...c, [label]: open }))}
                  >
                    <span className={`bp-group__caret${open ? ' is-open' : ''}`}>
                      <IconCaret size={12} />
                    </span>
                    <span className="bp-group__name">{label}</span>
                    <span className="bp-group__count">{list.length}</span>
                  </button>
                  {open ? (
                    <div className="bp-group__body">
                      {list.map((f) => {
                        const meta = fieldMeta(f.type)
                        const blocked = meta.capability === 'none'
                        return (
                          <button
                            key={f.id}
                            type="button"
                            className={`bp-chip-item${blocked ? ' is-blocked' : ''}`}
                            aria-disabled={blocked}
                            title={meta.note ? `${meta.label}：${meta.note}` : meta.label}
                            onPointerDown={(e) => {
                              if (blocked) {
                                onNotice(`「${f.name}」是${meta.label}字段，不可打印，无法放入模板`)
                                return
                              }
                              onDragStart(
                                {
                                  insert: { type: 'element', spec: { kind: 'fieldBlock', fieldId: f.id, fieldName: f.name, fieldType: f.type } },
                                  label: f.name,
                                  tint: meta.tint,
                                },
                                e,
                              )
                            }}
                            onClick={() => {
                              if (blocked) onNotice(`「${f.name}」是${meta.label}字段，不可打印`)
                            }}
                          >
                            <span className="bp-chip-item__dot" style={{ background: meta.tint }} aria-hidden />
                            <span className="bp-chip-item__name">{f.name}</span>
                            {f.isPrimary ? <span className="bp-chip-item__flag">主字段</span> : null}
                            {blocked ? <span className="bp-chip-item__flag bp-chip-item__flag--danger">不可打印</span> : null}
                            {!blocked && meta.capability === 'titleOnly' ? (
                              <span className="bp-chip-item__flag bp-chip-item__flag--warn">仅标题</span>
                            ) : null}
                            {!meta.writable && meta.capability !== 'none' ? (
                              <span className="bp-chip-item__flag">只读</span>
                            ) : null}
                          </button>
                        )
                      })}
                    </div>
                  ) : null}
                </section>
              )
            })}
          </div>
        )}
        <p className="bp-panel__foot">按住字段拖到画布上即可插入占位符</p>
      </div>
    )
  }

  /** 元素按钮（基础元素 / 码 两组共用一套外观与拖拽载荷） */
  const defButton = (d: ElementDef): ReactNode => {
    const Icon = d.icon
    return (
      <button
        key={d.key}
        type="button"
        className="bp-el-item"
        title={d.hint}
        onPointerDown={(e) => onDragStart({ insert: { type: 'element', spec: d.spec }, label: d.label }, e)}
      >
        <span className="bp-el-item__icon">
          <Icon size={15} />
        </span>
        <span className="bp-el-item__body">
          <span className="bp-el-item__label">{d.label}</span>
          <span className="bp-el-item__hint">{d.hint}</span>
        </span>
      </button>
    )
  }

  return (
    <div className="bp-panel">
      <div className="bp-panel__scroll">
        <section className="bp-group">
          <div className="bp-group__title">基础元素</div>
          <div className="bp-group__body">{ELEMENT_DEFS.map(defButton)}</div>
        </section>

        <section className="bp-group">
          <div className="bp-group__title">码 / 标识</div>
          <div className="bp-group__body">{CODE_DEFS.map(defButton)}</div>
          <p className="bp-panel__foot">插入后可在右侧属性面板选择取数字段或手填内容</p>
        </section>

        <section className="bp-group">
          <div className="bp-group__title">系统变量</div>
          <div className="bp-group__body bp-group__body--wrap">
            {SYSVAR_KEYS.map((k) => (
              <button
                key={k}
                type="button"
                className="bp-chip-item bp-chip-item--inline"
                onPointerDown={(e) =>
                  onDragStart(
                    { insert: { type: 'sysvar', key: k }, label: SYSVAR_LABEL[k], tint: 'var(--info)' },
                    e,
                  )
                }
              >
                <span className="bp-el-item__icon bp-el-item__icon--sm">
                  <IconSysVar size={12} />
                </span>
                <span className="bp-chip-item__name">{SYSVAR_LABEL[k]}</span>
              </button>
            ))}
          </div>
          <p className="bp-panel__foot">「页码」建议配合表尾区使用，否则只在循环区中生效</p>
        </section>
      </div>
    </div>
  )
}

/**
 * memo 的意义：拖动画布元素时每一帧都会改 doc，若不 memo，
 * 这个几十项的字段列表会被无意义地重渲染，侧边栏里能明显感到掉帧。
 * EditorShell 侧已把 onDragStart / onNotice 固定为稳定引用。
 */
export const Palette = memo(PaletteImpl)
