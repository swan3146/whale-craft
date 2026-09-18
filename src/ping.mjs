// -*- coding: utf-8 -*-
/**
 * whale_craft / ping.mjs —— **单地址服务器探测（Minecraft STATUS ping）**
 * ============================================================================
 * 用户 2026-09-18 要求："有没有 ping 的工具？已知地址，测试通透性和 motd 等信息，单地址。"
 *
 * 与 `mc_lan` 的分工（**别再混起来**）：
 *   · `mc_lan`  = **只听**局域网公告（不知道地址时用），恒定几秒，不主动发包；
 *   · `mc_ping` = **已知地址**，主动发一次 STATUS ping（握手 + 状态请求），拿
 *                 "通不通 / 版本 / 协议号 / MOTD / 人数 / 延迟"——**不登录、不用账户**。
 * 与 `mc_connect` 的分工：`mc_connect` 是真的进服（要账户、要认证、会掉线重连）；
 *   `mc_ping` 只问一句"你是谁"，问完就断。
 *
 * 实现上游：**用 mineflayer 自己那份 `minecraft-protocol`**（`createRequire` 锚在解析到的
 * mineflayer 上）——和 `mc_connect` 走的是同一套协议栈/版本表，不另写一份协议。
 *   协议细节（`src/ping.js`）：TCP 连上后写 `set_protocol(nextState=1)`、
 *   状态切到 STATUS 后写 `ping_start`，服务端回 `server_info`（JSON 字符串）
 *   ——**"通不通"在收到 `server_info` 那一刻就确定了**；随后的 `ping` 包只是量延迟。
 *
 * 🔴 **绝不冒泡异常**：这个工具是诊断用的，"连不上"是**正常结果**而不是错误。
 *    任何 rejection / 超时都在这里收敛成 `{ok:false, error, hint}`，
 *    不能让一个 ECONNREFUSED 变成宿主眼里的未处理错误（2026-09-18 那次 P0 的教训）。
 * ============================================================================
 */
import { createRequire } from 'node:module'

/** 从 mineflayer **自己的**依赖树里解析（和 core.mjs 同款锚点，保证是同一份协议栈） */
const requireFromMineflayer = (() => {
  try { return createRequire(createRequire(import.meta.url).resolve('mineflayer')) } catch { return createRequire(import.meta.url) }
})()

/** 常见网络错误 → 一句人话（给 LLM 省一轮猜测；认不出就原样回） */
export function friendlyNetError (e) {
  const code = String(e?.code ?? '')
  const msg = String(e?.message ?? e ?? '')
  const table = {
    ECONNREFUSED: '端口没人听（服务端没开、或端口不对）',
    ETIMEDOUT: '连上了但一直没回应（可能被防火墙丢包，或服务端卡死）',
    EHOSTUNREACH: '路由不到这台主机（地址不对，或不同网段）',
    ENETUNREACH: '网络不可达（本机没网 / 网卡不对）',
    ENOTFOUND: '域名解析不了（地址拼错了？）',
    EAI_AGAIN: '域名解析超时（DNS 有问题）',
    ECONNRESET: '连接被对方重置（服务端踢掉了这次连接）',
    EPIPE: '连接被对方关掉了',
    CERT_HAS_EXPIRED: 'TLS 证书过期',       // 一般 MC 用不到，留着兜底
  }
  if (table[code]) return `${code}：${table[code]}`
  if (/unsupported protocol/i.test(msg)) return '服务端上报的协议号不在本地版本表里（服务端太新/太老，考虑用 mc_connect 的 version 参数手填版本）'
  if (code) return `${code}：${msg}`
  return msg || '未知错误'
}

/**
 * 地址 → `{host, port}`。
 * 认这些写法：`example.com` · `example.com:25566` · `1.2.3.4:25565` · `[::1]:25565` ·
 * `localhost`（**不认 IPv6 裸地址**——MC 的 SRV/握手都要方括号形，含糊不如直说）。
 */
