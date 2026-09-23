/**
 * 数据源启动逻辑。
 *
 * 三种启动路径：
 * 1) URL 带 `?mock=1` → 直接用本地 MockDataSource（开发调试 / 非飞书环境演示）
 * 2) 正常情况 → SdkDataSource；初始化失败时**不自动**降级到 mock，
 *    而是把错误交给 UI，让用户明确选择"重试"还是"用示例数据体验"——静默降级会让用户
 *    以为自己操作的是真实表格，这是很危险的体验。
 * 3) 用户显式选择"用示例数据体验" → MockDataSource
 */

import type { DataSource } from './data-source'
import { MockDataSource, shouldUseMock } from './mock-source'
import { SdkDataSource, isNotInFeishu } from './sdk-source'

export type BootMode = 'sdk' | 'mock'

export interface BootResult {
  ds: DataSource
  mode: BootMode
  /** 降级时的说明文案，用于在 UI 上明确告知用户"当前不是真实数据" */
  warning?: string
}

export class BootError extends Error {
  /** 给用户看的可操作建议 */
  readonly hint: string
  constructor(message: string, hint: string) {
    super(message)
    this.name = 'BootError'
    this.hint = hint
  }
}

/** 创建一个已初始化的数据源 */
export async function createDataSource(): Promise<BootResult> {
  if (shouldUseMock()) {
    const ds = new MockDataSource(60)
    await ds.init()
    return { ds, mode: 'mock', warning: '当前为本地示例数据模式（URL 带 ?mock=1），不读取任何真实表格。' }
  }

  const ds = new SdkDataSource()
  try {
    await ds.init()
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (isNotInFeishu(e)) {
      throw new BootError(msg || '插件没有运行在飞书多维表格中', MOCK_HINT)
    }
    throw new BootError(msg, '可以先重试；若持续失败，请重新打开插件。' + MOCK_HINT)
  }

  // 握手通过后，再确认能拿到当前表上下文——拿不到说明用户还没打开任何数据表
  try {
    await ds.getContext()
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    throw new BootError(msg, '请先在一张多维表格数据表里打开本插件。')
  }

  return { ds, mode: 'sdk' }
}

/** 用户选择"用示例数据体验"时调用 */
export async function createMockDataSource(recordCount = 60): Promise<BootResult> {
  const ds = new MockDataSource(recordCount)
  await ds.init()
  return {
    ds,
    mode: 'mock',
    warning: '当前为示例数据模式，所有操作不会写入你的多维表格。',
  }
}

const MOCK_HINT = '也可以用示例数据先体验完整流程。'

/** 主题：跟随飞书 / 跟随系统，写入 <html data-theme> */
export function applyTheme(mode: 'auto' | 'light' | 'dark', feishuTheme?: 'light' | 'dark' | null): void {
  const root = document.documentElement
  if (mode === 'auto') {
    // 「自动」＝优先跟随**飞书自己的主题**，而不是只看系统偏好。
    // 两者可能不一致（飞书设了深色但系统是浅色），只依赖 prefers-color-scheme 会跟错。
    if (feishuTheme) {
      root.setAttribute('data-theme', feishuTheme)
    } else {
      // 拿不到飞书主题时才退回系统偏好（此时 CSS 的 @media 分支生效，所以不能设 attribute）
      root.removeAttribute('data-theme')
    }
  } else {
    root.setAttribute('data-theme', mode)
  }
  try {
    localStorage.setItem('bitableprint.ui.theme', mode)
  } catch {
    /* 隐私模式下 localStorage 可能不可用，忽略 */
  }
}

export function readStoredTheme(): 'auto' | 'light' | 'dark' {
  try {
    const v = localStorage.getItem('bitableprint.ui.theme')
    if (v === 'light' || v === 'dark' || v === 'auto') return v
  } catch {
    /* 忽略 */
  }
  return 'auto'
}

// ============================================================
// 飞书主题同步
// ============================================================

/**
 * 读飞书当前主题。
 *
 * 为什么不能只靠 `prefers-color-scheme`：飞书的主题是**用户级设置**，与操作系统主题可以不一致。
 * 用户在飞书里选了深色、系统还是浅色时，插件会渲染成浅色，跟宿主"两截颜色"，很扎眼。
 * 探针 P1 确认 `bridge.getTheme` 存在，所以这里优先用它。
 */
export async function readFeishuTheme(): Promise<'light' | 'dark' | null> {
  try {
    const mod = await import('@lark-base-open/js-sdk')
    const bridge = (mod as { bitable?: { bridge?: { getTheme?: () => Promise<unknown> } } }).bitable?.bridge
    if (typeof bridge?.getTheme !== 'function') return null
    const t = await bridge.getTheme()
    if (t === 'dark' || t === 'light') return t
    // 有些版本返回的是对象或大写枚举，做一轮宽容归一
    const s = String(t ?? '').toLowerCase()
    if (s.includes('dark')) return 'dark'
    if (s.includes('light')) return 'light'
    return null
  } catch {
    return null
  }
}

/** 订阅飞书主题变化，返回取消订阅函数（拿不到就返回 null） */
export async function onFeishuThemeChange(
  cb: (t: 'light' | 'dark') => void,
): Promise<null | (() => void)> {
  try {
    const mod = await import('@lark-base-open/js-sdk')
    const bridge = (mod as { bitable?: { bridge?: { onThemeChange?: (f: (e: unknown) => void) => unknown } } })
      .bitable?.bridge
    if (typeof bridge?.onThemeChange !== 'function') return null
    const off = bridge.onThemeChange((e: unknown) => {
      const s = String(JSON.stringify(e) ?? '').toLowerCase()
      if (s.includes('dark')) cb('dark')
      else if (s.includes('light')) cb('light')
    })
    return typeof off === 'function' ? (off as () => void) : null
  } catch {
    return null
  }
}
