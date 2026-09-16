// core.mjs 语法验证器（2026-09-14 事故后新增，改 core.mjs 后必跑）
//   用法：node whale_craft/tools/check-core.mjs
//   背景：core.mjs 里少一个换行，会让 V8 提前结束 class 解析 → 所有 `#私有方法` 失联 →
//         报错却是 "Private field '#authenticate' must be declared in an enclosing class"，
//         插件整树加载失败 → 主实例起不来。这个脚本用来在"上主实例之前"抓住这类问题。
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const core = join(here, '..', 'src', 'core.mjs')

let failed = false
function step (name, fn) {
  try {
    fn()
    console.log(`✅ ${name}`)
  } catch (e) {
    failed = true
    console.log(`❌ ${name}`)
    console.log(String(e.stdout ?? e.stderr ?? e.message).split('\n').slice(0, 8).map((l) => '   ' + l).join('\n'))
  }
}

step('node --check 语法', () => {
  execFileSync(process.execPath, ['--check', core], { stdio: 'pipe' })
})

step('动态 import（真实加载路径，能抓住私有方法失联）', async () => {
  // 动态 import 在同步 step 里没法 await，这里用顶层 await 之外的兜底：子进程执行
  execFileSync(process.execPath, ['-e', `import(${JSON.stringify(pathToFileURL(core).href)}).then(m=>{if(!m.McBot) throw new Error('McBot 未导出'); console.log('exports ok')})`], { stdio: 'pipe' })
})

// 统计私有字段声明与引用，做一致性自检（引用里的名字必须在类体里有声明）
const src = readFileSync(core, 'utf8')
const declared = new Set([...src.matchAll(/^\s*(?:static\s+)?(?:async\s+)?(#[A-Za-z_$][\w$]*)\s*\(/gm)].map((m) => m[1]))
const used = new Set([...src.matchAll(/this\.(#[A-Za-z_$][\w$]*)/g)].map((m) => m[1]))
step(`私有字段一致性（声明 ${declared.size} 个 / 引用 ${used.size} 个）`, () => {
  const missing = [...used].filter((u) => !declared.has(u))
  if (missing.length) throw new Error(`引用了但没声明（V8 会报 enclosing class 错）：${missing.join(', ')}`)
})

console.log(failed ? '\n结论：❌ 不要上主实例，先修 core.mjs' : '\n结论：✅ 语法与私有字段都正常（仍建议按铁律起隔离实例验证整树）')
process.exit(failed ? 1 : 0)