export function parseAddress (input, defaultPort = 25565) {
  const raw = String(input ?? '').trim()
  if (!raw) throw new Error('缺少地址：给 address，如 `example.com` 或 `example.com:25566`')
  const m = /^\[([^\]]+)\](?::(\d{1,5}))?$/.exec(raw)          // [::1]:25565
  if (m) return { host: m[1], port: clampPort(m[2] ?? defaultPort) }
  const parts = raw.split(':')
  if (parts.length === 1) return { host: parts[0], port: clampPort(defaultPort) }
  if (parts.length === 2) return { host: parts[0], port: clampPort(parts[1]) }
  throw new Error(`地址写法不认：${raw}（IPv6 请写成 [::1]:25565 这样）`)
}

function clampPort (p) {
  const n = Number(p)
  if (!Number.isInteger(n) || n <= 0 || n > 65535) throw new Error(`端口不合法：${p}（要 1-65535）`)
  return n
}

/** MOTD 可能是字符串、`{text}` 组件或组件数组 → 拍平成纯文本（顺手去掉 `§` 颜色码） */
export function flattenMotd (d) {
  if (d == null) return ''
  if (typeof d === 'string') return d.replace(/§./g, '')
  if (Array.isArray(d)) return d.map(flattenMotd).join('')
  if (typeof d === 'object') {
    const own = typeof d.text === 'string' ? d.text : ''
    const extra = Array.isArray(d.extra) ? d.extra.map(flattenMotd).join('') : ''
    return (own + extra).replace(/§./g, '')
  }
  return String(d)
}

/**
 * 发一次 STATUS ping。**永不抛异常**。
 * @param {object} o
 * @param {string} o.host            目标主机（域名或 IP）
 * @param {number} [o.port=25565]
 * @param {number} [o.timeoutMs=5000] 硬超时（自己兜，不依赖上游默认的 120 秒）
 * @param {string} [o.fakeHost]      Velocity 之类的子服域名（握手里的 serverHost 用它，路由到子服）
 * @param {string|false} [o.version=false] 握手用的协议版本；默认 false = 先按默认版本握手拿服务端上报的协议号
 * @returns {Promise<object>} `{ok:...}`；失败时 `{ok:false, host, port, error, hint}`
 */
