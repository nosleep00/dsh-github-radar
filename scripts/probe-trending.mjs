/**
 * Live check for the no-signal fallback: run the trending queries against the
 * real GitHub API and print what the panel would show for an empty session.
 *
 * Usage: node scripts/probe-trending.mjs
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'radar-trending-'))

const { GithubClient } = await import('../dist/host/github.js')
const { RadarEngine } = await import('../dist/host/engine.js')
const { createStore } = await import('../dist/host/store.js')
const { DEFAULT_SETTINGS } = await import('../dist/host/index.js')
const { buildTrendingQueries } = await import('../dist/host/query.js')

const settings = { ...DEFAULT_SETTINGS }
const options = {
  minStars: settings.minStars,
  languages: settings.languages,
  chineseOnly: settings.chineseOnly,
  now: Date.now(),
}
console.log('trending queries:', buildTrendingQueries(options))

const client = new GithubClient({ token: '' })
const queries = []
const wrapped = {
  get lastQuota() {
    return client.lastQuota
  },
  async search(query, searchOptions) {
    queries.push(query)
    return client.search(query, searchOptions)
  },
}

const engine = new RadarEngine({
  getEvents: () => [],
  settings: () => settings,
  client: wrapped,
  store: createStore(),
  now: () => Date.now(),
  log: (message) => console.log('[log]', message),
})

function report(label, state) {
  console.log(`\n=== ${label} ===`)
  console.log('status:', state.status, '| trending:', state.trending, '| cached:', state.cached)
  console.log('keywords:', JSON.stringify(state.keywords ?? []))
  console.log('notice:', state.notice ?? '')
  console.log('quota:', JSON.stringify(state.quota ?? null), '| anonymous:', state.anonymous)
  for (const card of state.cards) {
    console.log(`- ${card.fullName} [${card.language ?? '?'} ${card.stars}★] ${card.zh}`)
  }
  console.log('cards:', state.cards.length)
  return state.cards.map((card) => card.fullName)
}

const first = report('refresh #1', await engine.refreshNow('trend-probe'))
const second = report('refresh #2 (⟳)', await engine.refreshNow('trend-probe'))
const overlap = second.filter((name) => first.includes(name))
console.log('\noverlap between batch 1 and 2:', overlap.length === 0 ? 'none (rotated)' : overlap)
console.log('queries sent:', queries.length, queries.map((query) => query.slice(0, 44)))
