// -*- coding: utf-8 -*-
/**
 * whale_craft / accounts.mjs —— MC账户库（元数据）+ 凭据封装（密码/token）
 * ============================================================================
 * 用户 2026-09-16 的要求：
 *   · 默认有一个**离线账户 DeepSeek**；离线账户可改名、可自定义 UUID
 *   · 可新建：离线账户 / **皮肤站账户**（默认 littleskin，可自己加认证服务器）/ 微软账户（暂不支持）
 *   · 已添加的认证服务器要**记住**，也能移除
 *   · 🔴 **MCAI 再也拿不到密码和 token**：它只能看到账户基本信息（innerID/ID/UUID/服务器）
 *
 * 两处存储，刻意分开：
 *   · **元数据**（能见人的部分）→ `<工作区>/.whale-craft/accounts.json`
 *   · **凭据**（密码/token）→ **宿主的凭据服务** `ctx.credentials`
 *     （落在 `$DSH_HOME/.credentials.yaml`，目录 owner-only；key = `whale-craft/<innerID>`）
 *
 * ⚠️ 为什么不把密码写进工作区文件：MC 模式的 agent 手里有 `read`（tool-fs）——
 *    密码一旦落进工作区，等于直接喂给 LLM。所以宁可"凭据服务不可用就拒绝存密码"，
 *    也**不降级**写明文。
 * ============================================================================
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { createHash, randomBytes } from 'node:crypto'

/**
 * **预置**认证服务器（首次建库时写进去当便利，**不是内置、可以删**）。
 * 🔴 用户 2026-09-16：LittleSkin 只是"提前预设"——删掉就是删掉，**不许再自动长回来**
 *    （靠 `seeded` 标记：只在第一次建库时种一次）。
 */
export const PRESET_AUTH_SERVERS = [
  { id: 'littleskin', name: 'LittleSkin', url: 'https://littleskin.cn/api/yggdrasil' },
]

/** 兼容旧名字（别的模块可能还引用） */
export const BUILTIN_AUTH_SERVERS = PRESET_AUTH_SERVERS

const FILE = 'accounts.json'
const CRED_SCOPE = 'whale-craft'
/** 凭据 key 的两段都要求"小写连字符标识符"，所以 innerID 只用 [a-z0-9-] */
const INNER_ID = /^acc-[a-z0-9]{8}$/

