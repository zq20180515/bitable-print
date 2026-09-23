import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import './styles/tokens.css'
import './styles/app.css'

const el = document.getElementById('root')
if (!el) throw new Error('#root not found')

/**
 * 只有一个入口：插件本体（四步向导 + 数据自检 + 探针）。
 *
 * ⚠️ 这里原来还有一个 `?mode=editor` 分支，把独立窗口渲染成 `EditorWindow`
 * （理由是要在开窗前把飞书 SDK 跳过 —— 编辑器只需要字段元数据 + 模板 JSON）。
 * 那条路**已经整体移除**（2026-09-21）：飞书代理了 `window.open`，窗口虽然开了但父窗口
 * 既没有句柄也没有 opener ⇒ postMessage / localStorage / window.name 三条回传通道同时断，
 * 只能靠"手动复制 → 回来粘贴"。现在编辑器是**插件内的全屏浮层**（见 `EditorOverlay`），
 * 与数据源在同一个文档里，保存直接走 SDK 落库 —— 整类跨窗口问题连同那个入口一起消失。
 *
 * ⇒ **不要再把 `?mode=editor` 加回来**。要改编辑器，改 `components/editor/EditorOverlay.tsx`。
 */
createRoot(el).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
