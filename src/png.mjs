// -*- coding: utf-8 -*-
/**
 * whale_craft / png.mjs —— 极简 PNG 编码器（RGBA8，零依赖）
 * ============================================================================
 * 为什么自己写而不装 sharp/pngjs：
 *   1. 插件要被 symlink 挂进 profile，多一个原生依赖就多一份装不上的风险；
 *   2. 我们只需要"像素数组 → PNG 字节"这一条路，node:zlib 已经给了 deflate。
 * 仅支持 8bit RGBA（color type 6）、无隔行、filter 全 0 —— 足够画地图。
 * ============================================================================
 */
import { deflateSync } from 'node:zlib'

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1)
    table[n] = c
  }
  return table
})()

function crc32 (buf) {
  let c = -1
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

function chunk (type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body), 0)
  return Buffer.concat([len, body, crc])
}

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/**
 * 把 RGBA8 像素编码成 PNG。
 * @param {number} width
 * @param {number} height
 * @param {Uint8Array} rgba 长度必须是 width*height*4
 * @returns {Buffer} PNG 字节
 */
export function encodePng (width, height, rgba) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error(`PNG 尺寸非法：${width}x${height}`)
  }
  const stride = width * 4
  if (rgba.length < stride * height) {
    throw new Error(`PNG 像素不足：需要 ${stride * height}，实际 ${rgba.length}`)
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8    // bit depth
  ihdr[9] = 6    // color type: RGBA
  ihdr[10] = 0   // compression: deflate
  ihdr[11] = 0   // filter method: adaptive
  ihdr[12] = 0   // interlace: none

  // 每条扫描线前面加一个 filter 字节（0 = None）
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    const rowStart = y * (stride + 1)
    raw[rowStart] = 0
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(raw, rowStart + 1)
  }

  const idat = deflateSync(raw, { level: 9 })
  return Buffer.concat([SIGNATURE, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))])
}