/** 离线 UUID = Java 的 `UUID.nameUUIDFromBytes("OfflinePlayer:<name>")`（version 3） */
export function offlineUuid (name) {
  const h = createHash('md5').update(`OfflinePlayer:${String(name)}`, 'utf8').digest()
  h[6] = (h[6] & 0x0f) | 0x30
  h[8] = (h[8] & 0x3f) | 0x80
  const hex = h.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/** 补横线的 UUID（认证服有时给不带横线的） */
export function dashUuid (raw) {
  const s = String(raw ?? '').trim().replace(/-/g, '')
  if (!/^[0-9a-fA-F]{32}$/.test(s)) return null
  const l = s.toLowerCase()
  return `${l.slice(0, 8)}-${l.slice(8, 12)}-${l.slice(12, 16)}-${l.slice(16, 20)}-${l.slice(20)}`
}

/** 认证服务器地址归一化：去空白、补 https://、去结尾斜杠（**不猜路径**） */
export function normalizeServerUrl (raw) {
  let s = String(raw ?? '').trim()
  if (!s) throw new Error('认证服务器地址不能为空')
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s
  s = s.replace(/\/+$/, '')
  let u
  try { u = new URL(s) } catch { throw new Error(`不是合法的地址：${raw}`) }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('只支持 http/https')
  // 必须像个主机名（域名要有 nnn.nnn，或 IPv4/IPv6）——否则 "https://随便几个字" 也会被 URL 当 IDN 收下
  const host = u.hostname
  const looksLikeHost = /\./.test(host) || /^\[[0-9a-f:]+\]$/i.test(host) || host === 'localhost'
  if (!looksLikeHost) throw new Error(`地址里没有主机名（要有类似 example.com 这样的域名）：${raw}`)
  return u.toString().replace(/\/+$/, '')
}

/**
 * 解析 authlib-injector 卡片/文本里的认证服务器地址。
 * 形如 `authlib-injector:yggdrasil-server:https%3A%2F%2Fauth.example.com%2Fyggdrasil`
 * （网址部分是 URL-encoded；也容忍已经解码过、或干脆就是一条裸网址）
 * @returns {string|null} 归一化后的地址，解析不出来返回 null
 */
export function parseAuthlibCard (text) {
  const s = String(text ?? '').trim().replace(/^["'<]+|["'>]+$/g, '')
  if (!s) return null
  const m = s.match(/authlib-injector\s*:\s*yggdrasil-server\s*:\s*(\S+)/i)
  const raw = m ? m[1] : s
  const candidates = [raw]
  try { candidates.push(decodeURIComponent(raw)) } catch { /* 解不开就用原样 */ }
  for (const c of candidates) {
    try { return normalizeServerUrl(c) } catch { /* 换下一个 */ }
  }
  return null
}

export class AccountStore {
  /**
   * @param {{dir:string, credentials?:object|null, logger?:object|null}} opts
   *   dir = `<工作区>/.whale-craft`；credentials = 宿主 `ctx.credentials`（可为 null）
   */
  constructor ({ dir, credentials = null, logger = null } = {}) {
    this.dir = dir
    this.file = join(dir, FILE)
    this.credentials = credentials
    this.logger = logger
    this.data = { version: 1, defaultAccount: null, authServers: [], accounts: [] }
    this.load()
    /** 有凭据的 innerID 缓存（`list()` 是同步的，所以要缓存；启动/增删时刷新） */
    this._withCred = new Set()
    this.credIndexError = null
  }

  /* ─────────────── 读写 ─────────────── */

  load () {
    try {
      if (!existsSync(this.file)) { this.data = { version: 1, seeded: false, defaultAccount: null, authServers: [], accounts: [] }; return }
      const parsed = JSON.parse(readFileSync(this.file, 'utf8'))
      this.data = {
        version: 1,
        // 是否已经种过"预置认证服务器"。旧库没有这个字段 → 当成"没种过"，下一次 ensureDefaults 会补一次；
        // 之后删掉预置项就**不会再长回来**。
        seeded: parsed?.seeded === true,
        defaultAccount: parsed?.defaultAccount ?? null,
        authServers: Array.isArray(parsed?.authServers) ? parsed.authServers : [],
        accounts: Array.isArray(parsed?.accounts) ? parsed.accounts : [],
      }
    } catch (e) {
      this.data = { version: 1, seeded: false, defaultAccount: null, authServers: [], accounts: [] }
      this.loadError = `账户库读取失败（已按空库运行）：${e.message}`
    }
  }

  save () {
    try {
      if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true })
      writeFileSync(this.file, JSON.stringify(this.data, null, 2) + '\n', 'utf8')
    } catch (e) { throw new Error(`账户库写入失败：${e.message}`) }
  }

  /** 首次使用：种一次预置认证服务器 + 默认离线账户 `DeepSeek`（种过就不再种） */
  ensureDefaults () {
    let changed = false
    if (this.data.seeded !== true) {
      for (const s of PRESET_AUTH_SERVERS) {
        if (!this.data.authServers.some((x) => x.url === s.url)) this.data.authServers.push({ ...s })
      }
      this.data.seeded = true
      changed = true
    }
    if (!this.data.accounts.length) {
      const acc = { innerID: newInnerId(), type: 'offline', name: 'DeepSeek', uuid: null, login: null, id: null, serverId: null }
      this.data.accounts.push(acc)
      this.data.defaultAccount = acc.innerID
      changed = true
    }
    if (!this.data.defaultAccount || !this.data.accounts.some((a) => a.innerID === this.data.defaultAccount)) {
      this.data.defaultAccount = this.data.accounts[0]?.innerID ?? null
      changed = true
    }
    if (changed) this.save()
    return changed
  }

  /* ─────────────── 账户 ─────────────── */

  /** 给 LLM/UI 的公开视图：**绝不含密码/token** */
  view (acc) {
    if (!acc) return null
    const srv = this.data.authServers.find((s) => s.id === acc.serverId) ?? null
    const server = acc.type === 'offline'
      ? { kind: 'offline', name: '离线', url: null }
      : { kind: 'yggdrasil', name: srv?.name ?? '(已移除的服务器)', url: srv?.url ?? null }
    const uuid = acc.uuid ?? (acc.type === 'offline' ? offlineUuid(acc.name) : null)
    return {
      innerID: acc.innerID,
      id: acc.id ?? null,                       // 认证服务器给的账号 id（离线为 null）
      login: acc.login ?? null,                 // 登录用账号名/邮箱（皮肤站才有）
      name: acc.name,                           // 游戏内名字（皮肤站登录后会用档案名覆盖）
      uuid,
      uuidSource: acc.uuid ? 'custom' : (acc.type === 'offline' ? 'derived-from-name' : 'unknown'),
      type: acc.type,                           // offline | yggdrasil
      server,
      hasCredential: this._withCred.has(acc.innerID),
      default: this.data.defaultAccount === acc.innerID,
    }
  }

  list () { return this.data.accounts.map((a) => this.view(a)) }

  get (innerID) { return this.data.accounts.find((a) => a.innerID === innerID) ?? null }

  /** 选定/默认账户：给了 innerID 就必须存在；没给就 defaultAccount；再退第一个 */
  resolve (innerID = null) {
    if (innerID) {
      const acc = this.get(innerID)
      if (!acc) throw new Error(`没有这个账户：${innerID}（先用 mc_accounts{action:"list"} 看看有哪些）`)
      return acc
    }
    const d = this.data.defaultAccount ? this.get(this.data.defaultAccount) : null
    return d ?? this.data.accounts[0] ?? null
  }

  /** 按指令搜索：名字 / login / uuid / id / 服务器名 / innerID 模糊匹配 */
  search (query) {
    const q = String(query ?? '').trim().toLowerCase()
    if (!q) throw new Error('query 不能为空（要搜什么？名字、UUID、服务器名都行）')
    const hits = this.data.accounts.filter((a) => {
      const v = this.view(a)
      const hay = [v.innerID, v.id, v.login, v.name, v.uuid, v.server?.name, v.server?.url, v.type]
        .filter(Boolean).join(' ').toLowerCase()
      return hay.includes(q)
    })
    return { query, matched: hits.length, accounts: hits.map((a) => this.view(a)) }
  }

  /** 新建账户（凭据另行 setCredential 写入） */
  add ({ type, name, uuid = null, serverId = null, login = null, id = null } = {}) {
    const t = String(type ?? '').trim()
    if (t === 'microsoft') throw new Error('微软账户暂不支持（宿主侧还在做）')
    if (t !== 'offline' && t !== 'yggdrasil') throw new Error(`不支持的账户类型：${t}（离线 offline / 皮肤站 yggdrasil）`)
    const nm = String(name ?? '').trim()
    if (!nm) throw new Error('账户名不能为空')
    if (!/^[\w\u4e00-\u9fa5.]{1,32}$/.test(nm)) throw new Error('账户名只能用中英文/数字/下划线/点，最长 32')
    if (t === 'yggdrasil') {
      const srv = this.data.authServers.find((s) => s.id === serverId)
      if (!srv) throw new Error(`没有这个认证服务器：${serverId}（先在「MC设置」里添加）`)
    }
    const u = uuid ? dashUuid(uuid) : null
    if (uuid && !u) throw new Error(`UUID 格式不对：${uuid}（要 32 位十六进制，可有横线）`)
    if (t === 'offline' && this.data.accounts.some((a) => a.type === 'offline' && !a.uuid && a.name === nm)) {
      throw new Error(`已经有同名离线账户了：${nm}`)
    }
    const acc = { innerID: newInnerId(), type: t, name: nm, uuid: u, login: login ? String(login) : null, id: id ? String(id) : null, serverId: t === 'yggdrasil' ? serverId : null }
    this.data.accounts.push(acc)
    this.save()
    return this.view(acc)
  }

  /** 改：名字 / UUID / login / id / 设为默认 */
  update (innerID, patch = {}) {
    const acc = this.get(innerID)
    if (!acc) throw new Error(`没有这个账户：${innerID}`)
    if (patch.name !== undefined) {
      const nm = String(patch.name).trim()
      if (!nm) throw new Error('名字不能为空')
      if (!/^[\w\u4e00-\u9fa5.]{1,32}$/.test(nm)) throw new Error('名字只能用中英文/数字/下划线/点，最长 32')
      acc.name = nm
    }
    if (patch.uuid !== undefined) {
      if (patch.uuid === null || patch.uuid === '') acc.uuid = null
      else {
        const u = dashUuid(patch.uuid)
        if (!u) throw new Error(`UUID 格式不对：${patch.uuid}`)
        acc.uuid = u
      }
    }
    if (patch.login !== undefined) acc.login = patch.login === null ? null : String(patch.login)
    if (patch.id !== undefined) acc.id = patch.id === null ? null : String(patch.id)
    if (patch.serverId !== undefined) {
      if (patch.serverId !== null && !this.data.authServers.some((s) => s.id === patch.serverId)) {
        throw new Error(`没有这个认证服务器：${patch.serverId}`)
      }
      acc.serverId = patch.serverId
    }
    if (patch.default === true) this.data.defaultAccount = acc.innerID
    this.save()
    return this.view(acc)
  }

  /** 删账户（连同凭据）；删的是默认账户就把默认让给下一个 */
  async remove (innerID) {
    const i = this.data.accounts.findIndex((a) => a.innerID === innerID)
    if (i < 0) throw new Error(`没有这个账户：${innerID}`)
    this.data.accounts.splice(i, 1)
    if (this.data.defaultAccount === innerID) this.data.defaultAccount = this.data.accounts[0]?.innerID ?? null
    this.save()
    await this.deleteCredential(innerID).catch(() => {})
    return { removed: innerID, remaining: this.data.accounts.length, defaultAccount: this.data.defaultAccount }
  }

  /* ─────────────── 认证服务器 ─────────────── */

  listAuthServers () { return this.data.authServers.map((s) => ({ ...s })) }

  addAuthServer ({ name, url } = {}) {
    const u = normalizeServerUrl(url)
    const nm = String(name ?? '').trim() || hostOf(u)
    if (this.data.authServers.some((s) => s.url === u)) throw new Error(`这个认证服务器已经加过了：${u}`)
    if (this.data.authServers.some((s) => s.name === nm)) throw new Error(`已经有同名认证服务器：${nm}`)
    const srv = { id: newServerId(nm), name: nm, url: u, builtin: false }
    this.data.authServers.push(srv)
    this.save()
    return { ...srv }
  }

  /** 删认证服务器。**没有"内置不可删"这回事**（预置的也能删）；被账户占用的不许删。 */
  removeAuthServer (id) {
    const i = this.data.authServers.findIndex((s) => s.id === id)
    if (i < 0) throw new Error(`没有这个认证服务器：${id}`)
    const used = this.data.accounts.filter((a) => a.serverId === id).map((a) => a.name)
    if (used.length) throw new Error(`还有账户在用这个服务器（${used.join('、')}），先删/改那些账户`)
    const [gone] = this.data.authServers.splice(i, 1)
    this.save()
    return { removed: gone.id, name: gone.name }
  }

  /* ─────────────── 凭据（只进宿主凭据服务） ─────────────── */

  get credentialsReady () { return Boolean(this.credentials && typeof this.credentials.modifyRecord === 'function') }

  #key (innerID) {
    if (!INNER_ID.test(innerID)) throw new Error(`内部账户 id 不合法：${innerID}`)
    return `${CRED_SCOPE}/${innerID}`
  }

  /** 启动时建"哪些账户有凭据"的缓存（list() 是同步的，用它填充 hasCredential） */
  async refreshCredentialIndex () {
    this._withCred = new Set()
    this.credIndexError = null
    if (!this.credentialsReady) return
    try {
      const entries = await this.credentials.listRecords()
      for (const e of entries ?? []) {
        const key = String(e?.key ?? e ?? '')
        const [scope, id] = key.split('/')
        if (scope === CRED_SCOPE && id) this._withCred.add(id)
      }
    } catch (e) { this.credIndexError = String(e?.message ?? e) }
  }

  async setCredential (innerID, { password = null, accessToken = null, clientToken = null } = {}) {
    if (!this.get(innerID)) throw new Error(`没有这个账户：${innerID}`)
    if (!this.credentialsReady) {
      throw new Error('宿主凭据服务不可用，拒绝把密码写进工作区（那等于喂给 AI）——请检查 profile 是否挂了 dsh-credentials-local')
    }
    const key = this.#key(innerID)
    const payload = { password, accessToken, clientToken, refreshedAt: Date.now() }
    await this.credentials.modifyRecord(key, async () => ({ kind: 'grant', payload }))
    this._withCred.add(innerID)
    return { innerID, saved: true, hasCredential: true }
  }

  /** ⚠️ 只在插件内部（登录流程）用；**不要**把它塞进工具返回值或 HTTP 响应 */
  async getCredential (innerID) {
    if (!this.credentialsReady) return null
    try {
      const rec = await this.credentials.readRecord(this.#key(innerID))
      const p = rec?.payload
      if (!p || typeof p !== 'object') return null
      return { password: p.password ?? null, accessToken: p.accessToken ?? null, clientToken: p.clientToken ?? null, refreshedAt: p.refreshedAt ?? null }
    } catch (e) { this.logger?.warn?.(`[whale_craft] 读凭据失败 ${innerID}：${e.message}`); return null }
  }

  async deleteCredential (innerID) {
    if (!this.credentialsReady) return { deleted: false }
    try { await this.credentials.deleteRecord(this.#key(innerID)) } catch { /* 没有就算了 */ }
    this._withCred.delete(innerID)
    return { deleted: true }
  }
}

/* ─────────────── 小工具 ─────────────── */

function newInnerId () { return 'acc-' + randomBytes(4).toString('hex') }

function newServerId (name) {
  const slug = String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 20)
  return (slug || 'srv') + '-' + randomBytes(2).toString('hex')
}

function hostOf (url) {
  try { return new URL(url).hostname } catch { return '认证服务器' }
}
