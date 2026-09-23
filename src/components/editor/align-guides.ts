/**
 * 智能对齐线的**判定**（纯函数，不碰 DOM）。
 *
 * 用户原话：
 *   「各个元素、字段拖动的时候，能不能增加对齐线的标识，比如元素 A 拖动到和元素 B 左侧时，
 *     如果高度对齐了，就会显示一条线告知用户这个位置两个元素是平齐的」
 *
 * ## 两条设计约束
 *
 * 1. **判定全部在 mm 空间完成，签名里不出现 `px` / `scale` / `zoom`。**
 *    不是"记得乘缩放比"，而是**结构上做不到**把屏幕像素混进来。
 *    容差 `SNAP_TOL_MM` 是**物理容差**：若按像素定容差，同一个模板在 50% 与 150%
 *    缩放下手感会完全不同（像素容差 ÷ 缩放比 = 物理容差，而用户感知的是物理量）。
 *    画布只负责把 mm 换算成 px 画线。
 *
 * 2. **「等高」是区间关系，不是边对齐，所以它不叫 `atMm`。**
 *    `kind: 'same-size'` 的那一支没有 `atMm` 字段 —— 等高没有"一条线所在的位置"，
 *    硬塞一个坐标进去，会逼 UI 去猜该画在哪、也让断言无从下手。
 *    用可辨识联合（discriminated union）把它挡在类型层。
 */

/** 一个矩形（模型坐标，mm；`x`/`y` 相对版心左上角） */
export interface BoxMm {
  id?: string
  x: number
  y: number
  w: number
  h: number
}

export type Axis = 'x' | 'y'

export type GuideLine =
  /** 边 / 中心对齐：`atMm` 就是那条参考线在轴上的位置（mm） */
  | { axis: Axis; kind: 'edge' | 'center'; atMm: number; withId: string; deltaMm: number }
  /** 等高 / 等宽：**没有位置**，只有"和谁一样大" */
  | { axis: Axis; kind: 'same-size'; sizeMm: number; withId: string }
  /**
   * **文档级参考线**（2026-09-22 新增）：版心左/右/中心、纸张中心、分区边界…
   *
   * 与上面两支的关键差别：它**不依附于任何元素**（所以没有 `withId`），
   * 而是"这张纸本身的基准"。用户原话：
   *   "需要更加适用、智能，不仅仅和其他元素关联，能识别整个文档居中等位置"。
   *
   * 单独一支而不是复用 `edge`，是为了让 UI 能把它们画得不一样
   * （文档基准线比元素间的对齐线更"硬"），也让断言能分别数两类线。
   */
  | { axis: Axis; kind: 'doc'; atMm: number; label: string; scope: DocRefScope; deltaMm: number }

/** 文档级参考线的**级别**：纸张 / 版心 / 分区。UI 可按级别调深浅 */
export type DocRefScope = 'page' | 'content' | 'band'

/** 一条文档级参考线（不依附元素） */
export interface DocRefLine {
  axis: Axis
  atMm: number
  /** 给用户看的名字，如「版心水平居中」 */
  label: string
  scope: DocRefScope
}

export interface AlignInput {
  moving: BoxMm
  others: ReadonlyArray<BoxMm>
  /** 容差（mm）。默认 1mm —— 这是**物理**容差，不随缩放变 */
  tolMm?: number
  /** 参与判定的轴；默认两轴都算 */
  axes?: ReadonlyArray<Axis>
  /**
   * 文档级参考线（可选）。给了就一起参与吸附 ——
   * 于是"拖到纸张正中"和"和另一个元素左对齐"是同一套手感、同一套容差。
   */
  refs?: ReadonlyArray<DocRefLine>
}

export interface AlignResult {
  guides: GuideLine[]
  /** 建议吸附到的位置：只给"最佳匹配"那一对，不给整组 */
  snapped: { x?: number; y?: number }
}

export const SNAP_TOL_MM = 1

/** 浮点比较用的机器精度门槛（mm 级坐标上 1e-9 足够，不引入肉眼可见误差） */
const EPS = 1e-9

interface Anchor {
  /** 该锚点在轴上的位置 */
  at: number
  /** 'edge' | 'center' —— 用于给参考线分类 */
  role: 'edge' | 'center'
  /** 移动这个框时，让这对锚点重合所需的偏移 */
  fix: (box: BoxMm) => number
}

