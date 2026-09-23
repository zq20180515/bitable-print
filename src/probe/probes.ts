/**
 * M0 能力探针。
 *
 * 为什么要有这个东西：
 * PRD 附录 E 列了 6 项"必须先实测、否则需求可能整块返工"的不确定点。其中两项直接
 * 影响架构决策：
 *   - E-1：SDK 能不能读到主界面「用户已勾选的行」？决定"手动选中行"是跟随左表还是插件内自建列表。
 *   - F6 备选：`bridge.getData/setData` 是官方持久化 KV。如果它能按 Base 隔离且容量够，
 *     模板存储就可以不用 `_打印模板_` 表（避免在多维表格里多出一张表）。
 *
 * 这些能力在类型定义里能看到签名，但**运行时的真实行为读不出来**（作用域、容量、权限、
 * 返回结构），只能在真实多维表格里跑一遍。所以这里把每个探针做成一条独立、可单独执行、
 * 失败也不影响其他的检查项，最后产出一份可复制的报告。
 *
 * 用法：在飞书多维表格中打开插件 → 切到「探针」页 → 点「运行全部」→ 复制报告。
 */

import { MM_TO_PX, mmToPx } from '../lib/types'

export type ProbeStatus = 'ok' | 'warn' | 'fail' | 'skip'

export interface ProbeResult {
  id: string
  title: string
  /** 这项探针为什么重要（会显示在报告里，方便回看结论） */
  why: string
  status: ProbeStatus
  /** 一行结论 */
  detail: string
  /** 结构化细节（会以 JSON 打印） */
  data?: unknown
  /** 对需求的影响：探针失败时要走哪条降级路径 */
  impact?: string
  /** 是否是破坏性探针（需要用户显式确认才跑） */
  destructive?: boolean
  /** 给探针编号后面挂的短标签（如「会建表」「会改面板尺寸」），必须**先于运行**可见 */
  caution?: string
  /**
   * 运行前必须让用户看到的提醒（长句，常驻显示、不藏在展开区里）。
   *
   * 为什么单独一个字段而不是塞进 `why`：`why` 是"这项为什么重要"（解释性），
   * 而这里是"点下去之前你必须先知道"（告知性）—— 后者漏了就是事故。
   */
  notice?: string
  /**
   * 只能**单独运行**，绝不进任何批量组合。
   *
   * 与 `destructive` 的区别：`destructive` 是"会改动数据（建表，可自动删回来）"，
   * 这条是"会改动**用户看到的环境**，而且我们**没有接口还原**"——
   * 批量跑到一半把用户的面板尺寸改了、他又没预期，是最难解释的那类故障。
   */
  soloOnly?: boolean
}

export interface ProbeEnv {
  /** 动态 import 得到的 SDK 模块 */
  sdk: any
  base: any
  bridge: any
  ui: any
  /** 当前表 id（可能拿不到） */
  tableId?: string
  /** 当前视图 id（可能拿不到） */
  viewId?: string
  /**
   * `base.getSelection()` 的原始返回。
   * 实测：某些容器里 `getActiveView()` 会失败，但 getSelection() **能拿到 tableId / viewId**，
   * 所以它是 tableId / viewId 的兜底来源（否则 P5 / P8 会误报"无法测试"）。
   */
  selection?: { tableId?: string; viewId?: string; recordId?: string | null; fieldId?: string | null } | null
}

// ============================================================
// 探针定义
// ============================================================

export interface ProbeDef {
  id: string
  title: string
  why: string
  impact: string
  destructive?: boolean
  caution?: string
  notice?: string
  soloOnly?: boolean
  run(env: ProbeEnv): Promise<ProbeOut>
}

/** 探针 run() 的返回类型：只允许给"这次跑出来的东西"，其余元信息由定义与执行器补 */
type ProbeOut = Omit<
  ProbeResult,
  'id' | 'title' | 'why' | 'impact' | 'destructive' | 'caution' | 'notice' | 'soloOnly'
>

const ok = (detail: string, data?: unknown): ProbeOut => ({ status: 'ok', detail, data })
const warn = (detail: string, data?: unknown): ProbeOut => ({ status: 'warn', detail, data })
const fail = (detail: string, data?: unknown): ProbeOut => ({ status: 'fail', detail, data })

function errText(e: unknown): string {
  if (e instanceof Error) return `${e.name}: ${e.message}`
  return String(e)
}

/**
 * 把 SDK 抛出来的东西拆成"能贴进报告"的形状。
 *
 * ⚠️ 为什么不能只用 `errText`：SDK 的错误类 message 往往只有一句 `"not registered"`，
 * 真正有用的是它挂在实例上的 `code`（`errText` 只取 name+message，会把 code 丢掉）。
 * 丢掉的后果是报告里只剩一句英文，读的人无从判断是"宿主没注册"还是"参数写错了"。
 */
function describeError(e: unknown): { text: string; code: unknown; fields: string[] } {
  let code: unknown = null
  let fields: string[] = []
  try {
    if (e && typeof e === 'object') {
      fields = Object.keys(e as object)
      if ('code' in (e as object)) code = (e as { code?: unknown }).code
    }
  } catch {
    /* 某些代理对象取属性会抛，忽略 */
  }
  return { text: errText(e), code: code ?? null, fields }
}

/**
 * 从 SDK 错误的 `code` 里读**低位 3 位**的 detail code。
 *
 * 为什么要这么读：SDK 把 (scope, detail) 拼成一个整数，detail 恒在最低 3 位 ——
 * 类型定义里直接能看到这个约定，例如 `FieldTypeUnSupportedError = 10213991`
 * （低 3 位 `991` 正是 `UnSupportedType`，见 `index.d.ts:2682`）。
 * ⚠️ 低位只当**线索**用：原始 code 一律原样带进 data，判定绝不只看它。
 */
function lowDetailCode(code: unknown): string | null {
  if (typeof code === 'number' && Number.isFinite(code)) return String(Math.abs(Math.trunc(code)) % 1000)
  if (typeof code === 'string' && /^\d+$/.test(code)) return String(Number(code) % 1000)
  return null
}

/** 把 detail code 翻成人话。认不出来返回 null —— **绝不硬编一个说法** */
function detailCodeText(code: unknown): string | null {
  const d = lowDetailCode(code)
  if (d === '997') return '997 = HostNotRegistered，官方注释就是「Host 未注册 API」→ 飞书这一侧没有注册这个接口'
  if (d === '996') return '996 = NotSupported「不支持的操作，常见于对旧版本操作」→ 宿主版本太旧或该接口被禁用'
  if (d === '998') return '998 = NotFound'
  if (d === '999') return '999 = Unknown（未知错误，不能据此下任何结论）'
  return null
}

/**
 * 量 `mm` 毫米在**当前上下文里**等于多少 CSS px。
 *
 * 为什么不直接用常量 `MM_TO_PX`（`src/lib/types.ts:597`）：常量答的是"标准情况"
 * （1mm = 96/25.4 CSS px）。如果宿主对插件容器做了整体缩放，实际排版宽度就会偏离常量 ——
 * 而那正是这条探针要抓的东西。两个值都会报出来，差得多就说明宿主有缩放。
 *
 * **量不到就返回 null**，不返回估算值：估算值混进读数就是假证据。
 */
