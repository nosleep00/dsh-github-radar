/**
 * Probe: run the whole radar pipeline over a real session, end to end.
 *
 * `probe-session.mjs` shows the keywords, `probe-host.mjs` shows the HTTP
 * routes with a fake session. This script joins them: it decodes a real session
 * log, feeds the events to `RadarEngine`, and prints the cards a user would
 * see in the panel. It spends real GitHub quota (one search per query).
 *
 * Usage: node scripts/probe-real.mjs [session-id-substring]
 */
import { mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const sessionsRoot = join(home, 'sessions')
const arg = process.argv[2]

function listFiles(dir, depth = 0) {
  if (depth > 3) return []
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...listFiles(path, depth + 1))
    else if (entry.name.endsWith('.jsonl.zstd')) out.push(path)
  }
  return out
}

const candidates = listFiles(sessionsRoot)
  .filter((path) => (arg === undefined ? true : path.includes(arg)))
  .map((path) => ({ path, at: statSync(path).mtimeMs }))
  .sort((a, b) => b.at - a.at)
if (candidates.length === 0) {
  console.error('no session log found under', sessionsRoot)
  process.exit(1)
}

const file = candidates[0].path
const sessionId = /(session-[0-9a-f-]+)/.exec(file)?.[1] ?? 'probe-real'

/** Session logs are appended as independent zstd frames; walk the magic. */
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
      /* magic-looking bytes inside a payload */
    }
    offset = magicAt + 4
  }
  return chunks.join('')
}

const text = decodeFrames(readFileSync(file))
const seen = new Set()
const events = []
for (const line of text.split('\n')) {
  if (line.trim() === '' || seen.has(line)) continue
  seen.add(line)
  try {
    events.push(JSON.parse(line))
  } catch {
    /* torn tail line while the session is being written */
  }
}

const dataHome = mkdtempSync(join(tmpdir(), 'radar-real-'))
process.env.DSH_HOME = dataHome

const { createStore } = await import('../dist/host/store.js')
const { GithubClient } = await import('../dist/host/github.js')
const { RadarEngine } = await import('../dist/host/engine.js')
const { DEFAULT_SETTINGS } = await import('../dist/host/index.js')

const store = createStore()
const client = new GithubClient({ userAgent: 'dsh-github-radar-probe/0.1.0' })
const engine = new RadarEngine({
  getEvents: () => events,
  settings: () => DEFAULT_SETTINGS,
  client,
  store,
  log: (message) => console.log('  ·', message),
})

console.log('file      :', file)
console.log('sessionId :', sessionId)
console.log('events    :', events.length)

const started = Date.now()
const state = await engine.refreshNow(sessionId)
console.log('elapsed   :', `${Date.now() - started}ms`)
console.log('status    :', state.status)
console.log('keywords  :', JSON.stringify(state.keywords ?? []))
console.log('notice    :', JSON.stringify(state.notice ?? ''))
console.log('quota     :', JSON.stringify(state.quota ?? null))
console.log('cards     :')
for (const card of state.cards) {
  console.log(`  - ${card.fullName} · ${card.stars}★ · ${card.language ?? '?'} · ${card.zhSource}`)
  console.log(`    zh : ${card.zh}`)
  console.log(`    why: ${card.why}`)
  console.log(`    en : ${(card.descriptionEn ?? '').slice(0, 90)}`)
}
