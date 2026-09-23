/**
 * 「读取用户在多维表格里选中的记录（多条）」的能力封装。
 *
 * 背景：这个插件长期只能读到**一条**（光标所在的那一行），因为飞书对"勾选整行的复选框"
 * 不发任何事件。用户明确要求"直接读取我选中的那些行"，所以这里去接两个候选接口：
 *
 *   1. `view.getSelectedRecordIdList()`（Grid 视图）—— 直接读"表格里已被选中的行"，
 *      **不弹任何对话框**，最贴近用户说的"跟随左表勾选"。
 *   2. `bitable.ui.selectRecordIdList(tableId, viewId)` —— 调起飞书官方的记录选择器，
 *      用户在里面选完返回 recordId 列表。
 *
 * ⚠️ 实测结论（本机非飞书环境，`?mock=1`，Chromium + 真实 SDK 包）：
 *    这两个方法在 SDK 里**都存在**（见 @lark-base-open/js-sdk 的 index.d.ts），
 *    但宿主未注册时调用的 Promise **既不 resolve 也不 reject**（挂住）。
 *    所以这里一律带截止时间（deadline），绝不把 UI 卡在"点了没反应"上。
 */

/**
 * ① 用的截止时间：探测"表格视图那个通道到底有没有注册"。
 *
 * ⚠️ 为什么是 6 秒（以及为什么**不要**随手缩短）：本机实测过两种形态 ——
 *   · 桥接对象本身不存在 → **0ms 就在本地抛错**
 *     （`Cannot read properties of undefined (reading 'getContext')`）
 *   · 通道没注册 → 发出去的 Promise **永远不 settle**（复测到 12 秒仍无反应）
 * 也就是说：我**观察不到任何一次真实的成功往返**，所以"健康宿主是毫秒级"这句话
 * **没有数据支撑**，只是推测。而一个基于推测的缩短比不改更危险 ——
 * 它会带着"有实测支撑"的假象留在代码里，下一个人会当它是有依据的。
 *
 * 真要缩短：请先在**真机**（飞书容器内）跑 P11 探针，拿到一次成功调用的真实耗时，再拿数据说话。
 */
export const GRID_PROBE_TIMEOUT_MS = 6000

/**
 * ② 用的窗口：等用户在官方记录选择器里挑完。
 *
 * **它和 ① 是两件完全不同的事**：① 问的是"通道活着吗"（探测性质，越短越好），
 * ② 问的是"用户挑完了吗"（用户驱动，用户想多久就多久）。
 * 这两个职责曾经共用一个常量 `PICK_TIMEOUT_MS` —— 那是留给下一个人的陷阱：
 * 谁想调其中一个，都会连带改掉另一个。
 *
 * ⚠️ 现在这个"6 秒超时"是**名义上的**兜底，真正的兜底是：
 * `withDeadline` **不取消**原 Promise + `onLate` 把迟到的结果补收进来。
 * 所以今天没出问题，是因为真兜底在兜。
 * **如果哪天有人"优化" `withDeadline` 让它真的取消，② 就会在第 6 秒把用户正在挑的选择器作废。**
 * 动 `withDeadline` 语义的时候，必须同时把这里放大。
 */
export const PICKER_WINDOW_MS = 6000

export type SelectionSource = 'grid' | 'picker'

export type SelectionOutcome =
  | { status: 'ok'; source: SelectionSource; ids: string[] }
  /** 调通了，但结果为空 —— 用户确实一条都没选 */
  | { status: 'empty'; source: SelectionSource }
  /** 用户主动取消（返回 null） */
  | { status: 'cancelled'; source: SelectionSource }
  /** 当前飞书版本 / 容器没有这个接口 */
  | { status: 'unsupported'; source: SelectionSource; reason: string }
  | { status: 'error'; source: SelectionSource; reason: string }
  /** 宿主一直不回应（接口没被宿主注册时的典型表现） */
  | { status: 'timeout'; source: SelectionSource; waitedMs: number }

/** 降级链上的两级（用于"进行中"反馈，见 `stageText`） */
export type SelectionStage = 'grid' | 'picker'

export interface PickOptions {
  timeoutMs?: number
  /**
   * 超过 `timeoutMs` 之后才回来的结果。
   * 为什么要有它：用户在官方选择器里多挑一会儿是很正常的，不能因为超了就把他选的东西丢掉。
   */
  onLate?(outcome: SelectionOutcome): void
  /**
   * 走到某一级时的"进行中"反馈。
   *
   * 为什么必须有它：两级都不可用时最坏要等 `timeout × 2` 秒（6+6）。
   * 这个项目已经被"点了没反应 / 拖了没反应"反复折腾过 —— **十几秒的静默就是同一类失败**。
   * 所以界面在这段时间里必须一直在说话，而且要能看出"进度"（第一级 → 第二级），
   * 不是一个转圈转到底。
   */
  onStage?(stage: SelectionStage, text: string): void
}