function anchorsOf(box: BoxMm, axis: Axis): Anchor[] {
  if (axis === 'x') {
    const l = box.x
    const c = box.x + box.w / 2
    const r = box.x + box.w
    return [
      { at: l, role: 'edge', fix: (b) => b.x },
      { at: c, role: 'center', fix: (b) => b.x + b.w / 2 },
      { at: r, role: 'edge', fix: (b) => b.x + b.w },
    ]
  }
  const t = box.y
  const c = box.y + box.h / 2
  const bt = box.y + box.h
  return [
    { at: t, role: 'edge', fix: (b) => b.y },
    { at: c, role: 'center', fix: (b) => b.y + b.h / 2 },
    { at: bt, role: 'edge', fix: (b) => b.y + b.h },
  ]
}

/**
 * 算一次拖动过程中的参考线与吸附量。
 *
 * 移动中的元素**不在 `others` 里**（调用方负责排除自己），否则它会与自己 100% 重合、
 * 每次拖动都报出一堆 `deltaMm: 0` 的假参考线。
 */
export function computeGuides(input: AlignInput): AlignResult {
  const { moving, others } = input
  const tol = input.tolMm ?? SNAP_TOL_MM
  const axes = input.axes ?? (['x', 'y'] as const)
  const refs = input.refs ?? []

  const guides: GuideLine[] = []
  const snapped: { x?: number; y?: number } = {}

  for (const axis of axes) {
    const mine = anchorsOf(moving, axis)
    /*
     * `best` 记的是"这一次拖动最终吸附到哪里"。**元素间优先于文档级**：
     * 两者同时命中（同一轴上、容差内）时，用户更可能想要"和那个元素对齐"，
     * 而不是"吸附到纸张中心"—— 前者是他看得见的参照物。只有元素那边没命中时，
     * 文档级参考线才接管吸附（这也是"更智能"的正确含义：**多给参照，不抢参照**）。
     */
    let best: { delta: number; at: number; from: 'el' | 'doc' } | null = null
    const consider = (delta: number, at: number, from: 'el' | 'doc'): void => {
      if (!best) {
        best = { delta, at, from }
        return
      }
      const better =
        Math.abs(delta) < Math.abs(best.delta) - EPS ||
        (Math.abs(Math.abs(delta) - Math.abs(best.delta)) <= EPS && from === 'el' && best.from === 'doc')
      if (better) best = { delta, at, from }
    }

    for (const other of others) {
      // 把自己排除掉：漏掉这一步会产出 delta=0 的假参考线（它和自己 100% 重合），
      // 而"拖动时永远有一条线"会让这个功能看起来像坏了。
      // 放在函数里而不是指望每个调用方都记得。
      if (moving.id && other.id && moving.id === other.id) continue
      const withId = other.id ?? ''
      // ---- 边 / 中心对齐 ----
      for (const o of anchorsOf(other, axis)) {
        for (const m of mine) {
          const delta = o.at - m.at
          if (Math.abs(delta) > tol + EPS) continue
          guides.push({
            axis,
            // 只要有一端是中心，这条线就是"中心线"
            kind: m.role === 'center' || o.role === 'center' ? 'center' : 'edge',
            atMm: o.at,
            withId,
            deltaMm: delta,
          })
          consider(delta, o.at, 'el')
        }
      }
      // ---- 等高 / 等宽（区间关系，单独一支） ----
      const sizeMine = axis === 'x' ? moving.w : moving.h
      const sizeOther = axis === 'x' ? other.w : other.h
      if (Math.abs(sizeMine - sizeOther) <= tol + EPS) {
        guides.push({ axis, kind: 'same-size', sizeMm: sizeOther, withId })
      }
    }

    // ---- 文档级参考线（版心 / 纸张 / 分区边界）----
    for (const r of refs) {
      if (r.axis !== axis) continue
      for (const m of mine) {
        const delta = r.atMm - m.at
        if (Math.abs(delta) > tol + EPS) continue
        guides.push({ axis, kind: 'doc', atMm: r.atMm, label: r.label, scope: r.scope, deltaMm: delta })
        consider(delta, r.atMm, 'doc')
      }
    }

    if (best) {
      // 吸附：把移动框整体平移 best.delta，让那一对锚点严格重合
      const chosen = best as { delta: number; at: number }
      if (axis === 'x') snapped.x = moving.x + chosen.delta
      else snapped.y = moving.y + chosen.delta
    }
  }

  return { guides, snapped }
}

