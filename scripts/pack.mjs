/**
 * 打包上传前的干净出包（2026-09-21）。
 *
 * ── 为什么要有它 ────────────────────────────────────────────────
 * 这个仓库根目录躺着 **800+ 个 `_` 前缀的临时产物**（探针脚本、命令输出落盘、证据归档、
 * 以及 `_removed-<date>/` 这种"删掉的东西的快照"）。它们在 `.gitignore` 里，git 不管它们，
 * 但**如果按目录打包上传，它们会一起上车** —— 审核看到一堆 `_removed-<date>/editor-window.ts`
 * 和 `_r14-*.txt`，被问一句"这些是什么"就够呛。
 *
 * ⇒ 与其靠人记得"打包时挑着选"，不如把"该上传什么"写死在脚本里：
 *   **只出 `dist/`**，并在出包前后各扫一遍，任何不该出现的路径直接报错退出。
 *
 * ── 用法 ───────────────────────────────────────────────────────
 *   node scripts/pack.mjs              # 构建 + 出 deploy/ + 出 zip
 *   node scripts/pack.mjs --no-build   # 复用现有 dist（不重新构建）
 *
 * 产出：
 *   deploy/                        ← **只有该上传的东西**，目录结构 = 站点根
 *   bitable-print-v<version>.zip   ← 上面那个目录的压缩包（上传用）
 *
 * ⚠️ 本脚本**不删任何东西**，只往 `deploy/` 与 zip 里写。跑多少次都安全。
 */
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import JSZip from 'jszip'

const ROOT = process.cwd()
const DIST = join(ROOT, 'dist')
const OUT = join(ROOT, 'deploy')
const noBuild = process.argv.includes('--no-build')

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))

/** 出包内容里**绝对不允许**出现的东西（按路径片段判） */
const FORBIDDEN = [
  { pat: /(^|\/)_/, why: '`_` 前缀的临时产物 / 快照目录（`_removed-*`、`_r14-*`、证据归档…）' },
  { pat: /(^|\/)test\//, why: '测试脚本（不进交付物）' },
  { pat: /(^|\/)src\//, why: '源码（交付物只该有构建产物）' },
  { pat: /(^|\/)scripts\//, why: '构建/出包脚本自身' },
  { pat: /node_modules/, why: '依赖目录' },
  { pat: /\.(ts|tsx|mts|map)$/, why: 'TypeScript 源或 sourcemap（会把源码暴露出去）' },
  { pat: /(^|\/)\.(git|workbuddy|env)/, why: '版本控制 / 工具链 / 环境文件' },
  { pat: /\.log$/, why: '日志' },
]

/** 审核时会看到的功能性文案 —— 只做**提示**，不判红（见末尾注释） */
const DEV_UI_MARKERS = ['探针', '数据自检', '开发者', '示例数据']

function run(cmd, args) {
  console.log(`\n$ ${cmd} ${args.join(' ')}`)
  execFileSync(cmd, args, { cwd: ROOT, stdio: 'inherit', shell: process.platform === 'win32' })
}

// ---------- 1. 构建 ----------
if (noBuild) {
  if (!existsSync(DIST)) {
    console.error('✗ 加了 --no-build 但 dist/ 不存在。先跑一次不带参数的。')
    process.exit(1)
  }
  console.log('（--no-build：复用现有 dist/）')
} else {
  run('npm', ['run', 'build'])
}

// ---------- 2. 收拢到 deploy/ ----------
rmSync(OUT, { recursive: true, force: true })
mkdirSync(OUT, { recursive: true })
cpSync(DIST, OUT, { recursive: true })

/** 递归列出 deploy/ 下所有文件（相对 deploy/ 的路径，正斜杠） */
function listFiles(dir, base = dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) listFiles(p, base, out)
    else out.push(relative(base, p).replace(/\\/g, '/'))
  }
  return out
}

const files = listFiles(OUT).sort()

// ---------- 3. 门禁：不该出现的东西一律判红 ----------
const violations = []
for (const f of files) {
  for (const { pat, why } of FORBIDDEN) {
    if (pat.test(f)) violations.push({ f, why })
  }
}
console.log(`\n=== deploy/ 内容（${files.length} 个文件）===`)
let total = 0
for (const f of files) {
  const size = statSync(join(OUT, f)).size
  total += size
  console.log(`  ${String(Math.round(size / 1024)).padStart(6)} KB  ${f}`)
}
console.log(`  合计 ${(total / 1024 / 1024).toFixed(2)} MB`)

if (violations.length) {
  console.error(`\n❌ deploy/ 里出现了不该出包的东西：`)
  for (const v of violations) console.error(`   · ${v.f}  ← ${v.why}`)
  process.exit(1)
}
console.log('\n✅ 出包门禁通过：没有 `_` 前缀产物 / 测试 / 源码 / sourcemap / 依赖目录')

// ---------- 4. 提示：审核会看到的调试界面 ----------
console.log('\n=== 审核视角自检（只提示，不判红）===')
const js = files.filter((f) => f.endsWith('.js')).map((f) => readFileSync(join(OUT, f), 'utf8'))
for (const marker of DEV_UI_MARKERS) {
  const n = js.reduce((acc, s) => acc + (s.split(marker).length - 1), 0)
  if (n > 0) {
    console.log(
      `  ⚠️ 包里含调试界面文案「${marker}」×${n} —— 审核员点开插件是**看得见**的（顶部「开发者」菜单）。`,
    )
  }
}
console.log('  （这是设计取舍，不是错误：要移除得改 App.tsx 的 DeveloperMenu 接线，见项目记忆 2026-09-21）')

// ---------- 5. 打 zip ----------
const zipName = `bitable-print-v${pkg.version}.zip`
const zipPath = join(ROOT, zipName)
const zip = new JSZip()
for (const f of files) zip.file(f, readFileSync(join(OUT, f)))
const buf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
writeFileSync(zipPath, buf)

console.log(`\n✅ 出包完成`)
console.log(`  目录：deploy/（${files.length} 个文件，${(total / 1024 / 1024).toFixed(2)} MB）`)
console.log(`  压缩包：${zipName}（${(buf.length / 1024 / 1024).toFixed(2)} MB）`)
console.log(`\n⚠️ 提醒：deploy/ 与 *.zip 也在 .gitignore 里；上传完可以随时删，脚本能重新生成。`)