/**
 * 某一级的"进行中"文案。抽成函数是为了让断言能引到**同一份**文案 ——
 * 否则测试里写的字和界面上的字会各改各的。
 */
export function stageText(stage: SelectionStage, reason?: string): string {
  if (stage === 'grid') return '正在尝试读取左表勾选（表格视图里已勾选的行）…'
  return reason ? `左表勾选不可用（${reason}），正在打开飞书记录选择器…` : '正在打开飞书记录选择器…'
}

type Settled<T> =
  | { settled: true; ok: true; value: T }
  | { settled: true; ok: false; error: unknown }
  | { settled: false }

/** 给一个 Promise 加截止时间；**不取消**原 Promise（宿主的对话框可能还会回来） */
export function withDeadline<T>(p: Promise<T>, ms: number): Promise<Settled<T>> {
  return new Promise((resolve) => {
    let done = false
    const timer = setTimeout(() => {
      if (done) return
      done = true
      resolve({ settled: false })
    }, ms)
    p.then(
      (value) => {
        if (done) return
        done = true
        clearTimeout(timer)
        resolve({ settled: true, ok: true, value })
      },
      (error: unknown) => {
        if (done) return
        done = true
        clearTimeout(timer)
        resolve({ settled: true, ok: false, error })
      },
    )
  })
}

/**
 * 归一化各种可能的返回形态。
 * 返回 `null` 表示"用户取消/没给结果"，与"选了空"（`[]`）区分开 —— 这两种要给不同的提示。
 */
export function normalizeRecordIds(raw: unknown): string[] | null {
  if (raw === null || raw === undefined) return null
  const pick = (v: unknown): string[] | null => {
    if (!Array.isArray(v)) return null
    return v.filter((x): x is string => typeof x === 'string' && x.length > 0)
  }
  const direct = pick(raw)
  if (direct) return direct
  if (typeof raw === 'object') {
    const o = raw as { recordIds?: unknown; data?: unknown; records?: unknown }
    const a = pick(o.recordIds) ?? pick(o.records)
    if (a) return a
    if (o.data && typeof o.data === 'object') {
      const d = o.data as { recordIds?: unknown; records?: unknown }
      const b = pick(d.recordIds) ?? pick(d.records)
      if (b) return b
    }
  }
  return null
}

/** 把"调用结果 / 取消 / 抛错"收敛成一条可展示的结论 */
function toOutcome(source: SelectionSource, settled: Settled<unknown>): SelectionOutcome {
  if (!settled.settled) return { status: 'timeout', source, waitedMs: 0 }
  if (!settled.ok) return { status: 'error', source, reason: errText(settled.error) }
  const ids = normalizeRecordIds(settled.value)
  if (ids === null) return { status: 'cancelled', source }
  if (ids.length === 0) return { status: 'empty', source }
  return { status: 'ok', source, ids }
}

async function raceAndReport(
  source: SelectionSource,
  fn: () => Promise<unknown>,
  opts: PickOptions,
  /** 这一级自己的默认截止时间 —— ① 和 ② 语义不同，**必须由调用方显式给**，别在这里猜 */
  defaultMs: number,
): Promise<SelectionOutcome> {
  const timeoutMs = opts.timeoutMs ?? defaultMs
  let raw: Promise<unknown>
  try {
    raw = Promise.resolve(fn())
  } catch (e) {
    return { status: 'error', source, reason: errText(e) }
  }
  const settled = await withDeadline(raw, timeoutMs)
  if (settled.settled) return toOutcome(source, settled)
  // 超时：先给结论，但结果晚到了仍然交给调用方（用户在对话框里多挑了会儿）
  raw.then(
    (v) => opts.onLate?.(toOutcome(source, { settled: true, ok: true, value: v })),
    (e) => opts.onLate?.(toOutcome(source, { settled: true, ok: false, error: e })),
  )
  return { status: 'timeout', source, waitedMs: timeoutMs }
}

/**
 * ① 读"表格里已被选中的行"（Grid 视图）。
 * 不弹任何对话框；如果视图不是表格视图，`getSelectedRecordIdList` 不存在 → unsupported。
 */
