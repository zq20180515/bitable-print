/**
 * 极简 XML 解析器（DOCX 专用）
 *
 * 为什么不用 DOMParser：
 * 1) IR 层与解析逻辑必须能在 Node 里跑单测（PRD F3-05 明确要求"IR 与文档模型解耦，便于单测"），
 *    而 DOMParser 是浏览器专有 API，在 Node 下不存在 → 一旦用了，所有解析代码都没法测。
 * 2) DOCX 的 XML 由 Word 机器生成，结构规整：无 DTD、无外部实体、无命名空间验证需求。
 * 3) 硬约束禁止引入 XML DOM 解析库。
 *
 * 因此这里手写一个"够用"的解析器：元素 / 属性 / 文本 / CDATA / 注释 / 处理指令，
 * 命名空间前缀**原样保留在 tag 上**（如 `w:pPr`），这样调用方直接用 `w:` / `wp:` / `a:` 前缀匹配，
 * 不需要额外做命名空间解析 —— 这也是 DOCX 处理的通行做法。
 */

export interface XmlNode {
  /** 完整标签名（含前缀），如 `w:p`、`wp:anchor` */
  tag: string
  attrs: Record<string, string>
  children: XmlNode[]
  /** 该元素**直接**包含的文本（已解码实体，不含子元素文本） */
  text: string
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
}

/** 解码 XML 实体。不认识的原样保留（宁可显示怪字符，也不要丢内容） */
export function decodeXmlEntities(s: string): string {
  if (s.indexOf('&') < 0) return s
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (whole, body: string) => {
    if (body.charAt(0) === '#') {
      const isHex = body.charAt(1) === 'x' || body.charAt(1) === 'X'
      const code = parseInt(body.slice(isHex ? 2 : 1), isHex ? 16 : 10)
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return whole
      try {
        return String.fromCodePoint(code)
      } catch {
        return whole
      }
    }
    const named = NAMED_ENTITIES[body]
    return named === undefined ? whole : named
  })
}

/** 找到 `<` 之后对应的 `>`，跳过引号内的 `>`（属性值里出现 `>` 是合法的） */
function findTagEnd(src: string, lt: number): number {
  let quote = ''
  for (let i = lt + 1; i < src.length; i++) {
    const ch = src.charAt(i)
    if (quote) {
      if (ch === quote) quote = ''
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }
    if (ch === '>') return i
  }
  return -1
}

const ATTR_RE = /([^\s=/][^\s=]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g

function parseAttrs(raw: string): Record<string, string> {
  const out: Record<string, string> = {}
  ATTR_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = ATTR_RE.exec(raw)) !== null) {
    const name = m[1]
    const value = m[2] !== undefined ? m[2] : m[3] !== undefined ? m[3] : ''
    out[name] = decodeXmlEntities(value)
  }
  return out
}

/** 解析 XML 文本，返回一个虚拟根节点（tag = `#root`），其 children 为顶层元素 */
export function parseXml(src: string): XmlNode {
  const root: XmlNode = { tag: '#root', attrs: {}, children: [], text: '' }
  const stack: XmlNode[] = [root]
  const n = src.length
  let i = 0

  const appendText = (s: string): void => {
    if (s.length > 0) stack[stack.length - 1].text += decodeXmlEntities(s)
  }

  while (i < n) {
    const lt = src.indexOf('<', i)
    if (lt < 0) {
      appendText(src.slice(i))
      break
    }
    if (lt > i) appendText(src.slice(i, lt))

    if (src.startsWith('<!--', lt)) {
      const end = src.indexOf('-->', lt + 4)
      i = end < 0 ? n : end + 3
      continue
    }
    if (src.startsWith('<![CDATA[', lt)) {
      const end = src.indexOf(']]>', lt + 9)
      const raw = end < 0 ? src.slice(lt + 9) : src.slice(lt + 9, end)
      stack[stack.length - 1].text += raw
      i = end < 0 ? n : end + 3
      continue
    }
    if (src.startsWith('<?', lt)) {
      const end = src.indexOf('?>', lt + 2)
      i = end < 0 ? n : end + 2
      continue
    }
    if (src.startsWith('<!', lt)) {
      // DOCTYPE 等：直接跳到 '>'（DOCX 里其实不会出现）
      const end = src.indexOf('>', lt + 2)
      i = end < 0 ? n : end + 1
      continue
    }

    const gt = findTagEnd(src, lt)
    if (gt < 0) {
      appendText(src.slice(lt))
      break
    }
    const raw = src.slice(lt + 1, gt)
    i = gt + 1

    if (raw.charAt(0) === '/') {
      const name = raw.slice(1).trim()
      // 容错：不匹配也照常弹栈（真实文档偶有残缺），最多弹到根
      for (let k = stack.length - 1; k > 0; k--) {
        if (stack[k].tag === name) {
          stack.length = k
          break
        }
      }
      continue
    }

    const selfClosing = raw.charAt(raw.length - 1) === '/'
    const body = selfClosing ? raw.slice(0, -1) : raw
    const sp = body.search(/\s/)
    const tag = sp < 0 ? body : body.slice(0, sp)
    const attrs = sp < 0 ? {} : parseAttrs(body.slice(sp))
    const node: XmlNode = { tag, attrs, children: [], text: '' }
    stack[stack.length - 1].children.push(node)
    if (!selfClosing) stack.push(node)
  }

  return root
}

