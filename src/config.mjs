// -*- coding: utf-8 -*-
/**
 * whale_craft / config.mjs —— 插件全局配置（可配置、落盘、改完立即生效）
 * ============================================================================
 * 用户 2026-09-16 的要求：
 *   · **服务器指令白名单可配置**（原来是写死的正则）
 *   · **可配置向 MC 模式的 Agent 暴露哪些其它工具**
 *   · 非 MC 模式的 agent 有个工具能**直接改**这些配置；MC 模式的**不能用不能改**
 *
 * 落盘位置：**`$DSH_HOME/whale_craft/config.json`**（插件自己的家，见 {@link resolveStateDir}）。
 * 🔴 2026-09-16 用户要求：**配置与账户不该躺在工作区里** —— 工作区是某个项目的家，
 *    插件有插件自己的家。宿主在 app-boot 里 `ctx.provide('dshHomePath', …)`，
 *    与 `$DSH_HOME/skills`、`$DSH_HOME/.agent-presets`、`$DSH_HOME/storages`、`$DSH_HOME/attachments` 同一套规矩。
 *
 * 为什么不放在 cordis.patch.yml：那份配置要重启宿主才生效，而这里的键要**当场生效**。
 * 环境变量：`WHALE_CRAFT_STATE_DIR` 直接指定状态目录；`WHALE_CRAFT_DIR`（自检/隔离用）
 * 一给就表示"所有状态都留在那个临时目录里"。
 * ============================================================================
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'

/** 插件在 `$DSH_HOME` 下的目录名 */
export const STATE_DIR_NAME = 'whale_craft'

/**
 * 解析**插件状态目录**（配置 + 账户库放这里，**不放工作区**）。
 *
 * 优先级：`WHALE_CRAFT_STATE_DIR` → （自检/隔离）`WHALE_CRAFT_DIR` →
 * 宿主给的 `dshHomePath('whale_craft')` → `$DSH_HOME/whale_craft` → `~/.dsh/whale_craft`。
 * @param {{env?: Record<string,string|undefined>, dshHomePath?: Function, whaleDir?: string, home?: string}} [opts]
 * @returns {string} 绝对路径
 */
export function resolveStateDir ({ env = process.env, dshHomePath, whaleDir, home } = {}) {
  const explicit = String(env.WHALE_CRAFT_STATE_DIR ?? '').trim()
  if (explicit) return explicit
  // 自检 / 隔离实例：WHALE_CRAFT_DIR 一给，所有状态都留在那个临时目录（搬迁前的行为不变）
  if (String(env.WHALE_CRAFT_DIR ?? '').trim() && whaleDir) return whaleDir
  if (typeof dshHomePath === 'function') {
    try {
      const p = dshHomePath(STATE_DIR_NAME)
      if (p) return p
    } catch { /* 拿到不就用下面的兜底 */ }
  }
  const base = String(env.DSH_HOME ?? '').trim() || join(home ?? homedir(), '.dsh')
  return join(base, STATE_DIR_NAME)
}

/** 默认值 = 老行为（现有 mc_command 的白名单原样搬过来） */
export const DEFAULT_CONFIG = {
  /**
   * mc_command 允许的服务器指令名。支持三种写法：
   * 精确名（`"tp"`）· 正则（斜杠包裹，如 `^gi.+`）· `"*"` = 全部放行
   */
  commandWhitelist: [
    'tp', 'teleport', 'give', 'time', 'weather', 'say', 'tell', 'msg',
    'gamemode', 'effect', 'enchant', 'setblock', 'fill', 'clone', 'summon',
    'title', 'spawnpoint', 'difficulty', 'kill', 'clear', 'xp', 'experience',
  ],
  /** 哪些 agent preset 算"MC 模式"（用来做权限隔离：MC 模式不能用管理工具） */
  mcModePresets: ['minecraft', 'whale_craft'],
  mcMode: {
    /**
     * 允许 MC 模式会话使用的**其它工具**（whale_craft 自己的工具永远放行）。
     * 非空 = 白名单模式：除列出者之外，其它工具对 MC 模式会话隐藏。
     * ⚠️ 只能"收窄"，不能凭空添加 preset 没挂的工具。
     */
    allowOtherTools: [],
    /** 禁止 MC 模式会话使用的其它工具（黑名单，精确名）。 */
    denyOtherTools: [],
    /** 是否对 MC 模式会话隐藏 mc_admin_* （隐藏之外，guard 仍会硬拒） */
    hideAdminTools: true,
  },
  /** 记忆根目录；null = `<工作区>/.whale-craft` */
  memoryDir: null,
  /** 「MC设置 → 指令白名单」页的开关：允许所有服务器指令（默认关 = 只放行白名单里的） */
  allowAllCommands: false,
  /** 是否把 **whale-craft 自己的**行事准则（`.whale-craft/AGENTS.md`）注入给 MC 模式的 agent */
  injectWhaleCraftAgentsMd: true,
  /**
   * 是否**额外**注入**工作区**的 `AGENTS.md`（默认关）。
   * 2026-09-16 实测：MC 模式下宿主本来就没注入它（会话日志里 0 次），所以这里控制的是
   * "我们插件再补一份"，打开即恢复"工作区 AGENTS.md 也在场"。
   */
  injectWorkspaceAgentsMd: false,
  /**
   * 启动时若 `mcModePresets` 里**一个都不存在**，就自动建一个「MC模式」preset。
   *
   * 2026-09-16 用户定的：插件**不塞** preset 目录，但"没有 preset 就没有 MC 模式"这件事必须自己解决
   * —— preset 属于用户的 `$DSH_HOME/.agent-presets/`，新机器上没人建过，插件就永远认不出 MC 会话。
   *
   * 做法**只能用宿主官方接口**：`agentPresets.copy(源, 新id, 显示名)`（官方 authoring 明令
   * "只允许整目录复制已有 preset、调用方不得提供 composition 文本"）。默认复制官方的 `minimal`
   * （极简工具面）；**已存在就绝不动**。关掉它就回到"要自己建 preset"。
   */
  ensureMcPreset: true,
}