export async function statusPing ({ host, port = 25565, timeoutMs = 5000, fakeHost = '', version = false } = {}) {
  const out = { host: String(host ?? ''), port: Number(port), timeoutMs: Number(timeoutMs) }
  if (!out.host) return { ...out, ok: false, error: '缺少 host', hint: '给 address，如 example.com:25565' }

  let mc
  try {
    mc = requireFromMineflayer('minecraft-protocol')
  } catch (e) {
    // 没解析到协议栈时的唯一姿势：说清为什么，别假装是网络问题
    return { ...out, ok: false, error: `解析不到 minecraft-protocol：${e?.message ?? e}`, hint: '插件依赖树不完整（mineflayer 那棵树里应该有它）；这是环境问题，不是服务器问题' }
  }
  if (typeof mc?.ping !== 'function') {
    return { ...out, ok: false, error: 'minecraft-protocol 没有 ping()（版本太老？）', hint: '环境问题，不是服务器问题' }
  }

  const t0 = Date.now()
  let client = null
  let timer = null
  const limit = Math.max(1000, Math.min(out.timeoutMs, 30000))

  /**
   * 🔴 为什么不直接用上游的 `mc.ping()`：
   *   ① 它**不暴露 client**，我想在超时时把连接真掐掉就得去覆盖 `options.connect`
   *      —— 而 `ping.js` 结尾正是 `options.connect(client)`，覆盖掉它 = 谁都不建 socket，
   *      实测四种场景（通的、没人听的、黑洞、域名错）全都只能干等我的硬超时；
   *   ② 它的超时是 `closeTimeout`，默认 **120 秒**，对一个工具调用太长。
   * 所以这里用同一套底层（`Client` + `states` + `tcpDns`），把包序照抄一遍，
   * 但**超时与清理都由我自己掌握**。
   */
  const require2 = (m) => requireFromMineflayer(`minecraft-protocol/src/${m}`)

  return await new Promise((resolve) => {
    let settled = false
    let connected = false
    let handshakeMs = null
    let firstByteMs = null

    const done = (payload) => {
      if (settled) return
      settled = true
      try { if (timer) clearTimeout(timer) } catch { /* 无所谓 */ }
      // 无论哪条路径都把连接掐掉（超时那条尤其重要，否则 socket 挂着）
      try { client?.end?.() } catch { /* 已经断了 */ }
      try { client?.socket?.destroy?.() } catch { /* 已经断了 */ }
      resolve(payload)
    }
    const fail = (e) => done({
      ...out,
      ok: false,
      elapsedMs: Date.now() - t0,
      error: String(e?.message ?? e ?? '未知错误'),
      code: e?.code ?? null,
      hint: friendlyNetError(e),
    })
    const timeout = (why) => done({
      ...out,
      ok: false,
      elapsedMs: Date.now() - t0,
      error: `超时（${limit}ms 内${why}）`,
      hint: connected
        ? 'TCP 连上了，但服务端没回状态：可能被防火墙丢包、服务端 enable-status=false、或服务端卡死'
        : 'TCP 都没连上：地址/端口可能被防火墙挡了，或服务端根本没在监听',
    })

    try {
      const Client = require2('client')
      const states = require2('states')
      const tcpDns = require2('client/tcp_dns')
      const mcData = requireFromMineflayer('minecraft-data')(mc.defaultVersion)
      const version = mcData?.version
      if (!version) return done({ ...out, ok: false, error: `minecraft-data 里没有 ${mc.defaultVersion} 的版本信息`, hint: '环境问题，不是服务器问题' })

      const protocolVersion = version.version
      client = new Client(false, version.minecraftVersion)
      client.on('error', fail)

      const opts = {
        host: out.host,
        port: out.port,
        ...(fakeHost ? { fakeHost: String(fakeHost) } : {}),
      }
      // 握手/状态：`serverHost` 按 MC 惯例用 fakeHost 顶掉（Velocity 之类的子服路由靠它）
      const serverHost = opts.fakeHost ?? out.host

      client.on('connect', () => {
        connected = true
        handshakeMs = Date.now() - t0
        client.write('set_protocol', { protocolVersion, serverHost, serverPort: out.port, nextState: 1 })
        client.state = states.STATUS
      })
      client.on('state', (s) => {
        if (s !== states.STATUS) return
        firstByteMs = firstByteMs ?? (Date.now() - t0)
        client.write('ping_start', {})
      })
      client.on('server_info', (packet) => {
        firstByteMs = firstByteMs ?? (Date.now() - t0)
        let d = null
        try { d = JSON.parse(packet.response) } catch (e) {
          return done({ ...out, ok: false, elapsedMs: Date.now() - t0, error: `状态响应不是合法 JSON：${e?.message ?? e}`, hint: '服务端回了奇怪的东西（不是标准 MC 状态响应？）' })
        }
        // 延迟：写 ping 到收到 pong 的往返；pong 不来就用 noPongTimeout 兜底
        const pingSentAt = Date.now()
        const fallback = setTimeout(() => finish(d, null), 1500)
        client.once('ping', () => { clearTimeout(fallback); finish(d, Date.now() - pingSentAt) })
        client.write('ping', { time: [0, 0] })
      })

      const finish = (d, latency) => {
        const players = d?.players ?? {}
        const desc = d?.description
        const favicon = typeof d?.favicon === 'string' ? d.favicon : ''
        done({
          ...out,
          ok: true,
          elapsedMs: Date.now() - t0,
          handshakeMs: handshakeMs ?? (Date.now() - t0),
          statusMs: firstByteMs ?? (Date.now() - t0),
          latencyMs: Number.isFinite(latency) ? latency : (Number.isFinite(d?.latency) ? d.latency : null),
          version: d?.version?.name ?? null,
          protocol: d?.version?.protocol ?? null,
          players: {
            online: players?.online ?? null,
            max: players?.max ?? null,
            sample: (Array.isArray(players?.sample) ? players.sample : []).map((x) => x?.name).filter(Boolean).slice(0, 12),
          },
          motd: flattenMotd(desc),
          motdRaw: typeof desc === 'string' ? null : (desc ?? null),
          hasFavicon: Boolean(favicon),
        })
      }

      // 真去连：tcpDns 负责（它有 SRV 记录之类的处理），然后我们只发状态请求
      tcpDns(client, opts)
      if (typeof opts.connect === 'function') opts.connect(client)

      timer = setTimeout(() => timeout('没拿到状态响应'), limit)
      timer.unref?.()
    } catch (e) {
      fail(e)
    }
  })
}