function measureMm(mm: number): number | null {
  try {
    const el = document.createElement('div')
    el.style.position = 'absolute'
    el.style.left = '-10000px'
    el.style.top = '0'
    el.style.width = `${mm}mm`
    el.style.height = '1px'
    el.style.visibility = 'hidden'
    el.style.pointerEvents = 'none'
    document.body.appendChild(el)
    const w = el.getBoundingClientRect().width
    el.remove()
    return Number.isFinite(w) && w > 0 ? w : null
  } catch {
    return null
  }
}

/** 一次宽度快照（多个来源一起报：单看一个万一被宿主改写就误判了） */
function widthSnapshot(): {
  innerWidth: number
  innerHeight: number
  docElWidth: number | null
  bodyWidth: number | null
  dpr: number | null
} {
  const dw = document.documentElement ? document.documentElement.clientWidth : null
  const bw = document.body ? document.body.clientWidth : null
  return {
    innerWidth: Math.round(window.innerWidth),
    innerHeight: Math.round(window.innerHeight),
    docElWidth: dw === null ? null : Math.round(dw),
    bodyWidth: bw === null ? null : Math.round(bw),
    dpr: typeof window.devicePixelRatio === 'number' ? window.devicePixelRatio : null,
  }
}

/** A4 的两个方向（mm）；常量来自项目自身的纸张定义口径 */
const A4_PORTRAIT_MM = { w: 210, h: 297 }
const A4_LANDSCAPE_MM = { w: 297, h: 210 }

/** 取对象的全部自有方法名（含原型链），用于"这个模块到底有什么接口"的探查 */
function methodNames(obj: any): string[] {
  if (!obj) return []
  const out = new Set<string>()
  let cur = obj
  let depth = 0
  while (cur && cur !== Object.prototype && depth < 5) {
    for (const k of Object.getOwnPropertyNames(cur)) {
      if (k === 'constructor') continue
      try {
        if (typeof obj[k] === 'function') out.add(k)
      } catch {
        /* 某些 getter 会抛错，忽略 */
      }
    }
    cur = Object.getPrototypeOf(cur)
    depth++
  }
  return [...out].sort()
}