/**
 * preset id 必须是**目录名**：与宿主 `agent-presets/src/preset.ts` 的 `PRESET_ID` 同规则。
 * 🔴 这条很要命：默认名单里的 `whale_craft` **带下划线，永远不可能是 preset id**
 * （所以"自动建 MC 模式 preset"只能建 `minecraft` 那种）。
 */
export const PRESET_ID_RE = /^[a-z0-9][a-z0-9-]*$/

/** 从 `mcModePresets` 里挑一个**能当目录名**的 id；都不合法就 null */
export function pickPresetTarget (wanted) {
  const list = Array.isArray(wanted) ? wanted : []
  return list.map((x) => String(x ?? '').trim()).find((id) => PRESET_ID_RE.test(id)) ?? null
}

/** 复制源的优先级：越简的工具面越适合 MC 模式（MC 的 persona/指导由插件注入） */
export const PREFERRED_PRESET_SOURCES = ['minimal', 'standard', 'ptc']

/** 从现有 preset 里挑复制源：先按优先级，再退到宿主的默认 preset；都没有就 null */
export function pickPresetSource (ids, defaultId = null) {
  const set = new Set((ids ?? []).map((x) => String(x ?? '')))
  for (const id of PREFERRED_PRESET_SOURCES) if (set.has(id)) return id
  const d = String(defaultId ?? '')
  return set.has(d) ? d : null
}

const TOP_KEYS = new Set(Object.keys(DEFAULT_CONFIG))
const SECRET_KEYS = new Set()   // 目前没有敏感键；留个位置

export class PluginConfig {
  /** @param {string} dir 状态目录（`$DSH_HOME/whale_craft`；自检里是临时目录） */
  constructor (dir) {
    this.dir = dir
    this.file = join(dir, 'config.json')
    this.data = {}
    this.lastError = null
    this.load()
  }

  load () {
    try {
      if (!existsSync(this.file)) { this.data = {}; return }
      const raw = readFileSync(this.file, 'utf8')
      const parsed = JSON.parse(raw)
      this.data = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
    } catch (e) {
      // 配置坏了不能让插件起不来：记下错误，用默认值继续
      this.data = {}
      this.lastError = `配置读取失败（已按默认值运行）：${e.message}`
    }
  }

