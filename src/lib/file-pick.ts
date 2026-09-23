/**
 * 单例文件选择器：**不依赖任何 React 节点**。
 *
 * ⚠️ 为什么必须这样（2026-09-23 真机反馈，绕了两轮才定位）：
 *
 * 面板里那个 `<input type="file">` 是**画在 React 树里的**。而系统文件对话框一弹，
 * 浏览器会因窗口失焦退出全屏，编辑器随之切换布局档（全屏档 ↔ 侧边栏档）——
 * 两档的宿主不同，React 会**卸载重建**那棵子树 ⇒ **那个 input 节点被换掉**。
 * 用户选完文件时，`change` 事件落在一个**已经不在 DOM 里**的节点上 ⇒ 回调不执行 ⇒
 * 表现为"选了图片没反应"（没有任何提示、图不出、面板也不更新）。
 *
 * 真机实测的旁证：**同一次会话里第二次选图是好的**（那时树已经稳定了）——
 * 这正是"只在切换的那个瞬间会丢"的特征。
 *
 * ⇒ 把 input 建在 `document.body` 上、用完即弃：React 怎么重挂都与它无关，`change` 必达。
 *
 * ⚠️⚠️ **收尾不能靠 `window` 的 focus 事件**（2026-09-23 我又在这里栽了一回）：
 *    第一版写的是"重新获得焦点后 400ms 就当作用户取消"，结果**抢在 `change` 前面把 promise 结了**，
 *    真正的 `change` 到了发现已结算就被丢弃。
 *    真机现象是最硬的反证：「**全屏时选图不生效，小窗状态下可以正常上传**」——
 *    同一份代码同一个文件，差别只在**时机**：退出全屏时浏览器要做一整套布局/fullscreen 收尾，
 *    `change` 被推到 400ms 之后才到 ⇒ 被我的兜底吃掉；小窗下没有这套收尾，`change` 来得快 ⇒ 正常。
 *
 * ⇒ 现在用**浏览器自己的取消信号** `cancel`（Chromium 113+ / Safari 16.4+ 在用户按取消时派发），
 *    它天然不会和 `change` 抢：选了文件只触发 change，按取消只触发 cancel。
 *    剩下的极端情况（既没有 change 也没有 cancel）用一条**很长的**兜底超时收尾 ——
 *    宁可留一个隐藏 input，也绝不猜"这会儿应该是取消了"。
 */
export function pickFile(accept: string): Promise<File | null> {
  return new Promise((resolve) => {
    /* 上一次调用如果因取消留在 DOM 里，先清掉（不依赖任何定时器猜时机） */
    for (const stale of Array.from(document.querySelectorAll('input[data-bp-filepick]'))) stale.remove()

    const input = document.createElement('input')
    input.type = 'file'
    input.accept = accept
    input.dataset.bpFilepick = '1'
    /* 不能让它在屏幕上可见：固定在视口外（`display:none` 会让部分浏览器不弹对话框） */
    input.style.position = 'fixed'
    input.style.left = '-10000px'
    input.style.top = '0'
    input.style.opacity = '0'

    let settled = false
    let safetyTimer = 0

    const cleanup = (): void => {
      window.clearTimeout(safetyTimer)
      input.remove()
    }
    const done = (file: File | null): void => {
      if (settled) return
      settled = true
      cleanup()
      resolve(file)
    }

    input.addEventListener('change', () => done(input.files?.[0] ?? null))
    /* 用户按"取消"：`cancel` 是唯一**不会和 change 抢**的信号 */
    input.addEventListener('cancel', () => done(null))
    /* 兜底：两者都没来（极老的浏览器 / 异常路径）。10 分钟，绝不抢在 change 前面 */
    safetyTimer = window.setTimeout(() => done(null), 10 * 60_000)

    document.body.appendChild(input)
    input.click()
  })
}