export const PROBES: ProbeDef[] = [
  // ------------------------------------------------------------
  {
    id: 'P1',
    title: '环境与 SDK 模块清单',
    why: '先确认插件确实跑在飞书容器里，并看清 base / bridge / ui 各暴露了哪些接口 —— 后面几项探针的目标方法有没有、叫什么，以其为准。',
    impact: '若这里就拿不到 base，说明插件没被正确嵌入（对应 PRD E-03）。',
    async run(env) {
      const modules = {
        base: methodNames(env.base),
        bridge: methodNames(env.bridge),
        ui: methodNames(env.ui),
      }
      const hasSelection = modules.base.includes('getSelection')
      return ok(
        `SDK 已加载。base 暴露 ${modules.base.length} 个方法，bridge ${modules.bridge.length} 个，ui ${modules.ui.length} 个。` +
          `getSelection ${hasSelection ? '存在' : '不存在'}。`,
        modules,
      )
    },
  },

  // ------------------------------------------------------------
  {
    id: 'P2',
    title: 'base.getSelection() 能否读到选中记录（E-1）',
    why: '官方说明书写着"在左侧多维表直接选择需要批量的数据记录"，但类型定义注释写的是 recordId "仅 itemview 会返回"。侧边栏插件到底算不算 itemview，只能实测。这是 D-2 的核心。',
    impact:
      '**已实测定论：单条可得、多选不可得。** getSelection() **能读到 recordId**，但它只是"客户端当前所在的那一行"（点单元格 / 切换数据表时更新）；' +
      '**勾选整行的复选框不触发任何事件**，所以"用户勾选了哪几行"永远读不到 → ' +
      '"跟随左表勾选"的增强模式**不做**；改成用它做步骤①的"读取当前记录并预勾选"，' +
      '至少满足"我在表里选的那条要生效"的预期。',
    async run(env) {
      if (typeof env.base?.getSelection !== 'function') {
        return fail('base 上没有 getSelection 方法', { available: false })
      }
      try {
        const sel = await env.base.getSelection()
        const keys = sel ? Object.keys(sel) : []
        const hasRecord = Boolean(sel?.recordId)
        const hasTable = Boolean(sel?.tableId)
        const hasView = Boolean(sel?.viewId)

        // ui.selectRecordIdList 是另一条可能路径（官方 UI 方法，疑似能唤起记录选择器）
        const hasUiPicker = typeof env.ui?.selectRecordIdList === 'function'

        const detail =
          `返回结构：{${keys.join(', ')}}；` +
          `tableId ${hasTable ? '✓' : '✗'}，viewId ${hasView ? '✓' : '✗'}，recordId ${hasRecord ? '✓' : '✗'}` +
          (hasRecord
            ? ''
            : '。⚠️ **本轮不含定论**：recordId 为 null 有两种可能 —— ① 跑的时候左侧确实没有选中行；' +
              '② 该容器不暴露选中行。**请先在左侧表格里点选一行，再单独跑一次本项**，才能区分。') +
          `另：ui.selectRecordIdList ${hasUiPicker ? '存在' : '不存在'}` +
          (hasUiPicker ? '（可能是官方的记录选择器入口，值得单独试）' : '')

        return {
          // 只有真读到 recordId 才算 ok；null 一律给 warn，避免被误读成"不支持"
          status: hasRecord ? ('ok' as ProbeStatus) : ('warn' as ProbeStatus),
          detail,
          data: { sel, keys, hasUiPicker },
        }
      } catch (e) {
        return fail(`调用抛错：${errText(e)}`, { error: errText(e) })
      }
    },
  },

  // ------------------------------------------------------------
  {
    id: 'P3',
    title: 'onSelectionChange 能否监听选中变化（E-1 增强）',
    why:
      '即使能读到单次选中态，如果监听不到变化事件，"跟随左表勾选"就没法做实时联动 —— 用户每勾一行都要手动刷新，体验还不如自建列表。',
    impact:
      '**已实测定论：多选不可得、单条可得。** 事件**能收到**（点单元格、切换数据表都会让计数增长，载荷里带 recordId），' +
      '但**勾选整行的复选框不触发事件** → "跟随左表多选"**放弃**，不做半成品；' +
      '"读取当前光标所在记录"**可得**，已用于步骤①记录模板的预勾选。' +
      '注意：本项只验证"能否注册/取消"，**能否真的收到事件请用面板上的『选中态实时监听』卡片实测**' +
      '（在固定时间窗里等用户点行是等不到的，上一版探针因此误报了 fired=0）。',
    async run(env) {
      if (typeof env.base?.onSelectionChange !== 'function') {
        return fail('base 上没有 onSelectionChange 方法')
      }
      try {
        const off = env.base.onSelectionChange(() => {
          /* 真正的事件计数由面板上的实时监听卡片负责 */
        })
        await sleep(300)
        const canUnsubscribe = typeof off === 'function'
        if (canUnsubscribe) off()
        return {
          status: canUnsubscribe ? ('ok' as ProbeStatus) : ('warn' as ProbeStatus),
          detail:
            `注册成功，${canUnsubscribe ? '且能正确取消订阅' : '但返回值不是取消函数'}。` +
            `能否真正收到事件，请点面板上『选中态实时监听』的「开始监听」，` +
            `然后依次试：点单元格、点单元格内文字、切换数据表、勾选整行 —— 看哪一种会让计数增长。`,
          data: { canUnsubscribe },
        }
      } catch (e) {
        return fail(`注册抛错：${errText(e)}`)
      }
    },
  },

  // ------------------------------------------------------------
  {
    id: 'P4',
    title: 'bridge.getData/setData 持久化 KV 是否可用 + 作用域（决定模板存储方案）',
    why:
      '这是本次调研最重要的发现：SDK 存在官方持久化 KV `bridge.setData/getData`（类型定义里明确写着"持久化数据"）。' +
      '如果它可用且**作用域按 Base 隔离**、容量够放模板 JSON，模板存储就可以不用 `_打印模板_` 表，' +
      '从而避免在你的多维表格里凭空多出一张表（这是 D-1 唯一的缺点）。',
    impact:
      '按 Base 隔离 → 建议改为「bridge KV 为主 + 模板表为可选备份」，体验更干净。' +
      '全局共享 → **绝不能用**（会串表），维持现方案（专用模板表，作用域绑定数据表），本项零风险。',
    async run(env) {
      if (typeof env.bridge?.setData !== 'function' || typeof env.bridge?.getData !== 'function') {
        return fail('bridge 上没有 setData/getData（当前版本可能不支持）')
      }

      // 作用域判定必须**先读后写**：上一版探针是先写后读，写就把证据覆盖了，
      // 结果跑两个 Base 也判不出是共享还是隔离。
      const key = '__bp_kv_scope_probe__'
      let currentBase = ''
      let currentUser = ''
      try {
        currentBase = (await env.base?.getSelection?.())?.baseId ?? ''
      } catch {
        /* 拿不到就算了，下面会标注 */
      }
      try {
        if (typeof env.bridge?.getBaseUserId === 'function') {
          currentUser = String((await env.bridge.getBaseUserId()) ?? '')
        }
      } catch {
        /* 忽略 */
      }

      let existing: any = null
      let readError = ''
      try {
        existing = await env.bridge.getData(key)
      } catch (e) {
        readError = errText(e)
      }

      const existingBase = existing && typeof existing === 'object' ? String(existing.base ?? '') : ''
      const existingUser = existing && typeof existing === 'object' ? String(existing.user ?? '') : ''
      const existingAt = existing && typeof existing === 'object' ? String(existing.at ?? '') : ''

      // 写入时带上 base / user 标记，供下次比对
      const payload = {
        probe: true,
        at: new Date().toISOString(),
        base: currentBase || '(baseId 未取到)',
        user: currentUser || '(userId 未取到)',
        blob: Array.from({ length: 200 }, (_, i) => ({
          id: `el_${i}`,
          kind: 'text',
          text: '薇诺娜舒敏保湿特护霜 50g 规格型号 BTN-A-1001 批号 20260914',
        })),
      }

      let wrote: unknown = null
      let writeError = ''
      try {
        wrote = await env.bridge.setData(key, payload)
      } catch (e) {
        writeError = errText(e)
      }

      let back: any = null
      try {
        back = await env.bridge.getData(key)
      } catch {
        /* 忽略 */
      }
      const roundTripOk = Boolean(back && typeof back === 'object' && back.at === payload.at)
      const sizeBytes = JSON.stringify(payload).length

      // ---- 作用域判定：Base 维度 + User 维度 ----
      // 模板要能"多人共享"才有意义，所以【按用户隔离】同样是致命问题 —— 只验 Base 维度不够。
      let scope: 'isolated' | 'shared-base' | 'shared-user' | 'unknown' = 'unknown'
      let scopeText = ''
      if (!existing || (existingBase === '' && existingUser === '')) {
        scope = 'unknown'
        scopeText =
          `本次是**首次写入或按 Base/用户隔离**（读不到历史值）。要下结论需两步：` +
          `① **换到另一个多维表格再跑一次** → 若读到本次的 base（${currentBase || '?'}）说明跨 Base 共享；` +
          `② **让另一位同事在同一张表里跑一次** → 若他读到的 user 是你的（${currentUser || '?'}）说明跨用户共享。`
      } else if (existingUser && currentUser && existingUser !== currentUser) {
        scope = 'shared-user'
        scopeText =
          `❌ **跨用户共享**：读到了**另一位用户**（${existingUser}）写入的值，而当前用户是 ${currentUser}。` +
          `这对模板存储是**致命问题** —— 同名 key 会被别人的模板覆盖。**绝对不能用。**`
      } else if (existingBase && currentBase && existingBase !== currentBase) {
        scope = 'shared-base'
        scopeText =
          `❌ **跨 Base 共享**：读到了**另一个 Base**（${existingBase}）写入的值，而当前 Base 是 ${currentBase}。` +
          `KV 不按 Base 隔离 → **不能用于存模板**（会串表）。`
      } else {
        scope = 'isolated'
        scopeText =
          `✅ **按 Base 且按用户隔离**：历史值来自同一个 Base（${existingBase}）且同一用户（${existingUser || currentUser}）。` +
          `⚠️ 但注意：若是**按用户隔离**，意味着模板**不能多人共享**（换个人打开插件看不到你的模板），` +
          `这与 D-1"模板存于表格内可多人共享"的设定不同 —— 属于产品取舍，不是技术限制。` +
          `要确认这一点，请让**另一位同事在同一张表里跑一次本项**。`
      }

      const status: ProbeStatus = writeError
        ? 'fail'
        : scope === 'shared-base' || scope === 'shared-user'
          ? 'fail'
          : roundTripOk
            ? 'ok'
            : 'warn'

      return {
        status,
        detail:
          `写入返回 ${String(wrote)}；回读${roundTripOk ? '一致（round-trip 成功）' : '不一致或为空'}；负载约 ${(sizeBytes / 1024).toFixed(1)}KB。` +
          (readError ? ` 读取历史值报错：${readError}` : '') +
          (writeError ? ` 写入报错：${writeError}` : '') +
          ` 作用域：${scopeText}`,
        data: {
          wrote,
          roundTripOk,
          sizeBytes,
          currentBase,
          currentUser,
          existingBase,
          existingUser,
          existingAt,
          scope,
          stamp: payload.at,
          back: summarize(back),
        },
      }
    },
  },

  // ------------------------------------------------------------
  {
    id: 'P5',
    title: '视图筛选结果直读（E-3）',
    why: 'PRD F1-06「当前视图筛选结果」优先直读视图可见记录；若接口不可用就得降级为"按视图分页拉全量"。两条路的性能差一个数量级。',
    impact: '不可用 → 降级为 `getRecordsByPage({viewId})` 分页（视图自身已应用筛选），功能不受影响，只是慢一点。',
    async run(env) {
      if (!env.tableId || !env.viewId) {
        // 明确区分"SDK 不支持"与"探针自己没拿到上下文"，避免被误读成前者
        return fail(
          `探针自身拿不到 ${!env.tableId ? 'tableId' : ''}${!env.tableId && !env.viewId ? ' 和 ' : ''}${!env.viewId ? 'viewId' : ''}` +
            `（已尝试 getContext 与 getSelection 两条路径）。请在**左侧表格处于激活状态**时重跑本项。`,
          { tableId: env.tableId ?? null, viewId: env.viewId ?? null },
        )
      }
      try {
        const views = await env.base.getTableById(env.tableId).then((t: any) => t.getViewList())
        const view = (views ?? []).find((v: any) => v.id === env.viewId)
        if (!view) return fail('找不到当前视图对象')

        const hasDirect = typeof view.getVisibleRecordIdList === 'function'
        const hasPaged = typeof view.getVisibleRecordIdListByPage === 'function'
        if (!hasDirect && !hasPaged) return fail('视图对象上两个方法都不存在')

        let directCount: number | null = null
        let directSample: unknown = null
        if (hasDirect) {
          try {
            const ids = await view.getVisibleRecordIdList()
            directCount = Array.isArray(ids) ? ids.length : null
            directSample = Array.isArray(ids) ? ids.slice(0, 3) : ids
          } catch (e) {
            directSample = `抛错：${errText(e)}`
          }
        }

        let pagedCount: number | null = null
        if (hasPaged) {
          try {
            const res = await view.getVisibleRecordIdListByPage({ pageSize: 200 })
            pagedCount = Array.isArray(res?.recordIds) ? res.recordIds.length : null
          } catch (e) {
            pagedCount = null
            void e
          }
        }

        return {
          status: directCount !== null || pagedCount !== null ? ('ok' as ProbeStatus) : ('fail' as ProbeStatus),
          detail:
            `getVisibleRecordIdList ${hasDirect ? '存在' : '缺失'}${directCount !== null ? `（首屏返回 ${directCount} 条）` : ''}；` +
            `getVisibleRecordIdListByPage ${hasPaged ? '存在' : '缺失'}${pagedCount !== null ? `（首页 ${pagedCount} 条）` : ''}。`,
          data: { hasDirect, hasPaged, directCount, pagedCount, directSample },
        }
      } catch (e) {
        return fail(`调用抛错：${errText(e)}`)
      }
    },
  },

  // ------------------------------------------------------------
  {
    id: 'P6',
    title: '附件图片 fetch 的 CORS 是否放行（E-4）',
    why: 'PRD F4 整个模块都建立在"能拿到附件图片并渲染"之上。飞书返回的临时链接是否带 CORS 头，只能在 iframe 里实际 fetch 一次才知道。',
    impact:
      '放行 → 图片可以直接渲染，F4 按原设计实现。' +
      '不放行 → 必须启用 F4-27 的降级开关（"不嵌图、只导出文件名"），并在 UI 明确告知用户，同时把图片渲染改为"新窗口打开"。',
    async run(env) {
      if (!env.tableId) return fail('拿不到 tableId，无法测试')
      try {
        const table = await env.base.getTableById(env.tableId)
        const fields = await table.getFieldMetaList()
        const attField = (fields ?? []).find((f: any) => Number(f.type) === 17)
        if (!attField) return warn('当前表里没有附件字段，无法测试（请换一张有附件字段的表再跑）')

        const res = await table.getRecordsByPage({ pageSize: 20 })
        let target: any = null
        for (const r of res?.records ?? []) {
          const v = r.fields?.[attField.id]
          if (Array.isArray(v) && v.length > 0) {
            target = { recordId: r.recordId, attachments: v }
            break
          }
        }
        if (!target) return warn('前 20 条记录里附件字段都为空，无法测试（换一只有附件数据的表再跑）')

        const first = target.attachments[0]
        const tokens = target.attachments.map((a: any) => a.token).filter(Boolean)
        let urls: string[] = []
        try {
          urls = await table.getCellAttachmentUrls(tokens, attField.id, target.recordId)
        } catch (e) {
          return fail(`getCellAttachmentUrls 抛错：${errText(e)}`)
        }
        if (!urls?.length) return fail('getCellAttachmentUrls 返回空数组')

        const url = urls[0]
        let fetchResult: any
        const t0 = performance.now()
        try {
          const resp = await fetch(url)
          const blob = await resp.blob()
          fetchResult = {
            ok: resp.ok,
            status: resp.status,
            type: resp.type, // 'cors' 表示 CORS 放行；'opaque' 表示被拦
            contentType: resp.headers.get('content-type'),
            bytes: blob.size,
            ms: Math.round(performance.now() - t0),
          }
        } catch (e) {
          fetchResult = { fetchError: errText(e), ms: Math.round(performance.now() - t0) }
        }

        const passed = Boolean(fetchResult.ok)
        return {
          status: passed ? ('ok' as ProbeStatus) : ('fail' as ProbeStatus),
          detail: passed
            ? `✅ 直接 fetch 成功：HTTP ${fetchResult.status}，${fetchResult.contentType}，${fetchResult.bytes} 字节，${fetchResult.ms}ms。CORS 已放行，图片可直接渲染。`
            : `❌ fetch 被拦：${JSON.stringify(fetchResult)}。需要走降级方案。`,
          data: {
            fieldName: attField.name,
            attachmentCount: target.attachments.length,
            requestedTokens: tokens.length,
            returnedUrls: urls.length,
            urlHost: safeHost(url),
            urlHasSignature: /sign|token|expire/i.test(url),
            fetchResult,
            sampleName: first?.name,
            sampleSize: first?.size,
            sampleType: first?.type,
          },
        }
      } catch (e) {
        return fail(`探针异常：${errText(e)}`)
      }
    },
  },

  // ------------------------------------------------------------
  {
    id: 'P7',
    title: 'getRecordsByPage 的 pageSize 上限实测',
    why: '类型定义注释写"最大不得超过 200"。确认它是硬限制还是软限制，直接决定分页策略与拉全表的请求数。',
    impact: '确认 200 为硬上限 → 按 200 分页（已这么实现）。若实测允许更大，可以再调优请求数。',
    async run(env) {
      if (!env.tableId) return fail('拿不到 tableId，无法测试')
      try {
        const table = await env.base.getTableById(env.tableId)
        const out: Record<string, unknown> = {}
        for (const size of [200, 500, 1000]) {
          const t0 = performance.now()
          try {
            const res = await table.getRecordsByPage({ pageSize: size })
            out[`pageSize=${size}`] = {
              returned: res?.records?.length ?? 0,
              total: res?.total ?? null,
              hasMore: res?.hasMore ?? null,
              ms: Math.round(performance.now() - t0),
            }
          } catch (e) {
            out[`pageSize=${size}`] = { error: errText(e) }
          }
        }
        const okAt500 = !('error' in ((out['pageSize=500'] as any) ?? {}))
        return {
          status: okAt500 ? ('warn' as ProbeStatus) : ('ok' as ProbeStatus),
          detail: okAt500
            ? 'pageSize=500 未报错（可能被静默截断到 200，请对比 returned 数值）。'
            : 'pageSize 超过 200 会报错，确认 200 为硬上限。',
          data: out,
        }
      } catch (e) {
        return fail(`探针异常：${errText(e)}`)
      }
    },
  },

  // ------------------------------------------------------------
  {
    id: 'P8',
    title: '字段顺序：表级 vs 视图级（验证 F1-02 的依据）',
    why: 'PRD 里写明"table.getFieldMetaList() 返回无序，必须走 view.getFieldMetaList() 才能与界面列序一致"。这是整个字段面板正确性的基础，值得实测确认。',
    impact: '若两者顺序确实不同 → 坚持走视图级（已实现）。若相同 → 可以简化，但不是必须。',
    async run(env) {
      if (!env.tableId) return fail('拿不到 tableId，无法测试')
      try {
        const table = await env.base.getTableById(env.tableId)
        const tableFields: string[] = (await table.getFieldMetaList()).map((f: any) => String(f.name))
        let viewFields: string[] | null = null
        if (env.viewId) {
          try {
            const views = await table.getViewList()
            const view = (views ?? []).find((v: any) => v.id === env.viewId)
            if (view) viewFields = (await view.getFieldMetaList()).map((f: any) => String(f.name))
          } catch (e) {
            viewFields = null
            void e
          }
        }
        if (!viewFields) return warn('拿不到当前视图，只输出了表级顺序', { tableFields })
        const same =
          tableFields.length === viewFields.length &&
          tableFields.every((n: string, i: number) => n === viewFields![i])
        return {
          status: same ? ('warn' as ProbeStatus) : ('ok' as ProbeStatus),
          detail: same
            ? '两者顺序一致（本次样本）。仍建议保留视图级调用，因为它在其他表上可能不同。'
            : '✅ 两者顺序**不同**，确认必须走 view.getFieldMetaList()。',
          data: { tableFields, viewFields },
        }
      } catch (e) {
        return fail(`探针异常：${errText(e)}`)
      }
    },
  },

  // ------------------------------------------------------------
  {
    id: 'P9',
    title: '权限与可编辑性',
    why: '决定插件要不要提示"你没有该表的查看/编辑权限"，以及能不能写模板表。',
    impact: '无写权限 → 模板无法保存，需要提前在 UI 上禁用并说明，而不是让用户点了报错。',
    async run(env) {
      try {
        const out: Record<string, unknown> = {}
        // isEditable 是最可靠的一个信号，值得单独给出结论
        let editable: boolean | null = null
        if (typeof env.base?.isEditable === 'function') {
          try {
            editable = await env.base.isEditable()
            out.isEditable = editable
          } catch (e) {
            out.isEditable = `抛错：${errText(e)}`
          }
        }

        // ⚠️ getPermission 的参数形态在 .d.ts 里没有清晰说明，实测按 {type, entity, tableId} 传
        // 会对一张**明明可读**的表返回 false —— 说明参数不对，这个结果**没有参考价值**。
        // 所以这里只做信息采集并明确标注"不可采信"，绝不能让后人把它当成"没有读权限"。
        let permissionProbed = false
        if (env.tableId && typeof env.base?.getPermission === 'function') {
          permissionProbed = true
          for (const entity of ['Table', 'Record', 'Field']) {
            try {
              out[`permission.${entity}`] = await env.base.getPermission({
                type: 'read',
                entity,
                tableId: env.tableId,
              } as any)
            } catch (e) {
              out[`permission.${entity}`] = `抛错：${errText(e)}`
            }
          }
        }

        return {
          status: editable === null ? 'warn' : 'ok',
          detail:
            `isEditable = ${String(editable)}（这一项可信：true 表示可写，模板表能建、保存能用）。` +
            (permissionProbed
              ? ` ⚠️ permission.* 三项**不可采信** —— 对一张明显可读的表也返回 false，说明 ` +
                `getPermission 的参数形态与文档不符（本探针用 {type:'read', entity, tableId}）。` +
                `**不要据此判断没有权限**；需要真实权限判断时请单独实测参数。`
              : ' 未采集 permission（拿不到 tableId）。'),
          data: out,
        }
      } catch (e) {
        return fail(`探针异常：${errText(e)}`)
      }
    },
  },

  // ------------------------------------------------------------
  {
    id: 'P10',
    title: '新建表的默认列结构（验证"征用默认列"方案）',
    why:
      'F6-01 依赖一个假设：`addTable` 建出的表自带一个空白文本列，我们"征用"它作为「模板名」。' +
      '这个假设不成立的话，模板表会多出一列空的默认列，用户体验上像插件写坏了。',
    impact: '若默认列不存在或有多个 → 调整建表逻辑（改为显式建全部字段）。',
    destructive: true,
    caution: '会建表',
    notice: '会在你的多维表格里**临时新建一张表**做测试，跑完自动删掉它。表名带测试前缀，正常流程不会误删你的数据。',
    async run(env) {
      const name = `_BP探针临时表_${Date.now().toString(36)}`
      let tableId: string | null = null
      try {
        const res = await env.base.addTable({ name, fields: [] })
        tableId = res?.tableId
        if (!tableId) return fail('addTable 未返回 tableId')
        const table = await env.base.getTableById(tableId)
        const fields = await table.getFieldMetaList()
        const cols = (fields ?? []).map((f: any) => ({ name: f.name, type: f.type, isPrimary: f.isPrimary }))
        return {
          status: 'ok' as ProbeStatus,
          detail:
            `新建表自带 ${cols.length} 个字段：${cols.map((c: any) => `${c.name}(type=${c.type}${c.isPrimary ? ',主' : ''})`).join('、')}。` +
            `（临时表 ${name} 已被自动删除）`,
          data: { name, tableId, cols },
        }
      } catch (e) {
        return fail(`探针异常：${errText(e)}`)
      } finally {
        // 一定要清理掉，别在用户的 Base 里留垃圾表
        if (tableId) {
          try {
            await env.base.deleteTable(tableId)
          } catch (e) {
            console.warn('[BitablePrint] 探针临时表清理失败，请手动删除：', name, e)
          }
        }
      }
    },
  },

  // ------------------------------------------------------------
  {
    id: 'P11',
    title: '读取"左表勾选的行"：ui.selectRecordIdList / view.getSelectedRecordIdList',
    why:
      '用户明确要求"直接读取我在多维表格里选中的那些行"。SDK 的类型定义里有两个候选（PRD 附录 E.4）：' +
      '`bitable.ui.selectRecordIdList(tableId, viewId)`（弹官方记录选择器）和表格视图上的 ' +
      '`getSelectedRecordIdList()`（直接读已选中的整行，不弹窗）。两者在类型定义里都有，' +
      '但**运行时到底会不会被宿主响应从来没验证过** —— 而且本项目实测发现：宿主没注册该接口时，' +
      'Promise 既不 resolve 也不 reject（挂住）。所以必须实测，再决定界面上怎么写。',
    impact:
      '可用 → 「读取左表勾选（多条）」走官方接口；不可用/超时 → 自动退回"读取光标所在那一行"，' +
      '并在界面上如实说明当前版本没有该接口（绝不假装支持）。',
    destructive: true, // 会弹出官方记录选择器打断用户，所以不放进"全部非破坏性"批量跑
    // 这里以前挂的是硬编的"会建表"—— 它根本不建表，是句假话。标签必须由探针自己声明。
    caution: '会弹官方记录选择器',
    notice: '运行时会**弹出飞书官方的记录选择器**打断你，最长等 15 秒。可以直接点掉取消，不影响插件里的任何数据。',
    async run(env) {
      const race = async (
        p: Promise<unknown>,
        ms: number,
      ): Promise<{ settled: boolean; ok?: boolean; value?: unknown; error?: string }> =>
        new Promise((resolve) => {
          let done = false
          const t = setTimeout(() => {
            if (!done) {
              done = true
              resolve({ settled: false })
            }
          }, ms)
          Promise.resolve(p).then(
            (v) => {
              if (done) return
              done = true
              clearTimeout(t)
              resolve({ settled: true, ok: true, value: v })
            },
            (e) => {
              if (done) return
              done = true
              clearTimeout(t)
              resolve({ settled: true, ok: false, error: errText(e) })
            },
          )
        })

      const data: Record<string, unknown> = {
        tableId: env.tableId ?? null,
        viewId: env.viewId ?? null,
        uiSelectRecordIdList: typeof env.ui?.selectRecordIdList,
      }

      let uiRes: Awaited<ReturnType<typeof race>> | null = null
      if (typeof env.ui?.selectRecordIdList === 'function' && env.tableId) {
        uiRes = await race(Promise.resolve(env.ui.selectRecordIdList(env.tableId, env.viewId ?? '')), 15000)
        data.uiSelectRecordIdList = uiRes
      }

      // 表格视图上的"已选中的行"
      let gridRes: Awaited<ReturnType<typeof race>> | null = null
      let gridHasMethod: string = 'n/a'
      try {
        const table: any = env.tableId ? await env.base.getTableById(env.tableId) : null
        const views: any[] = (await table?.getViewList?.()) ?? []
        const view = views.find((v) => v.id === env.viewId) ?? views[0] ?? null
        gridHasMethod = typeof view?.getSelectedRecordIdList
        data.gridView = { count: views.length, pickedViewType: view?.type ?? null, getSelectedRecordIdList: gridHasMethod }
        if (typeof view?.getSelectedRecordIdList === 'function') {
          gridRes = await race(Promise.resolve(view.getSelectedRecordIdList()), 8000)
          data.gridSelectedRecordIdList = gridRes
        }
      } catch (e) {
        data.gridError = errText(e)
      }
      data.gridGetSelectedRecordIdList = gridHasMethod

      const settledArray = (r: typeof uiRes): number | null =>
        r?.settled && r.ok && Array.isArray(r.value) ? (r.value as unknown[]).length : null

      const uiCount = settledArray(uiRes)
      const gridCount = settledArray(gridRes)

      if (gridCount !== null) {
        return ok(
          `表格视图 getSelectedRecordIdList() 可用，返回 ${gridCount} 个 recordId —— 「跟随左表勾选」可以直接做，不需要自建勾选列表。`,
          data,
        )
      }
      if (uiCount !== null) {
        return ok(
          `ui.selectRecordIdList() 可用，返回 ${uiCount} 个 recordId（官方记录选择器可走）。` +
            '注意：它需要用户在弹窗里选择，与"直接读左表勾选"不是同一件事。',
          data,
        )
      }
      const uiHang = uiRes && !uiRes.settled
      const gridHang = gridRes && !gridRes.settled
      if (uiHang || gridHang) {
        return warn(
          `接口存在，但调用后**一直无响应**（ui=${uiHang ? '挂住' : '-'}，grid=${gridHang ? '挂住' : '-'}）——` +
            '与本地实测一致：宿主没注册这个通道时 Promise 不会 settle。插件已按"不可用"处理并带超时。',
          data,
        )
      }
      if (gridHasMethod === 'n/a' && typeof env.ui?.selectRecordIdList !== 'function') {
        return fail('两条路都不存在：ui.selectRecordIdList 不是函数，视图上也没有 getSelectedRecordIdList。', data)
      }
      return warn('接口存在但调用没有成功；详情见 data。', data)
    },
  },

  // ------------------------------------------------------------
  // ⚠️ 这条是**唯一**会改动用户所见环境的探针：它会真的把插件面板撑大，而且
  //    SDK 既没有"读当前尺寸"也没有"还原"的接口 —— 我们还原不了，只能提前告知。
  {
    id: 'P12',
    title: '插件宿主容器能否改大（决定"能不能干脆不开独立窗口"）',
    why:
      '排版要在宽容器里做，而飞书侧边栏只有 320–400px，所以现在是把编辑器开到独立窗口。' +
      'SDK 的类型定义里有一条现成的路：`bitable.ui.setHostContainerSize("small"|"medium"|"large")`' +
      '（node_modules/@lark-base-open/js-sdk/dist/index.d.ts:2990，枚举见 :2981-2985；' +
      '同族还有 `closeHostContainer()` :2988 —— 本探针**不会**碰它）。' +
      '但类型定义只能证明"有这么个签名"，**证明不了宿主会认**：飞书没注册这个 RPC 时会 reject 出 997' +
      '（HostNotRegistered，官方注释就叫「Host 未注册 API」，index.d.ts:2477），' +
      '也可能像 P11 实测的那样**既不 resolve 也不 reject（挂住）**。' +
      '这条读数直接决定"要不要干脆不开窗口、改成把侧边栏撑大"。',
    impact:
      '撑开后装得下 A4 → 值得认真评估"不开窗口"这条路（仍需与编辑器自身宽度要求对照，见 EditorShell.tsx:84-93）；' +
      '撑不开 / 接口不可用 / 挂住 → 继续用独立窗口，并把这条降级路径写进界面说明（绝不假装支持）。',
    destructive: true,
    soloOnly: true,
    caution: '会改面板尺寸',
    notice:
      '⚠️ 点「运行」后，插件面板的尺寸会被**真的改变**。SDK 没有"查询当前尺寸"也没有"还原尺寸"的接口，' +
      '所以我们**无法自动还原**。想恢复请关闭插件面板后重新打开（或刷新页面）。' +
      '请先把手头没保存的内容处理好，再点运行。',
    async run(env) {
      /**
       * 不 settle 的超时守卫。
       * P11 已实测：宿主没注册某个通道时，Promise 既不 resolve 也不 reject。
       * 所以这里**不能裸 await** —— 否则这一条会把整批探针拖死在原地。
       */
      const race = <T>(
        p: Promise<T>,
        ms: number,
      ): Promise<{ settled: boolean; ok?: boolean; value?: T; error?: string; code?: unknown; fields?: string[] }> =>
        new Promise((resolve) => {
          let done = false
          const t = setTimeout(() => {
            if (done) return
            done = true
            resolve({ settled: false })
          }, ms)
          Promise.resolve(p).then(
            (v) => {
              if (done) return
              done = true
              clearTimeout(t)
              resolve({ settled: true, ok: true, value: v })
            },
            (e) => {
              if (done) return
              done = true
              clearTimeout(t)
              const d = describeError(e)
              resolve({ settled: true, ok: false, error: d.text, code: d.code, fields: d.fields })
            },
          )
        })

      /**
       * 下面所有读数一律取整到 **CSS 整 px**，和 `widthSnapshot()` 的既有约定一致
       * （那个函数里也是 `Math.round`）。这里**故意不引入 `round2`**：
       * 项目里 round2 家族已登记在 `components/editor/__selftest.mts:783` 的 `KNOWN_DUPES`
       * （3 个名字 / 5 处，**已知分叉、本次不修**），再多抄一份就会被
       * 「结构：同一份逻辑只有一处」扫红（断言名：【已登记重复】round2 的定义处数量应仍是 2）。
       * 而且 0.01px 的精度对"装不装得下 210mm"这个判断本来就没有意义 —— 不是退让，是真的不需要。
       */
      const before = widthSnapshot()

      // 尺子：先量"210mm / 297mm 在本上下文里是多少 CSS px"，并和项目常量对照。
      // 量不到就 null —— 下面会如实标注用的是规范值而不是实测值。
      const measuredPortraitPx = measureMm(A4_PORTRAIT_MM.w)
      const measuredLandscapePx = measureMm(A4_LANDSCAPE_MM.w)
      const needPortraitPx = measuredPortraitPx ?? mmToPx(A4_PORTRAIT_MM.w)
      const needLandscapePx = measuredLandscapePx ?? mmToPx(A4_LANDSCAPE_MM.w)
      const rulerFromDom = measuredPortraitPx !== null && measuredLandscapePx !== null

      const data: Record<string, unknown> = {
        before,
        ruler: {
          fromDom: rulerFromDom,
          measuredPortraitPx: measuredPortraitPx === null ? null : Math.round(measuredPortraitPx),
          measuredLandscapePx: measuredLandscapePx === null ? null : Math.round(measuredLandscapePx),
          specPortraitPx: Math.round(mmToPx(A4_PORTRAIT_MM.w)),
          specLandscapePx: Math.round(mmToPx(A4_LANDSCAPE_MM.w)),
          mmToPxConstant: MM_TO_PX,
          note: rulerFromDom
            ? '两把尺子都在：DOM 实测与项目常量 MM_TO_PX 的差就是宿主的缩放比例'
            : 'DOM 没量到 mm 宽度（可能 document.body 还没准备好），下面的 A4 需求用的是 CSS 规范值，不是实测值',
        },
        uiApi: {
          setHostContainerSize: typeof env.ui?.setHostContainerSize,
          closeHostContainer: typeof env.ui?.closeHostContainer,
          calledCloseHostContainer: false, // 明确留证：这条探针**没有**调用它
        },
      }

      if (typeof env.ui?.setHostContainerSize !== 'function') {
        return fail(
          '这个 SDK 版本里 ui.setHostContainerSize 不是函数 —— 连"能不能改尺寸"都无从问起。' +
            '（注意：类型定义里有签名不等于运行时实例上有这个方法，两者要分开看。）',
          data,
        )
      }

      // 监听 resize：宿主改尺寸是不是"真的发生了"，只看一次前后采样不够
      const resizes: Array<{ atMs: number; innerWidth: number; innerHeight: number }> = []
      const t0 = Date.now()
      const onResize = (): void => {
        resizes.push({
          atMs: Date.now() - t0,
          innerWidth: Math.round(window.innerWidth),
          innerHeight: Math.round(window.innerHeight),
        })
      }
      window.addEventListener('resize', onResize)

      // async 包装：即使它同步 throw，也会变成 rejected promise，走同一条路
      const invoke = async (): Promise<unknown> => env.ui.setHostContainerSize('large')
      const call = await race(invoke(), 8000)

      // 改尺寸是异步的：留一段时间收 resize 事件，也让布局落定后再采样
      await sleep(2500)
      window.removeEventListener('resize', onResize)
      const after = widthSnapshot()

      const widthNow = after.innerWidth
      const fitPortraitW = widthNow >= needPortraitPx
      const fitLandscapeW = widthNow >= needLandscapePx
      const fitPortraitH = after.innerHeight >= mmToPx(A4_PORTRAIT_MM.h)
      const fitLandscapeH = after.innerHeight >= mmToPx(A4_LANDSCAPE_MM.h)

      data.call = call
      if (call.code !== null && call.code !== undefined) {
        data.callCodeText = detailCodeText(call.code) ?? null
        data.callCodeLow3 = lowDetailCode(call.code)
      }
      data.resizes = resizes
      data.after = after
      /**
       * 容器宽度是"A4 所需宽度"的百分之多少 —— **算一次、存一处**：
       * 下面 `data.fit` 与结论那句话共用这两个数。原先 data 里存的是倍率（0.8673…）、
       * 句子里写的是百分比，同一个量两种表示，改了一个另一个不会跟着改。
       *
       * ⚠️ 命名不许写成 `shrinkTo…`：装得下的时候它是 189 / 134（>100，根本不用缩），
       * 那样命名会反过来骗读的人。`pct…Need` 在两种情况下都成立：
       *   < 100 → 装不下，1:1 要缩到该比例；≥ 100 → 装得下。
       */
      const pctOfPortraitNeed = Math.round((widthNow / needPortraitPx) * 100)
      const pctOfLandscapeNeed = Math.round((widthNow / needLandscapePx) * 100)
      data.fit = {
        widthCssPx: widthNow,
        heightCssPx: after.innerHeight,
        needPortraitWidthPx: Math.round(needPortraitPx),
        needLandscapeWidthPx: Math.round(needLandscapePx),
        needPortraitHeightPx: Math.round(mmToPx(A4_PORTRAIT_MM.h)),
        portraitFitsWidth: fitPortraitW,
        landscapeFitsWidth: fitLandscapeW,
        portraitFitsHeight: fitPortraitH,
        landscapeFitsHeight: fitLandscapeH,
        pctOfPortraitNeed: pctOfPortraitNeed,
        pctOfLandscapeNeed: pctOfLandscapeNeed,
      }
      data.rulerNote = rulerFromDom ? 'A4 需求为 DOM 实测' : 'A4 需求为 CSS 规范值（DOM 未量到）'

      const a4Text =
        `装得下的判定（按容器宽度 ${widthNow} CSS px）：` +
        `A4 竖版 1:1 需要 ${Math.round(needPortraitPx)}px → ${fitPortraitW ? '装得下' : `装不下，要缩到 ${pctOfPortraitNeed}%`}；` +
        `横版 1:1 需要 ${Math.round(needLandscapePx)}px → ${fitLandscapeW ? '装得下' : `装不下，要缩到 ${pctOfLandscapeNeed}%`}` +
        (rulerFromDom ? '。' : '。⚠️ 这里的 A4 需求用的是 CSS 规范值（DOM 没量到 mm 宽度），不是实测值。')

      // ① 挂住：连错都不给，最像"宿主没注册"
      if (!call.settled) {
        return warn(
          'ui.setHostContainerSize("large") 调用后 **8 秒无响应**（既不 resolve 也不 reject）。' +
            '这与 P11 实测的"宿主没注册该通道时 Promise 不 settle"同族。' +
            '**结论：不能靠这条接口改容器尺寸。**' +
            '（面板尺寸没有被改动；本探针也没有调用 closeHostContainer。）',
          data,
        )
      }

      // ② reject：把 code 翻成人话，不许只甩错误码
      if (call.ok === false) {
        const human = detailCodeText(call.code)
        const codePart =
          call.code === null || call.code === undefined
            ? '（错误对象上没有 code 字段）'
            : `错误码 ${String(call.code)}${human ? ` → ${human}` : '（低位 3 位认不出对应哪条 detail code，不猜）'}`
        return warn(
          `宿主拒绝了这个调用：${String(call.error)}。${codePart}。` +
            '**结论：当前宿主没有提供"改容器尺寸"这个能力**（不是我们调用姿势不对 —— 参数只有一个枚举值，没有别的写法）。' +
            '面板尺寸没有被改动；本探针也没有调用 closeHostContainer。',
          data,
        )
      }

      // ③ resolve 了，但尺寸没变 —— 这不能算"能撑大"
      const grew = after.innerWidth > before.innerWidth || after.innerHeight > before.innerHeight
      if (!grew) {
        return warn(
          `接口**返回了成功**，但容器尺寸一点没变（${before.innerWidth}×${before.innerHeight} → ` +
            `${after.innerWidth}×${after.innerHeight}），期间收到 ${resizes.length} 次 resize 事件。` +
            '宿主接受了调用却没有真的改尺寸 —— **不能把它当成"能撑大"**。' +
            '（尺寸既然没变，也就无所谓恢复；本探针没有调用 closeHostContainer。）',
          data,
        )
      }

      // ④ 真的撑开了：报读数，并把"够不够"如实说清
      const delta = `${before.innerWidth}×${before.innerHeight} → ${after.innerWidth}×${after.innerHeight} CSS px`
      const evt = `期间收到 ${resizes.length} 次 resize 事件${resizes.length ? `（首次在 ${resizes[0].atMs}ms）` : ''}`
      const tail =
        `另：编辑器自身需要的宽度见 src/components/editor/EditorShell.tsx:84-93 那份注释（它把账算得很清楚），` +
        '把上面的实测宽度和它对照即可判"够不够排版"。'
      if (fitPortraitW) {
        return ok(
          `ui.setHostContainerSize("large") 被宿主接受，容器从 ${delta}，${evt}。${a4Text} ` +
            `**这条路是通的，值得认真评估"不开独立窗口"。** ${tail}` +
            '（本探针没有调用 closeHostContainer。）',
          data,
        )
      }
      return warn(
        `ui.setHostContainerSize("large") 被宿主接受，容器从 ${delta}，${evt}，但**仍然装不下 A4 竖版 1:1**。${a4Text} ` +
        `**结论：靠它把侧边栏撑到"能 1:1 排版"这条路走不通**（能撑大 ≠ 够大）。${tail}` +
        '（本探针没有调用 closeHostContainer。）',
        data,
      )
    },
  },
]

