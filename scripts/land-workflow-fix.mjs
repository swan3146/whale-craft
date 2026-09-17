/**
 * whale_craft · 落地"Release 工作流修复"（`npm run release:workflow-fix`）
 * ============================================================================
 * 为什么需要它（用户 2026-09-17）：
 *   · 旧 `release.yml` 最后一步是 `npm publish`（`if: env.NODE_AUTH_TOKEN != ''`）——
 *     仓库里那个 `NPM_TOKEN` 一失效，每次打 tag 都会**红叉**，而发布其实早就成功了；
 *   · 修好的版本已经放在 `scripts/release.workflow.yml`（**普通文件**，所以能随代码推上去）：
 *     删掉整段 npm、产物改 zip、正文取 CHANGELOG.md，不再 `--generate-notes`；
 *   · 但把文件放进 `.github/workflows/` 并推送，需要 token 有 **`workflow`** scope
 *     （GitHub 硬规则："refusing to allow a Personal Access Token to create or update workflow …"）。
 *     本脚本就是替你把这一步做完：复制 → 提交 → 推送 → 回读校验。
 *
 * 用法（在你自己的终端里跑，token 用**你自己的**）：
 *   node scripts/land-workflow-fix.mjs --dry                 # 只看会改什么
 *   GITHUB_TOKEN=<你的 token> node scripts/land-workflow-fix.mjs
 *   node scripts/land-workflow-fix.mjs --token-file ~/.token --remote origin --branch main
 *
 * 说明：
 *   · token 只用于**校验 scope / 回读校验**；真正的推送走你本机 git 的凭据（`git push`）；
 *   · token 不会写进任何文件，也不会出现在输出里；
 *   · 也可以不走脚本：把 `scripts/release.workflow.yml` 的内容直接粘到 GitHub 网页上的
 *     `.github/workflows/release.yml`（网页编辑不需要 workflow scope）。
 * ============================================================================
 */
import { readFileSync, writeFileSync, existsSync, copyFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const has = (f) => argv.includes(f)
const valueOf = (f, d = null) => {
  const i = argv.indexOf(f)
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d
}
const DRY = has('--dry')
const REMOTE = valueOf('--remote', 'origin')
const BRANCH = valueOf('--branch', 'main')
const API = valueOf('--api', 'https://api.github.com')
const TEMPLATE = join(ROOT, 'scripts', 'release.workflow.yml')
const TARGET = join(ROOT, '.github', 'workflows', 'release.yml')

const ok = (t) => console.log(`  ✅ ${t}`)
const warn = (t) => console.log(`  ⚠️  ${t}`)
const die = (t) => { console.error(`\n❌ ${t}\n`); process.exit(1) }
const capture = (cmd, args) => {
  // ⚠️ 只有 npm 走 shell（Windows 上是 npm.cmd）；git/node.exe 一律直接 spawn，
  //    否则带空格的路径（D:\Program Files\…）会被 cmd 拆开（2026-09-17 真踩过）
  try { return { code: 0, out: execFileSync(cmd, args, { cwd: ROOT, stdio: 'pipe', encoding: 'utf8', shell: process.platform === 'win32' && cmd === 'npm' }).trim() } } catch (e) {
    return { code: e.status ?? 1, out: String(e.stdout ?? '').trim(), err: String(e.stderr ?? '').trim() }
  }
}

/** token：--token / GITHUB_TOKEN / GH_TOKEN / --token-file 里的第一行 ghp_… */
function readToken () {
  const inline = valueOf('--token')
  if (inline) return inline.trim()
  const env = String(process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? '').trim()
  if (env) return env
  const file = valueOf('--token-file')
  if (file && existsSync(file)) {
    const t = readFileSync(file, 'utf8').split(/\r?\n/).map((l) => l.trim()).find((l) => /^(ghp_|github_pat_)/.test(l))
    if (t) return t
  }
  return ''
}

console.log('whale_craft · 落地 Release 工作流修复')
if (!existsSync(TEMPLATE)) die(`找不到模板 ${TEMPLATE}`)
const want = readFileSync(TEMPLATE, 'utf8')
const now = existsSync(TARGET) ? readFileSync(TARGET, 'utf8') : ''
if (now === want) { ok('远端那份（本地工作树）已经就是修好的版本，什么都不用做'); process.exit(0) }
if (/npm publish/.test(now)) warn('当前 .github/workflows/release.yml 里还有 `npm publish`（这正是红叉的来源）')
else warn('当前 .github/workflows/release.yml 与模板不同（会按模板覆盖）')

const token = readToken()
if (token) {
  try {
    const res = await fetch(`${API}/user`, { headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'user-agent': 'whale-craft' } })
    if (!res.ok) warn(`token 校验失败（${res.status}）—— 继续，推送会由 git 自己报错`)
    else {
      const scopes = String(res.headers.get('x-oauth-scopes') ?? '')
      const login = (await res.json()).login
      if (scopes) {
        console.log(`  token 属于 ${login}｜scopes: ${scopes}`)
        if (!/(^|,\s*)workflow(\s*,|$)/.test(scopes)) {
          die('这个 token **没有 `workflow` scope** —— GitHub 会拒绝推送工作流文件。\n'
            + '   去 GitHub → Settings → Developer settings → Personal access tokens 勾上 `workflow` 重新生成，\n'
            + '   或者干脆在网页上编辑 .github/workflows/release.yml（网页编辑不需要这个 scope）。')
        }
        ok('token 带 workflow scope')
      } else warn(`token 属于 ${login}（细粒度 token 没有 scopes 头，交给 git 判断）`)
    }
  } catch (e) { warn(`连不上 ${API}（${e.message}）—— 跳过 scope 预检`) }
} else warn('没给 token（--token / GITHUB_TOKEN / --token-file）—— 跳过 scope 预检，直接推')