export async function readGridSelected(
  table: unknown,
  viewId: string | undefined,
  opts: PickOptions = {},
): Promise<SelectionOutcome> {
  const t = table as { getViewList?: () => Promise<unknown[]> } | null
  if (!t || typeof t.getViewList !== 'function') {
    return { status: 'unsupported', source: 'grid', reason: '数据源没有暴露视图对象' }
  }
  let view: { id?: string; getSelectedRecordIdList?: () => Promise<unknown> } | undefined
  try {
    const views = (await t.getViewList()) ?? []
    view =
      (views.find((v) => (v as { id?: string }).id === viewId) as typeof view) ??
      (views[0] as typeof view)
  } catch (e) {
    return { status: 'error', source: 'grid', reason: errText(e) }
  }
  const fn = view?.getSelectedRecordIdList
  if (typeof fn !== 'function') {
    return {
      status: 'unsupported',
      source: 'grid',
      reason: '当前视图不是表格视图（或该飞书版本未提供 getSelectedRecordIdList）',
    }
  }
  return raceAndReport('grid', () => fn.call(view), opts, GRID_PROBE_TIMEOUT_MS)
}

/**
 * ② 调起飞书官方的记录选择器。
 * 用户在里面选完 → 返回 recordId 列表；取消 → 返回 null（也可能返回空数组）。
 */
export async function readByOfficialPicker(
  ui: unknown,
  tableId: string,
  viewId: string | undefined,
  opts: PickOptions = {},
): Promise<SelectionOutcome> {
  const u = ui as { selectRecordIdList?: (t: string, v: string) => Promise<unknown> } | null
  // "没有 ui 模块"和"有 ui 模块但版本里没这个方法"是两件事，别都推给飞书版本 ——
  // mock 数据源下走的是前者，若写成"当前飞书版本没有…"就是**界面在说谎**。
  if (!u) {
    return { status: 'unsupported', source: 'picker', reason: '当前数据源没有暴露飞书的 ui 模块' }
  }
  if (typeof u.selectRecordIdList !== 'function') {
    return { status: 'unsupported', source: 'picker', reason: '当前飞书版本没有提供 ui.selectRecordIdList' }
  }
  // ② 等的是**用户在弹窗里挑完**，和 ① 探测通道存活是两件事，所以用 PICKER_WINDOW_MS
  return raceAndReport('picker', () => u.selectRecordIdList!(tableId, viewId ?? ''), opts, PICKER_WINDOW_MS)
}

/** 最终停在（或落到）哪一级 */
export type SelectionLevel = 'grid' | 'picker' | 'none'

export interface ChainResult {
  /** 实际生效的那一级；`none` = 两级都不可用，调用方应退回到"读光标所在行" */
  level: SelectionLevel
  /** `level` 这一级给出的结论 */
  outcome: SelectionOutcome
  /**
   * 走到 `level` 之前，**每一级为什么没成**（按 ① ② 顺序，人话）。
   * 这就是"用户怎么知道自己在用哪一级、以及为什么不是更好的那一级"的唯一来源。
   */
  skipped: string[]
}

/**
 * 三级降级链本体：① 表格视图已选中的行 → ② 飞书官方记录选择器 → ③（不在本函数内）读光标所在行。
 *
 * 为什么单独抽成函数：这条链原来是写在 React hook 里的，
 * **"① 探测不到时自动走 ②"这条路径因此从来没有被断言覆盖过** ——
 * 单元级只测了 `readGridSelected` / `readByOfficialPicker` 各自的六种结果，
 * 真实 UI 只测了"两条都缺"。抽出来之后链本身可测，回归才有护栏。
 *
 * 约定：`ok` / `empty` / `cancelled` 都算"这一级用上了"（用户确实跟这一级交互过），
 * 只有 `unsupported` / `error` / `timeout` 才继续往下走。
 */
export async function readSelectionChain(
  table: unknown,
  ui: unknown,
  tableId: string,
  viewId: string | undefined,
  opts: PickOptions = {},
): Promise<ChainResult> {
  // 先说话再干活：用户点了按钮之后，界面在这段时间里必须一直是"有反应"的
  opts.onStage?.('grid', stageText('grid'))
  const grid = await readGridSelected(table, viewId, opts)
  if (grid.status === 'ok' || grid.status === 'empty' || grid.status === 'cancelled') {
    return { level: 'grid', outcome: grid, skipped: [] }
  }
  const skipped = [shortReason(grid)]
  opts.onStage?.('picker', stageText('picker', skipped[0]))
  const picked = await readByOfficialPicker(ui, tableId, viewId, opts)
  if (picked.status === 'ok' || picked.status === 'empty' || picked.status === 'cancelled') {
    return { level: 'picker', outcome: picked, skipped }
  }
  skipped.push(shortReason(picked))
  return { level: 'none', outcome: grid, skipped }
}

