/**
 * Plugin data directory (S15).
 *
 * Everything lives under `$DSH_HOME/plugin-data/dsh-github-radar/`:
 *   cache.json     queryHash -> last result (<= 40 entries, < 2 MB)
 *   feedback.json  dismissed / clicked counters
 *   summaries.json AI one-liners (<= 2000 entries)
 *   signals.json   hand-edited keywords/error per session (<= 200 sessions)
 *
 * Writes are atomic (temp file + rename) so a crashed write never leaves a
 * half-parsed JSON file behind.
 */
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import type {
  CacheEntry,
  CacheFile,
  FeedbackFile,
  SignalFile,
  SignalOverride,
  SummaryEntry,
  SummaryFile,
} from './types.js'

const MAX_CACHE_ENTRIES = 40
const MAX_CACHE_BYTES = 2 * 1024 * 1024
const MAX_SUMMARY_ENTRIES = 2000
const MAX_SIGNAL_ENTRIES = 200
const DISMISS_RETENTION_MS = 90 * 86_400_000

/** `$DSH_HOME`, falling back to `~/.dsh`. */
export function dshHome(): string {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv
  return join(homedir(), '.dsh')
}

export function pluginDataDir(): string {
  return join(dshHome(), 'plugin-data', 'dsh-github-radar')
}

let writeCounter = 0

/** A tiny JSON file with atomic writes and a in-memory fallback. */
export class JsonFile<T> {
  private cache: T | undefined
  private pending: Promise<void> | undefined

  constructor(
    readonly path: string,
    private readonly fallback: () => T,
    private readonly normalize?: (value: unknown) => T,
  ) {}

  async read(): Promise<T> {
    if (this.cache !== undefined) return this.cache
    try {
      const raw = await readFile(this.path, 'utf8')
      const parsed: unknown = JSON.parse(raw)
      this.cache = this.normalize === undefined ? (parsed as T) : this.normalize(parsed)
    } catch {
      this.cache = this.fallback()
    }
    return this.cache
  }

  /** Queue a write; failures are swallowed so a read-only home never breaks the panel. */
  async write(value: T): Promise<void> {
    this.cache = value
    const previous = this.pending ?? Promise.resolve()
    this.pending = previous.then(async () => {
      writeCounter += 1
      const tmp = `${this.path}.${process.pid}.${writeCounter}.tmp`
      try {
        await mkdir(pluginDataDir(), { recursive: true })
        await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
        await rename(tmp, this.path)
      } catch {
        await rm(tmp, { force: true }).catch(() => undefined)
      }
    })
    await this.pending
  }

  /** Drop the in-memory copy (used by tests and after an external edit). */
  forget(): void {
    this.cache = undefined
  }
}

function normalizeCache(value: unknown): CacheFile {
  const record = value as { entries?: unknown } | null
  const entries = record?.entries
  if (entries === null || entries === undefined || typeof entries !== 'object') {
    return { entries: {} }
  }
  const out: Record<string, CacheEntry> = {}
  for (const [key, entry] of Object.entries(entries as Record<string, unknown>)) {
    const candidate = entry as Partial<CacheEntry> | null
    if (candidate === null || candidate === undefined) continue
    if (typeof candidate.at !== 'number' || !Array.isArray(candidate.cards)) continue
    out[key] = {
      at: candidate.at,
      queryHash: typeof candidate.queryHash === 'string' ? candidate.queryHash : key,
      keywords: Array.isArray(candidate.keywords) ? candidate.keywords.filter((k) => typeof k === 'string') : [],
      cards: candidate.cards,
      ...(candidate.quota === undefined ? {} : { quota: candidate.quota }),
      ...(candidate.trending === true ? { trending: true } : {}),
    }
  }
  return { entries: out }
}

function normalizeFeedback(value: unknown): FeedbackFile {
  const record = (value ?? {}) as Partial<FeedbackFile> | null
  const numbers = (input: unknown): Record<string, number> => {
    if (input === null || input === undefined || typeof input !== 'object') return {}
    const out: Record<string, number> = {}
    for (const [key, entry] of Object.entries(input as Record<string, unknown>)) {
      if (typeof entry === 'number' && Number.isFinite(entry)) out[key] = entry
    }
    return out
  }
  return {
    dismissed: numbers(record?.dismissed),
    clicked: numbers(record?.clicked),
    stars: numbers(record?.stars),
  }
}

function normalizeSummaries(value: unknown): SummaryFile {
  const record = (value ?? {}) as { entries?: unknown } | null
  const entries = record?.entries
  if (entries === null || entries === undefined || typeof entries !== 'object') return { entries: {} }
  const out: Record<string, SummaryEntry> = {}
  for (const [key, entry] of Object.entries(entries as Record<string, unknown>)) {
    const candidate = entry as Partial<SummaryEntry> | null
    if (candidate === null || candidate === undefined) continue
    if (typeof candidate.zh !== 'string' || candidate.zh.trim() === '') continue
    out[key] = { zh: candidate.zh, at: typeof candidate.at === 'number' ? candidate.at : Date.now() }
  }
  return { entries: out }
}