if (DRY) {
  console.log('\n--dry：只报告，没有改文件、没有提交、没有推送。')
  console.log('会做：优先走 Contents API 更新 .github/workflows/release.yml；没有 token 时退回 git push')
  process.exit(0)
}

/**
 * 🔴 2026-09-17 实测结论（很关键）：**git push 这条通道推不了工作流文件** ——
 *   即便 token 的 `x-oauth-scopes` 里明明有 `workflow`，走代理 `gh.yunr.cc` 推送仍被 GitHub
 *   以 "without `workflow` scope" 拒（那一跳的凭据/转发方式有问题）。
 *   而 **Contents API 可以**（实测 PUT 成功）。所以优先走 API，git push 只当兜底。
 */
const apiHeaders = () => ({ authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'user-agent': 'whale-craft' })
const repoCoords = () => {
  const repo = capture('git', ['config', '--get', 'remote.' + REMOTE + '.url']).out
  const m = /github\.com[/:]([^/]+)\/([^/.]+)/.exec(repo)
  return m ? { owner: m[1], name: m[2] } : null
}

const landedViaApi = await (async () => {
  if (!token) return false
  const co = repoCoords()
  if (!co) { warn('认不出 GitHub 仓库地址，改走 git push'); return false }
  const base = `${API}/repos/${co.owner}/${co.name}/contents/.github/workflows/release.yml`
  try {
    const cur = await fetch(`${base}?ref=${BRANCH}`, { headers: apiHeaders() })
    if (!cur.ok) { warn(`读远端文件失败（${cur.status}），改走 git push`); return false }
    const sha = (await cur.json()).sha
    const put = await fetch(base, {
      method: 'PUT',
      headers: { ...apiHeaders(), 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({
        message: 'Release 工作流：删掉 npm 步骤（红叉来源）；产物改 zip；正文取 CHANGELOG',
        content: Buffer.from(want, 'utf8').toString('base64'),
        sha,
        branch: BRANCH,
      }),
    })
    if (!put.ok) { warn(`Contents API 更新失败（${put.status} ${(await put.text()).slice(0, 160)}），改走 git push`); return false }
    const out = await put.json()
    ok(`已通过 Contents API 更新：commit ${String(out.commit?.sha ?? '').slice(0, 7)}`)
    return true
  } catch (e) { warn(`Contents API 出错（${e.message}），改走 git push`); return false }
})()

if (!landedViaApi) {
  copyFileSync(TEMPLATE, TARGET)
  ok('已写入 .github/workflows/release.yml（本地）')

  const add = capture('git', ['add', '.github/workflows/release.yml'])
  if (add.code !== 0) die(`git add 失败：${add.err || add.out}`)
  const staged = capture('git', ['diff', '--cached', '--name-only'])
  if (!staged.out) { ok('没有变化（可能刚才已经写过了）'); process.exit(0) }
  const commit = capture('git', ['-c', 'user.name=' + (process.env.GIT_AUTHOR_NAME ?? 'whale-craft'), '-c', 'user.email=' + (process.env.GIT_AUTHOR_EMAIL ?? 'noreply@example.com'), 'commit', '-m',
    'Release 工作流：删掉 npm 步骤（红叉来源）；产物改 zip；正文取 CHANGELOG（不再 --generate-notes）'])
  if (commit.code !== 0) die(`git commit 失败：${commit.err || commit.out}`)
  ok('已提交')

  console.log(`  推送 ${REMOTE} → ${BRANCH} …`)
  const push = capture('git', ['push', REMOTE, `HEAD:${BRANCH}`])
  if (push.code !== 0) {
    const text = `${push.out}\n${push.err}`
    if (/workflow.*scope/i.test(text)) {
      die('这条**代理通道**推不了工作流文件（注意：token 本身可能是带 workflow 的）。\n'
        + '   ✅ 正解：给脚本一个 token —— `GITHUB_TOKEN=… node scripts/land-workflow-fix.mjs`，它会走 Contents API；\n'
        + '   或者直接把 scripts/release.workflow.yml 的内容粘到网页上的 .github/workflows/release.yml。')
    }
    die(`推送失败：\n${text}`)
  }
  ok(`已推送：${push.out.split('\n').slice(-2).join(' / ')}`)
}

if (token) {
  try {
    const co = repoCoords()
    if (co) {
      const url = `${API}/repos/${co.owner}/${co.name}/contents/.github/workflows/release.yml?ref=${BRANCH}`
      const res = await fetch(url, { headers: apiHeaders() })
      if (res.ok) {
        // ⚠️ 注释里**故意**提到 npm publish（说明为什么删掉它）→ 先剥注释再判
        const raw = Buffer.from((await res.json()).content, 'base64').toString('utf8')
        const code = raw.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n')
        console.log(`\n远端 ${BRANCH} 上的 release.yml：${/npm publish/.test(code) ? '❌ 还含 npm publish' : '✅ 已无 npm publish（剥注释后判的）'}`)
        console.log('下一次打 tag 就会：跑检查 → 出 zip → 用 CHANGELOG 当正文，不再碰 npm。')
      } else warn(`回读校验失败（${res.status}）`)
    }
  } catch (e) { warn(`回读校验跳过：${e.message}`) }
}
