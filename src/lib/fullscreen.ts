/**
 * 浏览器级全屏的**探测、进入、退出**（2026-09-20）。
 *
 * ── 背景（本地实测过，不是推测）────────────────────────────────
 * 插件跑在飞书的**跨源 iframe** 里，而 Fullscreen API 受 Permissions Policy 约束，
 * `fullscreen` 的默认 allowlist 是 `self` ⇒ **跨源 iframe 默认拿不到**。本地对照实验：
 *
 *   | 父页面的 iframe 写法        | 子页面 document.fullscreenEnabled |
 *   |--------------------------|--------------------------------|
 *   | 不加任何属性                | **false**                      |
 *   | `allow="fullscreen"`      | **true**                       |
 *
 * ⇒ 两个能落地的事实：
 *   ① **插件无法自己给自己开全屏** —— 那个属性长在飞书页面上的 `<iframe>` 上，
 *      只有飞书能加。所以"真全屏"能不能用，是**运行时才知道**的事；
 *   ② `document.fullscreenEnabled` 是**不需要用户手势**就能读到的可靠探测点
 *      ⇒ 可以据此**自动选路**，而不是让用户去猜、去手动切。
 *
 * ── 因此本模块的职责 ──────────────────────────────────────────
 * 不假装全屏一定能用：探测 → 尽力争取 → **如实回报拿到了哪一种**。
 * 界面据此显示一行状态，用户一眼知道"现在是真全屏还是容器内全屏"。
 */

export type FullscreenSupport =
  /** 这个环境连 API 都没有（极老的浏览器 / 被裁掉的宿主） */
  | 'unsupported'
  /** 有 API，但当前 iframe 没被放行（飞书没给 `allow="fullscreen"`） */
  | 'denied'
  /** 可以用 */
  | 'available'

/** 只读探测：**不需要用户手势**，可以在任何时刻调（包括渲染期做展示） */
export function probeFullscreen(): FullscreenSupport {
  if (typeof document === 'undefined') return 'unsupported'
  const el = document.documentElement
  if (typeof el?.requestFullscreen !== 'function') return 'unsupported'
  /**
   * ⚠️ `fullscreenEnabled === false` 时**不要去调** `requestFullscreen()`：
   * 那个调用必然被拒，而 Chrome 会往控制台丢一条红色错误 —— 用户看到会以为插件坏了。
   * 探测点已经足够，直接按"拿不到"处理。
   */
  if (document.fullscreenEnabled === false) return 'denied'
  return 'available'
}

/**
 * 尽力进入浏览器级全屏。
 *
 * ⚠️ **必须在用户手势的调用栈里同步调用**（点按钮那一下）。
 * 放进 `setTimeout` / `await fetch(...)` 之后再调会因"缺少用户激活"被拒 ——
 * 而那个报错与"父页面没放行"长得不一样，容易误判成"飞书不让全屏"。
 */
export async function enterFullscreen(): Promise<FullscreenSupport> {
  const support = probeFullscreen()
  if (support !== 'available') return support
  try {
    await document.documentElement.requestFullscreen()
    return 'available'
  } catch {
    // 探测说可以、实际仍被拒（少见：宿主在调用瞬间收回了策略）⇒ 如实说"拿不到"
    return 'denied'
  }
}

/** 退出浏览器级全屏。不在全屏态时是空操作（不抛错） */
export async function exitFullscreen(): Promise<void> {
  try {
    if (typeof document !== 'undefined' && document.fullscreenElement) {
      await document.exitFullscreen()
    }
  } catch {
    /* 退出失败没有可做的事：容器内全屏仍然在，用户还能继续编辑 */
  }
}

/** 订阅全屏态变化（用户按 Esc 退出也会触发）。返回退订函数 */
export function onFullscreenChange(cb: (isFullscreen: boolean) => void): () => void {
  if (typeof document === 'undefined') return () => {}
  const handler = (): void => cb(Boolean(document.fullscreenElement))
  document.addEventListener('fullscreenchange', handler)
  return () => document.removeEventListener('fullscreenchange', handler)
}

/**
 * 把探测/进入的结果翻成**一句给人看的话**。
 *
 * 为什么值得单独写：这三种状态对用户的意义完全不同 ——
 * "飞书没放行"用户改不了（只能告诉管理员/接受容器内全屏），
 * "浏览器不支持"与"已经进真全屏了"更是两回事。混成一句"已全屏"就丢掉了全部信息。
 */
export function fullscreenStatusText(
  support: FullscreenSupport,
  isFullscreen: boolean,
): { ok: boolean; text: string; detail: string } {
  if (isFullscreen) {
    return {
      ok: true,
      text: '全屏',
      detail: '已进入浏览器级全屏（按 Esc 退出全屏，仍会留在插件内的全屏画布里）',
    }
  }
  switch (support) {
    case 'available':
      // 探测说能用但还没进（比如用户按 Esc 退出了）：给一句"可以再进"的提示，不吓人
      return {
        ok: true,
        text: '容器内全屏',
        detail: '当前是容器内全屏（覆盖插件可视区）。可点「全屏」进入浏览器级全屏。',
      }
    case 'denied':
      return {
        ok: false,
        text: '容器内全屏',
        detail:
          '当前是容器内全屏。浏览器级全屏用不了 —— 飞书没有给插件 iframe 放行全屏权限（allow="fullscreen"），这一点插件无法自己解决。',
      }
    default:
      return {
        ok: false,
        text: '容器内全屏',
        detail: '当前是容器内全屏。这个环境没有浏览器全屏 API，因此没有「全屏」按钮。',
      }
  }
}