// ============================================================
// 查询辅助（DOCX 代码里高频使用，集中在这里避免各处重复写 for 循环）
// ============================================================

export function firstChild(node: XmlNode | undefined | null, tag: string): XmlNode | undefined {
  if (!node) return undefined
  for (const c of node.children) if (c.tag === tag) return c
  return undefined
}

export function childEls(node: XmlNode | undefined | null, tag: string): XmlNode[] {
  if (!node) return []
  return node.children.filter((c) => c.tag === tag)
}
/** 深度优先查第一个后代（不含自身） */
export function findDeep(node: XmlNode | undefined | null, tag: string): XmlNode | undefined {
  for (const t of findDeepAll(node, [tag])) return t
  return undefined
}

export function findDeepAny(
  node: XmlNode | undefined | null,
  tags: readonly string[],
): XmlNode | undefined {
  for (const t of findDeepAll(node, tags)) return t
  return undefined
}

/** 深度优先收集所有后代（不含自身）。用显式栈而不是递归，避免深文档爆栈 */
export function findDeepAll(node: XmlNode | undefined | null, tags: readonly string[]): XmlNode[] {
  const out: XmlNode[] = []
  if (!node) return out
  const stack: XmlNode[] = [...node.children].reverse()
  while (stack.length > 0) {
    const cur = stack.pop() as XmlNode
    if (tags.indexOf(cur.tag) >= 0) out.push(cur)
    for (let k = cur.children.length - 1; k >= 0; k--) stack.push(cur.children[k])
  }
  return out
}

export function attr(node: XmlNode | undefined | null, name: string): string | undefined {
  if (!node) return undefined
  return Object.prototype.hasOwnProperty.call(node.attrs, name) ? node.attrs[name] : undefined
}
/** 取数值属性；非法值返回 undefined（调用方用 `??` 给默认值） */
export function attrNum(node: XmlNode | undefined | null, name: string): number | undefined {
  const v = attr(node, name)
  if (v === undefined) return undefined
  const n = Number(v)
  return Number.isFinite(n) ? n : undefined
}

/**
 * 取布尔型 OOXML 属性（`w:val` 的取值语义）。
 * 无 val（如 `<w:b/>`）→ true；`0`/`false`/`off` → false；其他 → true。
 */
export function onOff(node: XmlNode | undefined | null): boolean | undefined {
  if (!node) return undefined
  const v = node.attrs['w:val']
  if (v === undefined) return true
  const s = v.trim().toLowerCase()
  if (s === '0' || s === 'false' || s === 'off') return false
  if (s === '1' || s === 'true' || s === 'on') return true
  return true
}

/**
 * 元素内所有文本（含后代），按文档顺序拼接。
 * 用于 `w:t` / `w:instrText` / `w:binData` 等"文本必在叶子节点"的场景。
 */
export function deepText(node: XmlNode | undefined | null): string {
  if (!node) return ''
  let out = node.text
  for (const c of node.children) out += deepText(c)
  return out
}
