/**
 * 并发控制池 / 串行链。
 *
 * 为什么必须自己控速（PRD 0.3 的硬约束）：
 * 1) 官方对批量上传接口（`batchUploadFile`）**明确禁止并发**，附件下载侧也只建议 4–5 并发；
 * 2) 侧边栏 iframe 内存有限，一次发 200 个图片请求会直接打爆；
 * 3) 用户随时可能点「取消加载」（F1-17）或导出中途取消（E-52），
 *    所以**排队中**与**执行中**的任务都必须能被 AbortSignal 打断。
 *
 * 关键设计取舍：
 * - 取消时立刻让调用方的 Promise 变成 AbortError，但**并发额度要等底层任务真正结束才释放**。
 *   否则"已取消"的请求其实还在网络里飞，池子却继续放新任务进来，
 *   真实并发数会超过 limit —— 限流保护就形同虚设。
 * - 任务函数统一收到一个 AbortSignal：不关心取消的任务直接忽略它即可，
 *   这样避免"有的任务收 signal、有的不收"两套签名。
 * - 本文件不依赖任何 SDK / DOM / 网络，可被 Node 单测直接跑（见 __selftest.mts）。
 */

/** 取消类错误。不用 DOMException 是为了在 Node 与浏览器下行为一致、且便于 isAbortError 判定 */
export function abortError(message = '已取消'): Error {
  const err = new Error(message)
  err.name = 'AbortError'
  return err
}

/** 判定是否为"取消"引起的失败：调用方应该静默处理（E-47 / E-52），不要弹错误 */
export function isAbortError(e: unknown): boolean {
  return !!e && typeof e === 'object' && (e as { name?: unknown }).name === 'AbortError'
}

export type PoolTask<T> = (signal: AbortSignal) => Promise<T> | T

export interface Pool {
  /** 并发上限（非法入参会退化为 1） */
  readonly limit: number
  /** 正在执行的任务数 */
  readonly active: number
  /** 排队中的任务数 */
  readonly pending: number
  /**
   * 提交一个任务。超过 limit 时排队。
   * @param task  收到 signal 后应把它透传给底层请求，取消才真正生效
   * @param signal 取消信号：排队中被取消 → 任务**根本不会启动**；执行中被取消 → 立刻以 AbortError 拒绝
   */
  run<T>(task: PoolTask<T>, signal?: AbortSignal): Promise<T>
  /** 等待池子跑空（active=0 且无排队）。打印/导出结束前用它确认所有图片已收尾 */
  onIdle(): Promise<void>
}

/** 给"不关心取消"的任务用的空 signal（永不触发），避免任务里到处写 `signal?` */
const NEVER_ABORT: AbortSignal = new AbortController().signal

class ConcurrencyLimiter implements Pool {
  readonly limit: number

  private _active = 0
  /** 队列里存的是"启动函数"，而不是任务本身：这样取消时可以直接把它摘掉 */
  private readonly queue: Array<() => void> = []
  private readonly idleWaiters: Array<() => void> = []

  constructor(limit: number) {
    // limit 非法（NaN / 0 / 负数 / 小数）时退化为 1：宁可慢，也绝不能变成"无限制"
    const n = Math.floor(limit)
    this.limit = Number.isFinite(n) && n >= 1 ? n : 1
  }

  get active(): number {
    return this._active
  }

  get pending(): number {
    return this.queue.length
  }

  run<T>(task: PoolTask<T>, signal?: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      // 已经取消：连排队都不必，直接拒绝（否则调用方会以为任务还在进行）
      if (signal?.aborted) {
        reject(abortError())
        return
      }

      let settled = false
      const finish = (fn: () => void): void => {
        if (settled) return
        settled = true
        signal?.removeEventListener('abort', onAbort)
        fn()
      }

      const onAbort = (): void => {
        // 仍在排队 → 从队列里摘掉并补位，任务函数一次都不会被调用
        const i = this.queue.indexOf(start)
        if (i >= 0) {
          this.queue.splice(i, 1)
          this.pump()
        }
        finish(() => reject(abortError()))
      }

      const start = (): void => {
        if (settled) {
          // 极端时序：刚出队就被取消。名额要还回去
          this.pump()
          return
        }
        this._active += 1
        let p: Promise<T>
        try {
          p = Promise.resolve(task(signal ?? NEVER_ABORT))
        } catch (e) {
          p = Promise.reject(e)
        }
        p.then(
          (v) => finish(() => resolve(v)),
          (e) => finish(() => reject(e)),
        ).finally(() => {
          this._active -= 1
          this.pump()
        })
      }

      signal?.addEventListener('abort', onAbort, { once: true })
      // 补一次竞态检查：信号可能在上面那次判断之后、挂监听之前就被取消了，
      // 那种情况下浏览器不会再补发 abort 事件，只能自己发现。
      if (signal?.aborted) {
        onAbort()
        return
      }
      this.queue.push(start)
      this.pump()
    })
  }

  onIdle(): Promise<void> {
    if (this._active === 0 && this.queue.length === 0) return Promise.resolve()
    return new Promise<void>((resolve) => {
      this.idleWaiters.push(resolve)
    })
  }

  /** 只要能启动就一直启动（上限是 limit），并在彻底空转时唤醒 onIdle 的等待者 */
  private pump(): void {
    while (this._active < this.limit && this.queue.length > 0) {
      const start = this.queue.shift() as () => void
      start()
    }
    if (this._active === 0 && this.queue.length === 0 && this.idleWaiters.length > 0) {
      const waiters = this.idleWaiters.splice(0)
      for (const w of waiters) w()
    }
  }
}

/** 并发池。图片下载建议 4；任何"官方未明说可并发"的接口一律用串行链 */
export function createPool(limit: number): Pool {
  return new ConcurrencyLimiter(limit)
}

/**
 * 串行链：limit=1 的池。
 *
 * 单独给一个函数而不是让调用方写 `createPool(1)`，是为了把语义写在名字里：
 * **用它 = 这个接口不能并发，任何时刻只允许一个在飞。**
 */
export function createSerialChain(): Pool {
  return new ConcurrencyLimiter(1)
}

/**
 * 全局上传串行链。
 *
 * 官方"批量上传禁止并发"是**进程级**约束，不是"每个调用方各自串行"——
 * 如果 A 模块和 B 模块各 createSerialChain() 一条，两者仍会同时上传。
 * 所以导出一个共享单例，业务代码必须用它（导出 PDF 到云文档时走这里，见 F5-22）。
 */
export const uploadChain: Pool = createSerialChain()
