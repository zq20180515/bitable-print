/**
 * 多维表格字段类型注册表。
 *
 * 重要（来自实战教训）：**直接用数字常量，不要依赖 SDK 枚举成员名**——跨版本会变。
 * 数值来源：@lark-base-open/js-sdk 的 FieldType 枚举。
 */

export const FT = {
  Text: 1,
  Number: 2,
  SingleSelect: 3,
  MultiSelect: 4,
  DateTime: 5,
  Checkbox: 7,
  User: 11,
  Phone: 13,
  Url: 15,
  Attachment: 17,
  SingleLink: 18,
  Lookup: 19,
  Formula: 20,
  DuplexLink: 21,
  Location: 22,
  GroupChat: 23,
  CreatedTime: 1001,
  ModifiedTime: 1002,
  CreatedUser: 1003,
  ModifiedUser: 1004,
  AutoNumber: 1005,
  Barcode: 99001,
  Progress: 99002,
  Currency: 99003,
  Rating: 99004,
  Email: 99005,
} as const

export type FieldTypeId = number

/** 打印能力等级 */
export type PrintCapability =
  /** 完整可打印 */
  | 'full'
  /** 只能打印到标题/名称等有限信息 */
  | 'titleOnly'
  /** 完全不可打印 */
  | 'none'

export type RenderKind =
  | 'text'
  | 'number'
  | 'date'
  | 'select'
  | 'person'
  | 'checkbox'
  | 'attachment'
  | 'link'
  | 'progress'
  | 'rating'
  | 'currency'

export interface FieldTypeMeta {
  type: FieldTypeId
  /** 中文名（用于字段面板分组与展示） */
  label: string
  /** 是否可作为筛选条件字段 */
  filterable: boolean
  /** 是否能被写回（本项目只读，但保留信息用于 UI 提示） */
  writable: boolean
  capability: PrintCapability
  renderKind: RenderKind
  /** 胶囊色（十六进制），用于字段面板与映射表 */
  tint: string
  /** 补充说明，会显示在 tooltip 中 */
  note?: string
}

const M = (
  type: FieldTypeId,
  label: string,
  renderKind: RenderKind,
  tint: string,
  opts: Partial<FieldTypeMeta> = {},
): FieldTypeMeta => ({
  type,
  label,
  renderKind,
  tint,
  filterable: opts.filterable ?? true,
  writable: opts.writable ?? true,
  capability: opts.capability ?? 'full',
  note: opts.note,
})

/**
 * 全量字段类型注册表 —— 与 PRD 附录 A《字段类型全量渲染矩阵》一一对应。
 * 新增/修改此处时请同步更新 PRD 附录 A。
 */
export const FIELD_TYPES: Record<number, FieldTypeMeta> = {
  [FT.Text]: M(FT.Text, '文本', 'text', '#8a8f99'),
  [FT.Number]: M(FT.Number, '数字', 'number', '#378add'),
  [FT.SingleSelect]: M(FT.SingleSelect, '单选', 'select', '#7f77dd'),
  [FT.MultiSelect]: M(FT.MultiSelect, '多选', 'select', '#7f77dd'),
  [FT.DateTime]: M(FT.DateTime, '日期', 'date', '#ef9f27'),
  [FT.Checkbox]: M(FT.Checkbox, '复选框', 'checkbox', '#1d9e75', {
    note: '可选渲染为 ☑/☐ 符号或 是/否 文本',
  }),
  [FT.User]: M(FT.User, '人员', 'person', '#1d9e75', { note: '多人以、分隔' }),
  [FT.Phone]: M(FT.Phone, '电话', 'text', '#8a8f99'),
  [FT.Url]: M(FT.Url, '网址', 'link', '#378add', { note: '可配置显示文本或完整链接' }),
  [FT.Attachment]: M(FT.Attachment, '附件', 'attachment', '#0f6e56', {
    note: '图片需实时获取临时链接（10 分钟有效）',
  }),
  [FT.SingleLink]: M(FT.SingleLink, '关联', 'link', '#d4537e', {
    filterable: false,
    capability: 'titleOnly',
    note: '仅能打印关联记录的标题，不展开关联内容',
  }),
  [FT.Lookup]: M(FT.Lookup, '查找引用', 'text', '#8a8f99', { writable: false }),
  [FT.Formula]: M(FT.Formula, '公式', 'text', '#8a8f99', { writable: false }),
  [FT.DuplexLink]: M(FT.DuplexLink, '双向关联', 'link', '#d4537e', {
    filterable: false,
    capability: 'titleOnly',
    note: '仅能打印关联记录的标题',
  }),
  [FT.Location]: M(FT.Location, '位置', 'text', '#639922', { filterable: false }),
  [FT.GroupChat]: M(FT.GroupChat, '群聊', 'text', '#639922', {
    filterable: false,
    capability: 'titleOnly',
    note: '仅能打印群名称',
  }),
  [FT.CreatedTime]: M(FT.CreatedTime, '创建时间', 'date', '#ef9f27'),
  [FT.ModifiedTime]: M(FT.ModifiedTime, '修改时间', 'date', '#ef9f27'),
  [FT.CreatedUser]: M(FT.CreatedUser, '创建人', 'person', '#1d9e75'),
  [FT.ModifiedUser]: M(FT.ModifiedUser, '修改人', 'person', '#1d9e75'),
  [FT.AutoNumber]: M(FT.AutoNumber, '自动编号', 'number', '#ba7517', { filterable: false }),
  [FT.Barcode]: M(FT.Barcode, '条形码', 'text', '#ba7517', {
    filterable: false,
    note: 'v1 仅打印编码文本，不渲染条码图形',
  }),
  [FT.Progress]: M(FT.Progress, '进度', 'progress', '#378add', { writable: false }),
  [FT.Currency]: M(FT.Currency, '货币', 'currency', '#0f6e56'),
  [FT.Rating]: M(FT.Rating, '评分', 'rating', '#ba7517', { writable: false }),
  [FT.Email]: M(FT.Email, '邮箱', 'text', '#8a8f99'),
}