/**
 * 把结论翻成给用户看的一句话。
 *
 * 硬规矩：**任何一条都必须说人话，且失败/取消不能静默** ——
 * 这个项目在"异常路径从没被测过"上栽过三次，这里至少别让用户猜。
 */
export function outcomeHint(o: SelectionOutcome, what = '记录'): { ok: boolean; text: string } {
  switch (o.status) {
    case 'ok':
      return { ok: true, text: `已读取你在多维表格里选中的 ${o.ids.length} 条${what}。` }
    case 'empty':
      return {
        ok: false,
        text:
          o.source === 'grid'
            ? '多维表格里当前没有选中任何整行（左侧的复选框一个都没勾）。也可以在下面按行数勾选。'
            : '记录选择器没有返回任何记录，已保持原有勾选不变。',
      }
    case 'cancelled':
      return { ok: false, text: '已取消选择，原有勾选保持不变。' }
    case 'unsupported':
      return { ok: false, text: `读不到你在多维表格里选中的行：${o.reason}。` }
    case 'timeout': {
      // 两级等的是不同的东西，超时文案也得分开说 —— 否则用户不知道该找谁：
      // ① 是"表格视图那个读选中行的接口"，② 是"记录选择器"。默认值也各走各的常量。
      const which = o.source === 'grid' ? '左表勾选的接口' : '记录选择器'
      const budget = o.source === 'grid' ? GRID_PROBE_TIMEOUT_MS : PICKER_WINDOW_MS
      return {
        ok: false,
        text: `${which} ${Math.round((o.waitedMs || budget) / 1000)} 秒内没有响应（当前环境没有注册它）。`,
      }
    }
    default:
      return { ok: false, text: `读取选中记录失败：${o.reason}。` }
  }
}

/** 一句话说清"这次为什么没拿到"（用于把两条路的原因并列给用户看） */
export function shortReason(o: SelectionOutcome): string {
  switch (o.status) {
    case 'unsupported':
      return o.reason
    case 'timeout':
      return '调用后一直无响应'
    case 'error':
      return o.reason
    case 'empty':
      return '没能返回任何记录'
    case 'cancelled':
      return '已取消'
    default:
      return '可用'
  }
}

/**
 * 成功带入之后，告诉用户"这一批是从哪一级来的"。
 *
 * 走到 ② 时必须把"① 为什么没成"一并说出来 —— 否则界面上只有一句
 * "已通过飞书记录选择器读取"，用户会以为这就是原本设计的第一选择，
 * 而不知道"跟随左表勾选"其实没接通。
 */
export function appliedLabel(level: SelectionLevel, skipped: string[] = []): string {
  if (level === 'grid') return '已读取你在多维表格里选中的记录'
  if (level === 'picker') {
    const why = skipped[0]
    return why ? `左表勾选不可用（${why}），已通过飞书记录选择器读取` : '已通过飞书记录选择器读取'
  }
  return '已读取'
}

/** 两级都没走通时，把**两条**原因并列说清（别只报最后试的那一个） */
export function chainFailureText(chain: ChainResult): string {
  const [grid = '不可用', picker = '不可用'] = chain.skipped
  return `读不到你在多维表格里选中的行（表格视图：${grid}；官方选择器：${picker}）。`
}

/** 界面底部必须如实说明"现在到底能不能直接跟随左表勾选" */
export function capabilityNote(capability: 'unknown' | 'grid' | 'picker' | 'none'): string {
  switch (capability) {
    case 'grid':
      return '已接通「读取左表勾选」：在多维表格里勾选整行后点上面的按钮即可一次性带入。'
    case 'picker':
      return '已接通飞书官方记录选择器：点上面的按钮，在弹出的选择器里多选记录。'
    case 'none':
      return '当前环境（飞书版本或数据源）没有提供「读取左表勾选」的接口（已实测），所以多选请在下面的列表里勾，或直接输入行数批量勾选。'
    default:
      return '飞书对「勾选整行的复选框」不触发事件（已实测）；点上面的按钮会尝试读取左表选中行，读不到则退回读取光标所在的那一行。'
  }
}

function errText(e: unknown): string {
  if (e instanceof Error) return e.message || e.name
  if (typeof e === 'string') return e
  try {
    return JSON.stringify(e)
  } catch {
    return String(e)
  }
}
