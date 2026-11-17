import { describe, expect, it } from 'vitest'
import {
  extractJsonArray,
  parseSummaryResponse,
  summarizeCards,
  type LlmLike,
  type SummaryRow,
} from '../src/host/summarize.js'
import type { PromptRepo } from '../src/host/prompts.js'

const expected: PromptRepo[] = [
  { fullName: 'fastapi/fastapi', description: 'FastAPI framework', topics: ['api'], language: 'Python', stars: 80_000 },
  { fullName: 'redis/redis', description: 'In-memory store', topics: ['database'], language: 'C', stars: 65_000 },
]

describe('extractJsonArray', () => {
  it('reads a bare array', () => {
    expect(extractJsonArray('[{"a":1}]')).toHaveLength(1)
  })

  it('strips markdown fences', () => {
    expect(extractJsonArray('```json\n[{"a":1}]\n```')).toHaveLength(1)
  })

  it('gives up on prose without an array', () => {
    expect(extractJsonArray('抱歉，我无法完成')).toBeUndefined()
    expect(extractJsonArray('[not json]')).toBeUndefined()
  })

  it('salvages the rows of an answer cut off by the token limit', () => {
    const rows = extractJsonArray(
      '[{"fullName":"a/b","zh":"一句话"},{"fullName":"c/d","zh":"另一句"},{"fullName":"e/f","zh":"被截',
    )
    expect(rows).toEqual([
      { fullName: 'a/b', zh: '一句话' },
      { fullName: 'c/d', zh: '另一句' },
    ])
  })

  it('keeps the good rows when one row has a raw newline inside a string', () => {
    const rows = extractJsonArray(
      '[{"fullName":"a/b","zh":"第一句"},{"fullName":"c/d","zh":"换\n行"},{"fullName":"e/f","zh":"第三句"}]',
    )
    expect(rows).toEqual([
      { fullName: 'a/b', zh: '第一句' },
      { fullName: 'c/d', zh: '换 行' },
      { fullName: 'e/f', zh: '第三句' },
    ])
  })
})

describe('parseSummaryResponse', () => {
  it('accepts a valid answer', () => {
    const rows = parseSummaryResponse(
      JSON.stringify([
        { fullName: 'fastapi/fastapi', zh: '一个高性能的 Python 接口框架', why: '接口开发快' },
        { fullName: 'redis/redis', zh: '内存数据库，做缓存和队列都很稳', why: '缓存首选' },
      ]),
      expected,
    )
    expect(rows).toHaveLength(2)
    expect(rows[0].zh).toContain('接口')
    expect(rows[0].why).toBe('接口开发快')
  })

  it('drops rows for repositories that were not asked about', () => {
    const rows = parseSummaryResponse(
      JSON.stringify([{ fullName: 'evil/repo', zh: '一个和问题无关的项目' }]),
      expected,
    )
    expect(rows).toHaveLength(0)
  })

  it('drops rows that are not Chinese', () => {
    const rows = parseSummaryResponse(
      JSON.stringify([{ fullName: 'fastapi/fastapi', zh: 'A fast Python framework for APIs' }]),
      expected,
    )
    expect(rows).toHaveLength(0)
  })

  it('drops rows that smuggle in a URL', () => {
    const rows = parseSummaryResponse(
      JSON.stringify([{ fullName: 'fastapi/fastapi', zh: '一个接口框架，详见 https://example.com' }]),
      expected,
    )
    expect(rows).toHaveLength(0)
  })

  it('caps the length of the generated line', () => {
    const rows = parseSummaryResponse(
      JSON.stringify([{ fullName: 'fastapi/fastapi', zh: '快' .repeat(200) }]),
      expected,
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].zh.length).toBeLessThanOrEqual(60)
  })

  it('drops a non-Chinese why but keeps the line', () => {
    const rows = parseSummaryResponse(
      JSON.stringify([{ fullName: 'redis/redis', zh: '内存数据库', why: 'great for caching' }]),
      expected,
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].why).toBeUndefined()
  })
})

function llmReturning(answer: string, log: string[] = []): LlmLike {
  return {
    stream: async function* (options: Record<string, unknown>) {
      log.push(JSON.stringify(options.messages))
      yield { text: answer.slice(0, 10) }
      yield { text: answer.slice(10) }
    },
  }
}

describe('summarizeCards', () => {
  it('returns one Chinese line per repository', async () => {
    const answer = JSON.stringify([
      { fullName: 'fastapi/fastapi', zh: '一个高性能的 Python 接口框架', why: '接口开发快' },
      { fullName: 'redis/redis', zh: '内存数据库，做缓存和队列都很稳', why: '缓存首选' },
    ])
    const batches: SummaryRow[][] = []
    const result = await summarizeCards(expected, {
      llm: llmReturning(answer),
      onBatch: (rows) => batches.push(rows),
    })
    expect(result['fastapi/fastapi']).toContain('接口')
    expect(result['redis/redis']).toContain('缓存')
    expect(batches).toHaveLength(1)
  })

  it('never throws when the model fails', async () => {
    const llm: LlmLike = {
      stream: async function* () {
        throw new Error('model exploded')
      },
    }
    const result = await summarizeCards(expected, { llm, log: () => {} })
    expect(result).toEqual({})
  })

  it('reuses a cached line instead of asking again', async () => {
    let calls = 0
    const llm: LlmLike = {
      stream: async function* () {
        calls += 1
        yield { text: '[]' }
      },
    }
    const result = await summarizeCards(expected, {
      llm,
      cachedZh: (repo) => (repo.fullName === 'redis/redis' ? '缓存里的旧结论' : undefined),
      log: () => {},
    })
    expect(result['redis/redis']).toBe('缓存里的旧结论')
    expect(calls).toBe(1)
  })

  it('splits more than five repositories into several batches', async () => {
    const many: PromptRepo[] = Array.from({ length: 7 }, (_, index) => ({
      fullName: `o${index}/r${index}`,
      description: 'desc',
      topics: [],
      language: 'Go',
      stars: 100,
    }))
    const prompts: string[] = []
    const llm: LlmLike = {
      stream: async function* (options: Record<string, unknown>) {
        prompts.push(JSON.stringify(options.messages))
        const asked = String(JSON.stringify(options.messages)).match(/o\d\/r\d/g) ?? []
        const unique = Array.from(new Set(asked))
        yield {
          text: JSON.stringify(unique.map((name) => ({ fullName: name, zh: `这是 ${name} 的中文说明` }))),
        }
      },
    }
    const result = await summarizeCards(many, { llm, log: () => {} })
    expect(Object.keys(result)).toHaveLength(7)
    expect(prompts.length).toBeGreaterThan(1)
  })
})
