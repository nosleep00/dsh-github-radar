/**
 * Probe: run the real signal pipeline over a real session log.
 *
 * The GUI panel is the only place the whole loop runs, but its keywords are
 * also the thing most likely to be junk (harness runtime context, pasted
 * tool output, ...). This script decompresses the newest session log, pulls the
 * last user messages, and prints what `extractSignal` + `buildQueries` would do
 * with them — no browser, no GitHub quota spent.
 *
 * Usage: node scripts/probe-session.mjs [path-or-session-id]
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'
import { extractSignal, messageText, stripHarnessNoise } from '../dist/host/signals.js'
import { buildQueries } from '../dist/host/query.js'

const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const sessionsRoot = join(home, 'sessions')

function listFiles(dir, depth = 0) {
  if (depth > 3) return []
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...listFiles(path, depth + 1))
    else if (entry.name.endsWith('.jsonl.zstd') || entry.name.endsWith('.jsonl')) out.push(path)
  }
  return out
}

const arg = process.argv[2]
let file
if (arg !== undefined && arg.endsWith('.zstd')) {
  file = arg
} else {
  const files = listFiles(sessionsRoot)
    .filter((path) => (arg === undefined ? true : path.includes(arg)))
    .map((path) => ({ path, at: statSync(path).mtimeMs }))
    .sort((a, b) => b.at - a.at)
  if (files.length === 0) {
    console.error('no session log found under', sessionsRoot)
    process.exit(1)
  }
  file = files[0].path
}

const raw = readFileSync(file)

/**
 * Session logs are a sequence of independent zstd frames (one per append), and
 * `zstdDecompressSync` only decodes the first one. Walk the frame magic instead.
 */
function decodeFrames(buffer) {
  const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
  const chunks = []
  let offset = 0
  while (offset < buffer.length) {
    const magicAt = buffer.indexOf(MAGIC, offset)
    if (magicAt < 0) break
    try {
      const out = zstdDecompressSync(buffer.subarray(magicAt))
      if (out.length > 0) chunks.push(out.toString('utf8'))
    } catch {
      /* a magic-looking byte pair inside a payload: ignore */
    }
    offset = magicAt + 4
  }
  return chunks.join('')
}

const text = file.endsWith('.zstd') ? decodeFrames(raw) : raw.toString('utf8')
const lines = Array.from(new Set(text.split('\n').filter((line) => line.trim() !== '')))

const events = []
for (const line of lines) {
  try {
    events.push(JSON.parse(line))
  } catch {
    /* a torn tail line is normal while a session is being written */
  }
}

const userEvents = events.filter((event) => event?.type === 'user/message')
console.log('file       :', file)
console.log('events     :', events.length, '| user/message:', userEvents.length)

const signal = extractSignal('probe', userEvents, { now: Date.now() })
console.log('keywords   :', JSON.stringify(signal.keywords))
console.log('errorText  :', JSON.stringify(signal.errorText ?? ''))
console.log('queries    :', JSON.stringify(buildQueries(signal, { minStars: 30, maxQueries: 3 }), null, 2))

/*
 * Mirror exactly what `extractSignal` keeps, so the probe can show *which* text
 * produced the keywords. Whenever the panel shows nonsense keywords, this is
 * the place to look first.
 */
const window = Number(process.env.RADAR_WINDOW ?? 3)
const kept = []
for (let i = userEvents.length - 1; i >= 0 && kept.length < window; i -= 1) {
  const event = userEvents[i]
  const body = messageText(event.data?.message ?? event.data?.content ?? event.data)
  const cleaned = stripHarnessNoise(body)
  if (cleaned.length < 8) continue
  kept.push({ at: i, cleaned })
}

console.log('\n-- texts extractSignal actually reads --')
for (const item of kept) {
  console.log(`--- #${item.at} (${item.cleaned.length} chars) ---`)
  console.log(item.cleaned.slice(0, 400).replace(/\n{2,}/g, '\n'))
}
