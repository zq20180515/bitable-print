/**
 * 一次性验证 .gitignore 的匹配语义。
 *
 * 为什么不在项目里直接跑：`bitable-print/` 根本不是 git 仓库
 * （既无 .git 也无上层仓库），`git check-ignore` 跑不了。
 * .gitignore 的匹配语义与仓库位置无关，所以在一个临时仓库里原样复制一份来验是等价的。
 */
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const GI_SRC = 'C:/Users/Administrator/WorkBuddy/2026-09-14-19-43-46/bitable-print/.gitignore'
const repo = mkdtempSync(join(tmpdir(), 'gi-check-'))

// 被测对象：[路径, 期望是否被忽略, 建成文件还是目录]
//
// 第三列不能省：profile 那条模式**结尾带斜杠**，而 gitignore 里结尾带斜杠表示
// 「只匹配目录」。如果把这些名字建成文件，用例会假失败（我第一版就踩了这个）。
const CASES = [
  // —— 手写源文件：必须入库（这是本次修正的核心）——
  ['test/e2e-smoke.mjs', false, 'file'],
  ['test/editor-interaction.mjs', false, 'file'],
  // ⚠️ 这里原来还有 paste-roundtrip / window-handshake / editor-window-wiring 三条 ——
  // 那三个脚本随"独立窗口编辑"整体删除（2026-09-21），用例一并撤掉。
  // 留着的话它们会变成"期望一个不存在的文件不被忽略"的假用例。
  ['test/editor-cell-edit.mjs', false, 'file'],
  ['test/loop-table-browser.mjs', false, 'file'],
  ['test/shot.mjs', false, 'file'],
  ['test/run-node-suites.mjs', false, 'file'],
  ['test/selftest.ts', false, 'file'],
  // —— 生成物：不入库 ——
  ['test/selftest.cjs', true, 'file'],
  ['test/skeleton-test.cjs', true, 'file'],
  ['test/code-elements-test.cjs', true, 'file'],
  ['test/.loop-table-merge-test.cjs', true, 'file'],
  ['test/.loop-table-probe.cjs', true, 'file'],
  // —— 历史残留 profile：不入库（都是目录）——
  ['.e2e-profile-mu18lxhk', true, 'dir'],
  ['.inter-profile-mu2sspxr', true, 'dir'],
  ['.paste-profile-mu2ush0w', true, 'dir'],
  ['.probe-profile', true, 'dir'],
  ['.shotw-profile-mu2micr3', true, 'dir'],
  ['.wh-profile-mu2julll', true, 'dir'],
  ['.cell-profile-abc', true, 'dir'],
  ['.loop-profile-abc', true, 'dir'],
  // —— 证据归档目录（`_*.txt` 盖不住目录，需单独一条）——
  ['_t5-evidence', true, 'dir'],
  ['_t6-evidence', true, 'dir'],
  // —— 子 agent 脚手架：`_` 前缀 = 非交付物，这组把"换扩展名"补齐 ——
  //    原来只忽略 `_*.txt` / `_*.log`，实际还会留下 .mjs / .cjs / .tmp / .err / .md。
  ['_cover.txt', true, 'file'],
  ['_sweep.txt', true, 'file'],
  ['_probe.mjs', true, 'file'],
  ['_t8.cjs', true, 'file'],
  ['_stat.tmp', true, 'file'],
  ['_v9.err', true, 'file'],
  ['_sec9.md', true, 'file'],
  // —— 反向对照 ②：`_` 前缀约定**不能**误伤 `src/` 下的自测源文件 ——
  //    `src/lib/__selftest.mts` 以 `_` 开头，扩展名是 `.mts`。`_*.mjs` / `_*.cjs`
  //    等模式只按各自扩展名匹配，不该命中它。这条防的是"哪天有人手一抖把 `_*`
  //    写成通配一切扩展名"，那会把四个自测源文件一起从版本库里抹掉。
  ['src/lib/__selftest.mts', false, 'file'],
  ['src/components/editor/__selftest.mts', false, 'file'],
  ['src/render/__selftest.mts', false, 'file'],
  ['src/import/__selftest.mts', false, 'file'],
  // —— 反向对照：正常文件/目录不该被误伤 ——
  ['src/main.tsx', false, 'file'],
  ['package.json', false, 'file'],
  ['test/readme.md', false, 'file'],
  ['src/render/html.ts', false, 'file'],
  ['src/components', false, 'dir'],
]

try {
  execFileSync('git', ['init', '-q'], { cwd: repo })
  copyFileSync(GI_SRC, join(repo, '.gitignore'))
  for (const [p, , kind] of CASES) {
    const abs = join(repo, p)
    if (kind === 'dir') mkdirSync(abs, { recursive: true })
    else {
      mkdirSync(join(abs, '..'), { recursive: true })
      writeFileSync(abs, 'x')
    }
  }

  let bad = 0
  for (const [p, wantIgnored, kind] of CASES) {
    let got = false
    let why = ''
    try {
      why = execFileSync('git', ['check-ignore', '-v', p], { cwd: repo, encoding: 'utf8' }).trim()
      got = true
    } catch {
      got = false // exit 1 = 未被忽略
    }
    const okMark = got === wantIgnored
    if (!okMark) bad++
    const label = wantIgnored ? '应忽略' : '应入库'
    console.log(`  ${okMark ? 'PASS' : 'FAIL'}  ${label}  ${(kind === 'dir' ? p + '/' : p).padEnd(36)} → ${got ? '被忽略' : '未忽略'}${why ? '  [' + why.split('\t').slice(0, 2).join('  ') + ']' : ''}`)
  }

  console.log(`\n${bad === 0 ? `全部通过：${CASES.length} 项` : `${bad} 项不符预期 / 共 ${CASES.length} 项`}`)
  process.exitCode = bad === 0 ? 0 : 1
} finally {
  rmSync(repo, { recursive: true, force: true })
}
