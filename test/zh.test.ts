import { describe, expect, it } from 'vitest'
import {
  chineseRatio,
  looksChinese,
  recencyText,
  starText,
  templateSummary,
  truncate,
  whyText,
  zhLanguage,
  zhTopics,
} from '../src/host/zh.js'
import type { GitHubRepo } from '../src/host/types.js'

const NOW = Date.UTC(2026, 5, 1)
const DAY = 86_400_000

function repo(over: Partial<GitHubRepo> & { full_name?: string } = {}): GitHubRepo {
  return {
    full_name: 'acme/tool',
    html_url: 'https://github.com/acme/tool',
    description: 'A tiny cache library',
    topics: ['cache', 'performance'],
    language: 'TypeScript',
    stargazers_count: 2_400,
    pushed_at: new Date(NOW - 3 * DAY).toISOString(),
    archived: false,
    fork: false,
    ...over,
  }
}

describe('chinese detection', () => {
  it('measures the CJK ratio of a description', () => {
    expect(chineseRatio('一个很快的缓存库')).toBeGreaterThan(0.8)
    expect(chineseRatio('a fast cache library')).toBe(0)
    expect(chineseRatio('')).toBe(0)
  })

  it('treats a mostly-Chinese description as Chinese', () => {
    expect(looksChinese('一个很快的缓存库')).toBe(true)
    expect(looksChinese('A fast cache library')).toBe(false)
    expect(looksChinese('Fast 缓存 cache 库')).toBe(false)
  })
})

describe('formatting', () => {
  it('truncates with an ellipsis', () => {
    expect(truncate('abcdef', 4)).toHaveLength(4)
    expect(truncate('abc', 10)).toBe('abc')
  })

  it('formats stars in units a reader can scan', () => {
    expect(starText(38_200)).toContain('万星')
    expect(starText(2_400)).toContain('千星')
    expect(starText(120)).toBe('120 星')
  })

  it('formats recency in Chinese', () => {
    expect(recencyText(new Date(NOW).toISOString(), NOW)).toBe('今天有更新')
    expect(recencyText(new Date(NOW - DAY).toISOString(), NOW)).toBe('昨天更新')
    expect(recencyText(new Date(NOW - 5 * DAY).toISOString(), NOW)).toBe('5 天前更新')
    expect(recencyText(undefined, NOW)).toBe('')
  })

  it('translates topics and languages', () => {
    expect(zhTopics(['cache', 'llm', 'unknown-topic'])).toEqual(['缓存', '大语言模型'])
    expect(zhLanguage('Python')).toBeTruthy()
    expect(zhLanguage(null)).toBe('')
  })
})

describe('templateSummary', () => {
  it('uses a Chinese description verbatim when there is one', () => {
    const line = templateSummary(repo({ description: '一个极快的多语言分词库' }), NOW)
    expect(line).toBe('一个极快的多语言分词库')
  })

  it('otherwise composes topic, language, stars and recency in Chinese', () => {
    const line = templateSummary(repo(), NOW)
    expect(line).toContain('缓存')
    expect(line).toContain('TypeScript')
    expect(line).toContain('星')
    expect(line).toContain('更新')
  })

  it('stays within the card budget', () => {
    const long = templateSummary(
      repo({ description: 'x'.repeat(200), topics: ['cache', 'performance', 'cli', 'llm'] }),
      NOW,
    )
    expect(long.length).toBeLessThanOrEqual(60)
  })
})

describe('whyText', () => {
  it('names the error it matched', () => {
    expect(whyText('error', 'ConnectionError')).toContain('ConnectionError')
  })

  it('names the keyword it matched', () => {
    expect(whyText('keyword', 'fastapi')).toContain('fastapi')
  })

  it('falls back to a generic line', () => {
    expect(whyText('fallback')).toBeTruthy()
  })
})