// ============================================================
// 执行器
// ============================================================

export async function runProbes(
  env: ProbeEnv,
  opts: { only?: string[]; includeDestructive?: boolean; onResult?: (r: ProbeResult) => void } = {},
): Promise<ProbeResult[]> {
  const list = PROBES.filter((p) => {
    if (opts.only && !opts.only.includes(p.id)) return false
    /**
     * `soloOnly`：只能单独跑。
     *
     * 挡在这里而不是只靠面板的分组列表，是因为这条规矩的代价不对称 ——
     * 面板那侧漏一次（比如以后有人加了新的快捷组合），用户就会在"跑一批"的预期下
     * 被改掉面板尺寸，而 SDK 没有还原接口。**规矩要挡在必经之路上，不能只挡在入口。**
     */
    if (p.soloOnly && (opts.only?.length ?? 0) > 1) return false
    if (p.destructive && !opts.includeDestructive) return false
    return true
  })

  const out: ProbeResult[] = []
  for (const def of list) {
    let partial: { status: ProbeStatus; detail: string; data?: unknown }
    try {
      partial = await def.run(env)
    } catch (e) {
      partial = { status: 'fail', detail: `未捕获异常：${errText(e)}` }
    }
    const full: ProbeResult = {
      id: def.id,
      title: def.title,
      why: def.why,
      impact: def.impact,
      destructive: def.destructive,
      caution: def.caution,
      notice: def.notice,
      soloOnly: def.soloOnly,
      ...partial,
    }
    out.push(full)
    opts.onResult?.(full)
  }
  return out
}

