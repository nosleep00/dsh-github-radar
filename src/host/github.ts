/**
 * The GitHub half (S10, S17).
 *
 * One global single-flight queue (concurrency 1, minimum interval between
 * requests), ETag revalidation, rate-limit accounting and the four failure
 * paths the panel knows about: ok / notModified / rateLimited / error.
 */
import type { GitHubRepo, RadarQuota } from './types.js'

export const DEFAULT_BASE_URL = 'https://api.github.com'
export const USER_AGENT = 'dsh-github-radar/0.1.0'
const PER_PAGE = 20
const ANON_INTERVAL_MS = 2_000
const TOKEN_INTERVAL_MS = 1_000
const MIN_RETRY_MS = 1_000
const MAX_RETRY_MS = 15 * 60_000

export type SearchOutcome =
  | { kind: 'ok'; repos: GitHubRepo[]; quota?: RadarQuota; etag?: string }
  | { kind: 'notModified'; quota?: RadarQuota }
  | { kind: 'rateLimited'; retryAfterMs: number; quota?: RadarQuota; message: string }
  | { kind: 'error'; message: string; status?: number }

export interface GithubClientOptions {
  token?: string
  baseUrl?: string
  userAgent?: string
  fetchImpl?: typeof fetch
  /** Overrides the default 2s anonymous / 1s token interval. */
  minIntervalMs?: number
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  /** Undici proxy agent factory; defaults to a lazy `undici` import. */
  proxy?: { url: string; dispatcher: unknown }
}

function headerOf(response: unknown, name: string): string | undefined {
  const headers = (response as { headers?: unknown }).headers
  if (headers === null || headers === undefined) return undefined
  const get = (headers as { get?: (key: string) => string | null }).get
  if (typeof get === 'function') {
    const value = get.call(headers, name)
    return value === null || value === undefined ? undefined : value
  }
  const record = headers as Record<string, string | undefined>
  const direct = record[name] ?? record[name.toLowerCase()]
  return typeof direct === 'string' ? direct : undefined
}

function parseQuota(response: unknown, now: number): RadarQuota | undefined {
  const remainingRaw = headerOf(response, 'x-ratelimit-remaining')
  const limitRaw = headerOf(response, 'x-ratelimit-limit')
  const resetRaw = headerOf(response, 'x-ratelimit-reset')
  const remaining = remainingRaw === undefined ? Number.NaN : Number.parseInt(remainingRaw, 10)
  const limit = limitRaw === undefined ? Number.NaN : Number.parseInt(limitRaw, 10)
  const resetAt = resetRaw === undefined ? Number.NaN : Number.parseInt(resetRaw, 10)
  if (Number.isNaN(remaining) || Number.isNaN(limit)) return undefined
  return {
    remaining,
    limit,
    resetAt: Number.isNaN(resetAt) ? Math.floor(now / 1000) + 60 : resetAt,
  }
}

function retryAfterMs(response: unknown, quota: RadarQuota | undefined, now: number): number {
  const retryAfter = headerOf(response, 'retry-after')
  if (retryAfter !== undefined) {
    const seconds = Number.parseFloat(retryAfter)
    if (Number.isFinite(seconds)) {
      return Math.min(MAX_RETRY_MS, Math.max(MIN_RETRY_MS, Math.round(seconds * 1000)))
    }
    const at = Date.parse(retryAfter)
    if (!Number.isNaN(at)) return Math.min(MAX_RETRY_MS, Math.max(MIN_RETRY_MS, at - now))
  }
  if (quota !== undefined) {
    const wait = quota.resetAt * 1000 - now
    if (Number.isFinite(wait) && wait > 0) return Math.min(MAX_RETRY_MS, Math.max(MIN_RETRY_MS, wait))
  }
  return 60_000
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms)
  })

/** Lazily build an undici ProxyAgent; `undefined` when undici is unavailable. */
export async function createProxyDispatcher(
  proxyUrl: string,
): Promise<unknown | undefined> {
  if (proxyUrl.trim() === '') return undefined
  try {
    // Non-literal specifier: `undici` is optional, so it must not be a build-time
    // dependency of this package's types.
    const specifier = 'undici'
    const undici = (await import(specifier)) as {
      ProxyAgent?: new (options: string) => unknown
    }
    if (typeof undici.ProxyAgent !== 'function') return undefined
    return new undici.ProxyAgent(proxyUrl)
  } catch {
    return undefined
  }
}

export class GithubClient {
  private chain: Promise<unknown> = Promise.resolve()
  private lastStart = 0
  private readonly etags = new Map<string, string>()
  private readonly now: () => number
  private readonly sleep: (ms: number) => Promise<void>
  private readonly fetchImpl: typeof fetch
  private readonly baseUrl: string
  private readonly userAgent: string
  private readonly explicitInterval: number | undefined
  private token: string
  private dispatcher: unknown
  private quota: RadarQuota | undefined

