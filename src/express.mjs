// -*- coding: utf-8 -*-
/**
 * whale_craft / express.mjs —— 「把产出文件端给浏览器」的那条最小通道
 * ============================================================================
 * 用户 2026-09-16 定的形态：
 *   · **目录即白名单**：只服务 `<工作区>/.whale-craft/.express/` 里的文件
 *     （放进这个目录 = 同意被访问；`.out/` 是默认输出，不对外）；
 *   · 地址形态：`<base>/whale-craft/<工作区指代>/<剩余路径>`
 *     例：`/api/mc/whale-craft/myproj/world1/example.png` → `.whale-craft/.express/world1/example.png`；
 *   · **不用 token**（用户：DSH 本身禁止公网访问；真要架公网，架的人自己加代理与鉴权）；
 *   · 下面**可以有子目录**；
 *   · **所有扩展名都放行**（用户自己把握）；但**必须防穿透**。
 *
 * 本模块是**纯函数**（不碰 fs），好测；真正的读写与 404 判定在 index.js 的路由里。
 * ============================================================================
 */
import { basename, join, sep } from 'node:path'

/** 「发布区」目录名（在 `<工作区>/.whale-craft/` 下） */
export const EXPRESS_DIR = '.express'
/** 默认工作输出目录名（**不对外**）——点开头，与 AI/用户的内容分开 */
export const OUT_DIR = '.out'
/** URL 前缀：`/api/mc` + 这一段 */
export const EXPRESS_URL_PREFIX = '/whale-craft'

/** 发布区根目录（给 fs 用） */
export const expressRootOf = (memoryRoot) => join(memoryRoot, EXPRESS_DIR)

/** 默认输出根目录（不对外） */
export const outRootOf = (memoryRoot) => join(memoryRoot, OUT_DIR)

/**
 * 「工作区指代」= 工作区目录名（用户不要 token）。
 * 名字里可能是空格/中文 → 拼 URL 时 percent-encode，匹配时 decode。
 */
export const wsIdOf = (cwd) => basename(String(cwd ?? ''))

/**
 * 解析 `/api/mc/whale-craft/<ws>/<rest...>`。
 *
 * ⚠️ 传入的应当是 `url.pathname`（**已解码**）：`new URL()` 会把 `%2e%2e` 还原成 `..`，
 *    所以下面的校验看得见真正的点段 —— 这正是"必须防穿透"的第一道。
 * @returns {{ws:string, segments:string[]}|null}
 */
export function parseExpressPath (pathname) {
  const raw = String(pathname ?? '')
  const prefix = `/api/mc${EXPRESS_URL_PREFIX}/`
  if (!raw.startsWith(prefix)) return null
  const rest = raw.slice(prefix.length)
  if (!rest) return null
  const parts = rest.split('/')
  const ws = parts.shift() ?? ''
  if (!ws) return null
  if (!parts.length) return null
  return { ws, segments: parts }
}

/**
 * 段级校验 + 拼绝对路径。**任何一段**不合格就返回 null（宁可不服务）：
 *   · 空段（连续 `/`、结尾 `/`）· `.` / `..` · 含 `/` `\`（编码过的分隔符）
 *   · 盘符/绝对路径味道（`C:`）· 控制字符 · 开头的 `~`
 * 另外做一次"拼完仍在 root 里面"的复查（纵深防御；真正的兜底是路由里的 realpath 检查）。
 * @returns {string|null} 绝对路径
 */
export function safeExpressTarget (root, segments) {
  const rootAbs = String(root ?? '')
  if (!rootAbs) return null
  const list = Array.isArray(segments) ? segments : []
  if (!list.length) return null
  for (const raw of list) {
    const s = String(raw ?? '')
    if (!s) return null
    if (s === '.' || s === '..') return null
    if (/[/\\]/.test(s)) return null
    if (/^[A-Za-z]:/.test(s)) return null
    if (s.startsWith('~')) return null
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f]/.test(s)) return null
    if (s.length > 255) return null
  }
  const abs = join(rootAbs, ...list)
  const prefix = rootAbs.endsWith(sep) ? rootAbs : rootAbs + sep
  if (abs !== rootAbs && !abs.startsWith(prefix)) return null
  return abs
}

/** 扩展名 → Content-Type（**所有扩展名都放行**；不认识的按二进制流走） */
const MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.avif': 'image/avif', '.bmp': 'image/bmp', '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml', '.pdf': 'application/pdf', '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8', '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg',
  '.zip': 'application/zip', '.glb': 'model/gltf-binary', '.schem': 'application/octet-stream',
}
export function mimeOf (file) {
  const s = String(file ?? '')
  const i = s.lastIndexOf('.')
  if (i < 0) return 'application/octet-stream'
  return MIME[s.slice(i).toLowerCase()] ?? 'application/octet-stream'
}

/**
 * 这些类型**被浏览器当文档打开时会执行脚本**（同源风险）→ 只加一个 CSP sandbox 头：
 * 内联 `<img>` 显示不受影响（图片上下文里脚本本来就不跑），但直接导航过去也跑不起来。
 */
export const SANDBOX_TYPES = /^(?:image\/svg\+xml|text\/html|text\/xml|application\/xml|text\/javascript|application\/javascript)/

/**
 * 一个绝对路径在发布区里时，给出**现成可粘贴的** URL 与 markdown；不在就返回 null。
 * URL 用**相对路径**：本地 `127.0.0.1` 与受信域名两种访问方式都同源可用，也不碰混合内容/CORS。
 * @param {string} cwd 工作区（用来取"工作区指代"= 目录名）
 * @param {string} absPath 文件绝对路径
 * @param {string} [memoryRoot] 记忆根（默认 `<cwd>/.whale-craft`；配了 WHALE_CRAFT_MEMORY_DIR/memoryDir 时调用方要传）
 * @returns {{rel:string, url:string, markdown:string}|null}
 */
export function expressRefFor (cwd, absPath, memoryRoot = join(String(cwd ?? ''), '.whale-craft')) {
  const root = expressRootOf(memoryRoot)
  const p = String(absPath ?? '')
  const prefix = root.endsWith(sep) ? root : root + sep
  if (!p.startsWith(prefix)) return null
  const rel = p.slice(prefix.length)
  if (!rel) return null
  const parts = rel.split(/[/\\]+/).filter(Boolean)
  if (!parts.length) return null
  const url = `/api/mc${EXPRESS_URL_PREFIX}/${encodeURIComponent(wsIdOf(cwd))}/${parts.map(encodeURIComponent).join('/')}`
  return { rel, url, markdown: `![](${url})` }
}
