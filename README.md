# BitablePrint · 飞书多维表格打印插件

面向**多维表格**单一场景的排版打印插件：把表格里的记录按自定义版式排成单据/清单，直接打印或导出 PDF。

- 形态：多维表格**侧边栏插件**（Base Extension / 自定义插件）
- 技术：Vite + React 18 + TypeScript，纯前端，无自建服务端
- 数据：业务数据零本地持久化；模板存于本多维表格内的 `_打印模板_` 表

---

## 一、功能概览

| 模块 | 说明 |
| --- | --- |
| **四步向导** | ① 选范围 → ② 选模板 → ③ 预览 → ④ 打印 / 导出 PDF |
| **可视化模板编辑器** | 拖拽摆放元素、撤销重做、样式面板、循环区可视化、表格行列与单元格合并 |
| **两类模板** | 记录模板（一条记录一份，如入库单/领料单）、视图模板（多条记录一份，如台账清单） |
| **模板骨架库** | 内置多个常用版式起点，字段按候选名自动尽量绑定 |
| **Word 模板导入** | 解析 `.docx` 还原版式、识别占位符与循环标签，并给出兼容性报告 |
| **渲染与分页引擎** | 表头跨页重复、表格跨页、分页符、系统变量（页码/日期等）、mm 精确排版 |
| **附件图片流水线** | 10 分钟临时链接、并发池限流、文件头解析尺寸、DPI 校验、缩略图 |

---

## 二、快速开始

```bash
npm install
npm run dev        # 开发服务器（host 0.0.0.0，允许 iframe 嵌入）
npm run build      # 类型检查 + 打包到 dist/
npm run typecheck  # 只做类型检查
npm run preview    # 预览构建产物
```

### 三种运行方式

| 方式 | 命令 / 地址 | 用途 |
| --- | --- | --- |
| **本地示例数据** | `http://localhost:5190/?mock=1` | 不连接飞书，用内置拟真数据（覆盖全部字段类型）跑通完整流程 |
| **在飞书里加载** | 多维表格 → 插件 → 自定义插件 → 填 `http://localhost:5190` | 真实数据、真实 SDK |
| **打包产物** | `npm run build` → `dist/` | 纯静态产物，部署到任意静态托管即可（**必须 HTTPS**，localhost 除外） |

> ⚠️ 插件靠 iframe 嵌入，所以 **dev server 不能设置 `X-Frame-Options` 或 CSP `frame-ancestors`**。
> `vite.config.ts` 里已确认没有设这两个头；以后加代理或中间件时注意别引入它们。

---

## 三、构建产物

`npm run build` 产出 `dist/`，结构如下：

```
dist/
├── index.html            ← 入口，位于 dist/ 根目录
└── assets/               ← JS / CSS（引用全部为相对路径 ./assets/...）
```

两条与部署相关的构建约定（**不要改**）：

- `vite.config.ts` 中 `base: './'` —— 产出相对路径。飞书把插件挂在子路径下，
  若用绝对路径 `/assets/...` 会被解析到飞书自己的域名上，导致资源 404、插件白屏。
- `package.json` 中 `"output": "dist"` —— 声明产物目录。

---

## 四、目录结构

```
src/
├── lib/                  领域模型、字段类型、数据源抽象、模板存储、并发池、附件流水线
├── render/               渲染与分页引擎（HTML 生成 / 版面计算 / 测量）
├── import/               Word(.docx) 模板导入解析
├── probe/                运行时能力探针
├── components/
│   ├── DataSanity.tsx    数据层自检
│   ├── wizard/           四步向导
│   └── editor/           在线模板编辑器（画布、面板、表格动作）
└── styles/               tokens.css（设计令牌）+ app.css

test/                     手写验证脚本（CDP 驱动的端到端与交互验证）
```

### 设计约定（改代码前请先读）

1. **尺寸一律用毫米（mm）** 存储与计算，只在写 CSS 时换算 px。禁止混用单位。
   换算函数在 `src/lib/types.ts`（`mmToPx` / `ptToMm` / `TWIPS_TO_MM` / `EMU_TO_PX`）。
2. **颜色一律用 `tokens.css` 的 CSS 变量**，禁止硬编码十六进制色值，否则暗黑模式必然出问题。
3. **侧边栏只有 320–400px 宽**：禁止横向滚动、禁止用 `<table>` 做布局、长文本必须 `ellipsis`。
4. **SDK 调用必须走 `DataSource` 接口**，不要在业务代码里直接 import SDK —— 否则插件在飞书外就没法调试。
5. **依赖已锁死**：`react` / `react-dom` / `jszip` / `@lark-base-open/js-sdk`。不要新增。
   特别地，不要用 html2canvas / jsPDF 做前端合成 PDF（中日韩字体与分页保真做不到）。
6. **双实现结构**：画布（`src/components/editor/Canvas.tsx`）与打印渲染（`src/render/html.ts`）
   是两条独立实现路径，**新增数据结构时两边都要接**，否则会出现"画布上对了、打印出来不对"。

---

## 五、测试

```bash
npm test                   # 核心纯逻辑
npm run test:skeleton      # 骨架库（结构 + 真渲染 + 字段绑定）
npm run test:lib           # 筛选 / 并发 / 模板存储
npm run test:render        # 分页与 HTML 生成
npm run test:import        # docx 解析与字段匹配
npm run test:e2e           # 浏览器端到端冒烟（CDP 驱动真实指针）
npm run test:all           # 统一跑全部分套件
```

> `test/e2e-*.mjs` 依赖 `test/fixtures/` 下的样例图片与样例模板 JSON —— 这些素材**不随仓库分发**，
> 需要自行准备后放入 `test/fixtures/` 才能跑通端到端用例。

---

## 六、已知边界

- 不做：飞书审批流打印、跨表关联字段展开、云端模板市场、服务端渲染 PDF、行业预置模板库。
- 暂不支持：嵌套循环区、页眉页脚内容还原。
- 云文档导出（PDF 存到飞书云盘）为后续增强项，需要额外申请 Drive 权限。