  constructor(options: GithubClientOptions = {}) {
    this.token = (options.token ?? '').trim()
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '')
    this.userAgent = options.userAgent ?? USER_AGENT
    this.now = options.now ?? (() => Date.now())
    this.sleep = options.sleep ?? defaultSleep
    this.explicitInterval = options.minIntervalMs
    this.dispatcher = options.proxy?.dispatcher
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init))
  }

  /** Swap the token without rebuilding the queue. */
  setToken(token: string): void {
    this.token = (token ?? '').trim()
  }

  hasToken(): boolean {
    return this.token !== ''
  }

  /** Attach (or clear) the connection dispatcher used for proxy support. */
  setProxy(dispatcher: unknown): void {
    this.dispatcher = dispatcher
  }

  get minIntervalMs(): number {
    if (this.explicitInterval !== undefined) return this.explicitInterval
    return this.hasToken() ? TOKEN_INTERVAL_MS : ANON_INTERVAL_MS
  }

  /** Last known quota (may be undefined before the first request). */
  get lastQuota(): RadarQuota | undefined {
    return this.quota
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.chain.then(async () => {
      const wait = this.lastStart + this.minIntervalMs - this.now()
      if (wait > 0) await this.sleep(wait)
      this.lastStart = this.now()
      return task()
    })
    // Keep the chain alive even when a task rejects.
    this.chain = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    const headers: Record<string, string> = {
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': this.userAgent,
      ...extra,
    }
    if (this.hasToken()) headers.authorization = `Bearer ${this.token}`
    return headers
  }

  /** `GET /search/repositories` for one query. */
  async search(
    query: string,
    options: { signal?: AbortSignal; page?: number } = {},
  ): Promise<SearchOutcome> {
    const trimmed = query.trim()
    if (trimmed === '') return { kind: 'error', message: '空查询' }
    const page = Number.isFinite(options.page) ? Math.max(1, Math.floor(options.page as number)) : 1
    return this.enqueue(() => this.searchOnce(trimmed, options.signal, true, page))
  }

  private async searchOnce(
    query: string,
    signal: AbortSignal | undefined,
    allowRetry: boolean,
    page = 1,
  ): Promise<SearchOutcome> {
    const pageParam = page > 1 ? `&page=${page}` : ''
    const url = `${this.baseUrl}/search/repositories?q=${encodeURIComponent(query)}&sort=stars&order=desc&per_page=${PER_PAGE}${pageParam}`
    // Page 2 has its own ETag: reusing page 1's validator would hand back 304.
    const etagKey = page > 1 ? `${query}\u0000p${page}` : query
    const etag = this.etags.get(etagKey)
    const init: Record<string, unknown> = {
      method: 'GET',
      headers: this.headers(etag === undefined ? {} : { 'if-none-match': etag }),
    }
    if (signal !== undefined) init.signal = signal
    if (this.dispatcher !== undefined) init.dispatcher = this.dispatcher

    let response: unknown
    try {
      response = await this.fetchImpl(url, init as RequestInit)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { kind: 'error', message: `网络请求失败：${message}` }
    }

    const status = typeof (response as { status?: unknown }).status === 'number'
      ? (response as { status: number }).status
      : 0
    const quota = parseQuota(response, this.now())
    if (quota !== undefined) this.quota = quota

    if (status === 304) return { kind: 'notModified', ...(quota === undefined ? {} : { quota }) }

    if (status === 403 || status === 429) {
      const resetHint = quota === undefined ? '' : `（额度 ${Math.max(0, quota.remaining)}/${quota.limit}）`
      return {
        kind: 'rateLimited',
        retryAfterMs: retryAfterMs(response, quota, this.now()),
        message: `GitHub 限速${resetHint}`,
        ...(quota === undefined ? {} : { quota }),
      }
    }

    if (status >= 500) {
      if (allowRetry) {
        await this.sleep(1_000)
        this.lastStart = this.now()
        return this.searchOnce(query, signal, false, page)
      }
      return { kind: 'error', message: `GitHub 服务异常（HTTP ${status}）`, status }
    }

    if (status !== 200) {
      const message = await this.readMessage(response)
      return {
        kind: 'error',
        message: message === '' ? `GitHub 返回 HTTP ${status}` : `GitHub 返回 HTTP ${status}：${message}`,
        status,
      }
    }

    let payload: unknown
    try {
      payload = await (response as { json: () => Promise<unknown> }).json()
    } catch {
      return { kind: 'error', message: 'GitHub 返回的内容无法解析', status }
    }

    const items = (payload as { items?: unknown }).items
    const repos = Array.isArray(items)
      ? (items.filter((item) => item !== null && typeof item === 'object') as GitHubRepo[])
      : []
    const newEtag = headerOf(response, 'etag')
    if (newEtag !== undefined) this.etags.set(etagKey, newEtag)
    return { kind: 'ok', repos, ...(quota === undefined ? {} : { quota }), ...(newEtag === undefined ? {} : { etag: newEtag }) }
  }

  private async readMessage(response: unknown): Promise<string> {
    try {
      const json = (response as { json?: () => Promise<unknown> }).json
      if (typeof json === 'function') {
        const payload = (await json.call(response)) as { message?: unknown }
        if (typeof payload.message === 'string') return payload.message.slice(0, 120)
      }
    } catch {
      // fall through
    }
    return ''
  }

  /** `GET /rate_limit` — used by the settings page's 「测试连接」 button. */
  async rateLimit(): Promise<{ ok: boolean; quota?: RadarQuota; message?: string }> {
    return this.enqueue(async () => {
      const init: Record<string, unknown> = { method: 'GET', headers: this.headers() }
      if (this.dispatcher !== undefined) init.dispatcher = this.dispatcher
      try {
        const response = (await this.fetchImpl(`${this.baseUrl}/rate_limit`, init as RequestInit)) as {
          status?: number
          json?: () => Promise<unknown>
        }
        const status = typeof response.status === 'number' ? response.status : 0
        if (status !== 200) {
          return { ok: false, message: `HTTP ${status}` }
        }
        const payload = (await response.json?.()) as
          | { resources?: { search?: { remaining?: number; limit?: number; reset?: number } } }
          | undefined
        const search = payload?.resources?.search
        if (search === undefined) return { ok: true }
        const quota: RadarQuota = {
          remaining: typeof search.remaining === 'number' ? search.remaining : 0,
          limit: typeof search.limit === 'number' ? search.limit : 0,
          resetAt: typeof search.reset === 'number' ? search.reset : 0,
        }
        this.quota = quota
        return { ok: true, quota }
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) }
      }
    })
  }
}