function normalizeSignals(value: unknown): SignalFile {
  const record = value as { sessions?: unknown } | null
  const sessions = record?.sessions
  if (sessions === null || sessions === undefined || typeof sessions !== 'object') return { sessions: {} }
  const out: Record<string, SignalOverride> = {}
  for (const [key, entry] of Object.entries(sessions as Record<string, unknown>)) {
    const candidate = entry as Partial<SignalOverride> | null
    if (candidate === null || candidate === undefined) continue
    const next: SignalOverride = { at: typeof candidate.at === 'number' ? candidate.at : Date.now() }
    if (Array.isArray(candidate.keywords)) {
      next.keywords = candidate.keywords
        .filter((item): item is string => typeof item === 'string')
        .map((item) => item.trim())
        .filter((item) => item !== '')
        .slice(0, 5)
    }
    if (candidate.errorText === null) next.errorText = null
    else if (typeof candidate.errorText === 'string' && candidate.errorText.trim() !== '') {
      next.errorText = candidate.errorText.slice(0, 200)
    }
    if (next.keywords === undefined && next.errorText === undefined) continue
    out[key] = next
  }
  return { sessions: out }
}

export interface Store {
  cache: JsonFile<CacheFile>
  feedback: JsonFile<FeedbackFile>
  summaries: JsonFile<SummaryFile>
  signals: JsonFile<SignalFile>
  /** Trim the cache to its retention limits and persist. */
  pruneCache(now?: number): Promise<void>
  pruneSummaries(): Promise<void>
  pruneSignals(): Promise<void>
}

export function createStore(): Store {
  const dir = pluginDataDir()
  const cache = new JsonFile<CacheFile>(join(dir, 'cache.json'), () => ({ entries: {} }), normalizeCache)
  const feedback = new JsonFile<FeedbackFile>(
    join(dir, 'feedback.json'),
    () => ({ dismissed: {}, clicked: {}, stars: {} }),
    normalizeFeedback,
  )
  const summaries = new JsonFile<SummaryFile>(
    join(dir, 'summaries.json'),
    () => ({ entries: {} }),
    normalizeSummaries,
  )

  const signals = new JsonFile<SignalFile>(
    join(dir, 'signals.json'),
    () => ({ sessions: {} }),
    normalizeSignals,
  )

  const store: Store = {
    cache,
    feedback,
    summaries,
    signals,
    async pruneCache(now = Date.now()) {
      const file = await cache.read()
      const entries = Object.entries(file.entries)
      entries.sort((a, b) => b[1].at - a[1].at)
      const kept: Record<string, CacheEntry> = {}
      let bytes = 0
      for (const [key, entry] of entries.slice(0, MAX_CACHE_ENTRIES)) {
        const size = JSON.stringify(entry).length
        if (bytes + size > MAX_CACHE_BYTES) continue
        bytes += size
        kept[key] = entry
      }
      // Also forget anything older than a day: it can no longer serve a replay.
      for (const [key, entry] of Object.entries(kept)) {
        if (now - entry.at > 86_400_000) delete kept[key]
      }
      await cache.write({ entries: kept })
    },
    async pruneSummaries() {
      const file = await summaries.read()
      const entries = Object.entries(file.entries)
      if (entries.length <= MAX_SUMMARY_ENTRIES) return
      entries.sort((a, b) => b[1].at - a[1].at)
      await summaries.write({ entries: Object.fromEntries(entries.slice(0, MAX_SUMMARY_ENTRIES)) })
    },
    async pruneSignals() {
      const file = await signals.read()
      const entries = Object.entries(file.sessions)
      if (entries.length <= MAX_SIGNAL_ENTRIES) return
      entries.sort((a, b) => b[1].at - a[1].at)
      await signals.write({ sessions: Object.fromEntries(entries.slice(0, MAX_SIGNAL_ENTRIES)) })
    },
  }
  return store
}

/** Drop dismissals older than the retention window (keeps feedback.json small). */
export async function pruneFeedback(store: Store, now = Date.now()): Promise<void> {
  const file = await store.feedback.read()
  let changed = false
  const dismissed: Record<string, number> = {}
  for (const [key, at] of Object.entries(file.dismissed)) {
    if (now - at > DISMISS_RETENTION_MS) {
      changed = true
      continue
    }
    dismissed[key] = at
  }
  if (changed) await store.feedback.write({ ...file, dismissed })
}

export { MAX_CACHE_ENTRIES, MAX_SUMMARY_ENTRIES }
