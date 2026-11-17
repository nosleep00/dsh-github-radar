import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

const home = mkdtempSync(join(tmpdir(), 'radar-engine-'))
process.env.DSH_HOME = home
let caseIndex = 0

/** A private plugin-data dir, so no test sees another test's cache. */
function freshDir(): string {
  caseIndex += 1
  const dir = join(home, `case-${caseIndex}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

const { RadarEngine } = await import('../src/host/engine.js')
const { createStore } = await import('../src/host/store.js')
const { DEFAULT_SETTINGS } = await import('../src/host/index.js')

import type { SearchOutcome } from '../src/host/github.js'
import type { L2Runner } from '../src/host/engine.js'
import type { RadarQuota, RadarSettings } from '../src/host/types.js'

const NOW = Date.UTC(2026, 0, 1)
const DAY = 86_400_000

afterAll(() => {
  rmSync(home, { recursive: true, force: true })
})

function repo(full_name: string, over: Record<string, unknown> = {}) {
  return {
    full_name,
    html_url: `https://github.com/${full_name}`,
    description: 'A fast async framework for APIs',
    topics: ['api', 'web'],
    language: 'Python',
    stargazers_count: 40_000,
    pushed_at: new Date(NOW - 2 * DAY).toISOString(),
    archived: false,
    fork: false,
    ...over,
  }
}

class FakeClient {
  queries: string[] = []
  pages: Array<number | undefined> = []
  readonly lastQuota: RadarQuota | undefined = { remaining: 8, limit: 10, resetAt: NOW + 60_000 }
  constructor(private readonly respond: (query: string, index: number) => SearchOutcome) {}
  async search(query: string, options: { page?: number } = {}): Promise<SearchOutcome> {
    this.queries.push(query)
    this.pages.push(options.page)
    return this.respond(query, this.queries.length - 1)
  }
}

const events = [
  {
    type: 'user/message',
    time: NOW,
    data: {
      message: {
        content: [{ type: 'text', text: '我在用 fastapi 写接口，pandas 读大文件特别慢，有什么替代方案' }],
      },
    },
  },
]

function settings(over: Partial<RadarSettings> = {}): RadarSettings {
  return { ...DEFAULT_SETTINGS, ...over }
}

function makeEngine(options: {
  respond?: (query: string, index: number) => SearchOutcome
  settings?: RadarSettings
  events?: typeof events
  l2?: L2Runner
  dir?: string
}) {
  process.env.DSH_HOME = options.dir ?? freshDir()
  const store = createStore()
  const client = new FakeClient(options.respond ?? (() => ({ kind: 'ok', repos: [repo('a/one'), repo('b/two')] })))
  const timers: Array<() => void> = []
  const current = options.settings ?? settings()
  const engine = new RadarEngine({
    getEvents: () => options.events ?? events,
    settings: () => current,
    client,
    store,
    now: () => NOW,
    setTimer: (handler) => {
      timers.push(handler)
      return timers.length
    },
    clearTimer: () => {},
    log: () => {},
    ...(options.l2 === undefined ? {} : { l2: options.l2 }),
  })
  return { engine, client, store, timers, current }
}