/**
 * 参考线去重（UI 用）：同一根线上可能叠着"左缘对左缘"和"左缘对右缘"两条。
 * 判定层不做去重 —— 断言要看得到全部匹配；画的时候才需要合并。
 */
export function dedupeGuides(guides: GuideLine[]): GuideLine[] {
  const seen = new Set<string>()
  const out: GuideLine[] = []
  for (const g of guides) {
    const key =
      g.kind === 'same-size'
        ? `${g.axis}|same|${g.sizeMm}|${g.withId}`
        : g.kind === 'doc'
          ? `${g.axis}|doc|${g.atMm}|${g.label}`
          : `${g.axis}|${g.kind}|${g.atMm}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(g)
  }
  return out
}

/**
 * 由页面几何算出**文档级参考线**（纯函数，输入全是数字，不依赖 TemplateDoc）。
 *
 * 用户原话："需要更加适用、智能，**不仅仅和其他元素关联，能识别整个文档居中等位置**"。
 * 这里给的正是那几条"整张纸的基准"：
 *
 *   · x 轴：版心左 / **版心水平居中** / 版心右（外加"纸张水平居中"—— 仅当左右页边距不等，
 *     此时它与版心居中**不是同一条线**，必须分开给，否则用户以为居中了对不上）；
 *   · y 轴：版心上 / **版心垂直居中** / 版心下 + 分区边界（循环区上、表尾区上）。
 *
 * ⚠️ 坐标全部是**相对版心左上角**的 mm（与元素坐标同系），不是纸张坐标 ——
 *    调用方传进来的 `bandTopsMm` 也必须是同一个坐标系。混用会让参考线整体偏一个页边距，
 *    而那种偏移在小缩放下几乎看不出来（所以只能靠"入口统一"来防，不能靠肉眼验）。
 */
export function buildDocRefs(input: {
  /** 版心宽（mm） */
  contentW: number
  /** 版心高（mm） */
  contentH: number
  /** 四边页边距（mm），只为了算"纸张居中"那条 */
  margin: { top: number; right: number; bottom: number; left: number }
  /** 分区上边界（相对版心顶部，mm） */
  bandTopsMm?: { loop?: number; footer?: number }
}): DocRefLine[] {
  const { contentW: w, contentH: h, margin } = input
  const refs: DocRefLine[] = []

  refs.push({ axis: 'x', atMm: 0, label: '版心左', scope: 'content' })
  refs.push({ axis: 'x', atMm: w / 2, label: '版心水平居中', scope: 'content' })
  refs.push({ axis: 'x', atMm: w, label: '版心右', scope: 'content' })

  // 纸张水平居中：页宽 = margin.left + w + margin.right，其中心换算到版心坐标系
  const pageCenterX = (margin.left + w + margin.right) / 2 - margin.left
  if (Math.abs(pageCenterX - w / 2) > 0.5) {
    refs.push({ axis: 'x', atMm: pageCenterX, label: '纸张水平居中', scope: 'page' })
  }

  refs.push({ axis: 'y', atMm: 0, label: '版心上', scope: 'content' })
  refs.push({ axis: 'y', atMm: h / 2, label: '版心垂直居中', scope: 'content' })
  refs.push({ axis: 'y', atMm: h, label: '版心下', scope: 'content' })

  const loopTop = input.bandTopsMm?.loop
  if (loopTop != null && loopTop > 0.5 && loopTop < h - 0.5) {
    refs.push({ axis: 'y', atMm: loopTop, label: '循环区上边界', scope: 'band' })
  }
  const footerTop = input.bandTopsMm?.footer
  if (footerTop != null && footerTop > 0.5 && footerTop < h - 0.5) {
    refs.push({ axis: 'y', atMm: footerTop, label: '表尾区上边界', scope: 'band' })
  }

  // 纸张垂直居中与版心垂直居中同理（上下边距不等时才是两条线）
  const pageCenterY = (margin.top + h + margin.bottom) / 2 - margin.top
  if (Math.abs(pageCenterY - h / 2) > 0.5) {
    refs.push({ axis: 'y', atMm: pageCenterY, label: '纸张垂直居中', scope: 'page' })
  }

  return refs
}
