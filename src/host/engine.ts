/**
 * The radar engine: one state machine per session (S08, S12, S14–S21).
 *
 * Flow for a refresh:
 *   session events -> signal -> queries -> GitHub -> candidates -> cards
 *   with the cache serving both the 30-minute fast path and the offline replay.
 *
 * Nothing here talks HTTP; the plugin shell owns routing, the engine owns
 * policy. That keeps the whole state machine unit-testable.
 */
import type { SearchOutcome } from './github.js'
import {
  buildQueries,
  buildTrendingQueries,
  queryHash,
  trendingHash,
  type QueryOptions,
  type TrendingOptions,
} from './query.js'
import { rankRepos, type Candidate } from './rank.js'
import {
  extractSignal,
  isSignalEmpty,
  signalHash,
  type SessionEventLike,
} from './signals.js'
import type { Store } from './store.js'
import type {
  CacheEntry,
  FeedbackFile,
  RadarQuota,
  RadarSettings,
  RadarSignal,
  RadarState,
  RepoCard,
  SignalOverride,
} from './types.js'
import type { SummaryRow } from './summarize.js'

const CACHE_FRESH_MS = 30 * 60_000
const MAX_QUERIES = 3
const MAX_CANDIDATES = 60
const RETRY_AFTER_DEFAULT_MS = 60_000
/** Search pages stay cheap, but anonymous quota is 10/min — five is plenty. */
const TREND_MAX_PAGE = 5

export interface L2Runner {
  run: (
    cards: RepoCard[],
    sessionId: string,
    onBatch: (rows: SummaryRow[]) => void,
  ) => Promise<void>
}

export interface ClientLike {
  search: (
    query: string,
    options?: { signal?: AbortSignal; page?: number },
  ) => Promise<SearchOutcome>
  readonly lastQuota: RadarQuota | undefined
}

export interface EngineDeps {
  getEvents: (sessionId: string) => readonly SessionEventLike[]
  settings: () => RadarSettings
  client: ClientLike
  store: Store
  l2?: L2Runner
  log?: (message: string) => void
  now?: () => number
  setTimer?: (handler: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
}

interface SessionEntry {
  state: RadarState
  lastKey: string
  lastAt: number
  seen: string[]
  inflight?: Promise<RadarState>
  autoRetry?: unknown
  /** Last time an AI-summary batch was fired for this session. */
  l2At?: number
  /**
   * Repositories this session already saw in trending mode. The batch is a
   * fixed list, so "refresh" has to mean "the next five", not "the same five".
   */
  trendShown?: string[]
  /** Search page used for trending; bumped once the first page is exhausted. */
  trendPage?: number
}

function idleState(): RadarState {
  return { status: 'idle', cards: [] }
}

export class RadarEngine {
  private readonly sessions = new Map<string, SessionEntry>()
  private feedbackCache: FeedbackFile | undefined
  /** sessionId -> hand-edited keywords/error, hydrated from signals.json. */
  private overrides: Map<string, SignalOverride> | undefined
  private disposed = false
  private readonly now: () => number
  private readonly setTimer: (handler: () => void, ms: number) => unknown
  private readonly clearTimer: (handle: unknown) => void

  constructor(private readonly deps: EngineDeps) {
    this.now = deps.now ?? (() => Date.now())
    this.setTimer =
      deps.setTimer ??
      ((handler, ms) => {
        const handle = setTimeout(handler, ms)
        // Never keep the process alive just for a retry timer.
        if (typeof (handle as { unref?: () => void }).unref === 'function') {
          ;(handle as { unref: () => void }).unref()
        }
        return handle
      })
    this.clearTimer =
      deps.clearTimer ??
      ((handle) => {
        clearTimeout(handle as ReturnType<typeof setTimeout>)
      })
  }

  /** Stop all timers (plugin unload). */
  dispose(): void {
    this.disposed = true
    for (const entry of this.sessions.values()) {
      if (entry.autoRetry !== undefined) this.clearTimer(entry.autoRetry)
      entry.autoRetry = undefined
    }
    this.sessions.clear()
  }

  private entry(sessionId: string): SessionEntry {
    const existing = this.sessions.get(sessionId)
    if (existing !== undefined) return existing
    const created: SessionEntry = { state: idleState(), lastKey: '', lastAt: 0, seen: [] }
    this.sessions.set(sessionId, created)
    return created
  }