/** 生成可粘贴回对话的 Markdown 报告 */
export function formatReport(results: ProbeResult[], extra?: Record<string, unknown>): string {
  const icon: Record<ProbeStatus, string> = { ok: '✅', warn: '⚠️', fail: '❌', skip: '⏭' }
  const lines: string[] = []
  lines.push('# BitablePrint M0 探针报告')
  lines.push('')
  lines.push(`运行时间：${new Date().toLocaleString('zh-CN')}`)
  if (extra) {
    for (const [k, v] of Object.entries(extra)) {
      lines.push(`- ${k}：${typeof v === 'string' ? v : JSON.stringify(v)}`)
    }
  }
  lines.push('')
  lines.push('| 编号 | 结论 | 状态 |')
  lines.push('| --- | --- | --- |')
  for (const r of results) {
    lines.push(`| ${r.id} | ${r.title}${r.caution ? `（${r.caution}）` : ''} | ${icon[r.status]} ${r.status} |`)
  }
  lines.push('')
  for (const r of results) {
    lines.push(`## ${r.id} ${r.title} — ${icon[r.status]} ${r.status}`)
    lines.push('')
    // 提醒要跟着结论一起走：报告会被复制出去给别人看，
    // 只把"结果"带走、把"它改过我的面板"留下，是本末倒置
    if (r.notice) {
      lines.push(`> ${r.notice}`)
      lines.push('')
    }
    lines.push(`**结论**：${r.detail}`)
    lines.push('')
    if (r.data !== undefined) {
      lines.push('**数据**：')
      lines.push('```json')
      lines.push(safeJson(r.data))
      lines.push('```')
      lines.push('')
    }
  }
  return lines.join('\n')
}

// ============================================================

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

function safeHost(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return '(无法解析)'
  }
}

function safeJson(v: unknown, indent = 0): string {
  try {
    return JSON.stringify(v, null, 2) ?? String(v)
  } catch {
    return `(无法序列化，类型 ${typeof v})${indent}`
  }
}

function summarize(v: unknown): unknown {
  if (v === null || v === undefined) return v
  if (typeof v === 'object') {
    const keys = Object.keys(v as object)
    return `[object keys=${keys.slice(0, 12).join(',')}${keys.length > 12 ? ',…' : ''}]`
  }
  return v
}
