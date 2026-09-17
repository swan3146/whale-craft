/**
 * whale_craft · 落地"Release 工作流修复"（`npm run release:workflow-fix`）
 * ============================================================================
 * 为什么需要它（老大 2026-09-17）：
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
  try { return { code: 0, out: execFileSync(cmd, args, { cwd: ROOT, stdio: 'pipe', encoding: 'utf8', shell: process.platform === 'win32' }).trim() } } catch (e) {
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
  console.log(`会做：把 scripts/release.workflow.yml 复制到 .github/workflows/release.yml →`)
  console.log(`      git add/commit → git push ${REMOTE} ${BRANCH}`)
  process.exit(0)
}

copyFileSync(TEMPLATE, TARGET)
ok('已写入 .github/workflows/release.yml')

const add = capture('git', ['add', '.github/workflows/release.yml'])
if (add.code !== 0) die(`git add 失败：${add.err || add.out}`)
const staged = capture('git', ['diff', '--cached', '--name-only'])
if (!staged.out) { ok('没有变化（可能刚才已经写过了）'); process.exit(0) }
const commit = capture('git', ['-c', 'user.name=yzi1b', '-c', 'user.email=yzi1b@qq.com', 'commit', '-m',
  'Release 工作流：删掉 npm 步骤（红叉来源）；产物改 zip；正文取 CHANGELOG（不再 --generate-notes）'])
if (commit.code !== 0) die(`git commit 失败：${commit.err || commit.out}`)
ok('已提交')

console.log(`  推送 ${REMOTE} → ${BRANCH} …`)
const push = capture('git', ['push', REMOTE, `HEAD:${BRANCH}`])
if (push.code !== 0) {
  const text = `${push.out}\n${push.err}`
  if (/workflow.*scope/i.test(text)) {
    die('推送被 GitHub 拒了：token 缺 `workflow` scope（原文见上）。\n'
      + '   ① 换一个带 workflow scope 的 token 重跑；或\n'
      + '   ② 直接把 scripts/release.workflow.yml 的内容粘到网页上的 .github/workflows/release.yml。')
  }
  die(`推送失败：\n${text}`)
}
ok(`已推送：${push.out.split('\n').slice(-2).join(' / ')}`)

if (token) {
  try {
    const repo = capture('git', ['config', '--get', 'remote.' + REMOTE + '.url']).out
    const m = /github\.com[/:]([^/]+)\/([^/.]+)/.exec(repo)
    if (m) {
      const url = `${API}/repos/${m[1]}/${m[2]}/contents/.github/workflows/release.yml?ref=${BRANCH}`
      const res = await fetch(url, { headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'user-agent': 'whale-craft' } })
      if (res.ok) {
        const content = Buffer.from((await res.json()).content, 'base64').toString('utf8')
        console.log(`\n远端 ${BRANCH} 上的 release.yml：${/npm publish/.test(content) ? '❌ 还含 npm publish' : '✅ 已无 npm publish'}`)
        console.log('下一次打 tag 就会：跑检查 → 出 zip → 用 CHANGELOG 当正文，不再碰 npm。')
      } else warn(`回读校验失败（${res.status}）`)
    }
  } catch (e) { warn(`回读校验跳过：${e.message}`) }
}