  /** The current state. Triggers a background refresh when it is stale. */
  async get(sessionId: string): Promise<RadarState> {
    if (sessionId.trim() === '') return idleState()
    const entry = this.entry(sessionId)
    if (entry.inflight !== undefined) return entry.state

    const settings = this.deps.settings()
    const key = await this.keyFor(sessionId, settings)
    const stale =
      entry.state.status === 'idle' ||
      key !== entry.lastKey ||
      this.now() - entry.lastAt >= settings.refreshDebounceMs ||
      entry.state.status === 'rateLimited' ||
      entry.state.status === 'error'

    if (stale) {
      void this.refresh(sessionId, false).catch((error: unknown) => {
        this.log(`后台刷新失败：${error instanceof Error ? error.message : String(error)}`)
      })
    }
    return entry.state
  }

  private keyFor(sessionId: string, settings: RadarSettings): Promise<string> {
    return this.signalFor(sessionId, settings).then(({ signal }) => {
      // No usable signal: the fallback batch is keyed by the day instead of by
      // keywords, so it refreshes at most once a day and never thrashes.
      if (isSignalEmpty(signal)) return `trend:${trendingHash(this.trendingOptions(settings))}`
      const options = this.queryOptions(settings)
      return `${queryHash(signal, options)}:${signalHash(signal)}`
    })
  }

  private trendingOptions(settings: RadarSettings): TrendingOptions {
    return {
      minStars: settings.minStars,
      languages: settings.languages,
      chineseOnly: settings.chineseOnly,
      now: this.now(),
    }
  }

  /**
   * The signal actually used for queries: the extractor's output, unless the
   * user edited the chips. A user-provided keyword list *replaces* extraction
   * (that is the point of editing it), while a pasted error replaces only the
   * error line.
   */
  private async signalFor(
    sessionId: string,
    settings: RadarSettings,
  ): Promise<{ signal: RadarSignal; override: SignalOverride | undefined }> {
    const override = (await this.loadOverrides()).get(sessionId)
    const extracted = extractSignal(sessionId, this.deps.getEvents(sessionId), {
      languages: settings.languages,
      now: this.now(),
    })
    if (override === undefined) return { signal: extracted, override }

    const signal: RadarSignal = { ...extracted, keywords: [...extracted.keywords] }
    if (override.keywords !== undefined) signal.keywords = override.keywords.slice(0, 5)
    if (override.errorText === null) {
      delete signal.errorText
    } else if (typeof override.errorText === 'string' && override.errorText !== '') {
      signal.errorText = override.errorText
    }
    return { signal, override }
  }

  private async loadOverrides(): Promise<Map<string, SignalOverride>> {
    if (this.overrides !== undefined) return this.overrides
    const map = new Map<string, SignalOverride>()
    try {
      const file = await this.deps.store.signals.read()
      for (const [sessionId, override] of Object.entries(file.sessions)) map.set(sessionId, override)
    } catch (error) {
      this.log(`读取手动关键词失败：${error instanceof Error ? error.message : String(error)}`)
    }
    this.overrides = map
    return map
  }

  /** The panel-facing keyword/error fields, plus their edited-by-hand flags. */
  private signalFields(signal: RadarSignal, override: SignalOverride | undefined): Partial<RadarState> {
    return {
      keywords: signal.keywords,
      ...(signal.errorText === undefined ? {} : { errorText: signal.errorText }),
      ...(override?.keywords === undefined ? {} : { keywordsManual: true }),
      ...(override?.errorText === undefined ? {} : { errorManual: true }),
    }
  }

  /**
   * Add/drop keywords or set the error line for one session, then refresh so
   * the cards match the new signal immediately.
   */
  async setSignal(
    sessionId: string,
    patch: { keywords?: string[]; errorText?: string | null; reset?: boolean },
  ): Promise<RadarState> {
    if (sessionId.trim() === '') return idleState()
    const overrides = await this.loadOverrides()
    const previous = overrides.get(sessionId)

    if (patch.reset === true) {
      overrides.delete(sessionId)
    } else {
      const next: SignalOverride = { at: this.now() }
      const keywords =
        patch.keywords === undefined
          ? previous?.keywords
          : [...new Set(patch.keywords.map((item) => item.trim()).filter((item) => item !== ''))].slice(0, 5)
      if (keywords !== undefined) next.keywords = keywords
      const errorText =
        patch.errorText === undefined ? previous?.errorText : patch.errorText === null ? null : patch.errorText.slice(0, 200)
      if (errorText !== undefined) next.errorText = errorText
      if (next.keywords === undefined && next.errorText === undefined) overrides.delete(sessionId)
      else overrides.set(sessionId, next)
    }

    try {
      const sessions: Record<string, SignalOverride> = {}
      for (const [key, value] of overrides) sessions[key] = value
      await this.deps.store.signals.write({ sessions })
      await this.deps.store.pruneSignals()
    } catch (error) {
      this.log(`保存手动关键词失败：${error instanceof Error ? error.message : String(error)}`)
    }

    // A new keyword list is a different query: force, so the debounce window
    // cannot serve the previous batch.
    const entry = this.entry(sessionId)
    entry.lastKey = ''
    entry.lastAt = 0
    return this.refreshNow(sessionId)
  }

