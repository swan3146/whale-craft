// -*- coding: utf-8 -*-
/**
 * whale_craft / image.mjs —— 图像能力（SVG 为编辑语言 + 光栅化）
 * ============================================================================
 * 用户 2026-09-15 的思路（比我原来的方案对）：
 *   "让它能保存图片，能写 svg 和向 svg 引入图片，以及将 svg 转为 png，保存 svg 之类的，不就行了。"
 *
 * 为什么这样更好：
 *   · **SVG 是文本** —— AI 本来就会写。拼网格、画矩形框、加文字（含中文）、
 *     组合多张图……全都可以在 SVG 里表达，比给一堆固定 API（grid/annotate/resize）
 *     灵活得多，也不会被"参数只能这么传"卡住。
 *   · 我们要提供的其实只有两块它自己做不到的事：
 *       ① **把外部图片塞进 SVG**（要 base64 → 给个 embed）
 *       ② **SVG → PNG 光栅化**（要字体渲染 → 给个 render）
 *     其余（布局/标注/文字）它用 `write` 写 SVG 文本就行。
 *
 * 引擎：sharp（实测从 whale_craft 可解析 0.35.3，**中文 SVG 文字光栅化正常**）。
 * 解析不到时所有方法**抛清晰错误**，不静默假装成功。
 * ============================================================================
 */
import { createRequire } from 'node:module'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname, extname } from 'node:path'

let sharp = null
let sharpError = null
try {
  const req = createRequire(import.meta.url)
  sharp = req('sharp')
} catch (e) { sharpError = e }

export const imageEngineAvailable = () => Boolean(sharp)
export const imageEngineError = () => (sharpError ? String(sharpError.message) : null)

function need () {
  if (!sharp) throw new Error(`图像引擎不可用（sharp 解析失败：${sharpError?.message ?? '未知'}）`)
  return sharp
}

const MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.avif': 'image/avif', '.bmp': 'image/bmp',
}
const mimeFor = (p) => MIME[extname(String(p)).toLowerCase()] ?? 'application/octet-stream'

function writeOut (outPath, data) {
  const dir = dirname(outPath)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(outPath, data)
  return { file: outPath, bytes: data.length }
}

function readText (path) {
  if (!existsSync(path)) throw new Error(`文件不存在：${path}`)
  return readFileSync(path, 'utf8')
}

const XML_ESCAPE = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }
export const escapeXml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => XML_ESCAPE[c])

