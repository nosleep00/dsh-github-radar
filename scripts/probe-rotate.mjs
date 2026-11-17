/**
 * Deterministic check for "⟳ shows the next batch": runs the real engine against
 * a fake GitHub client with a fixed candidate pool, so the rotation and the
 * page-2 fallback can be inspected without spending anonymous quota.
 *
 * Usage: node scripts/probe-rotate.mjs
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'radar-rotate-'))

const { RadarEngine } = await import('../dist/host/engine.js')
const { createStore } = await import('../dist/host/store.js')
const { DEFAULT_SETTINGS } = await import('../dist/host/index.js')

const NOW = Date.UTC(2026, 10, 17)
const LIMIT = Number(process.argv[2] ?? 14)

function repo(name, index) {
  return {
    full_name: name,
    html_url: `https://github.com/${name}`,
    description: `项目 ${index} 的英文简介`,
    topics: ['cli'],
    language: 'TypeScript',
    stargazers_count: 2_000 + index * 137,
    pushed_at: new Date(NOW - 86_400_000).toISOString(),
    archived: false,
  }
}

const pool = Array.from({ length: LIMIT }, (_, index) => repo(`owner${index}/hot${index}`, index))
const pageSize = 20
const calls = []
const client = {
  lastQuota: { remaining: 9, limit: 10, resetAt: NOW + 60_000 },
  async search(query, options = {}) {
    const page = options.page ?? 1
    calls.push({ query: query.slice(0, 40), page })
    // GitHub semantics: each page is a disjoint slice of the same ranking.
    const start = (page - 1) * pageSize
    return { kind: 'ok', repos: pool.slice(start, start + pageSize) }
  },
}

const settings = { ...DEFAULT_SETTINGS }
const engine = new RadarEngine({
  getEvents: () => [],
  settings: () => settings,
  client,
  store: createStore(),
  now: () => NOW,
  log: () => {},
})

const banners = []
for (let round = 1; round <= 4; round += 1) {
  const state = await engine.refreshNow('rotate-probe')
  const names = state.cards.map((card) => card.fullName)
  banners.push(names)
  const freshness = state.notice === undefined ? '' : ' | notice: 有'
  console.log(`⟳ #${round}: ${state.status} (${names.length} 张)${freshness}`)
  for (const name of names) console.log(`   ${name}`)
}

let overlap = 0
for (let index = 1; index < banners.length; index += 1) {
  const seen = new Set(banners.slice(0, index).flat())
  overlap += banners[index].filter((name) => seen.has(name)).length
}
console.log('\n重复出现的卡片数:', overlap)
console.log('请求记录:', calls.length, '次 |', calls.map((call) => `p${call.page}`).join(' '))
