import { describe, expect, it } from 'vitest'
import {
  buildQueries,
  buildTrendingQueries,
  errorExcerpt,
  mapKeyword,
  queryHash,
  stableHash,
  trendingHash,
} from '../src/host/query.js'
import type { RadarSignal } from '../src/host/types.js'

function signal(over: Partial<RadarSignal> = {}): RadarSignal {
  return {
    sessionId: 's1',
    keywords: ['fastapi'],
    languages: [],
    turnedAt: 0,
    ...over,
  }
}

const options = { minStars: 30, languages: [], chineseOnly: false, maxQueries: 3 }

describe('buildQueries', () => {
  it('turns a keyword into a scoped search with the star floor', () => {
    const [query] = buildQueries(signal(), options)
    expect(query).toContain('in:name,description,topics')
    expect(query).toContain('stars:>=30')
    expect(query).toContain('fastapi')
  })

  it('turns a connection error into a retry-library query', () => {
    const queries = buildQueries(
      signal({ errorText: 'ConnectionError: Max retries exceeded with url: /api/users' }),
      options,
    )
    expect(queries[0]).toContain('retry')
    expect(queries[0]).toContain('in:name,description,topics')
    expect(queries.some((query) => query.includes('in:readme'))).toBe(false)
    expect(queries.length).toBeLessThanOrEqual(3)
  })

  it('searches the package named by an import error', () => {
    const queries = buildQueries(
      signal({ errorText: "ModuleNotFoundError: No module named 'pydantic'" }),
      options,
    )
    expect(queries[0]).toContain('pydantic')
  })

  it('falls back to a readme phrase for an unrecognised error', () => {
    const queries = buildQueries(signal({ errorText: 'Error: something weird happened here' }), options)
    expect(queries[0]).toContain('in:readme')
    expect(queries[0].startsWith('"')).toBe(true)
  })

  it('caps the query count at three', () => {
    const queries = buildQueries(
      signal({ keywords: ['fastapi', 'pandas', 'redis', 'kafka', 'grpc'] }),
      options,
    )
    expect(queries.length).toBe(3)
  })

  it('applies a language clause only for a single preferred language', () => {
    const one = buildQueries(signal(), { ...options, languages: ['Python'] })
    expect(one[0]).toContain('language:Python')
    const two = buildQueries(signal(), { ...options, languages: ['Python', 'TypeScript'] })
    expect(two[0]).not.toContain('language:')
  })

  it('reserves a slot for a Chinese-topic query when chineseOnly is on', () => {
    const queries = buildQueries(signal(), { ...options, chineseOnly: true })
    expect(queries.some((query) => query.startsWith('topic:chinese'))).toBe(true)
    expect(queries.length).toBeLessThanOrEqual(3)
  })

  it('returns nothing without keywords or an error excerpt', () => {
    expect(buildQueries(signal({ keywords: [] }), options)).toEqual([])
  })

  it('dedupes queries that normalise to the same search', () => {
    const queries = buildQueries(signal({ keywords: ['FastAPI', 'fastapi'] }), options)
    expect(queries.length).toBe(1)
  })
})

describe('buildTrendingQueries', () => {
  const now = Date.UTC(2026, 10, 17)

  it('asks for recently active popular repositories', () => {
    const queries = buildTrendingQueries({ minStars: 30, languages: [], chineseOnly: false, now })
    expect(queries).toHaveLength(3)
    // Star *bands*, each with its own recency window: `sort=stars` on an
    // open-ended query returns 500k-star evergreen lists instead of trending
    // projects, and one band would return five repos on the same ceiling.
    expect(queries[0]).toContain('stars:1000..2999')
    expect(queries[0]).toContain('pushed:>=2026-11-03')
    expect(queries[1]).toContain('stars:3000..9999')
    expect(queries[1]).toContain('pushed:>=2026-11-07')
    expect(queries[2]).toContain('stars:10000..60000')
    expect(queries[2]).toContain('pushed:>=2026-11-10')
  })

  it('keeps a real popularity floor even when minStars is tiny', () => {
    const [query] = buildTrendingQueries({ minStars: 1, languages: [], chineseOnly: false, now })
    expect(query).toContain('stars:1000..2999')
  })

  it('raises the whole ladder with minStars', () => {
    const [query] = buildTrendingQueries({ minStars: 500, languages: [], chineseOnly: false, now })
    expect(query).toContain('stars:5000..14999')
  })

  it('respects a single preferred language and chineseOnly', () => {
    const queries = buildTrendingQueries({
      minStars: 30,
      languages: ['TypeScript'],
      chineseOnly: true,
      now,
    })
    expect(queries[0]).toContain('language:TypeScript')
    expect(queries[0]).toContain('topic:chinese')
  })

  it('rolls the cache hash over daily but not within a day', () => {
    const base = { minStars: 30, languages: [], chineseOnly: false }
    expect(trendingHash({ ...base, now })).toBe(trendingHash({ ...base, now: now + 3_600_000 }))
    expect(trendingHash({ ...base, now })).not.toBe(trendingHash({ ...base, now: now + 2 * 86_400_000 }))
  })
})

describe('errorExcerpt', () => {
  it('keeps a short, quotable fragment', () => {
    const excerpt = errorExcerpt('TypeError: Cannot read properties of undefined (reading "map")')
    expect(excerpt.length).toBeGreaterThan(0)
    expect(excerpt.length).toBeLessThanOrEqual(80)
  })

  it('handles missing input', () => {
    expect(errorExcerpt(undefined)).toBe('')
    expect(errorExcerpt('')).toBe('')
  })
})

describe('keyword mapping', () => {
  it('maps a Chinese tech word to an English search term', () => {
    const mapped = mapKeyword('智能体')
    expect(mapped).toMatch(/^[a-z0-9-]+$/)
  })

  it('leaves an English keyword alone', () => {
    expect(mapKeyword('fastapi')).toBe('fastapi')
  })
})

describe('hashing', () => {
  it('is stable and changes with the payload', () => {
    expect(stableHash('abc')).toBe(stableHash('abc'))
    expect(stableHash('abc')).not.toBe(stableHash('abd'))
  })

  it('produces a compact cache key', () => {
    const key = queryHash(signal(), options)
    expect(key).toMatch(/^q[a-z0-9]+$/)
    expect(queryHash(signal({ keywords: ['redis'] }), options)).not.toBe(key)
  })
})
