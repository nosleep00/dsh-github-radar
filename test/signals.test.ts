import { describe, expect, it } from 'vitest'
import {
  extractErrorText,
  extractKeywords,
  extractSignal,
  isSignalEmpty,
  signalHash,
} from '../src/host/signals.js'

const NOW = Date.UTC(2026, 0, 1)

describe('extractKeywords', () => {
  it('finds English tech terms in Chinese prose', () => {
    const keywords = extractKeywords([
      '我在用 fastapi 写接口，pandas 读 csv 的时候特别慢，想换个方式',
    ])
    expect(keywords.length).toBeGreaterThan(0)
    expect(keywords.length).toBeLessThanOrEqual(5)
    const joined = keywords.join(' ').toLowerCase()
    expect(joined).toContain('fastapi')
  })

  it('maps Chinese tech words onto English search terms', () => {
    const keywords = extractKeywords(['想做一个智能体，需要向量数据库和检索增强'])
    expect(keywords.length).toBeGreaterThan(0)
    expect(keywords.every((keyword) => /^[\x20-\x7e]+$/.test(keyword))).toBe(true)
  })

  it('ignores code blocks, urls and paths', () => {
    const keywords = extractKeywords([
      '看一下 https://example.com/very/long/path C:\\Users\\user\\app.log ```js const x = require("left-pad") ```',
    ])
    expect(keywords.join(' ')).not.toContain('example.com')
  })

  it('returns an empty list for empty input', () => {
    expect(extractKeywords([])).toEqual([])
    expect(extractKeywords(['   '])).toEqual([])
  })
})

describe('extractErrorText', () => {
  it('keeps a short error line', () => {
    const text = extractErrorText([
      '跑起来了，但是报错 TypeError: Cannot read properties of undefined (reading "map")',
    ])
    expect(text).toContain('TypeError')
    expect((text ?? '').length).toBeLessThanOrEqual(200)
  })

  it('finds python tracebacks', () => {
    const text = extractErrorText(['Traceback (most recent call last): ConnectionError: Max retries exceeded'])
    expect(text).toBeTruthy()
  })

  it('returns undefined when there is no error', () => {
    expect(extractErrorText(['今天天气不错，帮我写个脚本'])).toBeUndefined()
  })

  it('drops the chinese question tail after a pasted traceback', () => {
    const text = extractErrorText([
      'ConnectionError: Max retries exceeded，pip install 也特别慢，想找点能自动重试的库。',
    ])
    expect(text).toBe('ConnectionError: Max retries exceeded')
  })
})

describe('extractSignal', () => {
  const events = [
    {
      type: 'user/message',
      time: NOW - 1_000,
      data: {
        message: {
          role: 'user',
          content: [{ type: 'text', text: '帮我看看 fastapi 这个接口为什么 ConnectionError: Max retries exceeded' }],
        },
      },
    },
    {
      type: 'assistant/message',
      time: NOW,
      data: { message: { content: [{ type: 'text', text: '这个问题通常和连接池有关。' }] } },
    },
  ]

  it('builds a signal from the last user messages', () => {
    const signal = extractSignal('s1', events, { now: NOW })
    expect(signal.sessionId).toBe('s1')
    expect(signal.keywords.length).toBeGreaterThan(0)
    expect(signal.errorText).toContain('ConnectionError')
    expect(signal.turnedAt).toBe(NOW - 1_000)
  })

  it('ignores tool results and thinking blocks', () => {
    const noisy = [
      {
        type: 'user/message',
        time: NOW,
        data: {
          message: {
            content: [
              { type: 'tool_result', content: 'x'.repeat(500) },
              { type: 'thinking', thinking: 'secret reasoning about fastapi' },
              { type: 'text', text: '我想研究一下向量数据库' },
            ],
          },
        },
      },
    ]
    const signal = extractSignal('s1', noisy, { now: NOW })
    expect(signal.keywords.join(' ')).not.toContain('secret')
  })

  it('only reads the tail of a long conversation', () => {
    const long = Array.from({ length: 30 }, (_, index) => ({
      type: 'user/message',
      time: NOW - (30 - index) * 1_000,
      data: { message: { content: [{ type: 'text', text: `第 ${index} 轮聊的是 kafka${index}` }] } },
    }))
    const signal = extractSignal('s1', long, { now: NOW })
    expect(signal.keywords.join(' ')).not.toContain('kafka0')
  })

  it('reports an empty signal for an empty session', () => {
    expect(isSignalEmpty(extractSignal('s1', [], { now: NOW }))).toBe(true)
  })

  it('hashes stably and changes with content', () => {
    const a = extractSignal('s1', events, { now: NOW })
    const b = extractSignal('s1', events, { now: NOW })
    expect(signalHash(a)).toBe(signalHash(b))
    expect(signalHash({ ...a, keywords: ['redis'] })).not.toBe(signalHash(a))
  })

  it('ignores the harness runtime context wrapped around a user message', () => {
    // Real shape: the harness prepends/appends runtime metadata to the message.
    const noisy = [
      'Current runtime context. This snapshot supersedes earlier snapshots.',
      '',
      'Current working directory: "E:\\work\\demo".',
      '',
      'Current DSH file policy: danger-full-access.',
      'Approval prompts are disabled in this session.',
      '',
      'Time sampled while preparing turn 1, step 477: 2026-11-13T15:32:29+08:00[Asia/Shanghai]',
      'Browser time zone for this request: Asia/Shanghai. Interpret otherwise-unqualified dates in this zone.',
      'Elapsed since the preceding step context: 48m 53s.',
      '',
      '<acp tokens="34" type="text">我在用 python 写爬虫，pip install 特别慢，想要重试和代理支持</acp>',
    ].join('\n')
    const signal = extractSignal(
      's1',
      [{ type: 'user/message', time: NOW, data: { message: { content: [{ type: 'text', text: noisy }] } } }],
      { now: NOW },
    )
    const joined = signal.keywords.join(' ').toLowerCase()
    expect(joined).not.toContain('asia')
    expect(joined).not.toContain('zone')
    expect(joined).not.toContain('current')
    expect(joined).not.toContain('interpret')
    expect(joined).toContain('crawler')
  })

  it('ignores release artefacts, versions and dotted type names', () => {
    // Real shape: a build/log oriented message from a live session.
    const signal = extractSignal(
      's2',
      [
        {
          type: 'user/message',
          time: NOW,
          data: {
            message: {
              content: [
                {
                  type: 'text',
                  text: '> 升到 1.1.0 并重新出一个便携包（SandianshuiLauncher-1.1.0-win-x64.zip），顺便修 System.Text.UTF8Encoding 那个报错',
                },
              ],
            },
          },
        },
      ],
      { now: NOW },
    )
    const joined = signal.keywords.join(' ').toLowerCase()
    expect(joined).not.toContain('win-x64')
    expect(joined).not.toContain('1.1.0')
    expect(joined).not.toContain('sandianshuilauncher')
    expect(joined).not.toContain('system.text')
  })
})
