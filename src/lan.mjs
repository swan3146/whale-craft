// -*- coding: utf-8 -*-
/**
 * whale_craft / lan.mjs —— **局域网 Minecraft 服务器探测**
 * ============================================================================
 * 用户 2026-09-16 要求："加一个工具，可以探测局域网服务器。"
 *
 * 两种手段（都只**读**，不连接、不进服）：
 *   ① **广播**：Minecraft 客户端"对局域网开放"后，会在多播组
 *      `224.0.2.60:4445` 上周期性发 `[MOTD]...[/MOTD][AD]端口[/AD]`（UDP）
 *      —— 这是"谁开了房间"最准的信号，连端口都能直接拿到。
 *   ② **扫段**：对本机所在网段（默认 /24）的候选端口做 TCP 连接，开着的再发
 *      **STATUS ping**（handshake + status request）拿版本 / MOTD / 人数。
 *      mineflayer 自己会做 STATUS 探测，但那是"连服"路径上的事，这里需要"只为看一眼"，
 *      所以协议在这一层手写（VARINT + JSON，无依赖）。
 *
 * 🔴 **安全边界**：只允许内网网段（私有 / 回环 / 链路本地），公网直接拒绝；
 *    主机数、端口数、并发、超时全部有上限 —— 这是"看看谁开了房间"，不是扫描器。
 * ============================================================================
 */
import { createSocket } from 'node:dgram'
import { connect } from 'node:net'
import { networkInterfaces } from 'node:os'

/** Minecraft 的局域网广播地址（客户端"对局域网开放"用的多播组） */
export const LAN_BROADCAST = { group: '224.0.2.60', port: 4445 }

/** 常见端口：默认只试 Minecraft 默认端口 + 几个常见的相邻端口 */
export const DEFAULT_PORTS = [25565, 25566, 25567, 25568, 25569]

/* ─────────────────────────── 纯函数（好测） ─────────────────────────── */

/**
 * 解析 Minecraft 的局域网广播文本。
 * 形如：`[MOTD]A Minecraft Server[/MOTD][AD]25565[/AD]`（AD = 端口）
 * @returns {{motd: string, port: number}|null} 不是这种格式就 null
 */
export function parseLanBroadcast (msg) {
  const s = String(msg ?? '')
  const ad = /\[AD\]([\s\S]*?)\[\/AD\]/i.exec(s)
  if (!ad) return null
  const port = Number(String(ad[1]).trim())
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null
  const motd = /\[MOTD\]([\s\S]*?)\[\/MOTD\]/i.exec(s)
  return { motd: motd ? motd[1].trim() : '', port }
}

/** 内网地址判定：10/8 · 172.16/12 · 192.168/16 · 169.254/16 · 127/8 */
export function isPrivateIPv4 (ip) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(ip ?? '').trim())
  if (!m) return false
  const [a, b, c, d] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])]
  if ([a, b, c, d].some((n) => n > 255)) return false
  if (a === 10) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 169 && b === 254) return true     // 链路本地（直连网线/临时网络很常见）
  if (a === 127) return true                  // 回环（自测用）
  return false
}

/** 本机所有 IPv4 地址（含回环；`includeSelf:false` 时用它过滤掉自己） */
export function localAddresses () {
  const out = new Set()
  let lists = []
  try { lists = Object.values(networkInterfaces()) } catch { lists = [] }
  for (const list of lists) for (const it of list ?? []) if (it?.family === 'IPv4') out.add(String(it.address))
  return [...out]
}

/** 本机所有私有 IPv4 网卡的 /24 网段（去重，形如 `192.168.1`） */
export function localSubnets () {
  const out = new Set()
  let lists = []
  try { lists = Object.values(networkInterfaces()) } catch { lists = [] }
  for (const list of lists) {
    for (const it of list ?? []) {
      if (it?.family !== 'IPv4' || it.internal) continue
      if (!isPrivateIPv4(it.address)) continue
      out.add(String(it.address).split('.').slice(0, 3).join('.'))
    }
  }
  return [...out]
}

/**
 * 网段写法 → 主机地址数组。
 * 认：`192.168.1`（=/24）、`192.168.1.0/24`、`192.168.1.7`（=/32 单机）、`192.168.1.0/28`。
 * 只支持 /24 ~ /32（最后一个字节内），且必须是内网。
 */
