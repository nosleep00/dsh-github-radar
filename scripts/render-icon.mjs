/**
 * Renders assets/icon-180.png from the same geometry as icon.svg, without any
 * image dependency: a small RGBA canvas + zlib PNG encoder.
 *
 * The market wants a raster tile (~96px display, square, GitHub-hosted), so the
 * SVG alone is not enough.
 *
 * Usage: node scripts/render-icon.mjs [size]
 */
import { deflateSync } from 'node:zlib'
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const size = Number(process.argv[2] ?? 180)
const out = fileURLToPath(new URL(`../assets/icon-${size}.png`, import.meta.url))

const px = new Float64Array(size * size * 4)

function clamp01(value) {
  return value < 0 ? 0 : value > 1 ? 1 : value
}

function smoothstep(edge0, edge1, x) {
  const t = clamp01((x - edge0) / (edge1 - edge0))
  return t * t * (3 - 2 * t)
}

/** Source-over composite of one colour onto a pixel. */
function blend(index, r, g, b, a) {
  if (a <= 0) return
  const i = index * 4
  const sr = r / 255
  const sg = g / 255
  const sb = b / 255
  const da = px[i + 3]
  const oa = a + da * (1 - a)
  if (oa <= 0) {
    px[i] = 0
    px[i + 1] = 0
    px[i + 2] = 0
    px[i + 3] = 0
    return
  }
  px[i] = (sr * a + px[i] * da * (1 - a)) / oa
  px[i + 1] = (sg * a + px[i + 1] * da * (1 - a)) / oa
  px[i + 2] = (sb * a + px[i + 2] * da * (1 - a)) / oa
  px[i + 3] = oa
}

const centre = size / 2
const radius = size * 0.42

for (let y = 0; y < size; y += 1) {
  for (let x = 0; x < size; x += 1) {
    const index = y * size + x
    const dx = x + 0.5 - centre
    const dy = y + 0.5 - centre
    const distance = Math.hypot(dx, dy)
    const angle = Math.atan2(dy, dx)

    // Rounded-square tile, corner radius ~22% of the side.
    const half = size / 2 - size * 0.02
    const rounding = size * 0.22
    const qx = Math.abs(x + 0.5 - centre) - (half - rounding)
    const qy = Math.abs(y + 0.5 - centre) - (half - rounding)
    const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0)
    const tile = smoothstep(rounding + 0.75, rounding - 0.75, outside)
    if (tile <= 0) continue

    // Background: vertical gradient from near-black to a dark navy.
    const t = y / size
    const br = 11 + 17 * t
    const bg = 16 + 27 * t
    const bb = 32 + 54 * t
    blend(index, br, bg, bb, tile)

    // Radar rings.
    for (const scale of [0.42, 0.68, 1]) {
      const ringRadius = radius * scale
      const width = size * (scale === 1 ? 0.011 : 0.008)
      const ring = smoothstep(width + 0.6, width - 0.6, Math.abs(distance - ringRadius)) * tile
      blend(index, 96, 196, 255, ring * 0.55)
    }

    // Sweep: a rotating wedge that fades with angle.
    let sweepAngle = angle + Math.PI * 0.72
    while (sweepAngle < 0) sweepAngle += Math.PI * 2
    while (sweepAngle > Math.PI * 2) sweepAngle -= Math.PI * 2
    const sweepWidth = Math.PI * 0.55
    if (sweepAngle < sweepWidth && distance < radius) {
      const fade = (1 - sweepAngle / sweepWidth) ** 1.5
      const inner = smoothstep(radius, radius * 0.15, distance)
      blend(index, 56, 189, 248, fade * inner * 0.85 * tile)
    }

    // Blips, placed inside the sweep's quadrant.
    const blips = [
      [0.72, -0.35, 0.035],
      [0.52, 0.9, 0.028],
      [0.3, 2.3, 0.03],
      [0.86, -2.1, 0.026],
    ]
    for (const [scale, blipAngle, dot] of blips) {
      const bx = Math.cos(blipAngle) * radius * scale
      const by = Math.sin(blipAngle) * radius * scale
      const d = Math.hypot(x + 0.5 - centre - bx, y + 0.5 - centre - by)
      const r = size * dot
      const dotAlpha = smoothstep(r + 0.7, r - 0.7, d) * tile
      blend(index, 125, 211, 252, dotAlpha)
    }

    // Centre dot.
    const centreAlpha = smoothstep(size * 0.028, size * 0.016, distance) * tile
    blend(index, 224, 242, 254, centreAlpha)
  }
}

// --- PNG encoding -----------------------------------------------------------

const raw = Buffer.alloc((size * 4 + 1) * size)
for (let y = 0; y < size; y += 1) {
  raw[y * (size * 4 + 1)] = 0 // filter: none
  for (let x = 0; x < size; x += 1) {
    const i = (y * size + x) * 4
    const o = y * (size * 4 + 1) + 1 + x * 4
    raw[o] = Math.round(clamp01(px[i]) * 255)
    raw[o + 1] = Math.round(clamp01(px[i + 1]) * 255)
    raw[o + 2] = Math.round(clamp01(px[i + 2]) * 255)
    raw[o + 3] = Math.round(clamp01(px[i + 3]) * 255)
  }
}

function chunk(type, body) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(body.length, 0)
  const typeAndBody = Buffer.concat([Buffer.from(type, 'ascii'), body])
  const crcTable = []
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    crcTable[n] = c >>> 0
  }
  let crc = 0xffffffff
  for (const byte of typeAndBody) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  const crcBuffer = Buffer.alloc(4)
  crcBuffer.writeUInt32BE((crc ^ 0xffffffff) >>> 0, 0)
  return Buffer.concat([length, typeAndBody, crcBuffer])
}

const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(size, 0)
ihdr.writeUInt32BE(size, 4)
ihdr[8] = 8 // bit depth
ihdr[9] = 6 // colour type: RGBA
ihdr[10] = 0
ihdr[11] = 0
ihdr[12] = 0

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
])

mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, png)
console.log(`wrote ${out} (${size}x${size}, ${png.length} bytes)`)