const UNKNOWN: FieldTypeMeta = {
  type: -1,
  label: '未知字段',
  renderKind: 'text',
  tint: '#b4b2a9',
  filterable: false,
  writable: false,
  capability: 'none',
  note: '插件不认识该字段类型，已按文本处理',
}

export function fieldMeta(type: number | undefined): FieldTypeMeta {
  if (typeof type !== 'number') return UNKNOWN
  return FIELD_TYPES[type] ?? { ...UNKNOWN, type }
}
// ============================================================
// 单元格值渲染（只读方向：SDK → 展示字符串）
// ============================================================

/**
 * 单个值 → 可读文本。**绝不 dump JSON、绝不产出 `[object Object]`**。
 *
 * 为什么必须有它：飞书**文本字段的值可能是富文本片段数组**
 * （形如 `[{type:'text',text:'张三'}]`），落到 `String()` 就是 `[object Object]`、
 * 落到 `JSON.stringify()` 就是 `[{"type":"text","text":"张三"}]`。
 * 后者会直接印在纸面上 —— 对用户来说，打印里出现 `{"` 永远是事故。
 *
 * 取不到可读文本时返回**空串**而不是任何形式的原值：空串顶多让用户觉得"这个字段没值"，
 * 而 JSON 会让他以为插件坏了（两者都别扭，但后者更伤）。
 */
function scalarText(v: unknown): string {
  if (v === null || v === undefined) return ''
  if (typeof v === 'string') return v
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : ''
  if (typeof v === 'boolean' || typeof v === 'bigint') return String(v)
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>
    // 常见可读字段，按"人话优先级"取第一个有值的：
    //   text/name/enName/title/label = 可见文本；link/url = 链接；value = 兜底
    for (const k of ['text', 'name', 'enName', 'title', 'label', 'content', 'link', 'url', 'value']) {
      const x = o[k]
      if (typeof x === 'string' && x !== '') return x
      if (typeof x === 'number' && Number.isFinite(x)) return String(x)
    }
    return ''
  }
  return ''
}

/** 富文本片段数组判定：每项都是 `{type, text}` 形状（飞书文本字段的富文本表示） */
function isRichTextSegments(arr: unknown[]): boolean {
  return (
    arr.length > 0 &&
    arr.every(
      (x) =>
        x !== null &&
        typeof x === 'object' &&
        !Array.isArray(x) &&
        typeof (x as Record<string, unknown>).type === 'string' &&
        typeof (x as Record<string, unknown>).text === 'string',
    )
  )
}

/**
 * 任意值 → 可读文本。
 * 数组：富文本片段**直接相接**（"张三" + "@李四" 才是一句人话），
 * 其余数组与 select / person 的既有写法保持一致，用「、」分隔。
 */