export function hostsOf (spec, { max = 256 } = {}) {
  const s = String(spec ?? '').trim()
  const m = /^(\d{1,3}\.\d{1,3}\.\d{1,3})(?:\.(\d{1,3}))?(?:\/(\d{1,2}))?$/.exec(s)
  if (!m) throw new Error(`网段写法不认：${s}（用 192.168.1 或 192.168.1.0/24）`)
  const base = m[1]
  if (!isPrivateIPv4(`${base}.1`)) throw new Error(`只允许扫描内网网段（私有/回环/链路本地），拒绝：${s}`)
  const last = m[2] === undefined ? null : Number(m[2])
  if (last !== null && last > 255) throw new Error(`网段写法不认：${s}`)
  const prefix = m[3] === undefined ? (last === null ? 24 : 32) : Number(m[3])
  if (!(prefix >= 24 && prefix <= 32)) throw new Error(`只支持 /24 ~ /32，拒绝：${s}`)
  if (prefix === 32) return [last === null ? `${base}.1` : `${base}.${last}`]
  const bits = 32 - prefix
  const size = 2 ** bits
  const start = Math.floor((last ?? 0) / size) * size
  const hosts = []
  for (let i = start; i < start + size && hosts.length < max; i++) {
    if (prefix === 24 && (i === 0 || i === 255)) continue      // 网络号 / 广播号
    hosts.push(`${base}.${i}`)
  }
  return hosts
}

/**
 * MOTD 可能是字符串、`{text}` 组件或组件数组 → 拍平成纯文本（顺手去掉 `§` 颜色码）。
 */
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

/* ─────────────────────────── VARINT（协议用） ─────────────────────────── */

export function writeVarInt (n) {
  const out = []
  let v = Number(n) >>> 0
  do { let b = v & 0x7f; v >>>= 7; if (v) b |= 0x80; out.push(b) } while (v)
  return Buffer.from(out)
}

export function readVarInt (buf, off = 0) {
  let num = 0
  let shift = 0
  let i = off
  for (;;) {
    if (i >= buf.length) return null
    const b = buf[i++]
    num |= (b & 0x7f) << shift
    if (!(b & 0x80)) return { value: num >>> 0, size: i - off }
    shift += 7
    if (shift > 35) return null
  }
}

/* ─────────────────────────── 网络探测 ─────────────────────────── */

/** 并行跑一批（限制并发），保持结果顺序 */
export async function mapLimit (items, limit, fn) {
  const out = new Array(items.length)
  let i = 0
  const workers = new Array(Math.max(1, Math.min(limit, items.length))).fill(0).map(async () => {
    for (;;) {
      const k = i++
      if (k >= items.length) return
      try { out[k] = await fn(items[k], k) } catch { out[k] = undefined }
    }
  })
  await Promise.all(workers)
  return out
}

/** TCP 连得上吗（只连、不发数据） */
export function probePort ({ host, port, timeoutMs = 400 }) {
  return new Promise((resolve) => {
    let done = false
    const sock = connect({ host, port })
    const finish = (ok) => {
      if (done) return
      done = true
      try { sock.destroy() } catch { /* 已经关了 */ }
      resolve(ok)
    }
    sock.setTimeout(Math.max(50, timeoutMs))
    sock.once('connect', () => finish(true))
    sock.once('timeout', () => finish(false))
    sock.once('error', () => finish(false))
  })
}

/**
 * Minecraft **STATUS ping**：握手(nextState=1) + status request，读回 JSON。
 * 只为"看一眼"，拿到就断开。
 * @returns {Promise<{ok:boolean, version?:string, protocol?:number, players?:object, motd?:string, latencyMs?:number, error?:string}>}
 */