describe('RadarEngine', () => {
  it('produces cards from a session and caches them', async () => {
    const { engine, client, store } = makeEngine({})
    const state = await engine.refresh('s1')
    expect(state.status).toBe('ready')
    expect(state.cards).toHaveLength(2)
    expect(state.cards[0].zh.length).toBeGreaterThan(0)
    expect(state.keywords?.length).toBeGreaterThan(0)
    expect(client.queries.length).toBeGreaterThan(0)
    expect(client.queries.length).toBeLessThanOrEqual(3)

    const cache = await store.cache.read()
    expect(Object.keys(cache.entries)).toHaveLength(1)
  })

  it('does not search again inside the debounce window', async () => {
    const { engine, client } = makeEngine({})
    await engine.refresh('s2')
    const first = client.queries.length
    await engine.refresh('s2')
    expect(client.queries.length).toBe(first)
  })

  it('replays the cache when the network is unreachable', async () => {
    let failing = false
    const { engine, client } = makeEngine({
      respond: () => (failing ? { kind: 'error', message: '网络请求失败：fetch failed' } : { kind: 'ok', repos: [repo('a/one')] }),
    })
    const warm = await engine.refresh('s3')
    expect(warm.status).toBe('ready')

    failing = true
    const before = client.queries.length
    const state = await engine.refreshNow('s3')
    expect(client.queries.length).toBeGreaterThan(before)
    expect(state.status).toBe('offline')
    expect(state.cards.map((card) => card.fullName)).toEqual(['a/one'])
    expect(state.notice).toContain('缓存')
  })

  it('reports rate limiting and schedules a single retry', async () => {
    const { engine, timers } = makeEngine({
      respond: () => ({ kind: 'rateLimited', retryAfterMs: 30_000, message: 'API rate limit exceeded' }),
    })
    const state = await engine.refresh('s4')
    expect(state.status).toBe('rateLimited')
    expect(state.retryAfterMs).toBe(30_000)
    expect(state.notice).toContain('限速')
    expect(timers).toHaveLength(1)
  })

  it('serves the cache without touching GitHub when networking is off', async () => {
    const dir = freshDir()
    const online = makeEngine({ dir, respond: () => ({ kind: 'ok', repos: [repo('c/three')] }) })
    await online.engine.refresh('s5')

    const offline = makeEngine({ dir, settings: settings({ allowNetwork: false }) })
    const state = await offline.engine.refresh('s5')
    expect(offline.client.queries).toHaveLength(0)
    expect(state.status).toBe('ready')
    expect(state.notice).toContain('已关闭联网')
    expect(state.cards.map((card) => card.fullName)).toEqual(['c/three'])
  })

  it('explains itself when networking is off and there is no cache', async () => {
    const { engine } = makeEngine({ settings: settings({ allowNetwork: false }) })
    const state = await engine.refresh('s6')
    expect(state.status).toBe('offline')
    expect(state.notice).toContain('已关闭联网')
  })

  it('keeps only Chinese projects when chineseOnly is on', async () => {
    const { engine } = makeEngine({
      settings: settings({ chineseOnly: true }),
      respond: () => ({
        kind: 'ok',
        repos: [
          repo('zh/one', { description: '一个非常好用的中文接口框架', topics: ['chinese'] }),
          repo('en/two', { description: 'A fast framework', topics: ['web'] }),
        ],
      }),
    })
    const state = await engine.refresh('s7')
    expect(state.cards.map((card) => card.fullName)).toEqual(['zh/one'])
    expect(state.notice).toContain('中文')
  })

  it('dismisses a card and remembers it', async () => {
    const { engine, store } = makeEngine({})
    const state = await engine.refresh('s8')
    const [first] = state.cards
    const after = await engine.dismiss(first.fullName)
    expect(after?.cards.map((card) => card.fullName)).not.toContain(first.fullName)

    const feedback = await store.feedback.read()
    expect(feedback.dismissed[first.fullName]).toBe(NOW)
  })

  it('counts clicks for the ranking boost', async () => {
    const { engine, store } = makeEngine({})
    await engine.recordClick('a/one')
    await engine.recordClick('a/one')
    const feedback = await store.feedback.read()
    expect(feedback.clicked['a/one']).toBe(2)
  })

  it('shows trending repositories when the session has nothing to search for', async () => {
    const { engine, client } = makeEngine({
      events: [] as unknown as typeof events,
      respond: () => ({ kind: 'ok', repos: [repo('alpha/one'), repo('beta/two')] }),
    })
    const state = await engine.refresh('s9')
    expect(state.status).toBe('ready')
    expect(state.trending).toBe(true)
    expect(state.cards).toHaveLength(2)
    expect(state.keywords).toEqual([])
    expect(state.notice).toContain('线索')
    expect(state.cards[0].why).toContain('近期热门')
    // No keywords to search for: the fallback asks GitHub for what is hot,
    // using qualifier-only queries rather than an empty panel.
    expect(client.queries[0]).toContain('pushed:>=')
    expect(client.queries[0]).toContain('stars:')
  })

  it('shows the next batch on refresh instead of the same cards', async () => {
    const pool = Array.from({ length: 12 }, (_, index) => `owner${index}/trending${index}`)
    const { engine } = makeEngine({
      events: [] as unknown as typeof events,
      respond: () => ({ kind: 'ok', repos: pool.map((name) => repo(name)) }),
    })
    const first = await engine.refresh('s9b')
    expect(first.status).toBe('ready')
    const firstNames = first.cards.map((card) => card.fullName)
    expect(firstNames).toHaveLength(5)

    const second = await engine.refreshNow('s9b')
    const secondNames = second.cards.map((card) => card.fullName)
    // ⟳ means "换一批": the fixed daily list is rotated, not repeated.
    expect(second.status).toBe('ready')
    expect(secondNames).toHaveLength(5)
    expect(secondNames.filter((name) => firstNames.includes(name))).toEqual([])
  })

  it('reads a second search page once the first batch is drained', async () => {
    // Two repos per band: the first ⟳ takes them all, the next one has nothing
    // left on page 1 and must ask GitHub for page 2.
    const pool = Array.from({ length: 6 }, (_, index) => `owner${index}/trending${index}`)
    const { engine, client } = makeEngine({
      events: [] as unknown as typeof events,
      respond: () => ({ kind: 'ok', repos: pool.map((name) => repo(name)) }),
    })
    await engine.refresh('s9d')
    await engine.refreshNow('s9d')
    const third = await engine.refreshNow('s9d')
    expect(third.status).toBe('ready')
    expect(client.pages).toContain(2)
  })

  it('serves the trending batch from the cache on the next refresh', async () => {
    const dir = freshDir()
    const first = makeEngine({
      dir,
      events: [] as unknown as typeof events,
      respond: () => ({ kind: 'ok', repos: [repo('trend/one')] }),
    })
    await first.engine.refresh('s9c')

    const second = makeEngine({
      dir,
      events: [] as unknown as typeof events,
      respond: () => ({ kind: 'ok', repos: [] }),
    })
    const state = await second.engine.refresh('s9c')
    expect(state.status).toBe('ready')
    expect(state.trending).toBe(true)
    expect(state.cached).toBe(true)
    expect(second.client.queries).toEqual([])
  })

  it('retries with a relaxed star floor when nothing clears minStars', async () => {
    const { engine, client } = makeEngine({
      respond: (query) =>
        query.includes('stars:>=30')
          ? { kind: 'ok', repos: [] }
          : { kind: 'ok', repos: [repo('small/project', { stargazers_count: 12 })] },
    })
    const state = await engine.refresh('s11')
    expect(state.status).toBe('ready')
    expect(state.cards.map((card) => card.fullName)).toEqual(['small/project'])
    // Every normal query came back empty, then exactly one relaxed retry that
    // drops the star floor (`minStars: 0` leaves no `stars:>=` clause at all).
    expect(client.queries.length).toBeGreaterThan(1)
    expect(client.queries.at(-1)).not.toContain('stars:>=')
  })

  it('upgrades cards to AI summaries when the model answers', async () => {
    const l2: L2Runner = {
      run: async (_cards, _sessionId, onBatch) => {
        onBatch([{ fullName: 'a/one', zh: '模型写的中文一句话' }])
      },
    }
    const { engine } = makeEngine({ l2 })
    await engine.refresh('s10')
    await new Promise((resolve) => setTimeout(resolve, 0))
    const state = await engine.get('s10')
    const card = state.cards.find((item) => item.fullName === 'a/one')
    expect(card?.zh).toBe('模型写的中文一句话')
    expect(card?.zhSource).toBe('llm')
  })

  it('searches the keywords the user edited instead of the extracted ones', async () => {
    const { engine, client, store } = makeEngine({})
    await engine.refresh('s12')
    const extracted = client.queries.slice()

    // A fresh session: `seen` would otherwise filter every already-shown repo
    // out and the manual batch would look empty for the wrong reason.
    const state = await engine.setSignal('s12-manual', { keywords: ['crawler', 'scrapy'] })
    expect(state.status).toBe('ready')
    expect(state.keywords).toEqual(['crawler', 'scrapy'])
    expect(state.keywordsManual).toBe(true)

    const manual = client.queries.slice(extracted.length)
    expect(manual.length).toBeGreaterThan(0)
    expect(manual.every((query) => /crawler|scrapy/.test(query))).toBe(true)
    expect(manual.some((query) => /pandas|fastapi/.test(query))).toBe(false)

    const file = await store.signals.read()
    expect(file.sessions['s12-manual']?.keywords).toEqual(['crawler', 'scrapy'])
  })

  it('drops a keyword and stores the shorter list', async () => {
    const { engine, store } = makeEngine({})
    await engine.setSignal('s13', { keywords: ['alpha', 'beta', 'gamma'] })
    const state = await engine.setSignal('s13', { keywords: ['alpha', 'gamma'] })
    expect(state.keywords).toEqual(['alpha', 'gamma'])
    expect((await store.signals.read()).sessions.s13?.keywords).toEqual(['alpha', 'gamma'])
  })

  it('accepts a pasted error and can clear it again', async () => {
    const { engine, client } = makeEngine({ events: [] as unknown as typeof events })
    const withError = await engine.setSignal('s14', {
      keywords: ['retry'],
      errorText: 'ConnectionError: Max retries exceeded',
    })
    expect(withError.status).toBe('ready')
    expect(withError.errorText).toBe('ConnectionError: Max retries exceeded')
    expect(withError.errorManual).toBe(true)
    // A pasted error with no keywords still searches: the error becomes a
    // category query instead of an empty signal.
    expect(client.queries.some((query) => /retry|in:readme/.test(query))).toBe(true)

    const cleared = await engine.setSignal('s14', { errorText: null })
    expect(cleared.errorText).toBeUndefined()
  })

  it('goes back to the extracted keywords on reset', async () => {
    const { engine, client, store } = makeEngine({})
    await engine.refresh('s15')
    const extractedQueries = client.queries.slice()

    await engine.setSignal('s15', { keywords: ['onlymanual'] })
    const state = await engine.setSignal('s15', { reset: true })
    expect(state.keywordsManual).toBeUndefined()
    expect(state.keywords).not.toEqual(['onlymanual'])
    expect((await store.signals.read()).sessions.s15).toBeUndefined()

    const afterReset = client.queries.slice()
    expect(afterReset.length).toBeGreaterThan(extractedQueries.length)
    expect(afterReset.at(-1)).not.toContain('onlymanual')
  })

  it('caps hand-added keywords at five', async () => {
    const { engine } = makeEngine({})
    const state = await engine.setSignal('s16', { keywords: ['a', 'b', 'c', 'd', 'e', 'f'] })
    expect(state.keywords).toHaveLength(5)
    expect(state.keywords).toEqual(['a', 'b', 'c', 'd', 'e'])
  })
})
