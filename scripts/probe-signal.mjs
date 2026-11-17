#!/usr/bin/env node
/** 本地调参：打印给定会话片段抽出的关键词、报错行与将要发往 GitHub 的查询。 */
import { extractSignal } from '../dist/host/signals.js'
import { buildQueries, errorExcerpt } from '../dist/host/query.js'

const sample = [
  '我在用 python 写一个网页爬虫，别的都能跑，但有个页面老是报错：ConnectionError: Max retries exceeded with url: /api/users',
  'pip install 也特别慢，换源之后好了点。',
  '另外 opentelemetry 的接入想看看有没有现成库，最好是中文文档，顺便想加点自动重试和日志。',
]

const events = [
  { type: 'user/message', time: Date.now() - 60_000, data: { message: { content: [{ type: 'text', text: sample[0] }] } } },
  { type: 'user/message', time: Date.now() - 30_000, data: { message: { content: [{ type: 'text', text: sample[1] }] } } },
  { type: 'user/message', time: Date.now() - 5_000, data: { message: { content: [{ type: 'text', text: sample[2] }] } } },
]

const signal = extractSignal('probe', events, {})
console.log('keywords:', JSON.stringify(signal.keywords))
console.log('errorText:', JSON.stringify(signal.errorText))
console.log('errorExcerpt:', JSON.stringify(errorExcerpt(signal.errorText)))
console.log(
  'queries:',
  JSON.stringify(
    buildQueries(signal, { minStars: 30, languages: [], chineseOnly: false, maxQueries: 3 }),
    null,
    2,
  ),
)
console.log(
  'queries (zh):',
  JSON.stringify(
    buildQueries(signal, { minStars: 30, languages: [], chineseOnly: true, maxQueries: 3 }),
    null,
    2,
  ),
)