function anyText(v: unknown, depth = 0): string {
  if (Array.isArray(v)) {
    if (depth >= 4) return ''
    const parts = v.map((x) => anyText(x, depth + 1)).filter(Boolean)
    return parts.join(isRichTextSegments(v) ? '' : '、')
  }
  return scalarText(v)
}

/**
 * 值**是不是**一个毫秒时间戳；是就返回数值，不是返回 `null`。
 *
 * ⚠️ **数字和数字字符串都要收**（2026-09-24 实测教训）。
 * 第一版只认 `typeof v === 'number'`，结果飞书返回 `"1769126400000"`（字符串）时被漏掉，
 * 用户看到的现象是**"我改了跟没改一模一样"** —— 这类"判据太窄"的 bug 比"没改"更难查，
 * 因为它连日志都不留。
 *
 * 区间取 2000-01-01（946684800000）~ 2100-01-01（4102444800000）且要求整数：
 * 金额 / 数量 / 编号这类业务数字撞不进来，误伤面极小。字符串只收 10~13 位纯数字。
 */
export function asTimestampMs(v: unknown): number | null {
  const n =
    typeof v === 'number' ? v : typeof v === 'string' && /^\d{10,13}$/.test(v.trim()) ? Number(v.trim()) : NaN
  return Number.isInteger(n) && n >= 946_684_800_000 && n <= 4_102_444_800_000 ? n : null
}

/**
 * 复选框 / 布尔值 → 是否勾选。
 *
 * ⚠️ **不能只判 `=== true`**：同一条值经"公式 / 查找引用"转一手之后，飞书可能给
 * `1` / `'true'` / `'是'` 这些形态（与 `asTimestampMs` 是同一类教训 —— 判据太窄就静默失效）。
 * 与其事后猜"它到底给的是哪种"，不如把已知形态一次列全。
 */
export function isCheckedValue(v: unknown): boolean {
  if (v === true || v === 1) return true
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase()
    return s === 'true' || s === '1' || s === '是' || s === 'yes'
  }
  return false
}