export function statusPing ({ host, port, timeoutMs = 1200, protocolVersion = 0 }) {
  return new Promise((resolve) => {
    const started = Date.now()
    let buf = Buffer.alloc(0)
    let done = false
    const sock = connect({ host, port })
    const fail = (error) => {
      if (done) return
      done = true
      try { sock.destroy() } catch { /* 已经关了 */ }
      resolve({ ok: false, error: String(error) })
    }
    const ok = (payload) => {
      if (done) return
      done = true
      try { sock.destroy() } catch { /* 已经关了 */ }
      resolve({ ok: true, latencyMs: Date.now() - started, ...payload })
    }
    sock.setTimeout(Math.max(100, timeoutMs))
    sock.once('timeout', () => fail('timeout'))
    sock.once('error', (e) => fail(e?.code ?? e?.message ?? 'error'))
    sock.once('connect', () => {
      const hostBuf = Buffer.from(host, 'utf8')
      const portBuf = Buffer.alloc(2)
      portBuf.writeUInt16BE(port)
      const body = Buffer.concat([
        writeVarInt(0x00),            // packet id: handshake
        writeVarInt(protocolVersion), // 协议号：status 阶段服务端不看，随便给
        writeVarInt(hostBuf.length), hostBuf,
        portBuf,
        writeVarInt(1),               // next state: 1 = status
      ])
      sock.write(Buffer.concat([writeVarInt(body.length), body]))
      sock.write(Buffer.concat([writeVarInt(1), writeVarInt(0x00)]))   // status request
    })
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk])
      const len = readVarInt(buf, 0)
      if (!len) return
      if (buf.length < len.size + len.value) return
      const body = buf.subarray(len.size, len.size + len.value)
      const pid = readVarInt(body, 0)
      if (!pid) return
      if (pid.value !== 0x00) return fail(`unexpected packet id ${pid.value}`)
      const slen = readVarInt(body, pid.size)
      if (!slen) return
      const json = body.subarray(pid.size + slen.size, pid.size + slen.size + slen.value).toString('utf8')
      let d = null
      try { d = JSON.parse(json) } catch { return fail('status 不是合法 JSON') }
      const sample = Array.isArray(d?.players?.sample) ? d.players.sample : []
      ok({
        version: d?.version?.name ?? null,
        protocol: d?.version?.protocol ?? null,
        players: {
          online: d?.players?.online ?? null,
          max: d?.players?.max ?? null,
          sample: sample.map((p) => p?.name).filter(Boolean).slice(0, 8),
        },
        motd: flattenMotd(d?.description),
      })
    })
  })
}

/**
 * 听 Minecraft 的局域网广播（多播 224.0.2.60:4445）。
 * 到点自动收工；有些环境禁多播，那就只听广播包，拿不到也不报错。
 * @returns {Promise<Array<{host:string, port:number, motd:string, source:'broadcast'}>>}
 */
export function listenLanBroadcast ({ seconds = 3, group = LAN_BROADCAST.group, port = LAN_BROADCAST.port } = {}) {
  return new Promise((resolve) => {
    const found = []
    let closed = false
    let sock = null
    const close = () => {
      if (closed) return
      closed = true
      try { sock?.close() } catch { /* 没开成 */ }
      resolve(found)
    }
    try {
      sock = createSocket({ type: 'udp4', reuseAddr: true })
      sock.on('error', () => close())
      sock.on('message', (msg, rinfo) => {
        const parsed = parseLanBroadcast(msg.toString('utf8'))
        if (!parsed) return
        const host = String(rinfo?.address ?? '')
        if (found.some((f) => f.host === host && f.port === parsed.port)) return
        found.push({ host, port: parsed.port, motd: parsed.motd, source: 'broadcast' })
      })
      sock.bind(port, () => {
        try { sock.addMembership(group) } catch { /* 禁多播的环境：只听本机广播 */ }
      })
    } catch { close() }
    const t = setTimeout(close, Math.max(500, Math.min(Number(seconds) || 3, 15) * 1000))
    t.unref?.()
  })
}

/**
 * 一段网段的"开着口的 Minecraft 服务器"。
 * 先 TCP 摸端口（快、便宜），开着的再 STATUS ping（拿版本/MOTD/人数）。
 */
export async function scanSubnet ({
  subnet, ports = DEFAULT_PORTS, timeoutMs = 400, pingTimeoutMs = 1200,
  concurrency = 64, maxHosts = 256, signal = null,
} = {}) {
  const hosts = hostsOf(subnet, { max: maxHosts })
  const jobs = []
  for (const h of hosts) for (const p of ports) jobs.push({ host: h, port: p })
  const open = (await mapLimit(jobs, concurrency, async ({ host, port }) => {
    if (signal?.aborted) return null
    const alive = await probePort({ host, port, timeoutMs })
    return alive ? { host, port } : null
  })).filter(Boolean)
  const servers = (await mapLimit(open, Math.min(concurrency, 16), async ({ host, port }) => {
    if (signal?.aborted) return null
    const st = await statusPing({ host, port, timeoutMs: pingTimeoutMs })
    return st.ok
      ? { host, port, source: 'scan', version: st.version, protocol: st.protocol, players: st.players, motd: st.motd, latencyMs: st.latencyMs }
      : { host, port, source: 'scan', open: true, error: st.error }
  })).filter(Boolean)
  return { hosts: hosts.length, ports: ports.length, openPorts: open.length, servers }
}