  private queryOptions(settings: RadarSettings): QueryOptions {
    return {
      minStars: settings.minStars,
      languages: settings.languages,
      chineseOnly: settings.chineseOnly,
      maxQueries: MAX_QUERIES,
    }
  }

  private log(message: string): void {
    this.deps.log?.(message)
  }

  /** Force a new refresh (the panel's ⟳ button). */
  async refreshNow(sessionId: string): Promise<RadarState> {
    return this.refresh(sessionId, true)
  }

  /** A refresh that honours the cache and debounce windows. */
  async refresh(sessionId: string, force = false): Promise<RadarState> {
    if (this.disposed) return idleState()
    const settings = this.deps.settings()
    const entry = this.entry(sessionId)
    if (!force && entry.inflight !== undefined) return entry.inflight

    const run = this.runRefresh(sessionId, settings, entry, force).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      this.log(`刷新异常：${message}`)
      entry.state = { status: 'error', cards: [], errorMessage: `刷新失败：${message}` }
      return entry.state
    })
    entry.inflight = run
    try {
      return await run
    } finally {
      entry.inflight = undefined
    }
  }

  private async runRefresh(
    sessionId: string,
    settings: RadarSettings,
    entry: SessionEntry,
    force: boolean,
  ): Promise<RadarState> {
    const now = this.now()
    const { signal, override } = await this.signalFor(sessionId, settings)
    const options = this.queryOptions(settings)
    // An empty signal used to mean an empty panel. A brand-new conversation
    // has nothing to match yet, and "nothing here" is a dead end for the user,
    // so the fallback shows what is hot right now instead.
    const trending = isSignalEmpty(signal)
    const trendingOptions = this.trendingOptions(settings)
    const hash = trending ? trendingHash(trendingOptions) : queryHash(signal, options)
    const key = trending ? `trend:${hash}` : `${hash}:${signalHash(signal)}`
    const quota = this.deps.client.lastQuota

    if (
      !force &&
      key === entry.lastKey &&
      entry.state.status === 'ready' &&
      now - entry.lastAt < settings.refreshDebounceMs
    ) {
      return entry.state
    }

    const cached = await this.readCache(hash)

    if (!settings.allowNetwork) {
      if (cached !== undefined) {
        entry.state = this.cachedState(cached, settings, '已关闭联网，显示本地缓存')
        entry.lastKey = key
        entry.lastAt = now
        return entry.state
      }
      entry.state = {
        status: 'offline',
        cards: [],
        notice: '已关闭联网，且本地还没有缓存。开启「允许联网」后才能推荐项目。',
        ...(quota === undefined ? {} : { quota }),
      }
      return entry.state
    }

    if (!force && cached !== undefined && now - cached.at < CACHE_FRESH_MS) {
      entry.state = this.cachedState(cached, settings, '来自本地缓存')
      entry.lastKey = key
      entry.lastAt = now
      // Cached cards still deserve a real Chinese summary: the batch is
      // memoised in summaries.json, so a warm cache costs one request at most.
      this.kickL2(sessionId, entry)
      return entry.state
    }

    entry.state = {
      status: 'loading',
      cards: [],
      ...this.signalFields(signal, override),
      ...(trending ? { trending: true } : {}),
      ...(quota === undefined ? {} : { quota }),
    }

    const queries = trending ? buildTrendingQueries(trendingOptions) : buildQueries(signal, options)
    const candidates = new Map<string, Candidate>()
    let rateLimited: Extract<SearchOutcome, { kind: 'rateLimited' }> | undefined
    let lastError: string | undefined
    let okCount = 0
    let networkFailed = false

    // Split out because trending mode can need a second page: `?page=N` is how
    // GitHub serves "the next batch", and the refresh cycle drains page 1.
    const collect = async (page: number): Promise<void> => {
      for (const [queryIndex, query] of queries.entries()) {
        if (candidates.size >= MAX_CANDIDATES) break
        const outcome = await this.deps.client.search(query, page > 1 ? { page } : undefined)
        if (outcome.kind === 'ok') {
          okCount += 1
          if (outcome.repos.length === 0) continue
          // The band index rides along in the source tag so the ranker can
          // interleave the trending bands instead of returning the ceiling of one.
          const source = trending
            ? `trending:${queryIndex}`
            : /in:readme/.test(query)
              ? 'error'
              : errorSourceOf(query, signal)
          for (const repo of outcome.repos) {
            if (typeof repo.full_name !== 'string' || repo.full_name === '') continue
            if (repo.archived === true) continue
            const existing = candidates.get(repo.full_name)
            if (existing !== undefined) {
              if (!existing.sources.includes(source)) existing.sources.push(source)
              continue
            }
            if (candidates.size >= MAX_CANDIDATES) break
            candidates.set(repo.full_name, { repo, sources: [source] })
          }
          continue
        }
        if (outcome.kind === 'rateLimited') {
          rateLimited = outcome
          break
        }
        if (outcome.kind === 'error') {
          lastError = outcome.message
          if (/网络请求失败/.test(outcome.message)) networkFailed = true
        }
      }
    }

    await collect(1)

    // A niche topic may have no repository above `minStars` at all, and `empty`
    // is the honest-but-useless answer there. One relaxed retry gives the small
    // projects a chance without spending the whole per-refresh query budget.
    let relaxed = false
    if (okCount > 0 && candidates.size === 0 && signal.keywords.length > 0) {
      const relaxedOptions = { ...options, minStars: 0, maxQueries: 1 }
      for (const query of buildQueries(signal, relaxedOptions)) {
        const outcome = await this.deps.client.search(query)
        if (outcome.kind !== 'ok') break
        okCount += 1
        const source = errorSourceOf(query, signal)
        for (const repo of outcome.repos) {
          if (typeof repo.full_name !== 'string' || repo.full_name === '') continue
          if (repo.archived === true) continue
          if (candidates.size >= MAX_CANDIDATES) break
          if (!candidates.has(repo.full_name)) candidates.set(repo.full_name, { repo, sources: [source] })
        }
        if (candidates.size > 0) break
      }
      relaxed = candidates.size > 0
    }

    if (okCount === 0 && rateLimited !== undefined) {
      const retryAfterMs = Math.max(1_000, rateLimited.retryAfterMs)
      entry.state = {
        status: 'rateLimited',
        cards: [],
        ...this.signalFields(signal, override),
        retryAfterMs,
        notice: `GitHub 暂时限速，约 ${Math.round(retryAfterMs / 1000)} 秒后重试`,
        ...(rateLimited.quota === undefined ? {} : { quota: rateLimited.quota }),
        ...(settings.githubToken.trim() === ''
          ? { errorMessage: '配置一个只读令牌可以把额度从每分钟 10 次提升到 30 次' }
          : {}),
      }
      this.scheduleAutoRetry(sessionId, retryAfterMs)
      return entry.state
    }

    if (okCount === 0) {
      if (cached !== undefined) {
        entry.state = this.cachedState(
          cached,
          settings,
          `连不上 GitHub，显示缓存于 ${this.minutesAgo(cached.at)}前的推荐`,
        )
        entry.lastKey = key
        entry.lastAt = now
        entry.state.status = 'offline'
        return entry.state
      }
      entry.state = {
        status: networkFailed ? 'offline' : 'error',
        cards: [],
        ...this.signalFields(signal, override),
        ...(lastError === undefined ? {} : { errorMessage: lastError }),
        ...(networkFailed ? { notice: '网络不可用，检查代理或稍后再试' } : {}),
      }
      return entry.state
    }

    const feedback = await this.feedback()
    const shownBefore = trending ? (entry.trendShown ?? []) : []
    const rankNow = (seen: string[], pool: Map<string, Candidate>): ReturnType<typeof rankRepos> =>
      rankRepos([...pool.values()], {
        signal,
        settings,
        feedback,
        seen,
        now,
        trending,
      })

    // In trending mode the batch is a fixed list of what is hot today: hiding
    // the cards already shown is what turns ⟳ into "the next five", and once
    // page 1 is drained the next page continues the rotation.
    let ranked = rankNow(trending ? shownBefore : entry.seen, candidates)

    if (trending && ranked.cards.length < settings.maxCards && shownBefore.length > 0) {
      const nextPage = (entry.trendPage ?? 1) + 1
      if (nextPage <= TREND_MAX_PAGE) {
        entry.trendPage = nextPage
        entry.trendShown = []
        candidates.clear()
        okCount = 0
        rateLimited = undefined
        await collect(nextPage)
        if (candidates.size > 0) ranked = rankNow([], candidates)
      } else {
        // GitHub search stops serving results past ~1000; cycle back to page 1.
        entry.trendPage = 1
        entry.trendShown = []
        candidates.clear()
        await collect(1)
        if (candidates.size > 0) ranked = rankNow([], candidates)
      }
    }

    const quotaNow = this.deps.client.lastQuota
    const anonymous = settings.githubToken.trim() === ''
    const state: RadarState = {
      status: ranked.cards.length === 0 ? 'empty' : 'ready',
      cards: ranked.cards,
      updatedAt: now,
      ...this.signalFields(signal, override),
      ...(trending ? { trending: true } : {}),
      anonymous,
      ...(quotaNow === undefined ? {} : { quota: quotaNow }),
    }
    if (ranked.cards.length === 0) {
      state.notice = settings.chineseOnly
        ? '只保留中文社区项目，这一轮没有命中。看看「关掉这个开关」？'
        : '这一轮没有找到合适的项目，稍后再试或换个话题。'
    } else if (trending) {
      state.notice = '会话里还没有足够的线索，先给你看最近热门的项目；点 ⟳ 换一批，或「＋ 加关键词」按你的方向找'
    } else if (relaxed && settings.minStars > 0 && ranked.cards.every((card) => card.stars < settings.minStars)) {
      // Be honest about what the relaxed retry did: these are early-stage repos,
      // not the 30★+ ones the settings asked for.
      state.notice = `没有找到 ${settings.minStars} 星以上的仓库，下面是刚起步但相关的项目`
    } else if (settings.chineseOnly) {
      state.notice = '仅看中文项目 · 覆盖范围较窄，结果可能变少'
    } else if (rateLimited !== undefined) {
      state.notice = `部分查询被限速，结果可能偏少（约 ${Math.round(rateLimited.retryAfterMs / 1000)} 秒后恢复）`
    }

    entry.state = state
    entry.lastKey = key
    entry.lastAt = now
    if (!trending) {
      entry.seen = [...new Set([...entry.seen, ...ranked.cards.map((card) => card.fullName)])].slice(-80)
    } else {
      const base = entry.trendShown ?? []
      entry.trendShown = [...new Set([...base, ...ranked.cards.map((card) => card.fullName)])].slice(-150)
    }

    await this.writeCache({
      at: now,
      queryHash: hash,
      keywords: signal.keywords,
      ...(signal.errorText === undefined ? {} : { errorText: signal.errorText }),
      cards: ranked.cards,
      ...(trending ? { trending: true } : {}),
      ...(quotaNow === undefined ? {} : { quota: quotaNow }),
    })

    if (settings.enableAiSummary && this.deps.l2 !== undefined && ranked.cards.length > 0) {
      this.kickL2(sessionId, entry)
    }
    return entry.state
  }

  private minutesAgo(at: number): string {
    const minutes = Math.max(0, Math.round((this.now() - at) / 60_000))
    return minutes <= 0 ? '刚刚' : `${minutes} 分钟`
  }

  private cachedState(cached: CacheEntry, settings: RadarSettings, notice: string): RadarState {
    const cards = settings.chineseOnly
      ? cached.cards.filter((card) => card.zh !== '')
      : cached.cards
    return {
      status: cards.length === 0 ? 'empty' : 'ready',
      cards,
      updatedAt: cached.at,
      keywords: cached.keywords,
      cached: true,
      ...(cached.trending === true ? { trending: true } : {}),
      anonymous: settings.githubToken.trim() === '',
      notice: cached.trending === true ? `近期热门 · ${notice}` : notice,
      ...(cached.quota === undefined ? {} : { quota: cached.quota }),
    }
  }

  private scheduleAutoRetry(sessionId: string, ms: number): void {
    const entry = this.entry(sessionId)
    if (entry.autoRetry !== undefined) this.clearTimer(entry.autoRetry)
    entry.autoRetry = this.setTimer(() => {
      entry.autoRetry = undefined
      if (this.disposed) return
      void this.refresh(sessionId, true).catch((error: unknown) => {
        this.log(`限速后重试失败：${error instanceof Error ? error.message : String(error)}`)
      })
    }, Math.min(ms + 500, RETRY_AFTER_DEFAULT_MS * 15))
  }

  private kickL2(sessionId: string, entry: SessionEntry): void {
    const runner = this.deps.l2
    if (runner === undefined) return
    if (!this.deps.settings().enableAiSummary) return
    // Cached renders re-enter here on every cache hit; one batch per minute is
    // plenty because the answer is memoised in summaries.json anyway.
    const now = this.now()
    if (entry.l2At !== undefined && now - entry.l2At < 60_000) return
    const cards = entry.state.cards.filter((card) => card.zhSource === 'template')
    if (cards.length === 0) return
    entry.l2At = now
    void runner
      .run(cards, sessionId, (rows) => {
        if (this.disposed) return
        const byName = new Map(rows.map((row) => [row.fullName, row.zh]))
        let changed = false
        const next = entry.state.cards.map((card) => {
          const zh = byName.get(card.fullName)
          if (zh === undefined || zh === card.zh) return card
          changed = true
          return { ...card, zh, zhSource: 'llm' as const }
        })
        if (!changed) return
        entry.state = { ...entry.state, cards: next }
        void this.persistCacheCards(entry.state.cards)
      })
      .catch((error: unknown) => {
        this.log(`AI 摘要失败：${error instanceof Error ? error.message : String(error)}`)
      })
  }

  /** Update summary.text of the cache entry the current cards came from. */
  private async persistCacheCards(cards: RepoCard[]): Promise<void> {
    const file = await this.deps.store.cache.read()
    let touched = false
    for (const entry of Object.values(file.entries)) {
      const names = new Set(entry.cards.map((card) => card.fullName))
      const allPresent = cards.every((card) => names.has(card.fullName))
      if (!allPresent) continue
      entry.cards = cards
      touched = true
    }
    if (touched) await this.deps.store.cache.write(file)
  }

  private async readCache(hash: string): Promise<CacheEntry | undefined> {
    try {
      const file = await this.deps.store.cache.read()
      return file.entries[hash]
    } catch {
      return undefined
    }
  }

  private async writeCache(entry: CacheEntry): Promise<void> {
    try {
      const file = await this.deps.store.cache.read()
      file.entries[entry.queryHash] = entry
      await this.deps.store.cache.write(file)
      await this.deps.store.pruneCache(this.now())
    } catch (error) {
      this.log(`写入缓存失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  private async feedback(): Promise<FeedbackFile> {
    if (this.feedbackCache !== undefined) return this.feedbackCache
    this.feedbackCache = await this.deps.store.feedback.read()
    return this.feedbackCache
  }

  /** 「不感兴趣」: 30-day cooldown, and the card leaves the panel immediately. */
  async dismiss(fullName: string): Promise<RadarState | undefined> {
    const name = fullName.trim()
    if (name === '') return undefined
    const feedback = { ...(await this.feedback()) }
    feedback.dismissed = { ...feedback.dismissed, [name]: this.now() }
    this.feedbackCache = feedback
    await this.deps.store.feedback.write(feedback)

    let affected: RadarState | undefined
    for (const entry of this.sessions.values()) {
      if (!entry.state.cards.some((card) => card.fullName === name)) continue
      entry.state = { ...entry.state, cards: entry.state.cards.filter((card) => card.fullName !== name) }
      affected = entry.state
    }
    return affected
  }

  /** 「打开」 click counter — feeds the small owner/topic boost in the ranker. */
  async recordClick(fullName: string): Promise<void> {
    const name = fullName.trim()
    if (name === '') return
    const feedback = { ...(await this.feedback()) }
    const next = (feedback.clicked[name] ?? 0) + 1
    feedback.clicked = { ...feedback.clicked, [name]: next }
    this.feedbackCache = feedback
    await this.deps.store.feedback.write(feedback)
  }

  /** Forget the cached in-memory state for one session (settings changed). */
  invalidate(sessionId?: string): void {
    if (sessionId === undefined) {
      this.feedbackCache = undefined
      for (const entry of this.sessions.values()) {
        entry.lastKey = ''
        entry.lastAt = 0
      }
      return
    }
    const entry = this.sessions.get(sessionId)
    if (entry === undefined) return
    entry.lastKey = ''
    entry.lastAt = 0
  }
}

function errorSourceOf(query: string, signal: RadarSignal): string {
  const keyword = signal.keywords.find((kw) => query.includes(kw))
  return keyword === undefined ? 'keyword:' : `keyword:${keyword}`
}
