export const DEFAULT_BASE_URL = 'https://api.github.com';
export const USER_AGENT = 'dsh-github-radar/0.1.0';
const PER_PAGE = 20;
const ANON_INTERVAL_MS = 2_000;
const TOKEN_INTERVAL_MS = 1_000;
const MIN_RETRY_MS = 1_000;
const MAX_RETRY_MS = 15 * 60_000;
function headerOf(response, name) {
    const headers = response.headers;
    if (headers === null || headers === undefined)
        return undefined;
    const get = headers.get;
    if (typeof get === 'function') {
        const value = get.call(headers, name);
        return value === null || value === undefined ? undefined : value;
    }
    const record = headers;
    const direct = record[name] ?? record[name.toLowerCase()];
    return typeof direct === 'string' ? direct : undefined;
}
function parseQuota(response, now) {
    const remainingRaw = headerOf(response, 'x-ratelimit-remaining');
    const limitRaw = headerOf(response, 'x-ratelimit-limit');
    const resetRaw = headerOf(response, 'x-ratelimit-reset');
    const remaining = remainingRaw === undefined ? Number.NaN : Number.parseInt(remainingRaw, 10);
    const limit = limitRaw === undefined ? Number.NaN : Number.parseInt(limitRaw, 10);
    const resetAt = resetRaw === undefined ? Number.NaN : Number.parseInt(resetRaw, 10);
    if (Number.isNaN(remaining) || Number.isNaN(limit))
        return undefined;
    return {
        remaining,
        limit,
        resetAt: Number.isNaN(resetAt) ? Math.floor(now / 1000) + 60 : resetAt,
    };
}
function retryAfterMs(response, quota, now) {
    const retryAfter = headerOf(response, 'retry-after');
    if (retryAfter !== undefined) {
        const seconds = Number.parseFloat(retryAfter);
        if (Number.isFinite(seconds)) {
            return Math.min(MAX_RETRY_MS, Math.max(MIN_RETRY_MS, Math.round(seconds * 1000)));
        }
        const at = Date.parse(retryAfter);
        if (!Number.isNaN(at))
            return Math.min(MAX_RETRY_MS, Math.max(MIN_RETRY_MS, at - now));
    }
    if (quota !== undefined) {
        const wait = quota.resetAt * 1000 - now;
        if (Number.isFinite(wait) && wait > 0)
            return Math.min(MAX_RETRY_MS, Math.max(MIN_RETRY_MS, wait));
    }
    return 60_000;
}
const defaultSleep = (ms) => new Promise((resolve) => {
    setTimeout(resolve, ms);
});
/** Lazily build an undici ProxyAgent; `undefined` when undici is unavailable. */
export async function createProxyDispatcher(proxyUrl) {
    if (proxyUrl.trim() === '')
        return undefined;
    try {
        // Non-literal specifier: `undici` is optional, so it must not be a build-time
        // dependency of this package's types.
        const specifier = 'undici';
        const undici = (await import(specifier));
        if (typeof undici.ProxyAgent !== 'function')
            return undefined;
        return new undici.ProxyAgent(proxyUrl);
    }
    catch {
        return undefined;
    }
}
export class GithubClient {
    chain = Promise.resolve();
    lastStart = 0;
    etags = new Map();
    now;
    sleep;
    fetchImpl;
    baseUrl;
    userAgent;
    explicitInterval;
    token;
    dispatcher;
    quota;
    constructor(options = {}) {
        this.token = (options.token ?? '').trim();
        this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
        this.userAgent = options.userAgent ?? USER_AGENT;
        this.now = options.now ?? (() => Date.now());
        this.sleep = options.sleep ?? defaultSleep;
        this.explicitInterval = options.minIntervalMs;
        this.dispatcher = options.proxy?.dispatcher;
        this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
    }
    /** Swap the token without rebuilding the queue. */
    setToken(token) {
        this.token = (token ?? '').trim();
    }
    hasToken() {
        return this.token !== '';
    }
    /** Attach (or clear) the connection dispatcher used for proxy support. */
    setProxy(dispatcher) {
        this.dispatcher = dispatcher;
    }
    get minIntervalMs() {
        if (this.explicitInterval !== undefined)
            return this.explicitInterval;
        return this.hasToken() ? TOKEN_INTERVAL_MS : ANON_INTERVAL_MS;
    }
    /** Last known quota (may be undefined before the first request). */
    get lastQuota() {
        return this.quota;
    }
    enqueue(task) {
        const run = this.chain.then(async () => {
            const wait = this.lastStart + this.minIntervalMs - this.now();
            if (wait > 0)
                await this.sleep(wait);
            this.lastStart = this.now();
            return task();
        });
        // Keep the chain alive even when a task rejects.
        this.chain = run.then(() => undefined, () => undefined);
        return run;
    }
    headers(extra = {}) {
        const headers = {
            accept: 'application/vnd.github+json',
            'x-github-api-version': '2022-11-28',
            'user-agent': this.userAgent,
            ...extra,
        };
        if (this.hasToken())
            headers.authorization = `Bearer ${this.token}`;
        return headers;
    }
    /** `GET /search/repositories` for one query. */
    async search(query, options = {}) {
        const trimmed = query.trim();
        if (trimmed === '')
            return { kind: 'error', message: '空查询' };
        const page = Number.isFinite(options.page) ? Math.max(1, Math.floor(options.page)) : 1;
        return this.enqueue(() => this.searchOnce(trimmed, options.signal, true, page));
    }
    async searchOnce(query, signal, allowRetry, page = 1) {
        const pageParam = page > 1 ? `&page=${page}` : '';
        const url = `${this.baseUrl}/search/repositories?q=${encodeURIComponent(query)}&sort=stars&order=desc&per_page=${PER_PAGE}${pageParam}`;
        // Page 2 has its own ETag: reusing page 1's validator would hand back 304.
        const etagKey = page > 1 ? `${query}\u0000p${page}` : query;
        const etag = this.etags.get(etagKey);
        const init = {
            method: 'GET',
            headers: this.headers(etag === undefined ? {} : { 'if-none-match': etag }),
        };
        if (signal !== undefined)
            init.signal = signal;
        if (this.dispatcher !== undefined)
            init.dispatcher = this.dispatcher;
        let response;
        try {
            response = await this.fetchImpl(url, init);
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return { kind: 'error', message: `网络请求失败：${message}` };
        }
        const status = typeof response.status === 'number'
            ? response.status
            : 0;
        const quota = parseQuota(response, this.now());
        if (quota !== undefined)
            this.quota = quota;
        if (status === 304)
            return { kind: 'notModified', ...(quota === undefined ? {} : { quota }) };
        if (status === 403 || status === 429) {
            const resetHint = quota === undefined ? '' : `（额度 ${Math.max(0, quota.remaining)}/${quota.limit}）`;
            return {
                kind: 'rateLimited',
                retryAfterMs: retryAfterMs(response, quota, this.now()),
                message: `GitHub 限速${resetHint}`,
                ...(quota === undefined ? {} : { quota }),
            };
        }
        if (status >= 500) {
            if (allowRetry) {
                await this.sleep(1_000);
                this.lastStart = this.now();
                return this.searchOnce(query, signal, false, page);
            }
            return { kind: 'error', message: `GitHub 服务异常（HTTP ${status}）`, status };
        }
        if (status !== 200) {
            const message = await this.readMessage(response);
            return {
                kind: 'error',
                message: message === '' ? `GitHub 返回 HTTP ${status}` : `GitHub 返回 HTTP ${status}：${message}`,
                status,
            };
        }
        let payload;
        try {
            payload = await response.json();
        }
        catch {
            return { kind: 'error', message: 'GitHub 返回的内容无法解析', status };
        }
        const items = payload.items;
        const repos = Array.isArray(items)
            ? items.filter((item) => item !== null && typeof item === 'object')
            : [];
        const newEtag = headerOf(response, 'etag');
        if (newEtag !== undefined)
            this.etags.set(etagKey, newEtag);
        return { kind: 'ok', repos, ...(quota === undefined ? {} : { quota }), ...(newEtag === undefined ? {} : { etag: newEtag }) };
    }
    async readMessage(response) {
        try {
            const json = response.json;
            if (typeof json === 'function') {
                const payload = (await json.call(response));
                if (typeof payload.message === 'string')
                    return payload.message.slice(0, 120);
            }
        }
        catch {
            // fall through
        }
        return '';
    }
    /** `GET /rate_limit` — used by the settings page's 「测试连接」 button. */
    async rateLimit() {
        return this.enqueue(async () => {
            const init = { method: 'GET', headers: this.headers() };
            if (this.dispatcher !== undefined)
                init.dispatcher = this.dispatcher;
            try {
                const response = (await this.fetchImpl(`${this.baseUrl}/rate_limit`, init));
                const status = typeof response.status === 'number' ? response.status : 0;
                if (status !== 200) {
                    return { ok: false, message: `HTTP ${status}` };
                }
                const payload = (await response.json?.());
                const search = payload?.resources?.search;
                if (search === undefined)
                    return { ok: true };
                const quota = {
                    remaining: typeof search.remaining === 'number' ? search.remaining : 0,
                    limit: typeof search.limit === 'number' ? search.limit : 0,
                    resetAt: typeof search.reset === 'number' ? search.reset : 0,
                };
                this.quota = quota;
                return { ok: true, quota };
            }
            catch (error) {
                return { ok: false, message: error instanceof Error ? error.message : String(error) };
            }
        });
    }
}