  save () {
    try {
      if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true })
      writeFileSync(this.file, JSON.stringify(this.data, null, 2) + '\n', 'utf8')
      return true
    } catch (e) {
      throw new Error(`配置写入失败：${e.message}`)
    }
  }

  /** 生效值 = 默认值 + 文件值（深合并，只并对象；数组整体覆盖） */
  values () { return deepMerge(clone(DEFAULT_CONFIG), this.data) }

  /** 点号路径读取（如 `mcMode.hideAdminTools`） */
  get (path) {
    if (!path) return this.values()
    return readPath(this.values(), String(path))
  }

  /** 点号路径写入；只允许已知顶层键，且做类型校验（免得手滑把插件搞崩） */
  set (path, value) {
    const p = String(path ?? '').trim()
    if (!p) throw new Error('path 不能为空（如 commandWhitelist 或 mcMode.allowOtherTools）')
    const [top, ...rest] = p.split('.')
    if (!TOP_KEYS.has(top)) {
      throw new Error(`未知配置项 "${top}"；可用：${[...TOP_KEYS].join(', ')}`)
    }
    if (SECRET_KEYS.has(top)) throw new Error('这一项不允许通过工具修改')
    validate(top, rest, value)
    writePath(this.data, p.split('.'), value)
    this.save()
    return { path: p, value: this.get(p), file: this.file }
  }

  /** 删掉某一项（回到默认值） */
  unset (path) {
    const p = String(path ?? '').trim()
    if (!p) throw new Error('path 不能为空')
    const parts = p.split('.')
    const container = parts.length === 1 ? this.data : readPath(this.data, parts.slice(0, -1).join('.'))
    if (container && typeof container === 'object') delete container[parts[parts.length - 1]]
    this.save()
    return { path: p, value: this.get(p), file: this.file }
  }

  /** 全部恢复默认（把文件写成 {}） */
  reset () {
    this.data = {}
    this.save()
    return { reset: true, file: this.file, values: this.values() }
  }

  /* ── 语义化读取 ── */

  get mcModePresets () {
    const v = this.get('mcModePresets')
    return Array.isArray(v) ? v.map(String) : []
  }

  get mcMode () {
    const v = this.get('mcMode')
    return {
      allowOtherTools: Array.isArray(v?.allowOtherTools) ? v.allowOtherTools.map(String) : [],
      denyOtherTools: Array.isArray(v?.denyOtherTools) ? v.denyOtherTools.map(String) : [],
      hideAdminTools: v?.hideAdminTools !== false,
    }
  }

  get memoryDir () {
    const v = this.get('memoryDir')
    return typeof v === 'string' && v.trim() ? v.trim() : null
  }

  /** 这个 preset id 算不算 MC 模式 */
  isMcModePreset (presetId) {
    if (!presetId) return false
    return this.mcModePresets.includes(String(presetId))
  }

  /**
   * 服务器指令是否放行。
   * 输入可以是 `/tp x y z` 或 `tp`；只按**指令名**判定。
   */
  commandAllowed (command) {
    // 「MC设置 → 指令白名单」页的开关：允许所有指令
    if (this.get('allowAllCommands') === true) return true
    const wl = this.get('commandWhitelist')
    if (!Array.isArray(wl)) return false
    const name = String(command ?? '').trim().replace(/^\//, '').split(/\s+/)[0].toLowerCase()
    if (!name) return false
    for (const entry of wl) {
      const e = String(entry).trim()
      if (!e) continue
      if (e === '*') return true
      if (e.startsWith('/') && e.lastIndexOf('/') > 0) {
        const end = e.lastIndexOf('/')
        try {
          if (new RegExp(e.slice(1, end), e.slice(end + 1) || 'i').test(name)) return true
        } catch { /* 坏正则忽略 */ }
        continue
      }
      if (e.toLowerCase() === name) return true
    }
    return false
  }
}

/* ─────────────── 内部工具 ─────────────── */

function validate (top, rest, value) {
  const key = [top, ...rest].join('.')
  const isStrArray = Array.isArray(value) && value.every((x) => typeof x === 'string')
  if (top === 'commandWhitelist') {
    if (!isStrArray) throw new Error('commandWhitelist 必须是字符串数组（如 ["tp","give","/^gi.*/"]）')
    return
  }
  if (top === 'mcModePresets') {
    if (!isStrArray) throw new Error('mcModePresets 必须是字符串数组（如 ["minecraft","whale_craft"]）')
    return
  }
  if (top === 'memoryDir') {
    if (value !== null && typeof value !== 'string') throw new Error('memoryDir 必须是字符串（绝对路径）或 null')
    return
  }
  if (top === 'allowAllCommands' || top === 'injectWhaleCraftAgentsMd' || top === 'injectWorkspaceAgentsMd' || top === 'ensureMcPreset') {
    if (typeof value !== 'boolean') throw new Error(`${top} 必须是 true/false`)
    return
  }
  if (top === 'mcMode') {
    if (key === 'mcMode.allowOtherTools' || key === 'mcMode.denyOtherTools') {
      if (!isStrArray) throw new Error(`${key} 必须是字符串数组（工具名，精确匹配）`)
      return
    }
    if (key === 'mcMode.hideAdminTools') {
      if (typeof value !== 'boolean') throw new Error('mcMode.hideAdminTools 必须是 true/false')
      return
    }
    if (key !== 'mcMode') throw new Error(`未知配置项 "${key}"；mcMode 下可用：allowOtherTools / denyOtherTools / hideAdminTools`)
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new Error('mcMode 必须是对象，如 {"allowOtherTools":[],"denyOtherTools":[],"hideAdminTools":true}')
    }
  }
}

function readPath (obj, path) {
  let cur = obj
  for (const k of String(path).split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined
    cur = cur[k]
  }
  return cur
}

function writePath (obj, parts, value) {
  let cur = obj
  for (const k of parts.slice(0, -1)) {
    if (cur[k] === null || typeof cur[k] !== 'object' || Array.isArray(cur[k])) cur[k] = {}
    cur = cur[k]
  }
  cur[parts[parts.length - 1]] = value
}

function clone (v) {
  if (Array.isArray(v)) return v.map(clone)
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clone(x)]))
  return v
}

function deepMerge (base, over) {
  if (!over || typeof over !== 'object' || Array.isArray(over)) return base
  for (const [k, v] of Object.entries(over)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])) {
      base[k] = deepMerge(base[k], v)
    } else if (v !== undefined) {
      base[k] = clone(v)
    }
  }
  return base
}