/** 把 SDK 返回的单元格原始值转成可直接打印的字符串 */
export function renderCellValue(value: unknown, type: number | undefined, meta?: { dateFormat?: string }): string {
  if (value === null || value === undefined || value === '') return ''
  const m = fieldMeta(type)

  switch (m.renderKind) {
    // 显式分支：文本 / 数字原本走 default，会被 dump 成 JSON。
    // 文本字段是**最常见**的字段类型，它的值又是富文本片段数组的高发区，所以必须显式处理。
    case 'text':
      /*
       * ⚠️ **公式字段算出日期时，飞书返回的是裸的毫秒时间戳**（2026-09-24 第四批第 3 条）。
       *
       * 用户截图：单元格里显示 `2026/01/23`，打印出来却是 `1769126400000`。
       * 根因：`FT.Formula` 的 `renderKind` 是 `text`，而 SDK **不告诉调用方公式的结果类型** ——
       * 公式算出日期时给的就是一个数字，于是被 `anyText` 原样打印。
       *
       * 判据刻意收得很紧：**必须是公式字段**（`type === FT.Formula`）且值的形状像毫秒时间戳。
       * 普通文本 / 数字字段一律不受影响 —— 否则一个金额字段被格式化成日期就没法查了。
       */
      if (type === FT.Formula) {
        const ms = asTimestampMs(value)
        if (ms !== null) return formatDateTime(ms, meta?.dateFormat)
      }
      return anyText(value)

    case 'number': {
      if (Array.isArray(value)) return anyText(value)
      const n = typeof value === 'number' ? value : Number(value)
      return Number.isFinite(n) ? String(n) : anyText(value)
    }

    case 'checkbox':
      return value === true ? '是' : '否'

    case 'date': {
      const ms = typeof value === 'number' ? value : Number(value)
      if (!Number.isFinite(ms)) return anyText(value)
      return formatDateTime(ms, meta?.dateFormat)
    }

    case 'select': {
      // 单选 = {id,text}；多选 = 数组
      const one = (v: unknown): string => {
        if (v === null || v === undefined) return ''
        if (typeof v === 'string') return v
        if (typeof v === 'object' && 'text' in (v as Record<string, unknown>)) {
          const t = (v as { text?: unknown }).text
          return typeof t === 'string' ? t : ''
        }
        // 只给了 id 之类的对象：给空串，而不是 "[object Object]"
        return scalarText(v)
      }
      if (Array.isArray(value)) return value.map(one).filter(Boolean).join('、')
      return one(value)
    }

    case 'person': {
      const one = (v: unknown): string => {
        if (typeof v === 'string') return v
        if (v && typeof v === 'object') {
          const o = v as { name?: unknown; enName?: unknown; id?: unknown }
          if (typeof o.name === 'string' && o.name) return o.name
          if (typeof o.enName === 'string' && o.enName) return o.enName
          // 只剩 id 时不给可读文本：印一串 open_id 比印空更糟
          return ''
        }
        return ''
      }
      if (Array.isArray(value)) return value.map(one).filter(Boolean).join('、')
      return one(value)
    }

    case 'link': {
      const one = (v: unknown): string => {
        if (typeof v === 'string') return v
        if (v && typeof v === 'object') {
          const o = v as { text?: unknown; link?: unknown; recordIds?: unknown }
          if (typeof o.text === 'string') return o.text
          if (typeof o.link === 'string') return o.link
        }
        return ''
      }
      if (Array.isArray(value)) return value.map(one).filter(Boolean).join('、')
      return one(value)
    }

    case 'attachment': {
      if (Array.isArray(value)) {
        return value
          .map((v) => (v && typeof v === 'object' && 'name' in (v as object) ? String((v as { name: unknown }).name) : ''))
          .filter(Boolean)
          .join('\n')
      }
      return ''
    }

    case 'rating': {
      const n = typeof value === 'number' ? value : Number(value)
      return Number.isFinite(n) ? String(n) : anyText(value)
    }

    case 'progress': {
      const n = typeof value === 'number' ? value : Number(value)
      if (!Number.isFinite(n)) return anyText(value)
      const pct = n <= 1 ? n * 100 : n
      return `${Math.round(pct)}%`
    }

    case 'currency': {
      const n = typeof value === 'number' ? value : Number(value)
      if (!Number.isFinite(n)) return anyText(value)
      return `¥${n.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    }

    default:
      // 兜底也不能 dump：对象值尽力提取可读文本，提不出来给空串
      return anyText(value)
  }
}

const pad = (n: number, len = 2): string => String(n).padStart(len, '0')

/** 星期名（`Date.getDay()` 下标：0 = 周日） */
const WEEKDAY_CN = ['日', '一', '二', '三', '四', '五', '六'] as const

/**
 * 毫秒时间戳 → 可读日期时间。fmt 记法：`YYYY` `MM` `DD` `HH` `mm` `ss` `dddd` `ddd`。
 *
 * ⚠️ **替换顺序陷阱**：这是一条 `replace` 链，**`dddd` 必须排在 `ddd` 前面**。
 * 否则 `/ddd/g` 会先吃掉 `dddd` 的前三个字符，`dddd` 永远匹配不到，
 * `'YYYY-MM-DD dddd'` 会输出成「2026-09-16 周三三」而不是「星期三」。
 * 加新记号时同样遵守"长的写在短的之前"。
 */
export function formatDateTime(ms: number, fmt = 'YYYY-MM-DD'): string {
  const d = new Date(ms)
  if (Number.isNaN(d.getTime())) return ''
  const w = WEEKDAY_CN[d.getDay()]
  return fmt
    .replace(/YYYY/g, String(d.getFullYear()))
    .replace(/MM/g, pad(d.getMonth() + 1))
    .replace(/DD/g, pad(d.getDate()))
    .replace(/HH/g, pad(d.getHours()))
    .replace(/mm/g, pad(d.getMinutes()))
    .replace(/ss/g, pad(d.getSeconds()))
    .replace(/dddd/g, `星期${w}`)
    .replace(/ddd/g, `周${w}`)
}

// ============================================================
// 附件相关：图片判定
// ============================================================

const IMAGE_EXT = new Set(['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp', 'tif', 'tiff', 'svg', 'avif', 'heic'])

export function extOf(name: string): string {
  const i = name.lastIndexOf('.')
  return i >= 0 ? name.slice(i + 1).toLowerCase() : ''
}

/** 是否图片类附件（用于 F4-02 判定） */
export function isImageAttachment(name: string, mime?: string): boolean {
  if (mime && mime.startsWith('image/')) return true
  return IMAGE_EXT.has(extOf(name))
}

/** SVG 走矢量渲染，不参与 DPI 清晰度校验 */
export function isVectorImage(name: string, mime?: string): boolean {
  return extOf(name) === 'svg' || mime === 'image/svg+xml'
}
