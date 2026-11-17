import { describe, expect, it } from 'vitest'
import { GithubClient } from '../src/host/github.js'
import type { GitHubRepo } from '../src/host/types.js'

interface FakeResponse {
  status: number
  headers: { get: (name: string) => string | undefined }
  json: () => Promise<unknown>
}

function response(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): FakeResponse {
  const lower: Record<string, string> = {}
  for (const [key, value] of Object.entries(headers)) lower[key.toLowerCase()] = value
  return {
    status,
    headers: { get: (name: string) => lower[name.toLowerCase()] },
    json: async () => body,
  }
}

function repo(full_name: string): GitHubRepo {
  return {
    full_name,
    html_url: `https://github.com/${full_name}`,
    description: 'desc',
    topics: ['llm'],
    language: 'Python',
    stargazers_count: 1_234,
    pushed_at: new Date().toISOString(),
    archived: false,
  }
}

interface Call {
  url: string
  init: { headers: Record<string, string>; signal?: AbortSignal }
}

function clientWith(responses: FakeResponse[]): { client: GithubClient; calls: Call[] } {
  const calls: Call[] = []
  let index = 0
  const client = new GithubClient({
    minIntervalMs: 0,
    sleep: async () => {},
    fetchImpl: (async (url: string, init: Call['init']) => {
      calls.push({ url: String(url), init })
      const next = responses[Math.min(index, responses.length - 1)]
      index += 1
      return next
    }) as unknown as typeof fetch,
  })
  return { client, calls }
}

describe('GithubClient.search', () => {
  it('requests the search API with the required headers and returns repos', async () => {
    const { client, calls } = clientWith([
      response(
        200,
        { items: [repo('a/one'), repo('b/two')] },
        { etag: 'W/"abc"', 'x-ratelimit-remaining': '7', 'x-ratelimit-limit': '10', 'x-ratelimit-reset': '1700000060' },
      ),
    ])
    const outcome = await client.search('fastapi in:name,description,topics stars:>=30')
    expect(outcome.kind).toBe('ok')
    if (outcome.kind !== 'ok') return
    expect(outcome.repos.map((item) => item.full_name)).toEqual(['a/one', 'b/two'])
    expect(outcome.quota?.remaining).toBe(7)
    expect(outcome.quota?.limit).toBe(10)

    const [call] = calls
    expect(call.url).toContain('/search/repositories?q=')
    expect(call.url).toContain('sort=stars')
    expect(call.url).toContain('per_page=20')
    expect(call.init.headers.accept).toBe('application/vnd.github+json')
    expect(call.init.headers['x-github-api-version']).toBe('2022-11-28')
    expect(call.init.headers['user-agent']).toContain('dsh-github-radar')
    expect(call.init.headers.authorization).toBeUndefined()
  })

  it('asks for a later page with its own ETag', async () => {
    const { client, calls } = clientWith([
      response(200, { items: [repo('a/one')] }, { etag: 'W/"p1"' }),
      response(200, { items: [repo('b/two')] }, { etag: 'W/"p2"' }),
      response(304, {}),
    ])
    await client.search('redis')
    const second = await client.search('redis', { page: 2 })
    expect(second.kind).toBe('ok')
    expect(calls[1].url).toContain('&page=2')
    expect(calls[1].init.headers['if-none-match']).toBeUndefined()
    // A second page 2 request revalidates against page 2's ETag, not page 1's.
    await client.search('redis', { page: 2 })
    expect(calls[2].init.headers['if-none-match']).toBe('W/"p2"')
  })

  it('sends the token as a bearer header and shortens the interval', async () => {
    const { client, calls } = clientWith([response(200, { items: [] })])
    client.setToken('ghp_test')
    expect(client.hasToken()).toBe(true)
    await client.search('redis')
    expect(calls[0].init.headers.authorization).toBe('Bearer ghp_test')
    expect(new GithubClient({ token: 'x' }).minIntervalMs).toBe(1_000)
    expect(new GithubClient().minIntervalMs).toBe(2_000)
  })

  it('revalidates with the stored etag and treats 304 as notModified', async () => {
    const { client, calls } = clientWith([
      response(200, { items: [repo('a/one')] }, { etag: 'W/"v1"' }),
      response(304, {}),
    ])
    await client.search('redis')
    const second = await client.search('redis')
    expect(second.kind).toBe('notModified')
    expect(calls[1].init.headers['if-none-match']).toBe('W/"v1"')
  })

  it('maps 403 to rateLimited with a retry hint instead of retrying', async () => {
    const reset = Math.floor(Date.now() / 1000) + 30
    const { client, calls } = clientWith([
      response(
        403,
        { message: 'API rate limit exceeded' },
        { 'x-ratelimit-remaining': '0', 'x-ratelimit-limit': '10', 'x-ratelimit-reset': String(reset) },
      ),
    ])
    const outcome = await client.search('redis')
    expect(outcome.kind).toBe('rateLimited')
    if (outcome.kind !== 'rateLimited') return
    expect(outcome.retryAfterMs).toBeGreaterThanOrEqual(1_000)
    expect(outcome.retryAfterMs).toBeLessThanOrEqual(15 * 60_000)
    expect(calls).toHaveLength(1)
  })

  it('retries a 5xx exactly once', async () => {
    const { client, calls } = clientWith([
      response(502, { message: 'bad gateway' }),
      response(200, { items: [repo('a/one')] }),
    ])
    const outcome = await client.search('redis')
    expect(outcome.kind).toBe('ok')
    expect(calls).toHaveLength(2)
  })

  it('reports a transport failure as an error result', async () => {
    const client = new GithubClient({
      minIntervalMs: 0,
      fetchImpl: (async () => {
        throw new Error('getaddrinfo ENOTFOUND api.github.com')
      }) as unknown as typeof fetch,
    })
    const outcome = await client.search('redis')
    expect(outcome.kind).toBe('error')
    if (outcome.kind !== 'error') return
    expect(outcome.message).toContain('网络请求失败')
  })

  it('serialises concurrent searches (single flight)', async () => {
    let active = 0
    let maxActive = 0
    const client = new GithubClient({
      minIntervalMs: 0,
      fetchImpl: (async () => {
        active += 1
        maxActive = Math.max(maxActive, active)
        await new Promise((resolve) => setTimeout(resolve, 5))
        active -= 1
        return response(200, { items: [] })
      }) as unknown as typeof fetch,
    })
    await Promise.all([client.search('a'), client.search('b'), client.search('c')])
    expect(maxActive).toBe(1)
  })
})

describe('GithubClient.rateLimit', () => {
  it('reads the search quota from /rate_limit', async () => {
    const { client, calls } = clientWith([
      response(200, { resources: { search: { remaining: 28, limit: 30, reset: 1_700_000_000 } } }),
    ])
    const result = await client.rateLimit()
    expect(result.ok).toBe(true)
    expect(result.quota?.remaining).toBe(28)
    expect(result.quota?.limit).toBe(30)
    expect(calls[0].url).toContain('/rate_limit')
  })

  it('reports a bad token without throwing', async () => {
    const { client } = clientWith([response(401, { message: 'Bad credentials' })])
    const result = await client.rateLimit()
    expect(result.ok).toBe(false)
    expect(result.message).toContain('401')
  })
})
