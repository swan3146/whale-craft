// -*- coding: utf-8 -*-
/**
 * 插件自检：用假 ctx 加载 whale_craft 的 apply()，检查
 *   - Config schema 能否解析
 *   - 工具是否全部注册（名字/参数形态）
 *   - 🔴 **每会话实例分离**：两个不同 agent 拿到的 bot 必须是不同对象；
 *     同一 agent 反复调用必须复用同一个 bot。
 *   - 未连接时调工具应给出清晰错误而不是崩
 * 不连 MC、不动真实实例。
 *
 * 用法：node whale_craft/selfcheck.mjs
 */
// 自检不许污染生产状态：日志、记忆库、全局配置都改到自检专用位置
process.env.MC_LOG = new URL('./logs/selfcheck.log', import.meta.url).pathname.replace(/^\//, '')
{
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const whaleTmp = mkdtempSync(join(tmpdir(), 'whale-craft-'))
  process.env.WHALE_CRAFT_DIR = whaleTmp                 // 配置 + 记忆的固定文件夹
  process.env.WHALE_CRAFT_MEMORY_DIR = join(whaleTmp, 'memory')
}

const tools = new Map()
const logs = []
const registeredRoutes = []
const archivedSessions = []
const injectedContexts = []
const injectedFibers = []
const guards = []              // ctx.tools.guard 注册的守卫（MC 模式硬拦截靠它）
const eventHandlers = []       // ctx.on 注册的事件（agent/created 等）
const presetByCtx = new Map()  // 模拟宿主 agentPresets：agent.ctx → preset id
const presetRows = ['minimal', 'standard', 'ptc']   // 模拟"现有哪些 preset"（官方随包那三个）
const presetCopyCalls = []     // 自动建 preset 时对宿主 copy() 的调用
const { mkdtempSync: mkTop, existsSync: exTop, readFileSync: rfTop } = await import('node:fs')
const { tmpdir: tdTop } = await import('node:os')
const { join: jnTop } = await import('node:path')
/** 假"用户可写 preset 根"：自动建 preset 时把目录 / preset.yml 真写在这里，好断言内容 */
const presetUserRoot = mkTop(jnTop(tdTop(), 'whale-presets-'))
/** 假"官方随包 preset 根"：`list()` 要给出**真实存在**的组成文件路径（否则读不到组成、hash 只能是 null） */
const shippedRoot = mkTop(jnTop(tdTop(), 'whale-shipped-'))
const SHIPPED_DESC = {
  minimal: '仅提供持久 shell 的单工具编码 Agent。',
  standard: '功能完整的编码 Agent，支持文件编辑、Shell、文件与网页检索、Skills、计划、目标、子代理和工作流。',
  ptc: '功能完整的编码 Agent，但默认不提供 workflow 工具。',
}
/** id → 组成文件真实路径（copy 之后指到用户根那份） */
const presetPaths = new Map()
{
  const { mkdirSync, writeFileSync } = await import('node:fs')
  for (const [id, d] of Object.entries(SHIPPED_DESC)) {
    const dir = jnTop(shippedRoot, id)
    mkdirSync(dir, { recursive: true })
    // ⚠️ `minimal` 要写成**像真的**那份：带 persona 行（含 `complete: true`）和一个持久 shell 组 ——
    //    不然"复制完要改 persona / 关 shell"那两条集成断言就是假绿（2026-09-16 吃过一次假绿的亏）
    const comp = id === 'minimal'
      ? [
        '# The `minimal` agent preset: a fixed-prompt, single-tool coding-agent composition.',
        '',
        '- id: persona',
        "  name: '@deepseek-ai/dsh-persona'",
        '  config:',
        '    prefix: You are a helpful software engineer assistant.',
        '    complete: true',
        '    includeRuntimeContext: false',
        '',
        '- id: persistent-shell',
        '  name: cordis:group',
        '  group: true',
        '  isolate:',
        '    terminals: true',
        '  config:',
        '    - id: pty',
        "      name: '@deepseek-ai/dsh-terminal'",
        '',
      ].join('\n')
      : `# ${id} composition\n`
    writeFileSync(jnTop(dir, 'agent.cordis.yml'), comp, 'utf8')
    writeFileSync(jnTop(dir, 'preset.yml'), `name: ${id}\ndescription: ${JSON.stringify(d)}\n`, 'utf8')
    presetPaths.set(id, jnTop(dir, 'agent.cordis.yml'))
  }
}
/** 假宿主的"读元数据"：user 根里那份读 preset.yml，官方的读 SHIPPED_DESC */
const fakeDescriptionOf = (id) => {
  const p = jnTop(presetUserRoot, id, 'preset.yml')
  if (exTop(p)) {
    const m = /^description:\s*"?(.*?)"?\s*$/m.exec(rfTop(p, 'utf8'))
    if (m) return m[1]
  }
  return SHIPPED_DESC[id]
}

// ── 超时保护单元验证（"停不下来"根因修复的核心机制）──
console.log('--- withTimeout / raceAbort 单元验证 ---')
const { withTimeout, raceAbort } = await import('./src/core.mjs')

const never = new Promise(() => {})           // 永不 settle：模拟服务端不回 ack
const t0 = Date.now()
try {
  await withTimeout(never, 300, '永不返回的挖方块')
  console.log('  ❌ 竟然没超时')
} catch (e) {
  const ms = Date.now() - t0
  console.log(`  ✅ 永不 settle 的 promise ${ms}ms 后抛错：${e.message.slice(0, 60)}…`)
  console.log(`  ${e.mcTimeout === true ? '✅' : '❌'} 错误带 mcTimeout 标记（供 #t 松控制位用）`)
}

// 正常返回的 promise 必须原样透传，不能被误杀
const ok = await withTimeout(Promise.resolve({ placed: 'oak_planks' }), 300, '正常放置')
console.log(`  ${ok?.placed === 'oak_planks' ? '✅' : '❌'} 正常 promise 原样透传（不误杀）`)

// 业务错误不能被包装成超时
try {
  await withTimeout(Promise.reject(new Error('背包里没有 oak_planks')), 300, '缺物')
} catch (e) {
  console.log(`  ${e.mcTimeout ? '❌ 业务错误被误标为超时' : '✅ 业务错误原样透传'}：${e.message}`)
}

// raceAbort：用户按"停止"（signal abort）必须**立刻**结算，而不是等本地超时
{
  const ac = new AbortController()
  const t = Date.now()
  setTimeout(() => ac.abort({ kind: 'user' }), 120)
  try {
    await raceAbort(never, ac.signal, '走路')       // 本地超时远大于 120ms
    console.log('  ❌ abort 竟然没生效')
  } catch (e) {
    const ms = Date.now() - t
    console.log(`  ${e.mcAborted && ms < 1000 ? '✅' : '❌'} 停止信号 ${ms}ms 内中断（不等本地超时）：${e.message}`)
  }
}
// 已 abort 的 signal，调用时立即抛
{
  const ac = new AbortController(); ac.abort()
  try { await raceAbort(never, ac.signal, '已取消'); console.log('  ❌ 已 abort 未立即抛') }
  catch (e) { console.log(`  ${e.mcAborted ? '✅' : '❌'} 已 abort 的 signal 立即抛错（不产生悬空 await）`) }
}

const fakeCtx = {
  logger: {
    info: (m) => logs.push('[info] ' + m),
    warn: (m) => logs.push('[warn] ' + m),
    debug: (m) => logs.push('[debug] ' + m),
  },
  tools: {
    register: (def) => { tools.set(def.name, def); return () => {} },
    guard: (fn) => { guards.push(fn); return () => {} },
  },
  // 宿主 agentPresets 服务：判断"是不是 MC 模式"要用它；自动建 preset 也走它
  agentPresets: {
    composedPreset: (agentCtx) => presetByCtx.get(agentCtx),
    authorable: true,
    defaultId: 'standard',
    roots: [{ path: presetUserRoot, trust: 'user' }],
    list: async () => [...presetPaths.keys()].map((id) => ({
      id,
      trust: presetPaths.get(id).startsWith(presetUserRoot) ? 'user' : 'shipped',
      path: presetPaths.get(id),
      description: fakeDescriptionOf(id),
    })),
    copy: async (from, id, name) => {
      presetCopyCalls.push([from, id, name])
      // 假宿主真的把目录复制出来（组成也从源拷一份），这样插件随后写 preset.yml/标记 才有地方落
      const { mkdirSync, writeFileSync, readFileSync } = await import('node:fs')
      const dir = jnTop(presetUserRoot, id)
      mkdirSync(dir, { recursive: true })
      const srcComp = presetPaths.get(from)
      const body = srcComp && exTop(srcComp) ? readFileSync(srcComp, 'utf8') : `# ${id} composition\n`
      const comp = jnTop(dir, 'agent.cordis.yml')
      writeFileSync(comp, body, 'utf8')
      presetPaths.set(id, comp)
      // 官方 copy() 的行为：只改 name、**保留源简介**（这正是那个 bug 的来源）
      writeFileSync(jnTop(dir, 'preset.yml'), `name: ${name ?? id}\ndescription: ${JSON.stringify(SHIPPED_DESC[from] ?? '')}\n`, 'utf8')
    },
  },
  webServer: { register: (route) => { registeredRoutes.push(route); return () => {} } },
  // 必须在 apply 之前就在，否则归档保护的包装装不上
  workspaceRegistry: { archiveSession: async (sid) => { archivedSessions.push(String(sid)) } },
  // 系统提示：收集插件注册的动态 context（"总索引自动注入"就靠它）
  systemPrompt: {
    context: (c) => { injectedContexts.push(c); return () => {} },
    section: () => () => {},
    getContextOrder: () => 100,
    getSectionOrder: () => 100,
  },
  // 服务迟到时走这条路
  inject: (deps, cb) => { injectedFibers.push({ deps, cb }) },
  effect: (fn) => { try { fn() } catch (e) { logs.push('[effect error] ' + e.message) } },
  set: (k, v) => { fakeCtx[k] = v },
  // 没有 jobs 服务：验证看门狗在缺服务时报错清晰（不崩）
  get: (k) => (k === 'jobs' || k === 'sessionController' ? undefined : fakeCtx[k]),
  on: (ev, fn) => { eventHandlers.push({ ev, fn }); return () => {} },
}

const mod = await import('./index.js')
console.log('插件导出:', Object.keys(mod).join(', '))

const config = mod.Config ? mod.Config({}) : {}
console.log('Config 解析结果:', JSON.stringify(config, null, 1))

try {
  mod.apply(fakeCtx, config)
} catch (e) {
  console.error('❌ apply 抛错:', e.message)
  console.error(e.stack?.split('\n').slice(0, 5).join('\n'))
  process.exit(1)
}

console.log(`\n✅ 注册工具 ${tools.size} 个：`)
for (const [n, d] of tools) {
  const params = Object.keys(d.parameters ?? {})
  console.log(`  ${n}${params.length ? ' (' + params.join(', ') + ')' : ''} —— ${String(d.description ?? '').slice(0, 50)}`)
}

/** 造一个假的 exec（带会话身份），工具靠它路由到各自的实例 */
const execAs = (id) => ({ agent: { id } })

// ── 实例分离验证：靠 mc_diag 的 connection/stats 看不出来，改用 mc_sessions 列实例 ──
console.log('\n--- 每会话实例分离 ---')
const A = execAs('sess-A')
const B = execAs('sess-B')

await tools.get('mc_status').execute({}, A)
await tools.get('mc_status').execute({}, A)   // 同一会话再来一次，应复用
await tools.get('mc_status').execute({}, B)

const sess = await tools.get('mc_sessions').execute({}, A)
console.log('  活跃实例:', JSON.stringify(sess.sessions.map((s) => s.agentId)))
const ids = sess.sessions.map((s) => s.agentId).sort().join(',')
if (ids === 'sess-A,sess-B') console.log('  ✅ 两个会话各自一个独立实例（互不干扰）')
else console.log('  ❌ 实例隔离异常，期望 sess-A,sess-B，实际', ids)

// 没有 exec 时必须清晰报错（而不是静默用错实例）
try {
  await tools.get('mc_status').execute({})
  console.log('  ❌ 无 exec 竟然成功了（应报错）')
} catch (e) { console.log('  ✅ 无 exec 时清晰报错：', e.message) }

// ── 未连接时的行为 ──
console.log('\n--- 未连接时的行为 ---')
for (const n of ['mc_status', 'mc_map', 'mc_say', 'mc_connect']) {
  try {
    const r = await tools.get(n).execute(n === 'mc_say' ? { message: 'hi' } : {}, A)
    console.log(`  ${n} → ${JSON.stringify(r).slice(0, 140)}`)
  } catch (e) {
    console.log(`  ${n} → 抛错：${e.message}`)
  }
}

// ── 看门狗（v2）：挂载 / 配置 / 叫法 / 卸载 ──
console.log('\n--- 看门狗 v2 ---')
{
  // 没挂时：status 应是 armed:false，且能看清默认配置
  const s0 = await tools.get('mc_watch').execute({}, A)
  console.log(`  ${s0.armed === false ? '✅' : '❌'} 初始未挂载；配置项 ${Object.keys(s0.config ?? {}).length} 个`)

  // 唤醒矩阵默认值抽查（用户逐条问过的那些）
  const w = s0.config.wakeOn
  const want = {
    damage: true, death: true, teleport: true,   // 默认叫醒
    pushed: false, itemPickup: false,            // 默认只记档
  }
  const bad = Object.entries(want).filter(([k, v]) => w[k] !== v)
  console.log(bad.length
    ? `  ❌ 唤醒矩阵默认值不符：${bad.map(([k]) => k).join(', ')}`
    : `  ✅ 唤醒矩阵默认值正确（受击/死亡/被传送叫醒；被推/捡物只记档）`)
  console.log(`  ✅ 近距说话半径默认 ${s0.config.nearRadius} 格；观察窗口 ${s0.config.observeWindowMs}ms；限流 ${s0.config.maxWakePerMinute}/分`)

  // 挂载（宿主无 jobs → 降级为"无 job 模式"，但必须仍然武装成功）
  const s1 = await tools.get('mc_watch').execute({ action: 'arm' }, A)
  console.log(`  ${s1.armed === true ? '✅' : '❌'} arm 成功（无 jobs 服务时降级运行，不抛错）`)

  // 改配置：点号键 + 数组
  const c1 = await tools.get('mc_config').execute({
    patch: { 'wakeOn.itemPickup': true, nearRadius: 24, mentionPatterns: ['ds', '用户'] },
  }, A)
  const ok = c1.config.wakeOn.itemPickup === true && c1.config.nearRadius === 24
    && c1.config.mentionPatterns.length === 2 && c1.config.wakeOn.damage === true
  console.log(`  ${ok ? '✅' : '❌'} mc_config 点号键浅合并正确（未提及的项保持默认）`)

  // 叫法判定（**配置不是硬编码**）——直接构造 Watchdog 测，不依赖 registry
  const { Watchdog } = await import('./src/watchdog.mjs')
  const probe = new Watchdog({ ctx: fakeCtx, sess: { bot: {}, events: [], config: {} }, agent: A.agent })
  probe.updateConfig({ mentionPatterns: ['ds', '用户'] })
  const called = probe.calledBy('用户 你在吗')
  const notCalled = probe.calledBy('今天天气不错')
  console.log(`  ${called.includes('用户') && notCalled.length === 0 ? '✅' : '❌'} 动态叫法生效：命中 ${JSON.stringify(called)}，未命中 ${JSON.stringify(notCalled)}`)
  console.log(`  ${probe.config.wakeOn.damage && !probe.config.wakeOn.itemPickup ? '✅' : '❌'} 改叫法不影响唤醒矩阵默认值`)

  // 非法配置项要清晰报错
  try {
    await tools.get('mc_config').execute({ patch: { 不存在的项: 1 } }, A)
    console.log('  ❌ 非法配置项竟然被接受')
  } catch (e) { console.log(`  ✅ 非法配置项清晰报错：${e.message.slice(0, 50)}…`) }

  // 恢复默认
  const c2 = await tools.get('mc_config').execute({ reset: true }, A)
  console.log(`  ${c2.config.nearRadius === 16 && c2.config.mentionPatterns.length > 2 ? '✅' : '❌'} reset 恢复默认`)

  // 卸载
  const s2 = await tools.get('mc_watch').execute({ action: 'disarm', reason: '自检' }, A)
  console.log(`  ${s2.armed === false ? '✅' : '❌'} disarm 成功`)
}

// ── 新工具：mc_act / mc_give / mc_sequence / mc_stop ──
console.log('\n--- 工具重整后的新能力 ---')

// mc_act：未知 mode 要清晰报错（不静默）
try {
  await tools.get('mc_act').execute({ mode: '飞' }, A)
  console.log('  ❌ 未知 mode 竟然被接受')
} catch (e) {
  const msg = e.message
  console.log(`  ${/未知 mode/.test(msg) ? '✅' : '❌'} mc_act 未知 mode 报错并列出可用值：${msg.slice(0, 70)}…`)
}

// mc_act：look 缺参数时提示怎么用
try {
  await tools.get('mc_act').execute({ mode: 'look' }, A)
  console.log('  ❌ look 缺参数竟然成功')
} catch (e) {
  console.log(`  ✅ mc_act{look} 缺参报错：${e.message.slice(0, 46)}…`)
}

// mc_give：非创造/不在线要有明确说明（不是崩溃）
try {
  await tools.get('mc_give').execute({ name: 'oak_planks' }, A)
  console.log('  ❌ mc_give 竟然成功')
} catch (e) {
  console.log(`  ✅ mc_give 未连服报错：${e.message.slice(0, 40)}…`)
}

// mc_sequence：参数校验
for (const [label, args, want] of [
  ['空 steps', { steps: [] }, /非空数组/],
  ['超长 steps', { steps: Array.from({ length: 65 }, () => ({ op: 'wait', sec: 0 })) }, /步骤太多/],
]) {
  try {
    await tools.get('mc_sequence').execute(args, A)
    console.log(`  ❌ ${label} 竟然通过`)
  } catch (e) {
    console.log(`  ${want.test(e.message) ? '✅' : '❌'} mc_sequence ${label} 校验：${e.message.slice(0, 40)}`)
  }
}

// mc_sequence：纯等待步骤不需要连服也能跑通引擎
{
  const r = await tools.get('mc_sequence').execute({ steps: [{ op: 'wait', sec: 0.05 }, { op: 'wait', ms: 50 }] }, A)
  const ok = r.succeeded === 2 && r.failed === 0
  console.log(`  ${ok ? '✅' : '❌'} 序列引擎可独立运行：${r.succeeded}/${r.requested} 步成功，耗时 ${r.elapsedMs}ms`)
}

// mc_sequence：未知 op 要报错并列出可用 op（且按 stopOnError 停下）
{
  const r = await tools.get('mc_sequence').execute({ steps: [{ op: '不存在的动作' }, { op: 'wait', sec: 0.01 }] }, A)
  const first = r.results[0]
  const stopped = r.results.length === 1
  console.log(`  ${first?.ok === false && /可用：/.test(first.error) && stopped ? '✅' : '❌'} 未知 op 报错+列可用值+遇错即停：${String(first?.error).slice(0, 60)}…`)
}

// ── 强制停止：语义与**顺序**（用户 2026-09-16：移除普通停止，只剩强制停止）──
console.log('\n--- 强制停止（顺序：停LLM → 优雅退游戏 → 清后台任务 → 再停LLM）---')
try {
  await tools.get('mc_stop').execute({})
  console.log('  ❌ mc_stop 无 exec 竟然成功')
} catch (e) {
  console.log(`  ${/拿不到当前会话/.test(e.message) ? '✅' : '❌'} mc_stop 无 exec 清晰报错：${e.message.slice(0, 30)}`)
}
{
  // 普通停止已移除：参数面只剩 reason（不再有 hard）
  // ⚠️ 注册表里的 `parameters` 是包好的 JSON schema，参数名在 .properties 下
  const params = Object.keys(tools.get('mc_stop').parameters?.properties ?? {})
  console.log(`  ${!params.includes('hard') && params.includes('reason') ? '✅' : '❌'} mc_stop 参数面已无 hard（普通停止移除）：[${params.join(', ')}]`)
  const r = await tools.get('mc_stop').execute({ reason: '自检' }, A)
  const ok = r && 'kicked' in r && 'killedJobs' in r && 'stoppedLLM' in r && 'finalStopLLM' in r && Array.isArray(r.order)
  console.log(`  ${ok ? '✅' : '❌'} mc_stop 返回结构完整（kicked/killedJobs/stoppedLLM/finalStopLLM/order）：${JSON.stringify(r).slice(0, 110)}`)
  console.log(`  ${r?.order?.join(' → ') === 'quit-game → kill-jobs' ? '✅' : '❌'} AI 自己调（cancelTurn:false）不动 LLM、顺序 = 退游戏 → 清任务：${r?.order?.join(' → ')}`)
}

// 🔴 强制停止的**后端顺序**：用第二套"服务齐全的假 ctx"跑一遍 apply()，
//    再走 UI 那条路（POST /api/mc/stop）——工具路径强制 cancelTurn:false，验不到"先停 LLM"。
console.log('\n--- 强制停止：UI 路径的真实顺序（停LLM → 退游戏 → 清任务 → 再停LLM）---')
{
  const { EventEmitter } = await import('node:events')
  const side = []                       // 副作用调用顺序（cancel / kill）
  const tools2 = new Map()
  let route2 = null
  const fakeAgent2 = { id: 'sess-STOP', status: 'running' }
  // 这第二套 ctx 的 agents 服务要**可替换**：下面的「MC设置」接口测试需要换成"带工作区的会话"
  let agents2 = { get: () => fakeAgent2 }
  const jobs2 = { list: () => [{ id: 'job-watch' }, { id: 'job-other' }], kill: (id) => side.push(`kill:${id}`) }
  const sc2 = { cancel: ({ sessionId }) => side.push(`cancel:${sessionId}`) }
  const ctx2 = {
    logger: { info: () => {}, warn: () => {}, debug: () => {} },
    tools: { register: (d) => { tools2.set(d.name, d); return () => {} }, guard: () => () => {} },
    webServer: { register: (r) => { route2 = r; return () => {} }, port: 39999 },
    workspaceRegistry: { archiveSession: async () => {} },
    systemPrompt: { context: () => () => {}, section: () => () => {} },
    inject: () => {},
    effect: (fn) => { try { fn() } catch {} },
    on: () => () => {},
    get: (k) => (k === 'jobs' ? jobs2
      : k === 'sessionController' ? sc2
        : k === 'agents' ? agents2
          : undefined),
  }
  mod.apply(ctx2, mod.Config ? mod.Config({}) : {})

  // 先在这个会话上建出 McSession（UI 场景里它一定存在：那个会话正在玩）
  await tools2.get('mc_status').execute({}, { agent: { id: 'sess-STOP' } })

  const req = new EventEmitter()
  req.method = 'POST'
  req.url = '/api/mc/stop'
  req.headers = { host: '127.0.0.1:39999' }
  const res = { writeHead: () => {}, end: (body) => { res.body = String(body ?? '') } }
  const done = route2.handler(req, res)
  req.emit('data', JSON.stringify({ sessionId: 'sess-STOP' }))
  req.emit('end')
  await done
  const body = JSON.parse(res.body || '{}')

  console.log(`  ${route2?.path === '/api/mc' ? '✅' : '❌'} 路由注册为 ${route2?.path}（prefix）`)
  console.log(`  ${body.ok ? '✅' : '❌'} UI 路径返回 ok：${JSON.stringify(body).slice(0, 100)}`)
  const want = 'stop-llm → quit-game → kill-jobs → stop-llm-final'
  console.log(`  ${body.order?.join(' → ') === want ? '✅' : '❌'} 后端顺序 = ${want}${body.order?.join(' → ') === want ? '' : `｜实际：${body.order?.join(' → ')}`}`)
  console.log(`  ${body.stoppedLLM === true && body.finalStopLLM === true ? '✅' : '❌'} 停了两遍 LLM（首 + 尾，避免状态异常）：首=${body.stoppedLLM} 尾=${body.finalStopLLM}`)
  console.log(`  ${body.kicked === true ? '✅' : '❌'} 先尝试退出游戏（bot.disconnect 被调用）：${JSON.stringify(body.quit)}`)
  console.log(`  ${body.killedJobs?.length === 2 ? '✅' : '❌'} 该会话后台任务被清空：${JSON.stringify(body.killedJobs)}`)
  const sideWant = ['cancel:sess-STOP', 'kill:job-watch', 'kill:job-other', 'cancel:sess-STOP']
  console.log(`  ${side.join(' → ') === sideWant.join(' → ') ? '✅' : '❌'} 副作用真实顺序 = 先停LLM → 清任务 → 再停LLM：${side.join(' → ')}`)

  // ── 「MC设置」HTTP 接口（锁住 E2E 抓到的真 bug：**DELETE 也带 body，必须读**）──
  // 🔴 2026-09-16：这组接口现在**必须有带工作区的 sessionId**（用户："没有选中工作区就拒绝设置"）。
  //    造一个带工作区的会话，下面所有设置调用都自动带上它。
  const apiWs = (await import('node:fs')).mkdtempSync((await import('node:path')).join((await import('node:os')).tmpdir(), 'whale-apiws-'))
  const apiAgent = { id: 'sess-API', session: { header: { cwd: apiWs } } }
  agents2 = { get: (id) => (id === 'sess-API' ? apiAgent : undefined) }   // ⚠️ 这是**第二套** ctx 的服务（route2 属于它）
  const callApi = async (method, url, payload) => {
    const rq = new EventEmitter()
    rq.method = method
    rq.url = url + (url.includes('?') ? '&' : '?') + 'sessionId=sess-API'
    rq.headers = { host: '127.0.0.1:39999' }
    const rs = { writeHead: () => {}, end: (b) => { rs.body = String(b ?? '') } }
    const p = route2.handler(rq, rs)
    if (payload !== undefined) rq.emit('data', JSON.stringify(payload))
    rq.emit('end')
    await p
    try { return JSON.parse(rs.body || '{}') } catch { return {} }
  }
  const noSidApi = await (async () => {
    const rq = new EventEmitter()
    rq.method = 'GET'; rq.url = '/api/mc/config'; rq.headers = { host: '127.0.0.1:39999' }
    const rs = { writeHead: () => {}, end: (b) => { rs.body = String(b ?? '') } }
    const p = route2.handler(rq, rs); rq.emit('end'); await p
    try { return JSON.parse(rs.body || '{}') } catch { return {} }
  })()
  console.log(`  ${noSidApi.ok === false && /缺少 sessionId/.test(String(noSidApi.error)) ? '✅' : '❌'} 🔴 设置接口不带 sessionId → 拒绝（不猜工作区）`)
  const accApi = await callApi('GET', '/api/mc/accounts')
  if (!accApi.ok) console.log('    [debug] GET /accounts 返回：', JSON.stringify(accApi).slice(0, 240), '| agents 服务：', typeof fakeCtx.agents?.get, '| apiAgent.cwd =', apiAgent.session.header.cwd)
  console.log(`  ${accApi.ok && accApi.accounts?.some((a) => a.name === 'DeepSeek') && accApi.authServers?.some((s) => s.id === 'littleskin') ? '✅' : '❌'} 设置接口 GET /accounts（默认离线账户 + 内置认证服）`)
  const srvApi = await callApi('POST', '/api/mc/authservers', { card: 'authlib-injector:yggdrasil-server:https%3A%2F%2Fself.example%2Fyggdrasil' })
  const srvDel = await callApi('DELETE', '/api/mc/authservers', { id: srvApi.server?.id })
  console.log(`  ${srvApi.ok && srvDel.ok ? '✅' : '❌'} 认证服务器增/删（**DELETE 也要读 body**）：${String(srvApi.server?.url)}`)
  const accNew = await callApi('POST', '/api/mc/accounts', { type: 'offline', name: '自检账户' })
  const accDel = await callApi('DELETE', '/api/mc/accounts', { innerID: accNew.account?.innerID })
  console.log(`  ${accNew.ok && accDel.ok ? '✅' : '❌'} 账户增/删（DELETE 带 body）`)
  const cfgApi = await callApi('GET', '/api/mc/config')
  console.log(`  ${Array.isArray(cfgApi.commandWhitelist) ? '✅' : '❌'} 设置接口 GET /config（白名单 ${cfgApi.commandWhitelist?.length} 条）`)
  console.log(`  ${!/password|accessToken|clientToken/i.test(JSON.stringify([accApi, srvApi, accNew, cfgApi])) ? '✅' : '❌'} 🔴 设置接口响应里逐字查过：没有凭据字段`)
  console.log(`  ${typeof cfgApi.allowAllCommands === 'boolean' && typeof cfgApi.injectWorkspaceAgentsMd === 'boolean' ? '✅' : '❌'} 配置接口带上了新开关（allowAllCommands / injectWorkspaceAgentsMd）`)
  const cfgPatch = await callApi('PATCH', '/api/mc/config', { allowAllCommands: true })
  console.log(`  ${cfgPatch.ok && cfgPatch.allowAllCommands === true ? '✅' : '❌'} PATCH 打开"允许所有指令"`)
  await callApi('PATCH', '/api/mc/config', { allowAllCommands: false })
  const md0 = await callApi('GET', '/api/mc/agents-md')
  console.log(`  ${md0.ok && /行事准则/.test(String(md0.text)) ? '✅' : '❌'} 提示词接口能读准则（source=${md0.source}）`)
  const mdPut = await callApi('PUT', '/api/mc/agents-md', { text: '# 自检临时准则' })
  const md1 = await callApi('GET', '/api/mc/agents-md')
  console.log(`  ${mdPut.ok && md1.source === 'custom' && /自检临时准则/.test(md1.text) ? '✅' : '❌'} PUT 保存自定义准则后立刻生效`)
  const mdDel = await callApi('DELETE', '/api/mc/agents-md')
  const md2 = await callApi('GET', '/api/mc/agents-md')
  console.log(`  ${mdDel.ok && md2.source === 'default' ? '✅' : '❌'} DELETE 恢复默认（回到打包那份）`)
}

// McBot.disconnect 单元验证：**先优雅退出，走不掉才强断**
console.log('\n--- disconnect：优雅优先 / 强断兜底 ---')
{
  const { McBot } = await import('./src/core.mjs')
  const mk = (b) => { const bot = new McBot({ instanceId: 'sc-disc-' + Math.random().toString(36).slice(2, 7) }); bot.bot = b; return bot }

  // ① 优雅：quit 之后自己 emit('end')
  let forced1 = false
  const good = {
    entity: {},
    once: (ev, fn) => { if (ev === 'end') setTimeout(fn, 10) },
    quit: () => {},
    _client: { end: () => { forced1 = true } },
  }
  const r1 = await mk(good).disconnect('自检-优雅')
  console.log(`  ${r1.graceful && !r1.forced && !forced1 ? '✅' : '❌'} 优雅退出优先（${r1.ms}ms graceful=${r1.graceful} forced=${r1.forced}）`)

  // ② 走不掉：不 emit，且仍"在线"（有 entity）→ 必须强断兜底
  let forced2 = false
  const bad = { entity: {}, once: () => {}, quit: () => {}, _client: { end: () => { forced2 = true } } }
  const r2 = await mk(bad).disconnect('自检-强断', { graceMs: 150 })
  console.log(`  ${r2.forced && forced2 ? '✅' : '❌'} 走不掉时强断兜底（${r2.ms}ms forced=${r2.forced}）`)

  // ③ 本来就没连接：不吊死
  const r3 = await new McBot({ instanceId: 'sc-disc-null' }).disconnect('自检-未连接')
  console.log(`  ${!r3.graceful && !r3.forced ? '✅' : '❌'} 没连接时立刻返回（不吊死，${r3.ms}ms）`)
}

// ── 记忆（需求 6 v3）：固定 .whale-craft + AI 维护的 README 索引 + 任意格式 ──
console.log('\n--- 记忆能力（.whale-craft / README 索引 / 任意格式）---')
{
  const { MemoryStore } = await import('./src/memory.mjs')
  const { mkdtempSync, readFileSync, existsSync, readdirSync, writeFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const root = join(mkdtempSync(join(tmpdir(), 'whale-mem-')), '.whale-craft')
  const mem = new MemoryStore(root)

  console.log(`  ${mem.list().length === 0 ? '✅' : '❌'} 新库为空（README 不算记忆条目）`)
  mem.ensureReadme()
  console.log(`  ${/由 AI 维护/.test(readFileSync(mem.readmePath, 'utf8')) ? '✅' : '❌'} README.md 骨架就位（写明由 AI 维护索引）`)

  // 通用（不给 server）→ _global/；指定服务器 → 独立文件夹
  mem.append({ topic: 'owner', text: '用户在游戏里叫 <user>' })
  mem.append({ topic: 'landmarks', server: 'mc.example.com', text: '出生点 (12,70,-4)' })
  mem.append({ topic: 'landmarks', server: 'mc.example.com', text: '某人的房子 (100,64,100)' })
  mem.append({ topic: 'notes', server: 'ih.example.com', text: 'ih 是生存服' })

  const dirs = readdirSync(root)
  const hasGlobal = dirs.includes('_global')
  const hasmc = dirs.includes('mc.example.com')
  const hasIh = dirs.includes('ih.example.com')
  console.log(`  ${hasGlobal && hasmc && hasIh ? '✅' : '❌'} 按服务器分独立文件夹：${dirs.join(' / ')}`)
  console.log(`  ${existsSync(join(root, 'mc.example.com', 'landmarks.md')) ? '✅' : '❌'} 文件落在对应服文件夹里`)

  // 同 key 覆盖（不堆积）
  mem.append({ topic: 'owner', text: '用户在游戏里叫 <user>（服主）', key: '名字' })
  const dup = mem.list().filter((f) => f.rel === '_global/owner.md')
  console.log(`  ${dup.length === 1 && dup[0].entries === 2 ? '✅' : '❌'} append 同 key 覆盖、不堆积（owner.md 仍 1 个文件 / ${dup[0]?.entries} 条）`)

  // 查：读；改：整文件覆盖
  const r = mem.read({ path: 'mc.example.com/landmarks.md' })
  console.log(`  ${/出生点/.test(r.content) && r.kind === 'text' ? '✅' : '❌'} read 返回文本内容`)
  try { mem.read({ path: 'mc.example.com/nope.md' }); console.log('  ❌ 读不存在的竟然成功') }
  catch (e) { console.log(`  ${/现有文件/.test(e.message) ? '✅' : '❌'} 读不存在的报错并列出已有文件`) }
  mem.write({ path: 'mc.example.com/landmarks.md', content: '# mc 地标\n\n## 出生点\n- (12,70,-4)\n\n## 建筑\n- 某人的房子 (100,64,100)\n' })
  console.log(`  ${/## 出生点/.test(mem.read({ path: 'mc.example.com/landmarks.md' }).content) ? '✅' : '❌'} write 整文件覆盖（可写小标题）`)

  // 🆕 任意格式：不再是"只收 md"
  mem.write({ path: 'mc.example.com/coords.json', content: '{"spawn":[12,70,-4]}' })
  mem.write({ path: 'mc.example.com/notes.txt', content: '随便一段纯文本' })
  const j = mem.read({ path: 'mc.example.com/coords.json' })
  const t2 = mem.read({ path: 'mc.example.com/notes.txt' })
  console.log(`  ${j.kind === 'text' && /spawn/.test(j.content) && t2.kind === 'text' ? '✅' : '❌'} 任意格式读写（.json / .txt 都行）`)

  // 🆕 图片/任意文件：put 进来 + read 出去
  const { encodePng } = await import('./src/png.mjs')
  const src = join(root, 'src.png')
  writeFileSync(src, encodePng(16, 16, new Uint8Array(16 * 16 * 4).fill(180)))
  const put = mem.put({ source: src, path: 'mc.example.com/maps/地标塔.png' })
  console.log(`  ${/maps\/地标塔\.png/.test(put.saved) && put.kind === 'image' ? '✅' : '❌'} put 把文件存进记忆（任意子目录）：${put.saved}`)
  const rd = mem.read({ path: put.saved })
  console.log(`  ${rd.kind === 'image' && rd.mediaType === 'image/png' && rd.bytes > 0 ? '✅' : '❌'} read 图片返回 image + mediaType（工具层做附件 → 模型能直接看到）`)

  // 🆕 二进制嗅探：不认识的扩展名也不当文本读
  writeFileSync(join(root, 'mc.example.com', 'blob.bin'), Buffer.from([0, 1, 2, 3, 0, 9]))
  console.log(`  ${mem.read({ path: 'mc.example.com/blob.bin' }).kind === 'binary' ? '✅' : '❌'} 二进制文件识别为 binary`)

  // 路径安全：穿越/绝对路径仍全拒（非 md 现在**允许**，这是行为变更）
  const bad = [
    ['../../etc/passwd', '上级穿越'],
    ['/abs/path.md', '绝对路径'],
    ['mc.example.com/../secret.md', '中间穿越'],
    ['a/b/c/d/e/f.md', '太深'],
  ]
  const escaped = bad.filter(([p]) => { try { mem.safePath(p); return true } catch { return false } })
  console.log(`  ${escaped.length === 0 ? '✅' : '❌'} 路径锁死在 .whale-craft 内（${bad.length} 个用例全被拒）`)
  console.log(`  ${mem.safePath('mc.example.com/地标.md').rel === 'mc.example.com/地标.md' ? '✅' : '❌'} 中文文件名可用`)

  // 注入文本 = README（AI 维护）+ 自动目录树
  mem.write({ path: 'README.md', content: '# 麦块记忆索引（自检）\n\n- 通用：_global/owner.md\n' })
  const idxText = mem.indexText()
  console.log(`  ${/麦块记忆索引/.test(idxText) && /coords\.json/.test(idxText) ? '✅' : '❌'} 注入文本 = README 正文 + 自动目录树（${idxText.length} 字）`)
  console.log(`  ${/动手前先读|自动生成/.test(idxText) ? '✅' : '❌'} 目录树带"自动生成、永远准"的说明`)

  // 搜（只搜文本）+ 删（文件 / 目录）
  const s = mem.search({ query: '某人的房子' })
  console.log(`  ${s.matched >= 1 && s.hits[0].path === 'mc.example.com/landmarks.md' ? '✅' : '❌'} search 跨文本文件命中并给出文件+行号`)
  mem.delete({ path: 'ih.example.com/notes.md' })
  console.log(`  ${!existsSync(join(root, 'ih.example.com', 'notes.md')) ? '✅' : '❌'} delete 删文件（服务器文件夹保留）`)
  mem.delete({ path: 'mc.example.com/maps' })
  console.log(`  ${!existsSync(join(root, 'mc.example.com', 'maps')) ? '✅' : '❌'} delete 可整目录删`)

  // 工具层（用插件的真实记忆库）
  const ovTool = await tools.get('mc_kit_memory').execute({ action: 'index' }, A)
  console.log(`  ${ovTool.root && 'totalFiles' in ovTool && 'readme' in ovTool ? '✅' : '❌'} mc_kit_memory{index} 可用（真实库 ${ovTool.totalFiles} 个文件）`)
  const badAct = await tools.get('mc_kit_memory').execute({ action: '不存在' }, A).catch((e) => e.message)
  console.log(`  ${/未知 action/.test(String(badAct)) ? '✅' : '❌'} 未知 action 报错并列出可用值`)
}

// ── 图像地图（需求 7）──
console.log('\n--- 图像地图 ---')
{
  const { encodePng } = await import('./src/png.mjs')
  const w = 8, h = 6
  const rgba = new Uint8Array(w * h * 4)
  for (let i = 0; i < w * h; i++) {
    rgba[i * 4] = 100; rgba[i * 4 + 1] = 150; rgba[i * 4 + 2] = 200; rgba[i * 4 + 3] = 255
  }
  const png = encodePng(w, h, rgba)
  const sigOk = png.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  console.log(`  ${sigOk ? '✅' : '❌'} PNG 签名正确（${png.length} 字节，${w}x${h}）`)

  // IHDR 里的宽高要和我们给的一致
  const ihdrW = png.readUInt32BE(16), ihdrH = png.readUInt32BE(20)
  console.log(`  ${ihdrW === w && ihdrH === h ? '✅' : '❌'} IHDR 尺寸正确 ${ihdrW}x${ihdrH}`)
  console.log(`  ${png.includes(Buffer.from('IEND')) ? '✅' : '❌'} 含 IEND 块（结构完整）`)

  // 尺寸非法要拒
  try { encodePng(0, 5, new Uint8Array(0)); console.log('  ❌ 非法尺寸竟然通过') }
  catch { console.log('  ✅ 非法尺寸被拒') }

  // mc_map 参数面
  const mp = Object.keys(tools.get('mc_map').parameters?.properties ?? {})
  console.log(`  ${mp.includes('format') && mp.includes('scale') ? '✅' : '❌'} mc_map 支持 format/scale：${mp.join(', ')}`)
  // output.render 必须能产出 image 块
  const blocks = tools.get('mc_map').output.render({}, { text: 'x', image: { attachment: { attachmentId: 'a' } } })
  console.log(`  ${Array.isArray(blocks) && blocks.some((b) => b.type === 'image') ? '✅' : '❌'} mc_map 能返回 image 内容块（宿主对纯文本模型会自动降级）`)
}

// ── 扩展点（需求 6 的另一半）──
console.log('\n--- 扩展点 ---')
{
  const { existsSync, readFileSync } = await import('node:fs')
  const { fileURLToPath } = await import('node:url')
  const dir = fileURLToPath(new URL('./extensions/', import.meta.url))
  console.log(`  ${existsSync(dir) ? '✅' : '❌'} extensions/ 目录存在`)
  console.log(`  ${existsSync(dir + 'README.md') ? '✅' : '❌'} 扩展文档存在（其他 Agent 照它写）`)
  const tpl = readFileSync(dir + 'example.mjs.example', 'utf8')
  console.log(`  ${/export async function apply/.test(tpl) ? '✅' : '❌'} 模板符合契约（导出 apply(api)）`)
  const api = ['asTool', 'getSession', 'registry', 'memory', 'logLine']
  const missing = api.filter((k) => !tpl.includes(k) && !tpl.includes('api.'))
  console.log(`  ${missing.length ? '⚠️ ' : '✅'} 模板演示了关键 api（缺失项即使未演示也不影响加载）`)
}

// ── 归档保护（用户补充要求：归档前自动强行停止）──
console.log('\n--- 归档保护 ---')
{
  // 前置：给 sess-A 挂上看门狗
  await tools.get('mc_watch').execute({ action: 'arm' }, A)
  const armed = (await tools.get('mc_watch').execute({}, A)).armed

  // ① 无 MC 的会话：必须原样放行（不能把普通归档搞坏）
  await fakeCtx.workspaceRegistry.archiveSession('plain-session')
  console.log(`  ${archivedSessions.includes('plain-session') ? '✅' : '❌'} 无 MC 的会话正常放行归档`)

  // ② 有 MC（看门狗挂着）的会话：包装后的实现应先停掉再放行
  await fakeCtx.workspaceRegistry.archiveSession('sess-A')
  const armedAfter = (await tools.get('mc_watch').execute({}, A)).armed
  console.log(`  ${armed === true ? '✅' : '❌'} 前置条件：归档前看门狗挂着`)
  console.log(`  ${armedAfter === false ? '✅' : '❌'} 归档时看门狗被自动关闭（armed: ${armed} → ${armedAfter}）`)
  console.log(`  ${archivedSessions.includes('sess-A') ? '✅' : '❌'} 停止之后仍放行归档（选了"先停止"而非"阻止"）`)

  // ③ 原方法必须被调用（不是被我们吞掉）
  const calls = archivedSessions.filter((x) => x === 'sess-A').length
  console.log(`  ${calls === 1 ? '✅' : '❌'} 原 archiveSession 恰好被调用一次（未被吞/未重复）`)

  // ④ 回归：`apply()` 时 workspaceRegistry **还没就绪**（远端服务晚启动）——
  //    必须走 ctx.inject 等它就绪，而不是静默放弃。
  //    这是隔离实例实测抓到的真 bug（第一版直接 ctx.get 拿到 undefined 就放弃了）。
  {
    const mod3 = await import('./index.js')
    const pending = []
    const lateArchived = []
    let installRan = false
    const ctx3 = {
      logger: { info: () => {}, warn: () => {}, debug: () => {} },
      tools: { register: () => {} },
      webServer: { register: () => () => {} },
      effect: (fn) => { try { fn() } catch {} },
      set: () => {}, on: () => {},
      // 初次 get 拿不到（模拟服务未就绪）
      get: (k) => (k === 'workspaceRegistry' || k === 'jobs' || k === 'sessionController' || k === 'attachments'
        ? undefined : ctx3[k]),
      inject: (deps, cb) => { pending.push({ deps, cb }) },
      logger2: null,
    }
    mod3.apply(ctx3, mod3.Config({}))
    const registered = pending.some((p) => p.deps.includes('workspaceRegistry'))
    console.log(`  ${registered ? '✅' : '❌'} 服务未就绪时登记了 ctx.inject(['workspaceRegistry'])`)

    // 服务就绪 → 回调触发 → 应装上包装
    const scope = {
      get: () => ({ archiveSession: async (sid) => { lateArchived.push(String(sid)) } }),
      effect: (fn) => { try { fn() } catch {} },
      logger: { info: () => {} },
    }
    for (const p of pending) { if (p.deps.includes('workspaceRegistry')) { p.cb(scope); installRan = true } }
    const wrapped = typeof (await scope.get()).archiveSession === 'function'
    await scope.get().archiveSession('late-session')
    console.log(`  ${installRan && wrapped && lateArchived.includes('late-session') ? '✅' : '❌'} 服务迟到时归档保护仍能装上并放行`)
  }
}

// ── 总索引自动注入系统提示（用户要求：自动注入 + 提醒及时读）──
console.log('\n--- 总索引自动注入 ---')
{
  // 注册走 ctx.inject（Cordis 规定：访问 ctx.systemPrompt 属性必须先 inject）
  const fiber = injectedFibers.find((f) => f.deps.includes('systemPrompt'))
  console.log(`  ${fiber ? '✅' : '❌'} 通过 ctx.inject(['systemPrompt']) 登记（属性访问需先 inject）`)
  if (fiber) {
    fiber.cb({
      systemPrompt: fakeCtx.systemPrompt,
      effect: (fn) => { try { fn() } catch {} },
      logger: fakeCtx.logger,
    })
  }

  const ctxEntry = injectedContexts.find((c) => c.name === 'whale_craft:memory-index')
  console.log(`  ${ctxEntry ? '✅' : '❌'} 已注册动态 context：whale_craft:memory-index`)
  console.log(`  ${typeof ctxEntry?.text === 'function' ? '✅' : '❌'} text 是函数（每次组装时求值，能反映最新记忆）`)
  console.log(`  ${ctxEntry?.order === 200 ? '✅' : '❌'} order=${ctxEntry?.order}（排在宿主自留段 110/115/120 之后）`)

  const text = String(ctxEntry?.text?.() ?? '')
  const emptyOk = /长期记忆/.test(text) && /mc_kit_memory/.test(text)
  console.log(`  ${emptyOk ? '✅' : '❌'} 没记忆时不占位、改为教它怎么记（${text.length} 字）`)

  // 真写一条到插件的真实记忆库，注入文本必须立刻反映出来
  const mm = await tools.get('mc_kit_memory').execute(
    { action: 'append', topic: 'selftest-tmp', server: '_global', text: '这是一条自检临时记忆' }, A)
  const text2 = String(ctxEntry?.text?.() ?? '')
  const reflected = text2.includes('selftest-tmp') && /先读/.test(text2)
  console.log(`  ${reflected ? '✅' : '❌'} 写入后注入文本立刻带上该文件 + "先读"提醒`)
  await tools.get('mc_kit_memory').execute({ action: 'delete', path: String(mm.path) }, A)
  console.log(`  ${!String(ctxEntry?.text?.() ?? '').includes('selftest-tmp') ? '✅' : '❌'} 删除后注入文本同步移除`)
}

// ── 全局配置 + 管理工具 + MC 模式权限隔离（用户 2026-09-16 要求）──
console.log('\n--- 全局配置 / mc_admin_config / MC 模式隔离 ---')
{
  // 先让 agentPresets 的 inject 回调跑起来（插件靠它判断"是不是 MC 模式"）
  const apFiber = injectedFibers.find((f) => f.deps.includes('agentPresets'))
  console.log(`  ${apFiber ? '✅' : '❌'} 通过 ctx.inject(['agentPresets']) 等宿主服务就绪`)
  if (apFiber) {
    apFiber.cb({
      get: (k) => (k === 'agentPresets' ? fakeCtx.agentPresets : undefined),
      effect: (fn) => { try { fn() } catch {} },
      logger: fakeCtx.logger,
    })
  }

  // ① 配置存储本身
  const { PluginConfig, pickPresetTarget, pickPresetSource, isCopiedPresetDescription } = await import('./src/config.mjs')

  /* 🔴 2026-09-16 用户定：**没有 MC 模式 preset 就自动建一个**。
   * 起因：preset 属于用户的 $DSH_HOME/.agent-presets/，插件不塞目录 → 新机器上没人建过
   * → mcModePresets 一个都匹配不上 → "装了插件也没有 MC模式"。
   * 做法只能用宿主官方接口 `agentPresets.copy(源, 新id, 显示名)`
   * （官方 authoring 明令"只允许整目录复制已有 preset，调用方不得提供 composition 文本"）。 */
  await new Promise((r) => setTimeout(r, 0))          // ensureMcPresetIfMissing 是 async
  const cp = presetCopyCalls[0]
  console.log(`  ${cp?.[0] === 'minimal' && cp?.[1] === 'minecraft' && cp?.[2] === 'MC模式' ? '✅' : '❌'} 没有 MC 模式 preset → 自动建：复制 minimal → id=minecraft，名字「MC模式」（${JSON.stringify(presetCopyCalls)}）`)
  if (apFiber) {
    // 再触发一次：必须**不会**重复建（一次性）
    apFiber.cb({ get: (k) => (k === 'agentPresets' ? fakeCtx.agentPresets : undefined), effect: (fn) => { try { fn() } catch {} } })
    await new Promise((r) => setTimeout(r, 0))
  }
  console.log(`  ${presetCopyCalls.length === 1 ? '✅' : '❌'} 只建一次（重复触发不再复制）`)
  // 🔴 用户 2026-09-16 报的 bug："MC 模式的简介变成了和极简模式一样" ——
  //    官方 copy() **只改 name、保留源 description**，所以复制完必须把 preset.yml 改回来。
  const presetMetaFile = jnTop(presetUserRoot, 'minecraft', 'preset.yml')
  const presetMeta = exTop(presetMetaFile) ? rfTop(presetMetaFile, 'utf8') : ''
  console.log(`  ${/name: "MC模式"/.test(presetMeta) ? '✅' : '❌'} 建出来的 preset 显示名 = MC模式`)
  console.log(`  ${/可以加入Minecraft Java版服务器/.test(presetMeta) ? '✅' : '❌'} 🔴 简介改回自己的（不再是"极简模式"那句）：${JSON.stringify((presetMeta.split('\n').find((l) => l.startsWith('description')) ?? '').slice(0, 60))}`)
  console.log(`  ${!/极简/.test(presetMeta) ? '✅' : '❌'} 简介里没有残留极简模式的文案`)
  // 🔴 用户 2026-09-16："默认系统提示词居然是 'You are a helpful software engineer assistant.'，太离谱了"
  //    —— 那句来自复制的 minimal，必须换成我们自己的；顺带把 minimal 的 `complete: true` 和 shell 处理掉
  {
    const compFile = presetPaths.get('minecraft')
    const comp = compFile && exTop(compFile) ? rfTop(compFile, 'utf8') : ''
    console.log(`  ${/Minecraft Java 版服务器里扮演一名玩家/.test(comp) ? '✅' : '❌'} persona 换成我们自己的（Minecraft 玩家）`)
    console.log(`  ${!/helpful software engineer assistant/.test(comp) ? '✅' : '❌'} 🔴 官方那句"软件助手"已不存在`)
    console.log(`  ${!/complete: true/.test(comp) && !/includeRuntimeContext: false/.test(comp) ? '✅' : '❌'} minimal 的 complete / includeRuntimeContext 已去掉（否则会压掉其它 section）`)
    console.log(`  ${/^-\s+id:\s*persistent-shell[\s\S]{0,120}disabled: true/m.test(comp) ? '✅' : '❌'} 🔴 持久 shell 已关掉（与"本模式没有 shell"的指导一致）`)
    console.log(`  ${/id: pty/.test(comp) ? '✅' : '❌'} 其余结构原样保留（pty 组还在，只是被 disabled）`)
  }
  // 纯函数：结构不认识时要返回 null（宁可不改也不写坏 composition）
  {
    const C = await import('./src/config.mjs')
    console.log(`  ${C.patchPersonaInComposition('# 没有 persona 行\n', 'x') === null ? '✅' : '❌'} 没有 persona 行 → 返回 null（不瞎改）`)
    console.log(`  ${C.disableShellInComposition('# 没有 shell 组\n') === null ? '✅' : '❌'} 没有 shell 组 → 返回 null`)
    const twice = C.disableShellInComposition(C.disableShellInComposition('- id: persistent-shell\n  group: true\n', '') ?? '')
    console.log(`  ${(twice.match(/disabled: true/g) ?? []).length === 1 ? '✅' : '❌'} 关 shell 是幂等的（不会写两遍 disabled）`)
  }
  // 🔴 **已经建好的**那份也要能修（用户那台测试机上就是旧版建出来的）：
  //    只在"简介恰好等于某个官方 preset 的简介"（明显是复制残留）时才动，用户自己写的不碰。
  const SHIPPED = ['仅提供持久 shell 的单工具编码 Agent。', '功能完整的编码 Agent，支持文件编辑、Shell、文件与网页检索、Skills、计划、目标、子代理和工作流。']
  console.log(`  ${isCopiedPresetDescription(SHIPPED[0], SHIPPED) && isCopiedPresetDescription(SHIPPED[1], SHIPPED) ? '✅' : '❌'} 认得出"复制残留"的简介（等于某个官方简介）`)
  console.log(`  ${!isCopiedPresetDescription('Whale Craft插件提供加入MC Java版服务器模拟玩家交互的能力', SHIPPED) && !isCopiedPresetDescription('', SHIPPED) && !isCopiedPresetDescription(undefined, SHIPPED) ? '✅' : '❌'} 用户自己写的简介 / 空 / 缺省 → **不动**（不覆盖人家改过的）`)
  {
    const { readFileSync } = await import('node:fs')
    const src = readFileSync(new URL('./index.js', import.meta.url), 'utf8')
    console.log(`  ${/planPresetAction\(\{/.test(src) && /shippedDescriptionMatch: isCopiedPresetDescription\(row\?\.description, shippedDescs\)/.test(src) ? '✅' : '❌'} 已有的 MC 模式 preset 也会走一次判定（旧版建出来的能被修好）`)
    console.log(`  ${/writeMcPresetMarker\(svc, target, \{/.test(src) && /MC_PRESET_MARKER = '\.whale-craft\.json'/.test(src) ? '✅' : '❌'} 建完留下"自建标记"（下次启动才知道这份是我们建的）`)
    // 🔴 2026-09-16 真机事故：复制 minimal 带来的 persona（含 complete:true / includeRuntimeContext:false）
    //    会让宿主把**我们注入的 context 段整个丢掉** → "设置页显示正常、AI 却什么都没收到"
    console.log(`  ${/patchMcPresetComposition\(svc, target\)/.test(src) && /patchMcPresetComposition\(svc, existingId\)/.test(src) ? '✅' : '❌'} 新建/重建都会把 persona 换成我们的、并关掉 shell`)
    console.log(`  ${/stillShippedPersona/.test(src) && /You are a helpful software engineer assistant/.test(src) ? '✅' : '❌'} 旧版（无标记）那份：只在"官方那句人设还在"时才动它`)
    console.log(`  ${/runtimeContextSuppressed \? \[\]/.test(src) ? '✅' : '❌'} 状态块注释里钉住了宿主那段 contexts: runtimeContextSuppressed ? [] （这是根因）`)
    console.log(`  ${/registered: segs/.test(src) && /segments: delivered/.test(src) ? '✅' : '❌'} 状态块同时给"注册了没有"和"**实际收不收得到**"（不许再撒谎）`)
    // 🔴 用户："我不要模拟用户发送啊！" —— 投递的那条必须标成 plugin/notice，且**不许** steer（空闲时会起一轮）
    console.log(`  ${/kind: 'plugin', plugin: 'whale_craft', form: 'notice'/.test(src) ? '✅' : '❌'} 投递的消息标成 plugin/notice（插件提示行，不归到用户头上）`)
    console.log(`  ${!/agent\.steer\(/.test(src) ? '✅' : '❌'} 🔴 插件里**没有** steer 兜底（steer 空闲会"起一轮"＝没问就替用户说话）`)
  }

  // 🔴 用户问的："初始化时能不能检查是不是对的，不对也重新建吗？万一用户更新插件了呢。"
  //    → `planPresetAction()` 是那套判定的**纯函数**，每条分支都钉一遍。
  {
    const C = await import('./src/config.mjs')
    const plan = C.planPresetAction
    const ours = { createdBy: 'whale_craft', spec: C.MC_PRESET_SPEC, compositionHash: 'aaa' }
    const t = (label, got, want) => console.log(`  ${got === want ? '✅' : '❌'} ${label}（→ ${got}）`)
    t('没有 preset → 建', plan({ exists: false }).action, 'create')
    t('自建的 + 规格变了（插件更新）→ 重建', plan({ exists: true, marker: { ...ours, spec: 0 }, compositionHash: 'aaa', sourceHash: 'aaa' }).action, 'rebuild')
    t('🔴 自建的但**组成被用户改过** → 绝不动', plan({ exists: true, marker: ours, compositionHash: 'bbb', sourceHash: 'aaa' }).action, 'leave')
    t('自建的 + 官方源变了（DSH 更新）→ 重建', plan({ exists: true, marker: ours, compositionHash: 'aaa', sourceHash: 'ccc' }).action, 'rebuild')
    t('自建的 + 只是显示文本不对 → 只修元数据', plan({ exists: true, marker: ours, compositionHash: 'aaa', sourceHash: 'aaa', metaOk: false }).action, 'meta')
    t('自建的 + 都对 → 什么都不做', plan({ exists: true, marker: ours, compositionHash: 'aaa', sourceHash: 'aaa', metaOk: true }).action, 'leave')
    t('不是我们建的 + 简介是复制残留 → 只修元数据', plan({ exists: true, marker: null, shippedDescriptionMatch: true }).action, 'meta')
    t('不是我们建的 + 别的 → 一律不动（用户自己维护的）', plan({ exists: true, marker: null, shippedDescriptionMatch: false }).action, 'leave')
    // 🔴 读不到组成（没记下 hash）→ **没有依据判断用户改没改** → 只敢修显示文本，永不重建
    t('自建的但没记下组成 hash + 文本对 → 不动', plan({ exists: true, marker: { ...ours, compositionHash: null }, metaOk: true }).action, 'leave')
    t('自建的但没记下组成 hash + 文本不对 → 只修文本（不重建）', plan({ exists: true, marker: { ...ours, compositionHash: null }, metaOk: false }).action, 'meta')
  }
  // 自建标记真的落盘了吗（含规格与组成 hash）
  {
    const markerFile = jnTop(presetUserRoot, 'minecraft', '.whale-craft.json')
    const mk = exTop(markerFile) ? JSON.parse(rfTop(markerFile, 'utf8')) : null
    console.log(`  ${mk?.createdBy === 'whale_craft' && typeof mk?.compositionHash === 'string' && typeof mk?.spec === 'number' ? '✅' : '❌'} 自建标记落盘（createdBy/spec/compositionHash：${JSON.stringify(mk && { by: mk.createdBy, spec: mk.spec, hash: mk.compositionHash })})`)
  }
  console.log(`  ${pickPresetTarget(['minecraft', 'whale_craft']) === 'minecraft' ? '✅' : '❌'} 目标 id 取的是**合法目录名**（minecraft）`)
  console.log(`  ${pickPresetTarget(['whale_craft']) === null ? '✅' : '❌'} 🔴 \`whale_craft\` 带下划线、**不可能是 preset id** → 宁可不建也不硬来（null）`)
  console.log(`  ${pickPresetSource(['minimal', 'standard']) === 'minimal' && pickPresetSource(['ptc'], 'ptc') === 'ptc' && pickPresetSource([], 'standard') === null ? '✅' : '❌'} 复制源优先 minimal → standard → ptc，再退到宿主默认，都没有就 null`)
  {
    const { readFileSync } = await import('node:fs')
    const src = readFileSync(new URL('./index.js', import.meta.url), 'utf8')
    console.log(`  ${/svc\.copy\(source, target, MC_PRESET_NAME\)/.test(src) ? '✅' : '❌'} 用的是宿主官方 \`copy()\`（不手搓 composition —— 官方 authoring 不允许）`)
    console.log(`  ${/svc\.authorable === false/.test(src) ? '✅' : '❌'} 这份部署没有可写 preset 根时优雅跳过（不是崩）`)
  }
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const cfg = new PluginConfig(mkdtempSync(join(tmpdir(), 'whale-cfg-')))

  console.log(`  ${cfg.commandAllowed('tp') && !cfg.commandAllowed('op') ? '✅' : '❌'} 默认白名单：放行 tp、拒绝 op`)
  cfg.set('commandWhitelist', ['give', '/^ti/'])
  console.log(`  ${cfg.commandAllowed('time') && cfg.commandAllowed('give') && !cfg.commandAllowed('tp') ? '✅' : '❌'} 改白名单立即生效（正则 /^ti/ 命中 time，tp 被拒）`)
  cfg.set('commandWhitelist', ['*'])
  console.log(`  ${cfg.commandAllowed('随便什么') ? '✅' : '❌'} "*" = 全部放行`)
  const badType = await Promise.resolve().then(() => cfg.set('commandWhitelist', 'tp')).catch((e) => e.message)
  console.log(`  ${/必须是字符串数组/.test(String(badType)) ? '✅' : '❌'} 类型校验：${String(badType).slice(0, 40)}`)
  const badKey = await Promise.resolve().then(() => cfg.set('nope.x', 1)).catch((e) => e.message)
  console.log(`  ${/未知配置项/.test(String(badKey)) ? '✅' : '❌'} 未知键被拒：${String(badKey).slice(0, 40)}`)
  cfg.unset('commandWhitelist')
  console.log(`  ${cfg.commandAllowed('tp') ? '✅' : '❌'} unset 回到默认值`)
  cfg.reset()
  console.log(`  ${cfg.commandAllowed('tp') && cfg.get('mcMode.hideAdminTools') === true ? '✅' : '❌'} reset 全部恢复默认`)
  console.log(`  ${cfg.isMcModePreset('minecraft') && !cfg.isMcModePreset('standard') ? '✅' : '❌'} MC 模式判定用可配置的 preset 名单`)

  // ①b 插件状态目录：配置 / 账户**不在工作区**（用户 2026-09-16："dsh 没给插件专门记配置的目录吗"）
  {
    const { resolveStateDir } = await import('./src/config.mjs')
    const { readFileSync } = await import('node:fs')
    const fakeHome = 'C:\\Users\\x'
    const ws = 'E:\\ws\\.whale-craft'
    const viaSvc = resolveStateDir({ env: {}, dshHomePath: (n) => `C:\\Users\\x\\.dsh\\${n}`, whaleDir: ws, home: fakeHome })
    console.log(`  ${viaSvc === 'C:\\Users\\x\\.dsh\\whale_craft' ? '✅' : '❌'} 优先用宿主 dshHomePath('whale_craft')：${viaSvc}`)
    const viaEnv = resolveStateDir({ env: { DSH_HOME: 'D:\\dsh' }, whaleDir: ws, home: fakeHome })
    console.log(`  ${viaEnv === 'D:\\dsh\\whale_craft' ? '✅' : '❌'} 没有该服务时按 $DSH_HOME：${viaEnv}`)
    const viaHome = resolveStateDir({ env: {}, whaleDir: ws, home: fakeHome })
    console.log(`  ${viaHome === 'C:\\Users\\x\\.dsh\\whale_craft' ? '✅' : '❌'} 连 $DSH_HOME 也没有时用 ~/.dsh：${viaHome}`)
    console.log(`  ${!viaHome.includes('E:\\ws') ? '✅' : '❌'} 🔴 结果**不在工作区**里（这正是用户要的）`)
    const iso = resolveStateDir({ env: { WHALE_CRAFT_DIR: 'T:\\tmp' }, dshHomePath: () => 'C:\\x\\.dsh\\whale_craft', whaleDir: 'T:\\tmp', home: fakeHome })
    console.log(`  ${iso === 'T:\\tmp' ? '✅' : '❌'} 自检/隔离模式（WHALE_CRAFT_DIR）一切留在临时目录：${iso}`)
    const explicit = resolveStateDir({ env: { WHALE_CRAFT_STATE_DIR: 'S:\\s', WHALE_CRAFT_DIR: 'T:\\tmp' }, whaleDir: 'T:\\tmp', home: fakeHome })
    console.log(`  ${explicit === 'S:\\s' ? '✅' : '❌'} WHALE_CRAFT_STATE_DIR 优先级最高`)
    const idx = readFileSync(new URL('./index.js', import.meta.url), 'utf8')
    console.log(`  ${/new PluginConfig\(stateDir\)/.test(idx) && /new AccountStore\(\{ dir: stateDir/.test(idx) ? '✅' : '❌'} index.js 里配置与账户都建在 stateDir 上（不是 whaleDir）`)
    console.log(`  ${/resolveStateDir\(\{ dshHomePath, whaleDir: process\.env\.WHALE_CRAFT_DIR \}\)/.test(idx) ? '✅' : '❌'} 状态目录走 resolveStateDir（拿不到就 /$DSH_HOME 兜底）`)
    console.log(`  ${/copyFileSync\(from, to\)/.test(idx) && /unlinkSync\(from\)/.test(idx) ? '✅' : '❌'} 老工作区文件有一次性的"搬出工作区"迁移`)
    // 🔴 2026-09-16 抽取成标准插件：记忆/提示词必须**按会话工作区**解析（插件装哪都行）
    console.log(`  ${/const workspaceOf = \(agent\) =>/.test(idx) && /agent\?\.session\?\.header\?\.cwd/.test(idx) ? '✅' : '❌'} 工作区取自 exec.agent.session.header.cwd（不再用"插件自己在哪"）`)
    console.log(`  ${/join\(cwd, '\.whale-craft'\)/.test(idx) ? '✅' : '❌'} 记忆根 = <会话工作区>/.whale-craft`)
    console.log(`  ${/const installAgentPrompts = \(agent\)/.test(idx) && /installAgentPrompts\(agent\)/.test(idx) ? '✅' : '❌'} 提示词段（含记忆索引）按 agent 注入（每个工作区各一份）`)
  }

  // ② 管理工具（走真实插件实例，落盘在自检临时目录）
  const adminGet = await tools.get('mc_admin_config').execute({ action: 'get' }, A)
  console.log(`  ${adminGet.values && adminGet.file ? '✅' : '❌'} mc_admin_config{get} 可用（${adminGet.file.split(/[\\/]/).pop()}）`)
  const adminSet = await tools.get('mc_admin_config').execute(
    { action: 'set', path: 'commandWhitelist', value: ['op', 'tp'] }, A)
  console.log(`  ${Array.isArray(adminSet.value) && adminSet.value.includes('op') ? '✅' : '❌'} mc_admin_config{set} 改白名单成功`)

  // ③ 白名单立刻作用到 mc_command（改完不用重启）
  const wlErr = await tools.get('mc_command').execute({ command: '/give @s stone' }, A).catch((e) => e.message)
  console.log(`  ${/不在白名单/.test(String(wlErr)) ? '✅' : '❌'} 白名单外的指令被拒：${String(wlErr).slice(0, 46)}`)
  const wlOk = await tools.get('mc_command').execute({ command: '/op me' }, A).catch((e) => e.message)
  console.log(`  ${/不在线/.test(String(wlOk)) ? '✅' : '❌'} 白名单内的指令放行（只因未连服而报"不在线"）`)
  await tools.get('mc_admin_config').execute({ action: 'reset' }, A)

  // ④ guard：MC 模式调管理工具必须被硬拒；普通模式不被拒
  const mcCtxObj = {}; presetByCtx.set(mcCtxObj, 'minecraft')
  const plainCtxObj = {}; presetByCtx.set(plainCtxObj, 'standard')
  const mcExec = { name: 'mc_admin_config', agent: { id: 'sess-MC', ctx: mcCtxObj } }
  const plainExec = { name: 'mc_admin_config', agent: { id: 'sess-P', ctx: plainCtxObj } }
  const denied = guards.map((g) => { try { return g(mcExec) } catch { return undefined } }).find(Boolean)
  console.log(`  ${denied ? '✅' : '❌'} MC 模式调 mc_admin_config 被 guard 拒绝：${String(denied).slice(0, 42)}`)
  const plainDenied = guards.map((g) => { try { return g(plainExec) } catch { return undefined } }).find(Boolean)
  console.log(`  ${plainDenied === undefined ? '✅' : '❌'} 非 MC 模式不被拒（普通会话能改配置）`)
  const otherTool = guards.map((g) => { try { return g({ name: 'mc_status', agent: { id: 'sess-MC', ctx: mcCtxObj } }) } catch { return undefined } }).find(Boolean)
  console.log(`  ${otherTool === undefined ? '✅' : '❌'} guard 只管管理工具，不影响 mc_status 等游戏工具`)

  // guard 硬化：MC 模式不许用文件工具绕去读凭据
  const credRead = guards.map((g) => { try { return g({ name: 'read', arguments: { path: 'C:\\Users\\x\\.dsh\\.credentials.yaml' }, agent: { id: 'sess-MC', ctx: mcCtxObj } }) } catch { return undefined } }).find(Boolean)
  console.log(`  ${credRead ? '✅' : '❌'} MC 模式读 .credentials.yaml 被 guard 拒绝：${String(credRead).slice(0, 28)}`)
  const secretsRead = guards.map((g) => { try { return g({ name: 'read', arguments: { path: 'E:\\x\\.agent-docs\\secrets\\auth-account.md' }, agent: { id: 'sess-MC', ctx: mcCtxObj } }) } catch { return undefined } }).find(Boolean)
  console.log(`  ${secretsRead ? '✅' : '❌'} MC 模式读 secrets/ 明文凭据备忘也被拒：${String(secretsRead).slice(0, 28)}`)
  const mdRead = guards.map((g) => { try { return g({ name: 'read', arguments: { path: 'E:\\x\\.whale-craft\\AGENTS.md' }, agent: { id: 'sess-MC', ctx: mcCtxObj } }) } catch { return undefined } }).find(Boolean)
  console.log(`  ${mdRead ? '✅' : '❌'} MC 模式读 AGENTS.md 被 guard 拒绝：${String(mdRead).slice(0, 28)}`)
  const mdViaMemory = guards.map((g) => { try { return g({ name: 'mc_kit_memory', arguments: { action: 'read', path: 'AGENTS.md' }, agent: { id: 'sess-MC', ctx: mcCtxObj } }) } catch { return undefined } }).find(Boolean)
  console.log(`  ${mdViaMemory ? '✅' : '❌'} 记忆工具绕路读 AGENTS.md 也被拒`)
  const plainExec3 = { name: 'read', arguments: { path: 'E:\\x\\README.md' }, agent: { id: 'sess-MC', ctx: mcCtxObj } }
  const plainRead = guards.every((g) => { try { return g(plainExec3) === undefined } catch { return true } })
  console.log(`  ${plainRead ? '✅' : '❌'} 读普通文件不受影响`)

  // ⑤ 会话建立时应用策略：MC 模式 → 隐藏管理工具 + 注入专属指导；普通模式 → 什么都不做
  const restrictCalls = []
  const guidanceCtxs = []
  const makeAgentCtx = (preset) => {
    const base = {}
    presetByCtx.set(base, preset)
    base.get = (k) => (k === 'tools'
      ? { restrict: (f) => { restrictCalls.push({ preset, f }); return () => {} } }
      : k === 'systemPrompt'
        ? { context: (c) => { guidanceCtxs.push({ preset, c }); return () => {} } }
        : undefined)
    return base
  }
  const fire = (ev, agent) => eventHandlers.filter((h) => h.ev === ev).forEach((h) => h.fn({ agent }))

  const mcAgent = { id: 'sess-MC2', session: { header: { cwd: mkdtempSync(join(tmpdir(), 'whale-mc-')) } }, ctx: makeAgentCtx('minecraft'), inbox: { nextStep: [] }, steer: () => { throw new Error('不该走 steer！') } }
  const plainAgent = { id: 'sess-P2', session: { header: { cwd: mkdtempSync(join(tmpdir(), 'whale-pl-')) } }, ctx: makeAgentCtx('standard'), inbox: { nextStep: [] } }
  fire('agent/created', mcAgent)
  fire('agent/created', plainAgent)

  const mcRestrict = restrictCalls.find((c) => c.preset === 'minecraft')
  // 🔴 2026-09-16 真机事故的正解：把提示词当**插件提示**投递（宿主自己注入 AGENTS.md 也走 `inbox.nextStep`）
  //    —— 必达（不过 systemPrompt 组装，persona 的 complete/includeRuntimeContext 压不到）
  {
    const msgs = mcAgent.inbox.nextStep
    const first = msgs[0]
    console.log(`  ${msgs.length === 1 ? '✅' : '❌'} MC 会话：提示词被投递到 inbox.nextStep（${msgs.length} 条）`)
    console.log(`  ${first?.source?.kind === 'plugin' && first?.source?.plugin === 'whale_craft' && first?.source?.form === 'notice' ? '✅' : '❌'} 🔴 来源是 plugin/notice（**不是**用户发言）：${JSON.stringify(first?.source ?? null)}`)
    const body = (first?.content ?? []).map((c) => c.text ?? '').join('')
    console.log(`  ${/Whale Craft 行事准则/.test(body) && /Minecraft/.test(body) ? '✅' : '❌'} 投递内容含行事准则（${body.length} 字）`)
    console.log(`  ${plainAgent.inbox.nextStep.length === 0 ? '✅' : '❌'} 普通会话**不投递**（只有 MC 模式才投）`)
    const inboxBefore = mcAgent.inbox.nextStep.length
    fire('agent/session-start', mcAgent)
    console.log(`  ${mcAgent.inbox.nextStep.length === inboxBefore ? '✅' : '❌'} 同一会话只投一次（不刷屏）`)
  }
  const denyList = mcRestrict?.f?.deny ?? []
  console.log(`  ${denyList.includes('mc_admin_config') ? '✅' : '❌'} MC 模式会话被隐藏管理工具：${JSON.stringify(denyList)}`)
  // ⚠️ 按 **name** 找，不按 preset 找：同一个 agent 现在会先注入 memory-index，再注入 mode-guidance
  const g = guidanceCtxs.find((x) => x.c?.name === 'whale_craft:mode-guidance')
  console.log(`  ${g?.c?.name === 'whale_craft:mode-guidance' ? '✅' : '❌'} MC 模式注入了专属指导（name=${g?.c?.name}）`)
  // 🔴 2026-09-16：两个 AGENTS.md **不再走 systemPrompt**（会被 persona 的 complete/includeRuntimeContext 压掉），
  //    改成**插件提示行**投递（inbox.nextStep）—— 断言见上面那段 + 下面 ⑦。
  console.log(`  ${!guidanceCtxs.some((x) => x.c?.name === 'whale_craft:agents-md') && !guidanceCtxs.some((x) => x.c?.name === 'whale_craft:workspace-agents-md') ? '✅' : '❌'} 两个 AGENTS.md 不再重复走 systemPrompt（只走提示行，避免投两遍）`)
  console.log(`  ${/单对话/.test(String(g?.c?.text?.() ?? '')) && /mc_kit_memory/.test(String(g?.c?.text?.() ?? '')) ? '✅' : '❌'} 指导内容含关键约定（单对话 / 记忆工具名）`)
  // 用户 2026-09-16：指导里不再写"别碰插件源码与宿主配置（那是别的会话的活）"
  console.log(`  ${!/插件源码|宿主配置|别的会话/.test(String(g?.c?.text?.() ?? '')) ? '✅' : '❌'} 指导里已删掉"别碰插件源码/宿主配置"那条`)
  console.log(`  ${!restrictCalls.some((c) => c.preset === 'standard') ? '✅' : '❌'} 非 MC 模式的会话不被限制（不误伤普通会话）`)
  // 重复触发不应重复注入（WeakSet 去重）
  const before = guidanceCtxs.length
  fire('agent/session-start', mcAgent)
  console.log(`  ${guidanceCtxs.length === before ? '✅' : '❌'} 同一 agent 重复触发只应用一次策略`)

  /* ⑦ 🔴🔴 2026-09-16 真机事故回归（两轮）：提示词必须**必达 + 看得见**。
   *    第一轮事故：段注册绑在"那一刻是 MC 模式"上 → preset 晚选上就永远不注册。
   *    第二轮事故（更狠）：只走 `systemPrompt.context()` —— 复制官方 `minimal` 带来的 persona
   *    （`complete: true` / `includeRuntimeContext: false`）会让宿主把 context 段**整个丢掉**
   *    → "设置页显示正常、AI 却什么都没收到"。现在照宿主的做法投**插件提示行**。 */
  const lateAgent = {
    id: 'sess-LATE',
    session: { header: { cwd: mkdtempSync(join(tmpdir(), 'whale-late-')) } },
    ctx: makeAgentCtx(undefined),
    inbox: { nextStep: [] },
  }
  fire('agent/created', lateAgent)                                  // 建的时候还没选 mode
  console.log(`  ${lateAgent.inbox.nextStep.length === 0 ? '✅' : '❌'} preset 未知时不投递（不误注入）`)
  presetByCtx.set(lateAgent.ctx, 'minecraft')                       // ← "用户选了 MC模式"
  fakeCtx.agents = { get: (id) => (id === 'sess-LATE' ? lateAgent : id === 'sess-MC2' ? mcAgent : id === 'sess-P2' ? plainAgent : undefined) }
  eventHandlers.filter((h) => h.ev === 'agent-preset/selected').forEach((h) => h.fn('sess-LATE', 'minecraft'))
  await new Promise((r) => setTimeout(r, 0))                         // 让 installAgentPrompts ⑤ 里那个 queueMicrotask 落地
  const lateBody = (lateAgent.inbox.nextStep[0]?.content ?? []).map((c) => c.text ?? '').join('')
  console.log(`  ${/Whale Craft 行事准则/.test(lateBody) ? '✅' : '❌'} 🔴 模式晚选上后**立刻投递**（${lateAgent.inbox.nextStep.length} 条 / ${lateBody.length} 字）—— 就是那个 bug`)
  console.log(`  ${lateAgent.inbox.nextStep.length === 1 ? '✅' : '❌'} 补投递没有重复（只有一条 .whale-craft/AGENTS.md）`)
  const lateRestrict = restrictCalls.find((c) => c.preset === undefined)
  console.log(`  ${(lateRestrict?.f?.deny ?? []).includes('mc_admin_config') ? '✅' : '❌'} 模式晚选上时"命令式"的隔离也补上了（restrict 含 mc_admin_config）`)
  console.log(`  ${eventHandlers.some((h) => h.ev === 'agent-preset/selected') ? '✅' : '❌'} 挂了宿主的 agent-preset/selected 事件（会话里切模式才生效）`)

  /* ⑧ 🔴 用户："插件初始化就要检查 `.whale-craft` 是否存在，不存在则建立；README.md 是否存在，
   *    不存在则写入默认值。"（AGENTS.md 同理：提示词页编辑的就是这个文件，文件必须先在） */
  {
    const { mkdtempSync, existsSync, readFileSync, writeFileSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const ws = mkdtempSync(join(tmpdir(), 'whale-ws-'))
    const savedMemDir = process.env.WHALE_CRAFT_MEMORY_DIR
    delete process.env.WHALE_CRAFT_MEMORY_DIR        // 让记忆根跟着**会话工作区**走（真机就是这么配的）
    const seedAgent = { id: 'sess-SEED', session: { header: { cwd: ws } }, ctx: makeAgentCtx('minecraft'), inbox: { nextStep: [] } }
    fire('agent/created', seedAgent)
    const wsRoot = join(ws, '.whale-craft')
    const wsAgents = join(wsRoot, 'AGENTS.md')
    const wsReadme = join(wsRoot, 'README.md')
    console.log(`  ${existsSync(wsRoot) ? '✅' : '❌'} 初始化就建出 <工作区>/.whale-craft/（${wsRoot}）`)
    console.log(`  ${existsSync(wsAgents) ? '✅' : '❌'} 顺手把 AGENTS.md 建出来（「提示词」页编辑的就是它）`)
    console.log(`  ${existsSync(wsReadme) ? '✅' : '❌'} README.md 不存在则写入默认骨架`)
    const seeded = existsSync(wsAgents) ? readFileSync(wsAgents, 'utf8') : ''
    console.log(`  ${/Whale Craft 行事准则/.test(seeded) && /mc_capabilities/.test(seeded) ? '✅' : '❌'} 建出来的 AGENTS.md = 内置默认全文（${seeded.length} 字）`)
    writeFileSync(wsAgents, 'Master 手工改过的内容\n', 'utf8')
    fire('agent/session-start', seedAgent)
    console.log(`  ${/Master 手工改过的内容/.test(readFileSync(wsAgents, 'utf8')) ? '✅' : '❌'} 已存在的 AGENTS.md 不会被初始化覆盖`)
    // 🔴 用户 2026-09-16："如果启动对话时设置要求注入，但是找不到文件，那就注入默认，同时重建文件。"
    //    现在这条发生在**投递时**（inbox 提示）：删掉文件、再起一个新会话 → 文件被重建 + 投递默认全文
    const { unlinkSync } = await import('node:fs')
    unlinkSync(wsAgents)
    const seedAgent2 = { id: 'sess-SEED2', session: { header: { cwd: ws } }, ctx: makeAgentCtx('minecraft'), inbox: { nextStep: [] } }
    fire('agent/created', seedAgent2)
    const rebuiltBody = (seedAgent2.inbox.nextStep[0]?.content ?? []).map((c) => c.text ?? '').join('')
    console.log(`  ${existsSync(wsAgents) ? '✅' : '❌'} 投递时发现文件不在 → **重建**了文件`)
    console.log(`  ${/Whale Craft 行事准则/.test(rebuiltBody) ? '✅' : '❌'} 同时投递默认全文（${rebuiltBody.length} 字）—— 不允许"要求注入却什么都没有"`)

    // 🔴 用户 2026-09-16 改的**时机**：不是"启动时对每个会话建"，而是
    //    ① 首次发起 MC 模式会话 ② 点开「MC设置」——**别的时候（比如普通会话）不许建**。
    const ws2 = mkdtempSync(join(tmpdir(), 'whale-ws2-'))
    const plainWithWs = { id: 'sess-PLAINWS', session: { header: { cwd: ws2 } }, ctx: makeAgentCtx('standard') }
    fire('agent/created', plainWithWs)
    fire('agent/session-start', plainWithWs)
    console.log(`  ${!existsSync(join(ws2, '.whale-craft')) ? '✅' : '❌'} 🔴 普通会话**不会**被建 .whale-craft/（时机：只在 MC 模式会话/点开设置）`)

    // 🔴 没有选中工作区 → **拒绝发起 MC 模式会话**（不套隔离、不建文件）
    const noWs = { id: 'sess-NOWS', session: { header: {} }, ctx: makeAgentCtx('minecraft') }
    const restrictBefore = restrictCalls.length
    fire('agent/created', noWs)
    console.log(`  ${restrictCalls.length === restrictBefore ? '✅' : '❌'} 没工作区的 MC 会话**不套权限策略**（拒绝进入 MC 模式）`)
    if (savedMemDir === undefined) delete process.env.WHALE_CRAFT_MEMORY_DIR
    else process.env.WHALE_CRAFT_MEMORY_DIR = savedMemDir
  }

  // ⑥ 「MC设置」入口的模式门控接口（2026-09-16 真机事故：普通会话也显示了设置按钮）
  const { EventEmitter } = await import('node:events')
  const routeMc = registeredRoutes.find((r) => r.path === '/api/mc')
  const callMc = async (url) => {
    const rq = new EventEmitter()
    rq.method = 'GET'
    rq.url = url
    rq.headers = { host: '127.0.0.1:39999' }
    const rs = { writeHead: () => {}, end: (b) => { rs.body = String(b ?? '') } }
    const p = routeMc.handler(rq, rs)
    rq.emit('end')
    await p
    try { return JSON.parse(rs.body || '{}') } catch { return {} }
  }
  const modeMc = await callMc('/api/mc/mode?sessionId=sess-MC2')
  const modePlain = await callMc('/api/mc/mode?sessionId=sess-P2')
  const modeNoId = await callMc('/api/mc/mode')
  console.log(`  ${modeMc.mcMode === true ? '✅' : '❌'} /api/mc/mode：MC 模式会话 → true（才显示「MC设置」）`)
  console.log(`  ${modePlain.mcMode === false ? '✅' : '❌'} /api/mc/mode：普通会话 → false（标题条不出现入口）`)
  console.log(`  ${modeNoId.mcMode === false ? '✅' : '❌'} /api/mc/mode：没给 sessionId → false（保守，宁可不显示）`)

  // agent 服务在场时现场问 agentPresets；**把模式切回普通要立刻变 false**（不残留按钮）
  fakeCtx.agents = {
    get: (id) => (id === 'sess-MC2' ? mcAgent
      : id === 'sess-P2' ? plainAgent
        : id === 'sess-NOWS' ? noWs
          : undefined),
  }
  const liveMc = await callMc('/api/mc/mode?sessionId=sess-MC2')
  presetByCtx.set(mcAgent.ctx, 'standard')
  const afterSwitch = await callMc('/api/mc/mode?sessionId=sess-MC2')
  presetByCtx.set(mcAgent.ctx, 'minecraft')
  console.log(`  ${liveMc.mcMode === true ? '✅' : '❌'} 有 agent 服务时现场判定（不是只看历史记录）`)
  console.log(`  ${afterSwitch.mcMode === false ? '✅' : '❌'} 🔴 模式切成普通后立刻变 false（按钮不会残留）`)

  /* ⑨ 🔴 用户 2026-09-16："没有选中工作区，则拒绝发起 MC 模式会话**和设置**"。
   *    · 模式接口：MC 模式但没工作区 → mcMode=false + diag.reason='no-workspace'（前端据此隐藏入口）
   *    · 设置接口：没有 sessionId / 会话没有工作区 → **400 拒绝**
   *    · 有工作区 → 放行，并且**在这个时机**把该工作区的 `.whale-craft/` 备好（"点开设置即建"）。 */
  const modeNoWs = await callMc('/api/mc/mode?sessionId=sess-NOWS')
  console.log(`  ${modeNoWs.mcMode === false && modeNoWs.diag?.reason === 'no-workspace' ? '✅' : '❌'} 🔴 没工作区的 MC 会话：mcMode=false + reason=no-workspace（前端据此隐藏「MC设置」）`)
  console.log(`  ${modeNoWs.diag?.workspace === null || modeNoWs.diag?.workspace === undefined ? '✅' : '❌'} 诊断里明确报"没有工作区"（${JSON.stringify(modeNoWs.diag?.workspace ?? null)}）`)

  const callMc2 = async (method, url, body) => {
    const { EventEmitter } = await import('node:events')
    const rq = new EventEmitter()
    rq.method = method
    rq.url = url
    rq.headers = { host: '127.0.0.1:39999' }
    const rs = { writeHead: (code) => { rs.statusCode = code }, end: (b) => { rs.body = String(b ?? '') } }
    const p = routeMc.handler(rq, rs)
    if (body !== undefined) rq.emit('data', Buffer.from(JSON.stringify(body)))
    rq.emit('end')
    await p
    try { return { status: rs.statusCode ?? 200, json: JSON.parse(rs.body || '{}') } } catch { return { status: 0, json: {} } }
  }
  const noSid = await callMc2('GET', '/api/mc/config')
  console.log(`  ${noSid.json?.ok === false && /缺少 sessionId/.test(String(noSid.json?.error)) ? '✅' : '❌'} 🔴 设置接口没带 sessionId → 拒绝（${String(noSid.json?.error ?? '').slice(0, 24)}…）`)
  const noWsAgent2 = { id: 'sess-NOWS', session: { header: {} }, ctx: makeAgentCtx('minecraft') }   // 有 MC preset、没工作区
  fakeCtx.agents = { get: (id) => (id === 'sess-NOWS' ? noWsAgent2 : undefined) }
  const noWsCfg = await callMc2('GET', '/api/mc/config?sessionId=sess-NOWS')
  console.log(`  ${noWsCfg.json?.ok === false && /没有选中工作区/.test(String(noWsCfg.json?.error)) ? '✅' : '❌'} 🔴 会话没工作区 → 设置接口拒绝：${String(noWsCfg.json?.error ?? '').slice(0, 28)}…`)

  // 反面：有工作区 → 放行，并且**在这个时机**把 `.whale-craft/` 备好（"点开设置即建"）
  const memDirBefore = process.env.WHALE_CRAFT_MEMORY_DIR
  delete process.env.WHALE_CRAFT_MEMORY_DIR          // 让记忆根跟着会话工作区走（真机就是这么配的）
  const ws3 = (await import('node:fs')).mkdtempSync(join((await import('node:os')).tmpdir(), 'whale-ws3-'))
  const wsAgent = { id: 'sess-WSOK', session: { header: { cwd: ws3 } }, ctx: makeAgentCtx('minecraft') }
  fakeCtx.agents = { get: (id) => (id === 'sess-WSOK' ? wsAgent : id === 'sess-NOWS' ? noWsAgent2 : undefined) }
  const okCfg = await callMc2('GET', '/api/mc/config?sessionId=sess-WSOK')
  console.log(`  ${okCfg.json?.ok === true ? '✅' : '❌'} 有工作区 → 设置接口放行`)
  console.log(`  ${(await import('node:fs')).existsSync((await import('node:path')).join(ws3, '.whale-craft', 'AGENTS.md')) ? '✅' : '❌'} 🔴 **点开设置**这个时机就把该工作区的 .whale-craft/AGENTS.md 备好了`)

  // 🔴 2026-09-16 真机反馈："新对话还没开始（服务端还没这个会话），可工作区明明选了"——
  //    所以允许客户端**直接报工作区**（只认绝对路径 + 真实存在的目录）。
  const hintWs = (await import('node:fs')).mkdtempSync((await import('node:path')).join((await import('node:os')).tmpdir(), 'whale-hint-'))
  const hintOk = await callMc2('GET', '/api/mc/config?sessionId=sess-UNKNOWN&cwd=' + encodeURIComponent(hintWs))
  console.log(`  ${hintOk.json?.ok === true ? '✅' : '❌'} 新对话页：会话还没落盘、但客户端报了对的工作区 → **放行**`)
  const hintAbs = await callMc2('GET', '/api/mc/config?sessionId=sess-UNKNOWN&cwd=' + encodeURIComponent('relative/dir'))
  console.log(`  ${hintAbs.json?.ok === false ? '✅' : '❌'} 报的不是绝对路径 → 拒绝`)
  const hintGone = await callMc2('GET', '/api/mc/config?sessionId=sess-UNKNOWN&cwd=' + encodeURIComponent(jnTop(tdTop(), 'definitely-not-here-xyz')))
  console.log(`  ${hintGone.json?.ok === false ? '✅' : '❌'} 报的目录不存在 → 拒绝`)
  if (memDirBefore === undefined) delete process.env.WHALE_CRAFT_MEMORY_DIR
  else process.env.WHALE_CRAFT_MEMORY_DIR = memDirBefore
}

// ── MC账户体系（元数据 / 凭据分离；LLM 只能看基本信息）──
console.log('\n--- MC账户：账户库 / 凭据隔离 / 工具 ---')
{
  const { AccountStore, offlineUuid, parseAuthlibCard } = await import('./src/accounts.mjs')
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')

  // 假凭据服务：内存 key→record，形状照 ctx.credentials
  const recs = new Map()
  const fakeCred = {
    listRecords: async () => [...recs.entries()].map(([key, r]) => ({ key, kind: r.kind })),
    readRecord: async (key) => recs.get(key),
    modifyRecord: async (key, fn) => { const r = await fn(recs.get(key)); recs.set(key, r); return r },
    deleteRecord: async (key) => { recs.delete(key) },
  }
  const store = new AccountStore({ dir: mkdtempSync(join(tmpdir(), 'whale-acc-')), credentials: fakeCred })
  store.ensureDefaults()
  await store.refreshCredentialIndex()

  const def = store.list()[0]
  console.log(`  ${def?.type === 'offline' && def?.name === 'DeepSeek' && def?.default ? '✅' : '❌'} 默认账户 = 离线 DeepSeek（且是默认）`)
  console.log(`  ${def?.uuid === offlineUuid('DeepSeek') && def?.uuidSource === 'derived-from-name' ? '✅' : '❌'} 离线 UUID 按名字派生（Java 同款）：${def?.uuid}`)
  console.log(`  ${store.listAuthServers().some((s) => s.id === 'littleskin') ? '✅' : '❌'} 默认带 LittleSkin 认证服务器`)

  const renamed = store.update(def.innerID, { name: '用户', uuid: '0123456789abcdef0123456789abcdef' })
  console.log(`  ${renamed.name === '用户' && renamed.uuid === '01234567-89ab-cdef-0123-456789abcdef' && renamed.uuidSource === 'custom' ? '✅' : '❌'} 离线账户可改名 + 可自定义 UUID`)
  const badUuid = await Promise.resolve().then(() => store.update(def.innerID, { uuid: 'zzz' })).catch((e) => e.message)
  console.log(`  ${/UUID 格式不对/.test(String(badUuid)) ? '✅' : '❌'} 非法 UUID 被拒`)

  const srv = store.addAuthServer({ name: '认证服务器', url: 'https://auth.example.com/yggdrasil/' })
  console.log(`  ${srv.url === 'https://auth.example.com/yggdrasil' ? '✅' : '❌'} 认证服务器地址归一化（去尾斜杠）`)
  const dup = await Promise.resolve().then(() => store.addAuthServer({ url: 'https://auth.example.com/yggdrasil' })).catch((e) => e.message)
  console.log(`  ${/已经加过/.test(String(dup)) ? '✅' : '❌'} 重复地址被拒：${String(dup).slice(0, 26)}`)
  console.log(`  ${store.listAuthServers().length === 2 ? '✅' : '❌'} 已添加的服务器被记住：${store.listAuthServers().map((s) => s.name).join(' / ')}`)
  // 🔴 用户 2026-09-16：认证服务器的**名字**是给人看的（缓存标签里显示它），要能改；
  //    `addAuthServer` 不给名字时默认拿**域名**当名字，所以"建完再改名"是必须的。
  const renamedSrv = store.renameAuthServer(srv.id, '认证服务器')
  console.log(`  ${renamedSrv.name === '认证服务器' && renamedSrv.id === srv.id && renamedSrv.url === srv.url ? '✅' : '❌'} 认证服务器可改名，且 **id 不变**（账户是引用 id 的）`)
  const dupName = await Promise.resolve().then(() => store.renameAuthServer(srv.id, 'LittleSkin')).catch((e) => e.message)
  console.log(`  ${/已经有同名/.test(String(dupName)) ? '✅' : '❌'} 改成已存在的名字被拒：${String(dupName).slice(0, 30)}`)
  const emptyName = await Promise.resolve().then(() => store.renameAuthServer(srv.id, '   ')).catch((e) => e.message)
  console.log(`  ${/名字不能为空/.test(String(emptyName)) ? '✅' : '❌'} 空名字被拒`)
  const sameName = store.renameAuthServer(srv.id, '认证服务器')
  console.log(`  ${sameName.name === '认证服务器' ? '✅' : '❌'} 名字没变时是幂等的（不抛错）`)

  // 接口层：建账户时把 serverName 落到认证服务器（新建给名字 / 选中已有但改了名 → 改名）
  {
    const { readFileSync } = await import('node:fs')
    const { fileURLToPath } = await import('node:url')
    const idx = readFileSync(fileURLToPath(new URL('./index.js', import.meta.url)), 'utf8')
    const at = idx.indexOf("path === '/api/mc/accounts' && req.method === 'POST'")
    const seg = at >= 0 ? idx.slice(at, at + 2000) : ''
    console.log(`  ${/body\.serverName/.test(seg) && /renameAuthServer/.test(seg) ? '✅' : '❌'} 建账户接口把 serverName 落进认证服务器（含改名）`)
  }
  // 🔴 用户 2026-09-16：LittleSkin 只是**预置**（不是"内置"）——**能删**，而且删了不会被 ensureDefaults 复活
  const delPreset = await Promise.resolve().then(() => store.removeAuthServer('littleskin')).catch((e) => ({ error: e.message }))
  console.log(`  ${delPreset?.removed === 'littleskin' ? '✅' : '❌'} 预置的 LittleSkin 也能删（没有"内置不可删"这回事）`)
  const nSrv = store.listAuthServers().length
  store.ensureDefaults()
  console.log(`  ${store.listAuthServers().length === nSrv ? '✅' : '❌'} 删掉之后 ensureDefaults **不会**把它长回来（seeded 标记）`)

  const card = parseAuthlibCard('authlib-injector:yggdrasil-server:https%3A%2F%2Fauth.example.com%2Fyggdrasil')
  console.log(`  ${card === 'https://auth.example.com/yggdrasil' ? '✅' : '❌'} 解析 authlib-injector 卡片：${card}`)
  console.log(`  ${parseAuthlibCard('https://example.com/api/yggdrasil') === 'https://example.com/api/yggdrasil' && parseAuthlibCard('不是网址') === null ? '✅' : '❌'} 裸网址也认 / 垃圾文本返回 null`)

  const acc2 = store.add({ type: 'yggdrasil', name: '用户皮肤站号', serverId: srv.id, login: 'owner@example.com' })
  await store.setCredential(acc2.innerID, { password: 'p@ssw0rd', accessToken: 'tok-1', clientToken: 'ct-1' })
  await store.refreshCredentialIndex()
  const viewJson = JSON.stringify(store.list())
  const view2 = store.list().find((a) => a.innerID === acc2.innerID)
  console.log(`  ${view2?.server?.url === 'https://auth.example.com/yggdrasil' && view2?.hasCredential ? '✅' : '❌'} 皮肤站账户带服务器信息 + hasCredential 标记`)
  // 🔴 列表小灰字要显示"输入的账号"→ 视图必须把它带给 UI（离线/正版没有 login，为 null）
  console.log(`  ${view2?.login === 'owner@example.com' && store.list().find((a) => a.type === 'offline')?.login === null ? '✅' : '❌'} 视图带 login（皮肤站=输入的账号，离线=None）`)
  const delUsed = await Promise.resolve().then(() => store.removeAuthServer(srv.id)).catch((e) => e.message)
  console.log(`  ${/还有账户在用/.test(String(delUsed)) ? '✅' : '❌'} 被账户占用的服务器不许删：${String(delUsed).slice(0, 34)}`)
  console.log(`  ${!/p@ssw0rd|tok-1|ct-1/.test(viewJson) ? '✅' : '❌'} 🔴 公开视图里逐字查过：**没有**密码/token`)
  console.log(`  ${recs.has(`whale-craft/${acc2.innerID}`) ? '✅' : '❌'} 凭据落在宿主凭据服务（key = whale-craft/<innerID>）`)
  const noCred = new AccountStore({ dir: mkdtempSync(join(tmpdir(), 'whale-acc2-')) })
  noCred.ensureDefaults()
  const refuse = await noCred.setCredential(noCred.list()[0].innerID, { password: 'x' }).catch((e) => e.message)
  console.log(`  ${/拒绝把密码写进工作区/.test(String(refuse)) ? '✅' : '❌'} 凭据服务不可用时**拒绝降级写明文**`)
  const removed = await store.remove(acc2.innerID)
  console.log(`  ${removed.removed === acc2.innerID && !recs.has(`whale-craft/${acc2.innerID}`) ? '✅' : '❌'} 删账户连带删凭据`)
  console.log(`  ${store.search('用户').matched === 1 ? '✅' : '❌'} 按指令搜索（名字）`)

  // 工具层（跑在插件的真实实例上，账户库落在 WHALE_CRAFT_DIR 临时目录）
  const accList = await tools.get('mc_accounts').execute({ action: 'list' }, A)
  console.log(`  ${Array.isArray(accList.accounts) && accList.accounts.length >= 1 ? '✅' : '❌'} mc_accounts{list} 可用（${accList.accounts?.length} 个账户，凭据服务 ${accList.credentialsReady ? '可用' : '不可用'}）`)
  console.log(`  ${!/password|authPass|accessToken|clientToken|"token"/i.test(JSON.stringify(accList)) ? '✅' : '❌'} 🔴 mc_accounts 返回里没有任何凭据字段`)
  const chosen = await tools.get('mc_accounts').execute({ action: 'use', innerID: accList.accounts[0].innerID }, A)
  console.log(`  ${chosen.selected?.innerID === accList.accounts[0].innerID ? '✅' : '❌'} mc_accounts{use} 选定账户`)
  const badUse = await tools.get('mc_accounts').execute({ action: 'use', innerID: 'acc-00000000' }, A).catch((e) => e.message)
  console.log(`  ${/没有这个账户/.test(String(badUse)) ? '✅' : '❌'} 选不存在的账户报错清晰`)
  const searchTool = await tools.get('mc_accounts').execute({ action: 'search', query: 'DeepSeek' }, A)
  console.log(`  ${searchTool.matched >= 1 ? '✅' : '❌'} mc_accounts{search} 可用（命中 ${searchTool.matched}）`)
  const refreshOffline = await tools.get('mc_accounts').execute({ action: 'refresh' }, A)
  console.log(`  ${/离线/.test(String(refreshOffline.note ?? '')) ? '✅' : '❌'} 离线账户"刷新"= 说明不需要认证`)
  const ghost = await tools.get('mc_connect').execute({ host: 'mc.example', account: 'acc-00000000' }, A).catch((e) => e.message)
  console.log(`  ${/没有这个账户/.test(String(ghost)) ? '✅' : '❌'} mc_connect 指名不存在的账户报错清晰`)
}

// ── 行事准则 AGENTS.md / 新开关 / 边界信息工具 ──
console.log('\n--- 行事准则 AGENTS.md / 新开关 / 边界信息 ---')
{
  const { DEFAULT_AGENTS_MD, agentsMdPath, readAgentsMd, writeAgentsMd, resetAgentsMd, isAgentsMdPath } = await import('./src/agentsmd.mjs')
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')

  console.log(`  ${/Whale Craft 行事准则/.test(DEFAULT_AGENTS_MD) && /DeepSeek/.test(DEFAULT_AGENTS_MD) && /Master/.test(DEFAULT_AGENTS_MD) ? '✅' : '❌'} 默认准则像样（标题 / 称呼都在）`)
  console.log(`  ${/mc_accounts/.test(DEFAULT_AGENTS_MD) && /mc_capabilities/.test(DEFAULT_AGENTS_MD) && /mc_watch/.test(DEFAULT_AGENTS_MD) && /README\.md/.test(DEFAULT_AGENTS_MD) ? '✅' : '❌'} 默认准则里的关键工具/索引名都在`)
  console.log(`  ${!/xxx/.test(DEFAULT_AGENTS_MD) ? '✅' : '❌'} 草稿里的 "xxx" 占位符已全部替换`)
  // 🔴 凭据边界：默认准则**不得**再指路到明文凭据文件、也不得出现已删除的连接参数
  console.log(`  ${!/mc-servers\.md/.test(DEFAULT_AGENTS_MD) ? '✅' : '❌'} 默认准则不再指路 .agent-docs/mc-servers.md（那里曾有明文密码）`)
  console.log(`  ${!/authPass|authUrl|authUser/.test(DEFAULT_AGENTS_MD) ? '✅' : '❌'} 默认准则不含已删除的 mc_connect 凭据参数`)
  console.log(`  ${/MC设置/.test(DEFAULT_AGENTS_MD) ? '✅' : '❌'} 默认准则教它把用户引导到「MC设置」`)

  const dir = mkdtempSync(join(tmpdir(), 'whale-md-'))
  console.log(`  ${readAgentsMd(dir).source === 'default' ? '✅' : '❌'} 没有自定义文件时用默认`)
  writeAgentsMd(dir, '# 我的准则\n\n- 一句话')
  const custom = readAgentsMd(dir)
  console.log(`  ${custom.source === 'custom' && /我的准则/.test(custom.text) ? '✅' : '❌'} 写入后读回自定义版（${agentsMdPath(dir).split(/[\\/]/).pop()}）`)
  resetAgentsMd(dir)
  // 🔴 2026-09-16 用户纠正："AGENTS.md 就是单纯地编辑这个文件" →
  //    恢复默认 = 把**默认内容写回文件**（不是删掉文件让代码兜底）；source 由内容判定。
  const { existsSync: existsSyncMd, readFileSync: readFileSyncMd } = await import('node:fs')
  const backDefault = readAgentsMd(dir)
  console.log(`  ${existsSyncMd(agentsMdPath(dir)) && backDefault.source === 'default' ? '✅' : '❌'} 「恢复默认」= 把默认写回文件（文件仍在，source 按内容判定）`)
  console.log(`  ${backDefault.text === DEFAULT_AGENTS_MD ? '✅' : '❌'} 恢复后的内容逐字等于内置默认（${backDefault.text.length} 字）`)
  const emptyDir = mkdtempSync(join(tmpdir(), 'whale-md-none-'))
  const noFile = readAgentsMd(emptyDir)
  console.log(`  ${noFile.source === 'default' && noFile.text.length > 100 ? '✅' : '❌'} 文件不存在时也返回默认**全文**（绝不返回空串 → 提示词不会因此消失）`)
  writeAgentsMd(dir, DEFAULT_AGENTS_MD)
  console.log(`  ${readAgentsMd(dir).source === 'default' ? '✅' : '❌'} 就算文件在、只要内容等于默认 → 仍算"默认版"（标签不说谎）`)
  writeAgentsMd(dir, '# 我的准则\n\n- 一句话')
  console.log(`  ${readAgentsMd(dir).source === 'custom' ? '✅' : '❌'} 改过内容 → 算"自定义版"`)
  const tooBig = await Promise.resolve().then(() => writeAgentsMd(dir, 'x'.repeat(200 * 1024))).catch((e) => e.message)
  console.log(`  ${/太大/.test(String(tooBig)) ? '✅' : '❌'} 超大内容被拒`)
  console.log(`  ${isAgentsMdPath('E:\\x\\.whale-craft\\AGENTS.md') && isAgentsMdPath('E:/x/whale_craft/AGENTS.md') && !isAgentsMdPath('E:/x/README.md') ? '✅' : '❌'} isAgentsMdPath 认得本文件、不误伤别的`)

  // 开关：允许所有指令
  await tools.get('mc_admin_config').execute({ action: 'set', path: 'allowAllCommands', value: true }, A)
  const anyCmd = await tools.get('mc_command').execute({ command: '/definitely-not-whitelisted' }, A).catch((e) => e.message)
  console.log(`  ${/不在线/.test(String(anyCmd)) ? '✅' : '❌'} 「允许所有指令」打开后任意指令都过白名单（只因未连服报不在线）`)
  const badBool = await tools.get('mc_admin_config').execute({ action: 'set', path: 'allowAllCommands', value: 'yes' }, A).catch((e) => e.message)
  console.log(`  ${/必须是 true\/false/.test(String(badBool)) ? '✅' : '❌'} 开关类型校验`)
  await tools.get('mc_admin_config').execute({ action: 'reset' }, A)
  const afterReset = await tools.get('mc_admin_config').execute({ action: 'get', path: 'allowAllCommands' }, A)
  console.log(`  ${afterReset.value === false ? '✅' : '❌'} 默认关（reset 后为 false）`)
  const wsDefault = await tools.get('mc_admin_config').execute({ action: 'get', path: 'injectWorkspaceAgentsMd' }, A)
  const wcDefault = await tools.get('mc_admin_config').execute({ action: 'get', path: 'injectWhaleCraftAgentsMd' }, A)
  console.log(`  ${wsDefault.value === false && wcDefault.value === true ? '✅' : '❌'} 注入默认：whale-craft 开、工作区关`)

  const memMd = await tools.get('mc_kit_memory').execute({ action: 'read', path: 'AGENTS.md' }, A).catch((e) => e.message)
  console.log(`  ${/不能通过记忆工具读写/.test(String(memMd)) ? '✅' : '❌'} 记忆工具拒绝读写 AGENTS.md`)

  // 边界信息工具
  const caps = await tools.get('mc_capabilities').execute({}, A)
  const vers = caps?.game?.testedVersions ?? []
  // ⚠️ **不许断言"清单里必须有 26.2"**（2026-09-16 第八轮踩到）：官方 npm 版没有 26.2，
  //    只有本机那份打过补丁的树有；CI 是在干净环境跑官方依赖的，写死就等于把 CI 判死。
  //    这里只断言**自洽性** —— 清单像样、端点出自清单、mineflayer 版本报得出来；
  //    "这台机器支持到哪"属于部署事实，作为信息行打印，不判分。
  console.log(`  ${vers.length >= 20 && vers.includes(caps?.game?.latest) && vers.includes(caps?.game?.oldest) ? '✅' : '❌'} mc_capabilities 报出支持的 MC 版本（${vers.length} 个，端点 ${caps?.game?.oldest} → ${caps?.game?.latest} 均在清单内）`)
  console.log(`  ${vers.includes('26.2') === (caps?.game?.latest === '26.2') ? '✅' : '❌'} 清单与上界自洽（本机装的那份${vers.includes('26.2') ? '**含** 26.2（打过补丁的树）' : '不含 26.2（官方版）'}）`)
  console.log(`  ${caps?.game?.oldest && caps?.game?.latest ? '✅' : '❌'} 给出范围 ${caps?.game?.oldest} → ${caps?.game?.latest}（mineflayer ${caps?.game?.mineflayer}）`)
  console.log(`  ${/microsoft/i.test(JSON.stringify(caps?.auth?.notSupported)) ? '✅' : '❌'} 明说微软登录暂不支持`)
  console.log(`  ${caps?.tools?.count >= 26 && Array.isArray(caps?.tools?.names) ? '✅' : '❌'} 报了工具总数 ${caps?.tools?.count} + 清单`)
  console.log(`  ${caps?.limits?.sequence?.steps === 64 && caps?.config?.file ? '✅' : '❌'} 报了上限与配置文件路径`)
}

// ── 认证 URL 构造（2026-09-15 真机 bug 回归测试）──
// 真机症状：mc_connect 一律报 `Failed to parse URL from /authserver/authenticate`
// 根因：调用点传了 {authUrl,...}，但 #authenticate 签名没接参数、函数体读 this.cfg（已清空）。
// 教训：只测"缺凭据守卫"抓不到这个——**必须走一遍真实认证路径**，把实际发出的 URL 抓下来断言。
// 2026-09-16 更新：凭据不再走 connect 的参数，改由 `auth` 描述符传（账户库解析出来的）。
console.log('\n--- 认证请求 URL（真机 bug 回归）---')
{
  const { McBot } = await import('./src/core.mjs')
  const realFetch = globalThis.fetch
  const captured = []

  // 桩：记下请求，返回**形状不对**的 session，让流程在认证后立刻停住（不会真去连服）
  globalThis.fetch = async (url, opts) => {
    captured.push({ url: String(url), body: opts?.body })
    return { ok: true, status: 200, json: async () => ({}) }
  }
  const yggAuth = (authUrl, authUser = 'u1', authPass = 'p1') => ({ mode: 'yggdrasil', authUrl, authUser, authPass })

  const cases = [
    ['标准', 'https://auth.example/yggdrasil', 'https://auth.example/yggdrasil/authserver/authenticate'],
    ['结尾带斜杠', 'https://auth.example/yggdrasil/', 'https://auth.example/yggdrasil/authserver/authenticate'],
    ['结尾多个斜杠', 'https://auth.example/yggdrasil///', 'https://auth.example/yggdrasil/authserver/authenticate'],
  ]
  for (const [label, authUrl, want] of cases) {
    const bot = new McBot({ instanceId: 'selftest-auth' })
    captured.length = 0
    let err = null
    try { await bot.connect({ host: 'mc.example', auth: yggAuth(authUrl) }) } catch (e) { err = e }
    const got = captured[0]?.url
    const okUrl = got === want
    const okStop = /认证返回异常/.test(String(err?.message))
    console.log(`  ${okUrl && okStop ? '✅' : '❌'} ${label}：发出 ${got ?? '(没发请求)'}`)
    if (!okUrl) console.log(`      期望 ${want}`)
    if (!okStop) console.log(`      错误停在：${err?.message}`)
  }

  // 凭据确实进了请求体（不是只拼 URL）
  {
    const bot = new McBot({ instanceId: 'selftest-auth' })
    captured.length = 0
    try { await bot.connect({ host: 'mc.example', auth: yggAuth('https://auth.example/yggdrasil', 'user-x', 'pass-y') }) } catch {}
    const body = String(captured[0]?.body ?? '')
    console.log(`  ${body.includes('user-x') && body.includes('pass-y') ? '✅' : '❌'} 凭据进了请求体（不是只拼 URL）`)
  }

  // 空 authUrl 必须在**发请求之前**就被拦下（不能退化成相对路径）
  {
    const bot = new McBot({ instanceId: 'selftest-auth' })
    captured.length = 0
    let err = null
    try { await bot.connect({ host: 'mc.example', auth: { mode: 'yggdrasil', authUrl: '', authUser: 'u', authPass: 'p' } }) } catch (e) { err = e }
    console.log(`  ${captured.length === 0 && /认证端点为空/.test(String(err?.message)) ? '✅' : '❌'} 空 authUrl 在发请求前拦下（绝不发相对 URL）：${String(err?.message).slice(0, 40)}`)
  }

  // 没给账户 → 明确报错（凭据不再从 connect 参数来）
  {
    const bot = new McBot({ instanceId: 'selftest-auth' })
    captured.length = 0
    let err = null
    try { await bot.connect({ host: 'mc.example' }) } catch (e) { err = e }
    console.log(`  ${captured.length === 0 && /缺少登录账户/.test(String(err?.message)) ? '✅' : '❌'} 不带账户直接连 → 报"缺账户"而不是偷偷用旧凭据`)
  }

  globalThis.fetch = realFetch
}

// ── 看门狗唤醒投递（2026-09-15 真机 bug 回归：喊我没反应）──
// 真机症状：看门狗检测正常（woke:true）、但注入报
//   `Cannot read properties of undefined (reading 'throwIfAborted')`
// 根因：sessionController.prompt 是 @Remote 方法，签名 (request, signal)，
//   内部第一行就是 signal.throwIfAborted() —— 我只传了 1 个参数。
// 这条路径是**空闲时唯一的叫醒通道**，一炸就等于永远叫不醒。
// 本测试用**忠实模拟宿主契约**的桩：prompt 真的调 throwIfAborted，不给 signal 必炸。
console.log('\n--- 看门狗唤醒投递（真机 bug 回归）---')
{
  const { Watchdog } = await import('./src/watchdog.mjs')
  const { EventEmitter } = await import('node:events')

  const deliver = []
  const hostLike = {
    // 照抄 api/session-controller/src/index.ts:346 的行为
    prompt: (request, signal) => { signal.throwIfAborted(); deliver.push(request); return Promise.resolve({ accepted: true }) },
    cancel: () => ({ accepted: true }),
  }
  const wdCtx = {
    logger: { info: () => {}, warn: () => {} },
    get: (k) => (k === 'sessionController' ? hostLike : undefined),
  }
  const bot = new EventEmitter()
  const wd = new Watchdog({
    ctx: wdCtx,
    sess: { bot, events: [], agentId: 'sess-w', config: {} },
    agent: { id: 'sess-w', status: 'idle' },
    onFire: () => {},
    promptSignal: new AbortController().signal,
  })
  wd.updateConfig({ observeWindowMs: 100, maxWakePerMinute: 100 })
  wd.arm()

  // 空闲状态下命中叫法 → 走 'queue'（= followup，开新一轮）
  bot.emit('chat', { who: '<user>', text: 'deepseek，你在这里建一座地标塔' })
  await new Promise((r) => setTimeout(r, 1400))

  const got = deliver[0]
  console.log(`  ${got ? '✅' : '❌'} 空闲时能真正投递出去（${deliver.length} 次）`)
  console.log(`  ${got?.mode === 'steer' ? '✅' : '❌'} 空闲也走 steer（宿主语义：idle 会起一轮=唤醒）：mode=${got?.mode}`)
  console.log(`  ${/deepseek/.test(got?.content?.[0]?.text ?? '') ? '✅' : '❌'} 注入正文带上原始消息`)
  console.log(`  ${got?.sessionId === 'sess-w' ? '✅' : '❌'} 绑定到正确会话`)

  // 运行中也必须投得出去，且走 steer（插下一步，不打断）
  deliver.length = 0
  wd.agent = { id: 'sess-w', status: 'running' }
  bot.emit('chat', { who: '<user>', text: 'deepseek 在吗' })
  await new Promise((r) => setTimeout(r, 1400))
  console.log(`  ${deliver[0]?.mode === 'steer' ? '✅' : '❌'} 运行中走 steer=插话不打断：mode=${deliver[0]?.mode}`)
  console.log(`  ${wd.stats.injected >= 1 ? '✅' : '❌'} 注入计数已累加（${wd.stats.injected}）`)

  wd.disarm('自检结束')
  console.log(`  ${wd.armed === false ? '✅' : '❌'} disarm 后停止监听`)
}

// ── 看门狗 job 必须能结算（隐患：job 卡在 stopping）──
// 根因：_resolveJob 存了但从没调用 → done 永不 resolve → job_list 里永远挂着
console.log('\n--- 看门狗 job 结算 ---')
{
  const { Watchdog } = await import('./src/watchdog.mjs')
  const { EventEmitter } = await import('node:events')
  let hooks = null
  const kills = []
  const wdCtx = {
    logger: { info: () => {}, warn: () => {} },
    get: (k) => (k === 'jobs'
      ? {
          start: (spec) => { hooks = spec.run(); return 'job-1' },
          kill: (id) => { kills.push(id) },
        }
      : undefined),
  }
  const mk = () => new Watchdog({
    ctx: wdCtx,
    sess: { bot: new EventEmitter(), events: [], agentId: 's', config: {} },
    agent: { id: 's' },
    onFire: () => {},
  })

  const wd = mk()
  wd.arm()
  console.log(`  ${hooks ? '✅' : '❌'} job 已挂上（${wd.jobId}）`)

  // 宿主 kill job → 我们的 cancel → 必须结算 done，且不回头再 kill 自己
  let settled = null
  hooks.done.then((v) => { settled = v })
  hooks.cancel('宿主取消')
  await new Promise((r) => setTimeout(r, 30))
  console.log(`  ${settled ? '✅' : '❌'} done 被结算（不再永远挂在 stopping）：status=${settled?.status}`)
  console.log(`  ${kills.length === 0 ? '✅' : '❌'} 不回头 kill 自己（避免自我递归）：kill 调用 ${kills.length} 次`)
  console.log(`  ${wd.armed === false ? '✅' : '❌'} job 被取消后看门狗也已停`)

  // 反向：AI 主动 disarm → 应该真去 kill 那个 job **并且把 done 结算掉**
  // 🔴 2026-09-16 真机 bug：原来只断言了"会去 kill job"，没断言结算 →
  //    于是"强制关闭后 UI 一直显示还有 1 个后台任务 / 正在停止"漏了过去。
  const wd2 = mk()
  wd2.arm()
  const hooks2 = hooks
  let settled2 = null
  hooks2.done.then((v) => { settled2 = v })
  kills.length = 0
  wd2.disarm('AI 主动关闭')
  await new Promise((r) => setTimeout(r, 30))
  console.log(`  ${kills.includes('job-1') ? '✅' : '❌'} AI 主动 disarm 会去 kill job（${kills.join(',') || '没调'}）`)
  console.log(`  ${settled2 ? '✅' : '❌'} 🔴 **主动** disarm 也结算了 done（否则宿主的 job 永远停在 stopping）：status=${settled2?.status}`)

  // 宿主随后回调 cancel()（我们 kill 之后宿主一定会走这一步）→ 幂等，不能报错也不能重复结算
  let secondSettle = 0
  hooks2.done.then(() => { secondSettle++ })
  let cancelThrew = null
  try { hooks2.cancel('宿主随后取消') } catch (e) { cancelThrew = e }
  await new Promise((r) => setTimeout(r, 30))
  console.log(`  ${!cancelThrew ? '✅' : '❌'} 再次进 disarm（已停用状态）不抛错：${cancelThrew ? cancelThrew.message : 'ok'}`)
  console.log(`  ${kills.length === 1 ? '✅' : '❌'} 已停用后不再重复 kill（kill 调用仍 ${kills.length} 次）`)

  // 极端：没 arm 过就直接 disarm（例如重复点"强制停止"）也不能抛
  const wd3 = mk()
  let threw = null
  try { wd3.disarm('没在跑也要能调') } catch (e) { threw = e }
  console.log(`  ${!threw ? '✅' : '❌'} 未启动时 disarm 幂等不抛错`)
}

// ── 结构不变量：会话事件队列只能有一个写入方 ──
// 曾经的真 bug：McSession.ensureWired 与看门狗 onFire **都**往 sess.events 写，
// 于是同一句聊天进队列两遍（chat/damage/death 三类）。修法是删掉看门狗那一路。
// 这条测试锁死"别再加回来"——重复事件会让 AI 误判"对方说了两遍"。
console.log('\n--- 结构不变量：事件队列单一写入方 ---')
{
  const { readFileSync } = await import('node:fs')
  const { fileURLToPath } = await import('node:url')
  const wdSrc = readFileSync(fileURLToPath(new URL('./src/watchdog.mjs', import.meta.url)), 'utf8')
  const idxSrc = readFileSync(fileURLToPath(new URL('./index.js', import.meta.url)), 'utf8')

  // 看门狗不得调用 onFire（那正是"第二个写入方"）
  const wdPushes = /this\.onFire\s*\(/.test(wdSrc)
  console.log(`  ${!wdPushes ? '✅' : '❌'} 看门狗不写会话事件队列（无 this.onFire 调用）`)

  // 看门狗不得直接 push 到 sess.events
  const wdSessPush = /sess\.events\.push|this\.sess\.events\.push/.test(wdSrc)
  console.log(`  ${!wdSessPush ? '✅' : '❌'} 看门狗不直接 push sess.events`)

  // index.js 里 ensureWired 必须仍然是写入方（别把它也删了，否则 mc_events 空了）
  const wired = /this\.bot\.on\('chat',[\s\S]{0,120}#pushEvent\('chat'/.test(idxSrc)
  console.log(`  ${wired ? '✅' : '❌'} ensureWired 仍是唯一写入方（mc_events 事件来源）`)

  // 看门狗构造签名里不该再收 onFire
  const ctorTakesOnFire = /constructor \(\{ ctx, sess, agent, onFire/.test(wdSrc)
  console.log(`  ${!ctorTakesOnFire ? '✅' : '❌'} 看门狗构造签名已不含 onFire`)
}

// ── 无 OP 也能建造：创造模式自动取物（真机 mc 就是 creative）──
// 关键事实：mc_give 走 set_creative_slot **协议包**，只要求创造模式，**不要求 OP**。
// 之前 placeBlock 在背包为空时会直接失败（要 AI 先想起调 mc_give），这里补了自动取物。
// 用假 bot 真跑一遍 placeBlock，验证"给个方块名就能建"确实成立。
console.log('\n--- 无 OP 建造（创造模式自动取物）---')
{
  const { McBot } = await import('./src/core.mjs')
  // vec3 的导出形态跟 core.mjs 保持一致（默认导出可能是 {Vec3} 也可能是类本身）
  const vec3mod = await import('vec3')
  const Vec3 = vec3mod.Vec3 ?? vec3mod.default?.Vec3 ?? vec3mod.default ?? vec3mod
  if (typeof Vec3 !== 'function') { console.log('  ⚠️ Vec3 拿不到，跳过这组（不影响其他检查）') }
  else {

  const mkFakeBot = ({ gameMode = 'creative', inventory = [], slots = null } = {}) => {
    const state = { setCalls: [], placed: [], equipped: [] }
    // 有状态的世界：placeBlock 后目标格要真的变成该方块。
    // 因为 placeBlock 现在**会校验结果**（旧版不管成没成都报 placed），假 bot 不更新状态就会被正确判失败。
    const world = new Map()
    const key = (p) => `${p.x},${p.y},${p.z}`
    const fake = {
      username: 'bot_name',
      game: { gameMode },
      entity: { position: new Vec3(0, 64, 0), yaw: 0, pitch: 0 },
      players: {},
      controlState: {},
      quickBarSlot: 0,
      inventory: {
        slots: slots ?? new Array(45).fill(null),
        items () { return this.slots.filter(Boolean) },
      },
      blockAt: (pos) => {
        const k = key(pos)
        if (world.has(k)) return { name: world.get(k), boundingBox: 'block', position: pos }
        // 目标格是空气（否则 placeBlock 会报"已被占住"），其余是实心（#placeRef 才找得到依附面）
        if (pos.x === 1 && pos.y === 64 && pos.z === 0) return { name: 'air', boundingBox: 'empty', position: pos }
        return { name: 'stone', boundingBox: 'block', position: pos }
      },
      registry: {
        itemsByName: { oak_planks: { id: 5, stackSize: 64 } },
        items: { 5: { id: 5, name: 'oak_planks', stackSize: 64 } },
        itemsArray: [{ id: 5, name: 'oak_planks', stackSize: 64 }],
        supportFeature: () => false,
        version: { majorVersion: '26', minorVersion: '2' },
      },
      creative: {
        flyTo: async () => {},
        startFlying: () => {},
        stopFlying: () => {},
        setInventorySlot: async (slot, item) => {
          state.setCalls.push({ slot, name: item?.name, count: item?.count })
          if (item) fake.inventory.slots[slot] = { name: item.name, count: item.count, type: item.type }
          else fake.inventory.slots[slot] = null
        },
        clearInventory: async () => {},
      },
      physics: { gravity: 0.08, velocity: new Vec3(0, 0, 0) },
      equip: async (it) => { state.equipped.push(it.name); fake.heldItem = it },
      lookAt: async () => {},
      placeBlock: async (ref) => {
        state.placed.push({ x: ref.position.x, y: ref.position.y, z: ref.position.z })
        // 模拟服务端接受：把"被依附方块相邻的那格"变成新方块。
        // 我们的调用是 placeBlock(ref, face)，目标是 ref+face —— 简化成记录依附点即可，
        // 真正的目标格由测试自己按 (1,64,0) 预置。
        world.set('1,64,0', 'oak_planks')
      },
      setControlState: () => {},
      dig: async () => {},
    }
    return { fake, state }
  }

  // ① 创造 + 背包空 + 指定方块名 → 必须自动取物并放下
  {
    const { fake, state } = mkFakeBot({ gameMode: 'creative', inventory: [] })
    const bot = new McBot({ instanceId: 'selftest-nop' })
    bot.bot = fake
    fake.entity.position = new Vec3(0, 64, 0)
    const r = await bot.placeBlock({ x: 1, y: 64, z: 0, name: 'oak_planks' })
    console.log(`  ${state.setCalls.length === 1 && state.setCalls[0].name === 'oak_planks' ? '✅' : '❌'} 背包空时自动取物（set_creative_slot ${JSON.stringify(state.setCalls)}）`)
    console.log(`  ${state.placed.length === 1 && /oak_planks/.test(String(r.placed ?? '')) ? '✅' : '❌'} 取完就直接放下了（placed=${r.placed}）`)
  }

  // ② 生存模式不该有这福利（不能凭空变东西）
  {
    const { fake, state } = mkFakeBot({ gameMode: 'survival', inventory: [] })
    const bot = new McBot({ instanceId: 'selftest-nop2' })
    bot.bot = fake
    let err = null
    try { await bot.placeBlock({ x: 1, y: 64, z: 0, name: 'oak_planks' }) } catch (e) { err = e }
    console.log(`  ${state.setCalls.length === 0 && /背包里没有/.test(String(err?.message)) ? '✅' : '❌'} 生存模式不自动取物（报错：${String(err?.message).slice(0, 28)}…）`)
  }

  // ③ 不给方块名 + 背包空 → 报错要指导性（告诉它给 name 就能自动取）
  {
    const { fake } = mkFakeBot({ gameMode: 'creative', inventory: [] })
    const bot = new McBot({ instanceId: 'selftest-nop3' })
    bot.bot = fake
    let err = null
    try { await bot.placeBlock({ x: 1, y: 64, z: 0 }) } catch (e) { err = e }
    console.log(`  ${/给 name 指定/.test(String(err?.message)) ? '✅' : '❌'} 没给方块名时报错有指导性`)
  }

  // ④ 槽位选择：已有同款就复用，不占新格、不覆盖别的
  {
    const slots = new Array(45).fill(null)
    slots[36] = { name: 'oak_planks', count: 64 }
    slots[37] = { name: 'stone', count: 64 }
    const { fake, state } = mkFakeBot({ gameMode: 'creative', slots })
    const bot = new McBot({ instanceId: 'selftest-nop4' })
    bot.bot = fake
    await bot.giveItem({ name: 'oak_planks', count: 1 })
    const used = state.setCalls[0]?.slot
    console.log(`  ${used === 36 ? '✅' : '❌'} 同款复用原槽位（用了 ${used}，而不是空槽 38）`)
    console.log(`  ${fake.inventory.slots[37]?.name === 'stone' ? '✅' : '❌'} 没有覆盖掉别的方块（stone 还在 37）`)
  }
  }
}

// ── 看门狗唤醒投递：必须是**提示词注入**，不是模拟用户发言 ──
// 用户要求：不要 followup（那会给对话插一条用户消息），要 steer + plugin 来源。
// `steer` 的宿主文档："An idle driver starts a turn" —— 空闲也能唤醒，正合用。
console.log('\n--- 看门狗唤醒投递（提示词注入，非用户消息）---')
{
  const { Watchdog } = await import('./src/watchdog.mjs')
  const { EventEmitter } = await import('node:events')

  const steerCalls = []
  const promptCalls = []
  const fakeAgent = { id: 'sess-w', status: 'idle', steer: (msg) => { steerCalls.push(msg) } }
  const wdCtx = {
    logger: { info: () => {}, warn: () => {} },
    get: (k) => (k === 'sessionController'
      ? { prompt: (req, sig) => { sig.throwIfAborted(); promptCalls.push(req); return Promise.resolve({}) } }
      : undefined),
  }
  const bot = new EventEmitter()
  const wd = new Watchdog({
    ctx: wdCtx,
    sess: { bot, events: [], agentId: 'sess-w', config: {} },
    agent: fakeAgent,
    promptSignal: new AbortController().signal,
  })
  wd.updateConfig({ observeWindowMs: 100, maxWakePerMinute: 100 })
  wd.arm()

  bot.emit('chat', { who: '<user>', text: 'deepseek，你在这里建一座地标塔' })
  await new Promise((r) => setTimeout(r, 1400))

  const msg = steerCalls[0]
  console.log(`  ${steerCalls.length === 1 ? '✅' : '❌'} 走 agent.steer（${steerCalls.length} 次）`)
  console.log(`  ${promptCalls.length === 0 ? '✅' : '❌'} **没有**走 sessionController.prompt/followup（${promptCalls.length} 次）`)
  console.log(`  ${msg?.source?.kind === 'plugin' ? '✅' : '❌'} 来源是 plugin（不是 user）：kind=${msg?.source?.kind}`)
  console.log(`  ${msg?.source?.form === 'notice' ? '✅' : '❌'} form=notice（渲染成折叠摘要行）`)
  console.log(`  ${msg?.source?.plugin === 'whale_craft' ? '✅' : '❌'} 标了来源插件 whale_craft`)
  console.log(`  ${/deepseek/.test(msg?.content?.[0]?.text ?? '') ? '✅' : '❌'} 正文带上原始消息`)
  console.log(`  ${/MC 看门狗/.test(String(msg?.source?.summary ?? '')) ? '✅' : '❌'} 有单行摘要`)
  console.log(`  ${typeof msg?.id === 'string' && msg.id.length > 8 ? '✅' : '❌'} 是合法的 UserMessage（有 id）`)

  steerCalls.length = 0
  fakeAgent.status = 'running'
  bot.emit('chat', { who: '<user>', text: 'deepseek 在吗' })
  await new Promise((r) => setTimeout(r, 1400))
  console.log(`  ${steerCalls.length === 1 && promptCalls.length === 0 ? '✅' : '❌'} 运行中也用 steer（不分叉成 followup）`)

  wd.disarm('自检结束')
}

// ── 放置可行性判据（用户问：洞穴空气？液体？）──
console.log('\n--- 放置可行性判据 ---')
{
  const { readFileSync } = await import('node:fs')
  const { fileURLToPath } = await import('node:url')
  const src = readFileSync(fileURLToPath(new URL('./src/core.mjs', import.meta.url)), 'utf8')

  console.log(`  ${/boundingBox === 'empty'/.test(src) ? '✅' : '❌'} 判据用 boundingBox==='empty'（不占空间 = 可放）`)
  console.log(`  ${/isLiquid/.test(src) ? '✅' : '❌'} 液体被认作可放 —— 旧版只认 air，水里建不了（码头/桥全废）`)
  console.log(`  ${/canPlaceInto/.test(src) ? '✅' : '❌'} canPlaceInto 已就位`)
  console.log(`  ${/未加载（区块还没到）/.test(src) ? '✅' : '❌'} 未加载的坐标明确拒绝（不盲放）`)
  console.log(`  ${/占住，放不进去/.test(src) ? '✅' : '❌'} 被占住时报错说清是哪个方块`)

  // 从**解析到的** mineflayer 位置取它的依赖树（与插件里 requireFromMineflayer 同一手法）
  const requireHere = (await import('node:module')).createRequire(import.meta.url)
  const req = (await import('node:module')).createRequire(requireHere.resolve('mineflayer'))
  // ⚠️ **不许写死 '26.2'**（2026-09-16 第八轮：干净环境里 mcData 为 null → 整个自检崩在这里，
  //    后面 3 个分节全没跑）。26.2 只有本机那份打过补丁的 minecraft-data 才有；
  //    官方版没有 → 从**实际装的那份**里挑一个真有数据的版本。
  const mcDataPkg = req('minecraft-data')
  const pcVersions = (mcDataPkg.versions?.pc ?? []).map((v) => v.minecraftVersion)
  let version = null
  let mcData = null
  for (const v of ['26.2', ...pcVersions]) {
    const d = mcDataPkg(v)
    if (d?.blocksByName) { version = v; mcData = d; break }
  }
  if (!mcData) {
    console.log(`  ⏭ 真值表跳过：这份 minecraft-data 里找不到有方块数据的版本（${pcVersions.length} 个候选）`)
  } else {
    const shape = (n) => mcData.blocksByName[n]?.boundingBox
    const want = {
      air: 'empty', cave_air: 'empty', void_air: 'empty',
      water: 'empty', lava: 'empty',
      short_grass: 'empty', seagrass: 'empty', torch: 'empty',
      stone: 'block', oak_planks: 'block',
    }
    // 老版本没有某个方块（void_air / short_grass 之类）→ 跳过而不是判错
    const present = Object.entries(want).filter(([n]) => mcData.blocksByName[n])
    const skipped = Object.keys(want).length - present.length
    const bad = present.filter(([n, s]) => shape(n) !== s)
    console.log(bad.length
      ? `  ❌ 与 minecraft-data(${version}) 不符：${bad.map(([n, s]) => `${n}(期望${s} 实际${shape(n)})`).join(', ')}`
      : `  ✅ 真值表与 minecraft-data(${version}) 一致（${present.length} 个方块${skipped ? `，另有 ${skipped} 个该版本没有、已跳过` : ''}）`)
  }
}

// ── mc_connect 必须接受全部连接参数（工具化，不再强绑服务器）──
console.log('\n--- mc_connect 参数面 ---')
// defineTool 会把 parameters 归一成 JSON Schema，真正的参数在 .properties 里
// 2026-09-16：凭据参数（authUrl/authUser/authPass）**已从 mc_connect 移除**（LLM 不得接触）；
// 改成 host/port/subserver/version + account（innerID，账户在「MC设置」里维护）
const raw = tools.get('mc_connect').parameters ?? {}
const cp = Object.keys(raw.properties ?? raw)
const need = ['host', 'port', 'subserver', 'account', 'version']
const gone = ['authUrl', 'authUser', 'authPass']
const missing = need.filter((k) => !cp.includes(k))
const leaked = gone.filter((k) => cp.includes(k))
console.log(missing.length ? `  ❌ 缺少参数：${missing.join(', ')}` : `  ✅ 连接参数齐全：${cp.join(', ')}`)
console.log(leaked.length ? `  ❌ 凭据参数又回来了：${leaked.join(', ')}` : '  ✅ mc_connect 上没有 authUrl/authUser/authPass（凭据只在服务端）')

// ── 客户端 bundle 静态断言（防误删/防回退；真机渲染仍要浏览器里看）──
// ── 局域网探测（mc_lan）：纯函数 + **真在回环上跑一遍协议** ──
console.log('\n--- 局域网探测（mc_lan）---')
{
  const L = await import('./src/lan.mjs')
  const { createServer } = await import('node:net')

  // ① 广播文本解析（Minecraft "对局域网开放" 的格式）
  const b1 = L.parseLanBroadcast('[MOTD]A Minecraft Server[/MOTD][AD]25565[/AD]')
  console.log(`  ${b1?.port === 25565 && b1?.motd === 'A Minecraft Server' ? '✅' : '❌'} 解析局域网广播（MOTD + 端口）`)
  console.log(`  ${L.parseLanBroadcast('乱七八糟') === null && L.parseLanBroadcast('[AD]0[/AD]') === null ? '✅' : '❌'} 垃圾文本/非法端口 → null`)

  // ② 内网判定：只许打自己家网络
  const priv = ['10.0.0.5', '172.16.0.1', '172.31.255.254', '192.168.1.9', '169.254.1.1', '127.0.0.1']
  const pub = ['8.8.8.8', '172.15.0.1', '172.32.0.1', '11.0.0.1', '1.1.1.1']
  console.log(`  ${priv.every(L.isPrivateIPv4) && !pub.some(L.isPrivateIPv4) ? '✅' : '❌'} 内网判定（10/8 · 172.16-31 · 192.168 · 169.254 · 127）`)

  // ③ 网段展开 + 🔴 公网必须被拒
  const hosts = L.hostsOf('192.168.1')
  console.log(`  ${hosts.length === 254 && hosts[0] === '192.168.1.1' && hosts.at(-1) === '192.168.1.254' ? '✅' : '❌'} /24 展开成 .1~.254（跳过网络号/广播号）`)
  console.log(`  ${L.hostsOf('192.168.1.7').length === 1 && L.hostsOf('192.168.1.7')[0] === '192.168.1.7' ? '✅' : '❌'} 单个地址（/32）就只扫一个`)
  const refused = await Promise.resolve().then(() => L.hostsOf('8.8.8')).catch((e) => e.message)
  console.log(`  ${/只允许扫描内网网段/.test(String(refused)) ? '✅' : '❌'} 🔴 公网网段被拒：${String(refused).slice(0, 34)}`)
  const badSpec = await Promise.resolve().then(() => L.hostsOf('not-a-subnet')).catch((e) => e.message)
  console.log(`  ${/网段写法不认/.test(String(badSpec)) ? '✅' : '❌'} 写法不对也报清楚`)

  // ④ MOTD 组件拍平（含 § 颜色码）
  console.log(`  ${L.flattenMotd({ text: 'A ', extra: [{ text: '§aFake' }, { text: ' §rServer' }] }) === 'A Fake Server' ? '✅' : '❌'} MOTD 组件拍平 + 去掉 § 颜色码`)

  // ⑤ VARINT 往返（300 要两个字节才装得下）
  const v = L.writeVarInt(300)
  const back = L.readVarInt(v, 0)
  console.log(`  ${v.length === 2 && back?.value === 300 && back?.size === 2 ? '✅' : '❌'} VARINT 编解码往返（300 → ${v.length} 字节）`)

  // ⑥ 🔴 真在回环上起一个"假 MC 服务器"，把 STATUS ping 整条路跑通
  const fake = createServer((sock) => {
    sock.once('data', () => {
      const json = JSON.stringify({
        version: { name: '1.21.4', protocol: 769 },
        players: { online: 2, max: 20, sample: [{ name: 'Alice' }, { name: 'Bob' }] },
        description: { text: 'A §aFake §rServer' },
      })
      const payload = Buffer.concat([L.writeVarInt(0x00), L.writeVarInt(Buffer.byteLength(json)), Buffer.from(json, 'utf8')])
      sock.write(Buffer.concat([L.writeVarInt(payload.length), payload]))
    })
  })
  await new Promise((r) => fake.listen(0, '127.0.0.1', r))
  const port = fake.address().port
  const st = await L.statusPing({ host: '127.0.0.1', port, timeoutMs: 2000 })
  console.log(`  ${st.ok === true ? '✅' : '❌'} STATUS ping 手写协议跑通（${st.ok ? st.latencyMs + 'ms' : st.error}）`)
  console.log(`  ${st.version === '1.21.4' && st.protocol === 769 ? '✅' : '❌'} 读到版本 ${st.version}（协议 ${st.protocol}）`)
  console.log(`  ${st.players?.online === 2 && st.players?.max === 20 && st.players?.sample?.[0] === 'Alice' ? '✅' : '❌'} 读到人数 2/20 + 玩家名`)
  console.log(`  ${st.motd === 'A Fake Server' ? '✅' : '❌'} 读到 MOTD（颜色码已去）：${JSON.stringify(st.motd)}`)

  // ⑦ 端口探测：开着的 true、没人听的 false（都走回环）
  const openOk = await L.probePort({ host: '127.0.0.1', port, timeoutMs: 800 })
  const closedOk = await L.probePort({ host: '127.0.0.1', port: 1, timeoutMs: 300 })
  console.log(`  ${openOk === true && closedOk === false ? '✅' : '❌'} TCP 端口探测（开着=true / 关着=false）`)

  // ⑧ 扫段整条路：只扫 127.0.0.1 这一个地址、只扫那一个端口 → 必须找到这台假服务器
  const scan = await L.scanSubnet({ subnet: '127.0.0.1', ports: [port], timeoutMs: 800, pingTimeoutMs: 2000 })
  const hit = scan.servers?.[0]
  console.log(`  ${scan.hosts === 1 && scan.openPorts === 1 && hit?.version === '1.21.4' ? '✅' : '❌'} 扫段 → 摸端口 → STATUS ping 一条龙（找到 ${scan.servers?.length ?? 0} 台）`)
  await new Promise((r) => fake.close(r))

  // ⑨ 工具面：注册了、参数齐、公网网段在工具层也被拒（且不傻等广播）
  const lanDef = tools.get('mc_lan')
  console.log(`  ${lanDef ? '✅' : '❌'} 注册了 mc_lan 工具`)
  const lanParams = Object.keys(lanDef?.parameters?.properties ?? lanDef?.parameters ?? {})   // defineTool 归一成 JSON Schema，真参数在 .properties
  console.log(`  ${['mode', 'subnet', 'ports', 'seconds'].every((k) => lanParams.includes(k)) ? '✅' : '❌'} 参数齐（${lanParams.join(', ')}）`)
  const lanRefuse = await tools.get('mc_lan').execute({ mode: 'scan', subnet: '8.8.8' }, A)
  console.log(`  ${lanRefuse?.error && /网段被拒/.test(String(lanRefuse.error)) ? '✅' : '❌'} 工具层同样拒绝公网：${String(lanRefuse?.error).slice(0, 30)}`)
}

console.log('\n--- 客户端 bundle（client.js 静态检查）---')
{
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('./client.js', import.meta.url), 'utf8')
  // 只看**代码**，不看注释：事故记录里会提到 data-composer-card 这些词，但它们不在代码路径上。
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '')
  const checks = [
    ['注册 id 仍是 whale_craft', /id:\s*'whale_craft'/.test(src)],
    ['mc-agent 兼容壳已删除（宿主已冷启动、图里只有 whale_craft）', !/id:\s*'mc-agent'/.test(src)],
    ["状态条插槽 id/order='whale_craft-status'/50", /'whale_craft-status'[\s\S]{0,80}order:\s*50/.test(src)],
    ["MC设置按钮 order=45（排在状态条左边）", /whale_craft-mc-settings[\s\S]{0,200}order:\s*45/.test(src)],
    // 🔴 2026-09-16 事故：DOM 注入 + 全域 Observer 会把「MC设置」插到输入框上方（生成时尤其明显）。
    //    现在只允许**一处**、**有门控**、**锚点只在 hero 相位存在**、**观察范围只限卡片**的注入。
    ['不做 document.body 级观察（老 bug 的根源）', !/observe\(document\.body/.test(code)],
    ['不做"卡片前面的兄弟"式位置猜测', !/findHeroRow/.test(code) && !/appendChild\(btn\)/.test(code)],
    ['注入锚点用宿主的稳定壳 data-slot=conversation.hero.agentPreset', /HERO_CHIP_ANCHOR = '\[data-slot="conversation\.hero\.agentPreset"\]'/.test(code)],
    ['按钮插在模式芯片**右边**（afterend）', /insertAdjacentElement\('afterend', btn\)/.test(code)],
    ['放置是幂等的（不会自己触发自己）', /btn\.previousElementSibling === anchor\) return/.test(code)],
    ['观察目标只限作曲器卡片', /querySelector\('\[data-composer-card\]'\)/.test(code) && /observer\.observe\(target, \{ childList: true, subtree: true \}\)/.test(code)],
    ['组件卸载就摘掉按钮', /btn\.remove\(\)/.test(code)],
    ['注入由门控驱动（只有 show 为真才挂）', /if \(!show\) return undefined/.test(code) && /return mountHeroChipButton\(openSettings\)/.test(code)],
    // 🔴 2026-09-16 二轮事故：门控**不许依赖一次性网络请求**。
    //    第一版问 `/api/mc/mode`，浏览器在新接口上线前 HMR 拿到新客户端 → 404 →
    //    永久当成"非 MC 模式" → MC 模式里也没有按钮。
    //    现在：主判据是**本地的会话 preset**（不等网络），服务端只做兜底且**必带重试**。
    ['MC设置按会话 preset 本地门控（useSessions）', /useSessions/.test(code) && /projectionValues\?\.agentPreset/.test(code)],
    ['新会话页入口走正经插槽（conversation.input.right）', /conversation\.input\.right/.test(code) && /whale_craft-mc-settings-hero/.test(code)],
    ['两个入口按 blank 互斥（不会同时挂两个模态框）', /useMcSettingsGate\(props, false\)/.test(code) && /useMcSettingsGate\(props, true\)/.test(code) && /s\.blank === true/.test(code)],
    ['本地 preset 是主判据（不必等网络）', /const localShow = known && blank === wantBlank && mcPresetIds\.includes\(preset\)/.test(code) && /if \(localShow\) return !deniedNoWorkspace/.test(code)],
    // 🔴 2026-09-16 用户："没有选中工作区，则拒绝发起 MC 模式会话和设置。"
    //    前端：只有服务端**明确**说 no-workspace 才隐藏入口（请求失败/其它 false 一律维持本地判断
    //    ——"一次性请求失败 = 入口永久消失"那个坑不能再踩）
    ['没工作区才隐藏入口（服务端明确 no-workspace；失败不隐藏）', /diag\?\.reason === 'no-workspace'/.test(code) && /catch\(\(\) => \{ if \(alive\) setDeniedNoWorkspace\(false\) \}\)/.test(code)],
    ['设置接口全都带上 sessionId（服务端要用它定位工作区）', /const withSid = \(p\) =>/.test(code) && /apiGet\(withSid\('\/api\/mc\/accounts'\)\)/.test(code) && /apiPatch\(withSid\('\/api\/mc\/config'\)/.test(code) && !/api(Get|Patch|Post|Delete)\('\/api\/mc\/(accounts|config|authservers)'/.test(code)],
    // 🔴 门控名单走**专门的小接口**（不需要工作区）：用 /api/mc/config 会被闸门拒 → 静默退回兜底名单
    ['前端门控名单取 /api/mc/presets（不带 sessionId）', /fetch\('\/api\/mc\/presets'/.test(code) && !/fetch\('\/api\/mc\/config'/.test(code)],
    // 🔴 2026-09-16 真机 bug：两个入口都把模态框写成 `createElement(McSettingsModal, null)`
    //    → sessionId 永远是 undefined → 点开设置就报"缺少 sessionId"。
    ['模态框真的拿到了 props（不是 null）', !/React\.createElement\(McSettingsModal, null\)/.test(code) && /React\.createElement\(McSettingsModal, \{ \.\.\.props, wsCwd \}\)/.test(code)],
    ['新对话页会把已知工作区一起报上去（cwd 兜底）', /function useWorkspaceCwd\(props\)/.test(code) && /q\.push\('cwd=' \+ encodeURIComponent\(wsCwd\)\)/.test(code)],
    // 🔴 2026-09-16：真机上反复"没注入"却查不出原因 → 「提示词」页直接把判据摆出来
    ['「提示词」页显示注入状态（会不会注入 + 为什么不会）', /data-wc-injectstatus/.test(code) && /injectStatus\?\.segments/.test(code) && /data-wc-note/.test(code)],
    ['服务端兜底只给标题条且带重试（不是一次性请求）', /const needServer = !known && !wantBlank/.test(code) && /\+\+tries < 20/.test(code) && /setTimeout\(tick, 3000\)/.test(code)],
    ['名单来自 /api/mc/presets 的 mcModePresets（带默认值兜底）', /mcModePresets/.test(code) && /MC_PRESETS_FALLBACK/.test(code)],
    ['/api/mc/presets 不带闸门（门控名单不能被"没工作区"挡住）', /path === '\/api\/mc\/presets'[\s\S]{0,220}return ok\(\{ mcModePresets/.test(readFileSync(new URL('./index.js', import.meta.url), 'utf8'))],
    ['判不了就不渲染（return null）', /if \(!show\) return null/.test(code)],
    ['调用 /api/mc/accounts', src.includes('/api/mc/accounts')],
    ['调用 /api/mc/authservers', src.includes('/api/mc/authservers')],
    ['调用 /api/mc/config', src.includes('/api/mc/config')],
    ['普通停止按钮已移除（没有 }, \'停止\') 这种按钮）', !/\}\s*,\s*'停止'\s*\)/.test(src) && !/stop\(false\)/.test(src)],
    ['微软账户那项标"未实现"', /未实现/.test(code)],
    ['拖卡片能读 dataTransfer', /dataTransfer/.test(src)],
    // ── 账户页 UI（用户 2026-09-16 重做）：横条 + 类型气泡 + 独立新建/编辑界面 ──
    ['账户列表是横条 + 类型气泡', /data-wc-acct/.test(code) && /function TypeChip/.test(code)],
    ['列表里不再展示细节（innerID / UUID / 服务器）', !/innerID：/.test(code) && !/UUID：/.test(code) && !/服务器：/.test(code)],
    ['离线 = 编辑，其余 = 刷新', /disabled: rowBusy,\s*onClick: \(\) => props\.onEdit/.test(code) && /'刷新'/.test(code)],
    ['「添加」在右上角（panehead + spacer）', /data-wc-panehead/.test(code) && /data-wc-spacer/.test(code) && /＋ 添加/.test(code)],
    ['三种账户各有独立界面', /function TypePicker/.test(code) && /function OfflineForm/.test(code) && /function YggdrasilForm/.test(code)],
    ['第三方新建：服务器 → 名字 → 账号 → 密码', (() => {
      const a = code.indexOf("label: '认证服务器'")
      const b = code.indexOf("label: '服务器名字（留空就用域名）'")
      const c = code.indexOf("label: '账号（邮箱）'")
      const d = code.indexOf("label: '密码'")
      return a > 0 && a < b && b < c && c < d
    })()],
    // 🔴 用户 2026-09-16 纠正：第三方表单问的必须是**认证服务器的名字**（缓存标签要看得懂），
    //    不是"游戏内名字"——角色名由认证服返回，问用户填没有意义（登录后必被覆盖）。
    ['第三方表单只问"服务器名字"，不问"游戏内名字"', (() => {
      const a = code.indexOf('function YggdrasilForm')
      const b = code.indexOf('function AccountsPane')
      const seg = a >= 0 && b > a ? code.slice(a, b) : ''
      return /服务器名字/.test(seg) && !/游戏内名字/.test(seg)
    })()],
    ['服务器名字会随账户一起提交（serverName）', /serverName/.test(code)],
    ['改过名字才带 serverName（没改就别无谓地改名请求）', /nm !== pickedSrv\.name \? \{ serverName: nm \}/.test(code)],
    ['第三方新建有**看得见的**拽托接受区', /data-wc-drop/.test(code) && /把 authlib-injector 卡片拖到这里/.test(code)],
    ['拖卡片后自动选中并填进输入框', /onAddCard\(card\)[\s\S]{0,160}setUrl\(srv\.url\)/.test(code)],
    ['已缓存服务器 = 可点填充 + × 删除的标签', /data-wc-tagpick/.test(code) && /data-wc-tagx/.test(code)],
    ['第三方横条带小灰字服务器名（无名字退 url）', /data-wc-acctsub/.test(code) && /acc\.server\?\.name \|\| acc\.server\?\.url/.test(code)],
    // 🔴 用户 2026-09-16：主文本是**游戏 ID**（档案名），小灰字要写成「输入的账号（服务器名）」——
    //    输入的账号和游戏里的 ID 往往不是一回事，两个都得看得见；相同时不重复写。
    ['第三方小灰字 = 「账号（服务器名）」（两者不同时才带账号）', /\$\{login\}（\$\{srvLabel\}）/.test(code) && /login !== acc\.name/.test(code)],
    ['设置卡片**固定尺寸**（切页不跳大小：height 而非 max-height）', /\[data-wc-card\][\s\S]{0,220}height:min\(86vh,860px\)/.test(code) && !/\[data-wc-card\][\s\S]{0,220}max-height:min\(86vh,860px\)/.test(code)],
    ['不再有"内置不可删"的 UI 痕迹', !/data-wc-srv-builtin/.test(code) && !/data-wc-badge/.test(code)],
    // 🔴 文案规矩（用户 2026-09-16）：UI 里只写用户需要的信息——不许实现细节/AI 味的话
    ['UI 无"凭据库 / AI 看不到"之类', !/DSH 凭据库|AI 看不到|AI 不能读写|凭据库/.test(code)],
    ['UI 无"一拨就生效 / 即时保存"之类', !/一拨就生效|即时保存/.test(code)],
    ['UI 无"当前来源 / 默认版"之类', !/当前来源|默认版/.test(code)],
    ['提示词那页就叫「提示词」（不写"行事准则"）', /label: '提示词'/.test(code) && !/行事准则/.test(code)],
    ['强制停止的 tooltip 说人话（不写四步实现）', !/先停 LLM/.test(code)],
  ]
  for (const [label, passed] of checks) console.log(`  ${passed ? '✅' : '❌'} ${label}`)
}

console.log('\n--- 依赖面 + 打包完整性（mineflayer 是**依赖**不是"你自己装"；用户 2026-09-16 定）---')
{
  const { readFileSync } = await import('node:fs')
  const { createRequire } = await import('node:module')
  const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))
  const deps = pkg.dependencies ?? {}
  const opt = pkg.optionalDependencies ?? {}
  const peer = pkg.peerDependencies ?? {}
  const peerMeta = pkg.peerDependenciesMeta ?? {}
  const devDeps = pkg.devDependencies ?? {}
  const req = createRequire(new URL('./index.js', import.meta.url))

  // mineflayer 自己声明的 vec3 范围：我们必须跟它**同一条线**，否则会装出两份 vec3 → instanceof 失效
  let mfVec3Range = null
  let mfVersion = null
  let sameVec3 = false
  try {
    const reqMf = createRequire(req.resolve('mineflayer'))
    mfVec3Range = reqMf('mineflayer/package.json').dependencies?.vec3 ?? null
    mfVersion = reqMf('mineflayer/package.json').version
    sameVec3 = req.resolve('vec3') === reqMf.resolve('vec3')
  } catch {
    // 依赖没装：下面几项会 ❌ —— 那正是我们要的信号，不是崩溃
  }
  const lineOf = (r) => String(r ?? '').replace(/^[\^~>=<\s]+/, '').split('.').slice(0, 2).join('.')
  // ⚠️ 别拿"同 minor"当"相容"（2026-09-16 第八轮踩过：CI 里装到 4.39.0，被误判 ❌）。
  //    `^4.37.1` 的语义是"同大版本内可升"：4.37.1 → 4.39.0 合法。
  const caretOk = (range, version) => {
    const m = /^\^(\d+)\.(\d+)\.(\d+)/.exec(String(range ?? ''))
    if (!m) return true
    const [maj, min, pat] = [Number(m[1]), Number(m[2]), Number(m[3])]
    const v = String(version ?? '').split('.').map(Number)
    if (v[0] !== maj) return false
    if (maj === 0) return v[1] === min && v[2] >= pat     // 0.x：caret 只允许 patch 级
    return v[1] > min || (v[1] === min && v[2] >= pat)
  }

  const checks = [
    ['mineflayer 是**直接依赖**（装上插件就有机器人，不用用户自己补）', typeof deps.mineflayer === 'string'],
    ['vec3 也是直接依赖（pnpm 严格布局下，不声明就 import 不到传递依赖）', typeof deps.vec3 === 'string'],
    ['vec3 与 mineflayer 要的是**同一条线**（防两份 vec3 → instanceof 命门）', !!mfVec3Range && lineOf(deps.vec3) === lineOf(mfVec3Range)],
    ['运行时 vec3 与 mineflayer 解析到**同一个文件**', sameVec3],
    ['解析到的 mineflayer 版本满足声明范围（`^4.37.1` 允许 4.39.0）', !!mfVersion && caretOk(deps.mineflayer, mfVersion)],
    ['sharp 放 optionalDependencies（原生模块装不上也不该让整个安装失败）', typeof opt.sharp === 'string' && deps.sharp === undefined],
    ['宿主包走 peerDependencies（@deepseek-ai/dsh-tools / schemastery）', typeof peer['@deepseek-ai/dsh-tools'] === 'string' && typeof peer['@deepseek-ai/schemastery'] === 'string'],
    ['peer 范围写 `*`（npm 上 dsh-tools 只有 0.0.1-rc.1，钉版本号必错）', peer['@deepseek-ai/dsh-tools'] === '*' && peer['@deepseek-ai/schemastery'] === '*'],
    // 🔴 2026-09-16 第八轮：单纯写成 peer 不够 —— npm/pnpm 会**自动去 npm 装一份** 0.0.1-rc.1，
    //    和宿主那份（本机是源码树的 0.1.5-rc.2）变成**两个 Tool 类**。声明成 optional peer 才不装。
    ['宿主包是 **optional** peer（否则包管理器会装出第二份 Tool 类）', peerMeta['@deepseek-ai/dsh-tools']?.optional === true && peerMeta['@deepseek-ai/schemastery']?.optional === true],
    // 但本地跑自检/CI 时没有宿主，得靠 devDependencies 顶上（devDeps 不会发给用户）
    ['devDependencies 里有宿主包（干净环境/CI 里自检才跑得起来）', typeof devDeps['@deepseek-ai/dsh-tools'] === 'string' && typeof devDeps['@deepseek-ai/schemastery'] === 'string'],
  ]
  for (const [label, passed] of checks) console.log(`  ${passed ? '✅' : '❌'} ${label}`)
  if (!mfVersion) console.log('  ⚠️ 依赖没解析到（先 npm install / pnpm install 再跑自检）')

  // ── 打包完整性：`files` 白名单差点把 selfcheck.mjs 漏出包（2026-09-16 真事：README 让人跑它，包里却根本没有）──
  const { readdirSync, existsSync } = await import('node:fs')
  const { fileURLToPath } = await import('node:url')
  const { join } = await import('node:path')
  const root = fileURLToPath(new URL('./', import.meta.url))
  const files = pkg.files ?? []
  const covered = (rel) => files.some((f) => String(f) === rel || rel.startsWith(String(f).replace(/\/$/, '') + '/'))
  const srcFiles = readdirSync(join(root, 'src')).filter((n) => n.endsWith('.mjs')).map((n) => `src/${n}`)

  const packChecks = [
    ['files 覆盖运行入口（index.js / client.js / cordis.patch.yml）', ['index.js', 'client.js', 'cordis.patch.yml'].every(covered)],
    ['files 覆盖 selfcheck.mjs（README 让人跑它，就必须在包里）', covered('selfcheck.mjs')],
    [`files 覆盖 src/ 下每个 .mjs（现 ${srcFiles.length} 个；新增文件忘了加会当场红）`, srcFiles.every(covered)],
    ['files 覆盖 tools/check-core.mjs 与 extensions/', covered('tools/check-core.mjs') && covered('extensions')],
    ['files 里没有运行期产物（node_modules / logs / config / accounts）', !files.some((f) => /node_modules|^logs|config\.json|accounts\.json/.test(String(f)))],
    ['files 里每个条目都真实存在', files.every((f) => existsSync(join(root, String(f))))],
  ]
  for (const [label, passed] of packChecks) console.log(`  ${passed ? '✅' : '❌'} ${label}`)
}

console.log('\n日志:', logs.slice(0, 6).join(' | ') || '(无)')
process.exit(0)

