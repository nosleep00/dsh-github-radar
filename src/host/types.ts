/**
 * Shared data model for dsh-github-radar.
 *
 * These types are the contract between the host half (GitHub engine) and the
 * browser half (right-sidebar panel). Everything crossing the HTTP boundary is
 * JSON-serialisable, so the same shapes travel in both directions unchanged.
 */

/** One repository as returned by `GET /search/repositories`. */
export interface GitHubRepo {
  full_name: string
  html_url: string
  description?: string | null
  topics?: string[]
  language?: string | null
  stargazers_count?: number
  pushed_at?: string | null
  archived?: boolean
  fork?: boolean
  owner?: { login?: string } | null
}

/** How the Chinese one-liner was produced. */
export type ZhSource = 'template' | 'llm'

/** One recommended project, exactly as rendered by a card. */
export interface RepoCard {
  fullName: string
  htmlUrl: string
  descriptionEn: string
  topics: string[]
  language: string | null
  stars: number
  pushedAt: string
  archived: boolean
  /** Chinese one-liner shown as the card's main line. */
  zh: string
  zhSource: ZhSource
  /** Why this card is here, already localised to Chinese (L1 copy). */
  why: string
  /** Copy-pasteable install commands guessed from language/topics. */
  install: string[]
}

/** The de-identified context extracted from the conversation. */
export interface RadarSignal {
  sessionId: string
  /** Up to 5 technical keywords. Never raw conversation text. */
  keywords: string[]
  /** First error-looking line, <= 200 chars. */
  errorText?: string
  /** Preferred languages (from settings). */
  languages: string[]
  /** Timestamp (ms) of the last user message this signal was built from. */
  turnedAt: number
}

export type RadarStatus =
  | 'idle'
  | 'loading'
  | 'ready'
  | 'empty'
  | 'rateLimited'
  | 'offline'
  | 'error'

export interface RadarQuota {
  remaining: number
  limit: number
  /** Epoch seconds when the window resets. */
  resetAt: number
}

/** Everything the panel needs for one render. */
export interface RadarState {
  status: RadarStatus
  cards: RepoCard[]
  /** Last successful data timestamp (ms). */
  updatedAt?: number
  /** Server-suggested wait before the next automatic attempt. */
  retryAfterMs?: number
  quota?: RadarQuota
  /** Friendly, already-translated notice (cache age, coverage hint…). */
  notice?: string
  errorMessage?: string
  /** Query keywords actually used for the current cards. */
  keywords?: string[]
  /** The error line behind the current batch, already truncated (panel chip). */
  errorText?: string
  /** True for the anonymous GitHub quota (no token configured). */
  anonymous?: boolean
  /** Set when the last render came from the local cache. */
  cached?: boolean
  /** The keyword chips were edited by hand instead of extracted. */
  keywordsManual?: boolean
  /** The error chip was pasted by hand instead of extracted. */
  errorManual?: boolean
  /**
   * These cards are the no-signal fallback (recently active popular repos)
   * rather than a match against the session's keywords.
   */
  trending?: boolean
}

/**
 * A hand-edited signal for one session. The panel lets the user add or drop
 * keywords (and paste an error) without waiting for the extractor to improve.
 */
export interface SignalOverride {
  /** Replaces the extracted keywords entirely. */
  keywords?: string[]
  /** Replaces the extracted error line; `null` removes it. */
  errorText?: string | null
  /** Epoch ms of the last edit. */
  at: number
}

export interface SignalFile {
  /** sessionId -> override */
  sessions: Record<string, SignalOverride>
}

/** Persisted user feedback (dismiss / click counters). */
export interface FeedbackFile {
  /** fullName -> epoch ms of the dismissal. */
  dismissed: Record<string, number>
  /** fullName -> number of "open" clicks. */
  clicked: Record<string, number>
  /** fullName -> stars at last sighting (unused in v1, reserved). */
  stars: Record<string, number>
}

export interface CacheEntry {
  at: number
  queryHash: string
  keywords: string[]
  cards: RepoCard[]
  quota?: RadarQuota
  /** Cached batch came from the no-signal trending fallback. */
  trending?: boolean
}

export interface CacheFile {
  /** queryHash -> entry */
  entries: Record<string, CacheEntry>
}

export interface SummaryEntry {
  zh: string
  at: number
}

export interface SummaryFile {
  /** stable key -> entry */
  entries: Record<string, SummaryEntry>
}

/** The resolved plugin configuration (all fields have defaults). */
export interface RadarSettings {
  enableAiSummary: boolean
  minStars: number
  maxCards: number
  refreshDebounceMs: number
  languages: string[]
  chineseOnly: boolean
  githubToken: string
  proxyUrl: string
  allowNetwork: boolean
}