export const ImageEngine = {
  available: imageEngineAvailable,

  /** 图片信息（尺寸/格式）——也用来确认"这到底是不是张能用的图" */
  async info (path) {
    const s = need()
    if (!existsSync(path)) throw new Error(`文件不存在：${path}`)
    const meta = await s(readFileSync(path)).metadata()
    return {
      file: path, format: meta.format, width: meta.width, height: meta.height,
      channels: meta.channels, hasAlpha: Boolean(meta.hasAlpha), bytes: meta.size ?? null,
      isSvg: meta.format === 'svg' || /\.svg$/i.test(String(path)),
    }
  },

  /**
   * 把一个图片文件变成 **data URI** —— 这是"向 SVG 引入图片"的关键。
   * SVG 里的 `<image>` 不能直接引用本地路径（渲染器读不到），必须内联成 data URI。
   *
   * @param {string} path
   * @param {{ asTag?: boolean, x?:number, y?:number, width?:number, height?:number }} [opts]
   *        asTag=true 时顺带返回一个现成的 `<image .../>` 标签，直接贴进 SVG 即可。
   */
  async embed (path, { asTag = true, x = 0, y = 0, width = null, height = null } = {}) {
    if (!existsSync(path)) throw new Error(`文件不存在：${path}`)
    const buf = readFileSync(path)
    const mime = mimeFor(path)
    const uri = `data:${mime};base64,${buf.toString('base64')}`

    let w = width
    let h = height
    if (asTag && (w == null || h == null)) {
      // 没给尺寸就按原图比例补上（SVG 里不写 width/height 会按图片自身尺寸渲染）
      try {
        const meta = await need()(buf).metadata()
        if (w == null) w = meta.width
        if (h == null) h = meta.height
      } catch { /* 取不到就让它按自身尺寸渲染 */ }
    }
    const dims = [
      w == null ? '' : ` width="${Math.round(Number(w))}"`,
      h == null ? '' : ` height="${Math.round(Number(h))}"`,
    ].join('')

    return {
      file: path, mime, bytes: buf.length, dataUri: uri,
      ...(asTag ? { tag: `<image href="${uri}" x="${x}" y="${y}"${dims} preserveAspectRatio="xMidYMid meet"/>` } : {}),
      note: '把 tag（或 dataUri 放进你自己的 <image href="...">）贴进 SVG，渲染时就不会缺图。',
    }
  },

  /**
   * SVG → PNG 光栅化。
   *
   * @param {object} o
   * @param {string} [o.svg]     SVG 文本（与 svgPath 二选一）
   * @param {string} [o.svgPath] SVG 文件路径
   * @param {number} [o.width]   目标宽（等比；与 height 同给则决定画布）
   * @param {number} [o.height]  目标高
   * @param {number} [o.scale]   倍率（默认 1；2 = 两倍清晰度）
   * @param {number} [o.density] SVG 光栅化 DPI（默认 96，够清晰且不糊）
   * @returns {{ png: Buffer, width:number, height:number }}
   */
  async render ({ svg = null, svgPath = null, width = null, height = null, scale = 1, density = 96 }) {
    const s = need()
    const text = svg != null ? String(svg) : readText(svgPath)
    if (!/<svg[\s>]/i.test(text)) {
      throw new Error('这不像 SVG（找不到 <svg> 标签）—— SVG 必须是文本，不是图片文件')
    }
    const k = Math.max(0.05, Math.min(Number(scale) || 1, 16))
    // scale 直接乘到 density 上 —— 这样**只给 scale 也能提高光栅分辨率**
    // （早先只在给了 width/height 时才 resize，导致 scale 单独用等于没效果）
    const dens = Math.max(1, Number(density) || 96) * k
    let pipe = s(Buffer.from(text), { density: dens })
    const w = width ? Math.round(Number(width) * k) : null
    const h = height ? Math.round(Number(height) * k) : null
    if (w || h) pipe = pipe.resize({ width: w, height: h, fit: 'fill' })
    const png = await pipe.png().toBuffer()
    const meta = await s(png).metadata()
    return { engine: 'sharp', width: meta.width, height: meta.height, png }
  },

  /**
   * 把若干张图按网格拼成 **SVG 文本**（图片内联成 data URI）。
   *
   * 为什么返回 SVG 而不是直接 PNG：SVG 是可继续编辑的——AI 想在格子上加标注、
   * 改标题、调间距，直接改文本就行；要图就再 render 一次。
   * 布局/画框/文字本来也能自己写，这个只是省掉"重复 N 遍 <image> + 算坐标"的机械活。
   */
  async grid ({ paths, cols = null, cell = 256, gap = 8, labels = [], title = null, background = '#14141a' }) {
    if (!Array.isArray(paths) || paths.length === 0) throw new Error('paths 必须是非空数组')
    if (paths.length > 64) throw new Error(`一次最多拼 64 张（收到 ${paths.length}）`)

    const n = paths.length
    const c = Math.max(1, Math.min(Number(cols) || Math.ceil(Math.sqrt(n)), n))
    const rows = Math.ceil(n / c)
    const s = need()

    // 每格等比缩放进 cell×cell（不放大）
    const tiles = []
    for (let i = 0; i < n; i++) {
      const p = paths[i]
      if (!existsSync(p)) throw new Error(`文件不存在：${p}`)
      const buf = readFileSync(p)
      const meta = await s(buf).metadata()
      const k = Math.min(cell / meta.width, cell / meta.height, 1)
      const w = Math.max(1, Math.round(meta.width * k))
      const h = Math.max(1, Math.round(meta.height * k))
      const small = k < 1 ? await s(buf).resize(w, h).png().toBuffer() : buf
      tiles.push({ uri: `data:image/png;base64,${small.toString('base64')}`, w, h, label: labels[i] ?? null })
    }

    const cellW = Math.max(...tiles.map((t) => t.w))
    const labelH = tiles.some((t) => t.label) ? 26 : 0
    const cellH = Math.max(...tiles.map((t) => t.h)) + labelH
    const titleH = title ? 34 : 0
    const W = c * cellW + (c + 1) * gap
    const H = titleH + rows * cellH + (rows + 1) * gap

    const parts = [`<rect width="${W}" height="${H}" fill="${escapeXml(background)}"/>`]
    if (title) {
      parts.push(
        `<text x="${gap}" y="24" font-size="20" font-family="sans-serif" fill="#ffffff">${escapeXml(title)}</text>`,
      )
    }
    tiles.forEach((t, i) => {
      const col = i % c
      const row = Math.floor(i / c)
      const left = gap + col * (cellW + gap)
      const top = titleH + gap + row * (cellH + gap)
      parts.push(
        `<rect x="${left}" y="${top}" width="${t.w}" height="${t.h}" fill="#000000"/>`,
        `<image href="${t.uri}" x="${left}" y="${top}" width="${t.w}" height="${t.h}" preserveAspectRatio="xMidYMid meet"/>`,
        `<text x="${left + 4}" y="${top + 16}" font-size="14" font-family="monospace" fill="#ffd75c">${i + 1}</text>`,
      )
      if (t.label) {
        parts.push(
          `<rect x="${left}" y="${top + t.h}" width="${t.w}" height="${labelH}" fill="#000000" fill-opacity="0.72"/>`,
          `<text x="${left + 6}" y="${top + t.h + 18}" font-size="16" font-family="sans-serif" fill="#ffffff">${escapeXml(String(t.label).slice(0, 40))}</text>`,
        )
      }
    })

    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">\n${parts.join('\n')}\n</svg>`
    return { engine: 'sharp', width: W, height: H, cells: n, cols: c, rows, svg }
  },

  /** 落盘（PNG 或 SVG 文本都行） */
  save (outPath, data) {
    return writeOut(outPath, Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8'))
  },
}
