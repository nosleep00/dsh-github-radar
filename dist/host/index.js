/**
 * Host half of dsh-github-radar (S05, S08, S19).
 *
 * Responsibilities:
 *   - own the engine (signals -> GitHub -> cards) and the JSON stores,
 *   - serve the panel over same-origin HTTP routes under `/radar/*`,
 *   - keep the resolved settings in sync with the profile's plugin row.
 *
 * The panel is a client-side tab; it never talks to GitHub directly, so the
 * token and the rate-limit queue stay on the host.
 */
import { Buffer } from 'node:buffer';
import { appendFileSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { RadarEngine } from './engine.js';
import { GithubClient, createProxyDispatcher } from './github.js';
import { summarizeCards } from './summarize.js';
import { createStore, JsonFile, pluginDataDir, pruneFeedback } from './store.js';
const VERSION = '0.1.0';
export const name = 'dsh-github-radar';
/** Services this plugin needs; every one is read defensively anyway. */
export const inject = ['webServer', 'sessions', 'connection'];
const SETTINGS_NS = 'dsh-github-radar';
export const DEFAULT_SETTINGS = {
    enableAiSummary: true,
    minStars: 30,
    maxCards: 5,
    refreshDebounceMs: 75_000,
    languages: [],
    chineseOnly: false,
    githubToken: '',
    proxyUrl: '',
    allowNetwork: true,
};
// ---------------------------------------------------------------------------
// Config schema (optional: a runtime without schemastery still works).
// ---------------------------------------------------------------------------
let Config;
try {
    const mod = (await import('@deepseek-ai/schemastery'));
    const Schema = (mod.default ?? mod);
    Config = Schema.object({
        enableAiSummary: Schema.boolean().default(true),
        minStars: Schema.number().default(30),
        maxCards: Schema.number().default(5),
        refreshDebounceMs: Schema.number().default(75_000),
        languages: Schema.array(Schema.string()).default([]),
        chineseOnly: Schema.boolean().default(false),
        githubToken: Schema.string().default(''),
        proxyUrl: Schema.string().default(''),
        allowNetwork: Schema.boolean().default(true),
    });
}
catch {
    Config = undefined;
}
export { Config };
// ---------------------------------------------------------------------------
// Small helpers.
// ---------------------------------------------------------------------------
/**
 * Append one line to `<plugin-data>/requests.jsonl`.
 *
 * The panel is a browser tab, so "it keeps spinning" can mean four very
 * different things: the request never arrived, the auth fence rejected it, the
 * handler threw, or it is simply slow. Without a record we are guessing; this
 * file turns the guess into a fact. Diagnostics must never break a request, so
 * every failure here is swallowed.
 */
function logRequest(entry) {
    try {
        const dir = pluginDataDir();
        mkdirSync(dir, { recursive: true });
        const file = `${dir}/requests.jsonl`;
        let size = 0;
        try {
            size = statSync(file).size;
        }
        catch {
            size = 0;
        }
        if (size > 200_000)
            writeFileSync(file, '');
        appendFileSync(file, `${JSON.stringify(entry)}\n`, 'utf8');
    }
    catch {
        /* diagnostics only */
    }
}
function readField(value) {
    if (value !== null && typeof value === 'object' && typeof value.get === 'function') {
        try {
            return value.get();
        }
        catch {
            return undefined;
        }
    }
    return value;
}
function asString(value, fallback = '') {
    const raw = readField(value);
    return typeof raw === 'string' ? raw : fallback;
}
function asNumber(value, fallback) {
    const raw = readField(value);
    const parsed = typeof raw === 'number' ? raw : Number(raw);
    return Number.isFinite(parsed) ? parsed : fallback;
}
function asBoolean(value, fallback) {
    const raw = readField(value);
    return typeof raw === 'boolean' ? raw : fallback;
}
function asStringArray(value) {
    const raw = readField(value);
    if (!Array.isArray(raw))
        return [];
    return raw.filter((item) => typeof item === 'string' && item.trim() !== '').map((item) => item.trim());
}
function clampSettings(input, base) {
    const merged = { ...base, ...input };
    return {
        enableAiSummary: merged.enableAiSummary !== false,
        minStars: Math.min(100_000, Math.max(0, Math.round(merged.minStars || 0))),
        maxCards: Math.min(10, Math.max(1, Math.round(merged.maxCards || 5))),
        refreshDebounceMs: Math.min(3_600_000, Math.max(15_000, Math.round(merged.refreshDebounceMs || 75_000))),
        languages: merged.languages.map((lang) => lang.trim()).filter((lang) => lang !== ''),
        chineseOnly: merged.chineseOnly === true,
        githubToken: merged.githubToken.trim(),
        proxyUrl: merged.proxyUrl.trim(),
        allowNetwork: merged.allowNetwork !== false,
    };
}
function readSettings(config) {
    const record = (config ?? {});
    return clampSettings({
        enableAiSummary: asBoolean(record.enableAiSummary, DEFAULT_SETTINGS.enableAiSummary),
        minStars: asNumber(record.minStars, DEFAULT_SETTINGS.minStars),
        maxCards: asNumber(record.maxCards, DEFAULT_SETTINGS.maxCards),
        refreshDebounceMs: asNumber(record.refreshDebounceMs, DEFAULT_SETTINGS.refreshDebounceMs),
        languages: asStringArray(record.languages),
        chineseOnly: asBoolean(record.chineseOnly, DEFAULT_SETTINGS.chineseOnly),
        githubToken: asString(record.githubToken),
        proxyUrl: asString(record.proxyUrl),
        allowNetwork: asBoolean(record.allowNetwork, DEFAULT_SETTINGS.allowNetwork),
    }, DEFAULT_SETTINGS);
}
// ---------------------------------------------------------------------------
// Plugin entry.
// ---------------------------------------------------------------------------
export function apply(ctx, config) {
    try {
        setup(ctx, config);
    }
    catch (error) {
        // A plugin that cannot start must not take the host down with it.
        try {
            ctx.logger?.warn?.(`[github-radar] 启动失败：${describeError(error)}`);
        }
        catch {
            /* ignore */
        }
    }
}
function describeError(error) {
    return error instanceof Error ? error.message : String(error);
}
function setup(ctx, config) {
    const log = (message) => {
        try {
            ctx.logger?.info?.(`[github-radar] ${message}`);
        }
        catch {
            /* ignore */
        }
    };
    const warn = (message) => {
        try {
            ctx.logger?.warn?.(`[github-radar] ${message}`);
        }
        catch {
            /* ignore */
        }
    };
    const getService = (service) => {
        try {
            return ctx.get?.(service) ?? ctx[service];
        }
        catch {
            return undefined;
        }
    };
    const store = createStore();
    try {
        const marker = new JsonFile(`${pluginDataDir()}/boot.json`, () => ({ at: 0, version: '' }));
        void marker.write({ at: Date.now(), version: VERSION });
    }
    catch {
        /* a missing marker file is not a reason to fail the mount */
    }
    // --- settings -----------------------------------------------------------
    let overrides = {};
    let editor;
    let legacyScope;
    /**
     * Whether the L2 path can actually run in this host (llm service + the
     * `@deepseek-ai/dsh-llm` helper module). Resolved lazily, cached; the panel
     * uses it to be honest about "AI 摘要暂时不可用，先用模板摘要".
     */
    let aiReady;
    async function probeAi() {
        let llmOk = false;
        try {
            const llm = getService('llm');
            llmOk = llm !== undefined && typeof llm.stream === 'function';
        }
        catch {
            llmOk = false;
        }
        return { llm: llmOk };
    }
    async function resolveAiReady() {
        if (aiReady !== undefined)
            return aiReady;
        try {
            const probe = await probeAi();
            aiReady = probe.llm;
        }
        catch {
            aiReady = false;
        }
        return aiReady;
    }
    const currentSettings = () => {
        let raw = config;
        if (legacyScope !== undefined && typeof legacyScope.get === 'function') {
            try {
                const scoped = legacyScope.get();
                if (scoped !== undefined && scoped !== null)
                    raw = scoped;
            }
            catch {
                /* fall back to the composed config */
            }
        }
        return clampSettings({ ...readSettings(raw), ...overrides }, DEFAULT_SETTINGS);
    };
    // --- github client + engine --------------------------------------------
    const client = new GithubClient({ token: currentSettings().githubToken });
    let proxyUrl = '';
    const engine = new RadarEngine({
        getEvents: (sessionId) => {
            const sessions = getService('sessions');
            const events = sessions?.get?.(sessionId)?.snapshotEvents?.() ?? [];
            const out = [];
            for (const event of events) {
                const record = event;
                if (record === undefined || typeof record.type !== 'string')
                    continue;
                out.push({
                    type: record.type,
                    ...(typeof record.time === 'number' ? { time: record.time } : {}),
                    ...(record.data !== null && typeof record.data === 'object'
                        ? { data: record.data }
                        : {}),
                });
            }
            return out;
        },
        settings: currentSettings,
        client,
        store,
        l2: makeL2(),
        log,
    });
    function makeL2() {
        return {
            async run(cards, sessionId, onBatch) {
                const llm = getService('llm');
                if (llm === undefined || typeof llm.stream !== 'function')
                    return;
                const route = resolveModelRoute(sessionId);
                const summaries = await store.summaries.read();
                const keyOf = (fullName, description) => `${fullName}\u0000${description}\u0000zh-CN`;
                // Keep the last reasoning on disk: "why is every card still template?"
                // is otherwise invisible from outside the host process.
                const trail = [];
                const trailLog = (message) => {
                    trail.push(message);
                    log(message);
                };
                let fresh = {};
                try {
                    fresh = await summarizeCards(cards.map(toPromptRepo), {
                        llm: llm,
                        ...(route?.provider === undefined ? {} : { provider: route.provider }),
                        ...(route?.model === undefined ? {} : { model: route.model }),
                        cachedZh: (repo) => summaries.entries[keyOf(repo.fullName, repo.description)]?.zh,
                        onBatch,
                        log: trailLog,
                    });
                }
                catch (error) {
                    trailLog(`AI 摘要异常：${describeError(error)}`);
                }
                try {
                    const file = new JsonFile(`${pluginDataDir()}/l2.json`, () => ({ at: 0, sessionId: '', requested: 0, produced: 0, route: null, trail: [] }));
                    await file.write({
                        at: Date.now(),
                        sessionId,
                        requested: cards.length,
                        produced: Object.keys(fresh).length,
                        route: route ?? null,
                        trail: trail.slice(-12),
                    });
                }
                catch {
                    /* diagnostics must never break a refresh */
                }
                // Only model answers are cached; the L1 template line is never stored,
                // so a later refresh can still get a real summary.
                const latest = await store.summaries.read();
                const now = Date.now();
                let dirty = false;
                for (const card of cards) {
                    const generated = fresh[card.fullName];
                    if (generated === undefined || generated === '')
                        continue;
                    const key = keyOf(card.fullName, card.descriptionEn);
                    if (latest.entries[key]?.zh === generated)
                        continue;
                    latest.entries[key] = { zh: generated, at: now };
                    dirty = true;
                }
                if (dirty) {
                    await store.summaries.write(latest);
                    await store.pruneSummaries();
                }
            },
        };
    }
    /** Apply a settings patch: memory first, then the profile patch. */
    async function writeSettings(patch) {
        overrides = { ...overrides, ...patch };
        if (editor !== undefined) {
            try {
                await editor.edit(patch);
            }
            catch (error) {
                warn(`设置写入 profile 失败（下次启动会丢失）：${describeError(error)}`);
            }
        }
        const next = currentSettings();
        client.setToken(next.githubToken);
        if (next.proxyUrl !== proxyUrl) {
            proxyUrl = next.proxyUrl;
            void applyProxy();
        }
        engine.invalidate();
        return next;
    }
    async function applyProxy() {
        const url = currentSettings().proxyUrl;
        if (url === '') {
            client.setProxy(undefined);
            return;
        }
        try {
            const dispatcher = await createProxyDispatcher(url);
            client.setProxy(dispatcher);
            if (dispatcher === undefined)
                warn('代理不可用（未安装 undici），已回退直连');
        }
        catch (error) {
            warn(`代理配置失败：${describeError(error)}`);
        }
    }
    // 0.2+: configEditor writes the profile patch (same path as the settings UI).
    try {
        ctx.inject?.(['configEditor'], (child) => {
            try {
                const face = child.configEditor;
                if (face === undefined || typeof face.edit !== 'function')
                    return;
                const own = ctx.fiber?.entry ?? null;
                const rows = typeof face.entries === 'function' ? face.entries() : [];
                const entry = rows.find((row) => row === own) ??
                    rows.find((row) => {
                        const options = row.options;
                        return options !== undefined && options.name === name;
                    });
                if (entry === undefined) {
                    warn('未找到本插件的配置条目，设置只会保存在内存里');
                    return;
                }
                editor = {
                    edit: (patch) => face.edit(entry, (previous) => ({ ...previous, ...patch })),
                };
                log('设置写入通道已就绪（configEditor）');
            }
            catch (error) {
                warn(`configEditor 接入跳过：${describeError(error)}`);
            }
        });
    }
    catch {
        /* older runtime without ctx.inject for services */
    }
    // 0.1.x fallback: the legacy settings scope.
    try {
        ctx.inject?.(['settings'], (child) => {
            try {
                const settings = child.settings;
                if (settings === undefined || typeof settings.register !== 'function')
                    return;
                if (Config === undefined)
                    return;
                const scope = settings.register(SETTINGS_NS, Config, { base: config });
                legacyScope = scope;
                log('设置读取通道已就绪（legacy settings）');
            }
            catch {
                /* the configEditor path is the one that matters on 0.2 */
            }
        });
    }
    catch {
        /* ignore */
    }
    // --- session events ------------------------------------------------------
    function resolveModelRoute(sessionId) {
        const agents = getService('agents');
        const options = agents?.get?.(sessionId)?.options;
        if (options !== undefined &&
            typeof options.provider === 'string' &&
            options.provider !== '' &&
            typeof options.model === 'string' &&
            options.model !== '') {
            return { provider: options.provider, model: options.model };
        }
        const sessions = getService('sessions');
        const session = sessions?.get?.(sessionId);
        // `Session.requestContext()` carries the route of the current series: the
        // cheapest and most accurate source when the session is live.
        try {
            const context = typeof session?.requestContext === 'function' ? session.requestContext() : undefined;
            if (context !== undefined &&
                typeof context.provider === 'string' &&
                context.provider !== '' &&
                typeof context.model === 'string' &&
                context.model !== '') {
                return { provider: context.provider, model: context.model };
            }
        }
        catch {
            /* fall through to the event log */
        }
        const events = session?.snapshotEvents?.() ?? [];
        for (let index = events.length - 1; index >= 0; index -= 1) {
            const event = events[index];
            if (event?.type !== 'request/header')
                continue;
            const data = (event.data ?? {});
            if (typeof data.provider === 'string' && data.provider !== '' && typeof data.model === 'string' && data.model !== '') {
                return { provider: data.provider, model: data.model };
            }
        }
        const defaults = getService('agentDefaultModel');
        const selection = defaults?.currentSelection?.();
        if (selection !== null && typeof selection === 'object') {
            const record = selection;
            const provider = typeof record.provider === 'string' ? record.provider : '';
            const model = typeof record.model === 'string' ? record.model : '';
            if (provider !== '' && model !== '')
                return { provider, model };
        }
        return undefined;
    }
    // --- HTTP surface -------------------------------------------------------
    const webServer = getService('webServer');
    const connection = getService('connection');
    const cleanups = [];
    const registeredRoutes = [];
    function trusted(req) {
        if (connection === undefined || typeof connection.requestRejection !== 'function')
            return true;
        try {
            return connection.requestRejection({ headers: req.headers ?? {} }) === undefined;
        }
        catch {
            return true;
        }
    }
    function sendJson(res, status, body) {
        let payload;
        try {
            payload = Buffer.from(JSON.stringify(body), 'utf8');
        }
        catch {
            payload = Buffer.from('{"error":"serialize failed"}', 'utf8');
        }
        const headers = {
            'content-type': 'application/json; charset=utf-8',
            'content-length': String(payload.length),
            'cache-control': 'no-store',
        };
        try {
            if (typeof res.writeHead === 'function')
                res.writeHead(status, headers);
            else
                res.statusCode = status;
        }
        catch {
            res.statusCode = status;
        }
        try {
            res.end?.(payload);
        }
        catch {
            /* the socket went away */
        }
    }
    async function readBody(req) {
        if (typeof req[Symbol.asyncIterator] !== 'function')
            return {};
        const chunks = [];
        let bytes = 0;
        try {
            for await (const chunk of req) {
                const buffer = typeof chunk === 'string'
                    ? Buffer.from(chunk, 'utf8')
                    : chunk instanceof Uint8Array
                        ? Buffer.from(chunk)
                        : undefined;
                if (buffer === undefined)
                    continue;
                bytes += buffer.length;
                if (bytes > 64 * 1024)
                    break;
                chunks.push(buffer);
            }
        }
        catch {
            return {};
        }
        const text = Buffer.concat(chunks).toString('utf8').trim();
        if (text === '')
            return {};
        try {
            const parsed = JSON.parse(text);
            return parsed !== null && typeof parsed === 'object' ? parsed : {};
        }
        catch {
            return {};
        }
    }
    function queryOf(req) {
        try {
            return new URL(req.url ?? '/', 'http://127.0.0.1').searchParams;
        }
        catch {
            return new URLSearchParams();
        }
    }
    function sessionIdOf(raw) {
        if (typeof raw !== 'string')
            return undefined;
        const value = raw.trim();
        return value === '' || value.length > 200 ? undefined : value;
    }
    /**
     * Newest session id.
     *
     * The panel asks for its own session, but a tab body can be mounted without
     * one (an empty seat, a brand-new chat). Falling back to the newest session
     * is far better than answering 400 and leaving the pane on skeletons.
     */
    function newestSessionId() {
        const sessions = getService('sessions');
        const list = typeof sessions?.list === 'function' ? sessions.list() : [];
        let best;
        for (const entry of list) {
            const record = entry;
            const id = typeof record?.id === 'string' ? record.id : '';
            if (id === '')
                continue;
            const at = typeof record?.header?.createdAt === 'number' ? record.header.createdAt : 0;
            if (best === undefined || at > best.at)
                best = { id, at };
        }
        return best?.id;
    }
    function route(kind, path, handler) {
        if (webServer === undefined || typeof webServer.register !== 'function') {
            warn(`webServer 不可用，跳过路由 ${path}`);
            return;
        }
        try {
            const dispose = webServer.register({
                kind,
                path,
                handler: (req, res) => {
                    const startedAt = Date.now();
                    const method = (req.method ?? 'GET').toUpperCase();
                    const url = req.url ?? path;
                    const record = (status, note) => {
                        logRequest({
                            at: startedAt,
                            method,
                            url,
                            status,
                            ms: Date.now() - startedAt,
                            ...(note === undefined ? {} : { note }),
                        });
                    };
                    if (!trusted(req)) {
                        record(403, 'forbidden');
                        sendJson(res, 403, { error: 'forbidden' });
                        return;
                    }
                    Promise.resolve(handler(req, res))
                        .then(() => {
                        record(typeof res.statusCode === 'number' ? res.statusCode : 200);
                    })
                        .catch((error) => {
                        const message = describeError(error);
                        warn(`${path} 处理失败：${message}`);
                        record(500, message);
                        sendJson(res, 500, { error: message });
                    });
                },
            });
            if (typeof dispose === 'function')
                cleanups.push(dispose);
            registeredRoutes.push(`${kind}:${path}`);
        }
        catch (error) {
            warn(`注册路由 ${path} 失败：${describeError(error)}`);
        }
    }
    function publicSettings(settings) {
        return {
            enableAiSummary: settings.enableAiSummary,
            minStars: settings.minStars,
            maxCards: settings.maxCards,
            refreshDebounceMs: settings.refreshDebounceMs,
            languages: settings.languages,
            chineseOnly: settings.chineseOnly,
            githubToken: '',
            hasToken: settings.githubToken !== '',
            proxyUrl: settings.proxyUrl,
            allowNetwork: settings.allowNetwork,
            aiReady: aiReady === true,
        };
    }
    function stateFor(sessionId) {
        return engine.get(sessionId);
    }
    route('exact', '/radar/state', async (req, res) => {
        const sessionId = sessionIdOf(queryOf(req).get('sessionId')) ?? newestSessionId();
        if (sessionId === undefined) {
            sendJson(res, 400, { error: 'sessionId is required' });
            return;
        }
        if ((req.method ?? 'GET').toUpperCase() !== 'GET') {
            sendJson(res, 405, { error: 'method not allowed' });
            return;
        }
        sendJson(res, 200, { ...(await stateFor(sessionId)), sessionId });
    });
    route('exact', '/radar/refresh', async (req, res) => {
        const body = await readBody(req);
        const sessionId = sessionIdOf(body.sessionId ?? queryOf(req).get('sessionId')) ?? newestSessionId();
        if (sessionId === undefined) {
            sendJson(res, 400, { error: 'sessionId is required' });
            return;
        }
        const force = body.force === true;
        const state = force ? await engine.refreshNow(sessionId) : await engine.refresh(sessionId);
        sendJson(res, 200, { ...state, sessionId });
    });
    route('exact', '/radar/dismiss', async (req, res) => {
        const body = await readBody(req);
        const fullName = typeof body.fullName === 'string' ? body.fullName : '';
        if (fullName.trim() === '') {
            sendJson(res, 400, { error: 'fullName is required' });
            return;
        }
        const state = await engine.dismiss(fullName);
        const sessionId = sessionIdOf(body.sessionId) ?? newestSessionId();
        if (sessionId !== undefined) {
            sendJson(res, 200, state ?? (await engine.get(sessionId)));
            return;
        }
        sendJson(res, 200, state ?? { status: 'ready', cards: [] });
    });
    route('exact', '/radar/click', async (req, res) => {
        const body = await readBody(req);
        const fullName = typeof body.fullName === 'string' ? body.fullName : '';
        if (fullName.trim() !== '')
            await engine.recordClick(fullName);
        sendJson(res, 200, { ok: true });
    });
    // The panel's chips are editable: a keyword list replaces extraction for that
    // session, a pasted error replaces the error chip, `reset` goes back to
    // automatic. Editing is interactive, so this forces a fresh query set.
    route('exact', '/radar/keywords', async (req, res) => {
        const method = (req.method ?? 'POST').toUpperCase();
        if (method !== 'POST') {
            sendJson(res, 405, { error: 'method not allowed' });
            return;
        }
        const body = await readBody(req);
        const sessionId = sessionIdOf(body.sessionId) ?? newestSessionId();
        if (sessionId === undefined) {
            sendJson(res, 400, { error: 'sessionId is required' });
            return;
        }
        const patch = {};
        if (Array.isArray(body.keywords)) {
            patch.keywords = body.keywords.filter((item) => typeof item === 'string');
        }
        if (body.errorText === null)
            patch.errorText = null;
        else if (typeof body.errorText === 'string')
            patch.errorText = body.errorText;
        if (body.reset === true)
            patch.reset = true;
        try {
            const state = await engine.setSignal(sessionId, patch);
            sendJson(res, 200, { sessionId, state });
        }
        catch (error) {
            sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
        }
    });
    route('exact', '/radar/settings', async (req, res) => {
        const method = (req.method ?? 'GET').toUpperCase();
        if (method === 'GET') {
            await resolveAiReady();
            sendJson(res, 200, publicSettings(currentSettings()));
            return;
        }
        if (method !== 'POST') {
            sendJson(res, 405, { error: 'method not allowed' });
            return;
        }
        const body = await readBody(req);
        const patch = {};
        if (typeof body.minStars === 'number')
            patch.minStars = body.minStars;
        if (typeof body.maxCards === 'number')
            patch.maxCards = body.maxCards;
        if (typeof body.refreshDebounceMs === 'number')
            patch.refreshDebounceMs = body.refreshDebounceMs;
        if (Array.isArray(body.languages))
            patch.languages = body.languages.filter((item) => typeof item === 'string');
        if (typeof body.chineseOnly === 'boolean')
            patch.chineseOnly = body.chineseOnly;
        if (typeof body.enableAiSummary === 'boolean')
            patch.enableAiSummary = body.enableAiSummary;
        if (typeof body.allowNetwork === 'boolean')
            patch.allowNetwork = body.allowNetwork;
        if (typeof body.proxyUrl === 'string')
            patch.proxyUrl = body.proxyUrl;
        if (typeof body.githubToken === 'string' && body.githubToken.trim() !== '')
            patch.githubToken = body.githubToken;
        if (body.clearToken === true)
            patch.githubToken = '';
        const next = await writeSettings(patch);
        await resolveAiReady();
        sendJson(res, 200, publicSettings(next));
    });
    // Client-side failures (a thrown `apply`, a broken bundle, a render crash)
    // are invisible from the Host: the browser console is not ours. The panel
    // posts them here so they land in a file we can read.
    route('exact', '/radar/client-error', async (req, res) => {
        const body = await readBody(req);
        const dir = pluginDataDir();
        try {
            mkdirSync(dir, { recursive: true });
            const record = {
                at: Date.now(),
                kind: typeof body.kind === 'string' ? body.kind.slice(0, 40) : 'unknown',
                message: typeof body.message === 'string' ? body.message.slice(0, 600) : '',
                stack: typeof body.stack === 'string' ? body.stack.slice(0, 4000) : '',
                url: typeof body.url === 'string' ? body.url.slice(0, 300) : '',
                agent: typeof body.agent === 'string' ? body.agent.slice(0, 200) : '',
            };
            const file = `${dir}/client-errors.jsonl`;
            appendFileSync(file, `${JSON.stringify(record)}\n`, 'utf8');
            const size = statSync(file).size;
            if (size > 200_000)
                writeFileSync(file, '', 'utf8');
        }
        catch (error) {
            warn(`记录客户端错误失败：${error instanceof Error ? error.message : String(error)}`);
        }
        sendJson(res, 200, { ok: true });
    });
    route('exact', '/radar/token-check', async (req, res) => {
        const body = await readBody(req);
        const token = typeof body.token === 'string' ? body.token.trim() : '';
        const candidate = new GithubClient({ token });
        const result = await candidate.rateLimit();
        sendJson(res, 200, { ok: result.ok === true, quota: result.quota ?? null, message: result.message ?? '' });
    });
    if (webServer === undefined)
        warn('webServer 服务不可用，面板将无法取数');
    // --- lifecycle ----------------------------------------------------------
    try {
        ctx.effect?.(() => () => {
            for (const dispose of cleanups) {
                try {
                    dispose();
                }
                catch {
                    /* ignore */
                }
            }
            cleanups.length = 0;
            engine.dispose();
        });
    }
    catch {
        /* ignore */
    }
    void applyProxy();
    void pruneFeedback(store);
    // Warm the newest live session so the panel opens on cards instead of a
    // skeleton. `refresh` still honours the debounce and the fresh-cache fast
    // path, so this costs at most one real request per idle period.
    void (async () => {
        try {
            const sessions = getService('sessions');
            const list = typeof sessions?.list === 'function' ? sessions.list() : [];
            let best;
            for (const entry of list) {
                const record = entry;
                const id = typeof record?.id === 'string' ? record.id : '';
                if (id === '')
                    continue;
                const at = typeof record?.header?.createdAt === 'number' ? record.header.createdAt : 0;
                if (best === undefined || at > best.at)
                    best = { id, at };
            }
            if (best === undefined)
                return;
            await engine.refresh(best.id, false);
            log(`已预热最近会话的雷达数据（${best.id}）`);
        }
        catch (error) {
            warn(`预热跳过：${describeError(error)}`);
        }
    })();
    // Record whether L2 can run in this host. Kept on disk so a support question
    // ("why are all cards template?") can be answered without opening the panel.
    void (async () => {
        const ready = await resolveAiReady();
        try {
            const probe = await probeAi();
            const file = new JsonFile(`${pluginDataDir()}/ai-probe.json`, () => ({ at: 0, ready: false, llm: false, version: '' }));
            await file.write({ at: Date.now(), ready, ...probe, version: VERSION });
        }
        catch {
            /* diagnostics must never break the mount */
        }
    })();
    // Record which routes this mount actually managed to register: a missing
    // route is indistinguishable from a broken client unless it is written down.
    void (async () => {
        try {
            const routesFile = new JsonFile(`${pluginDataDir()}/routes.json`, () => ({ at: 0, version: '', webServer: false, routes: [] }));
            await routesFile.write({
                at: Date.now(),
                version: VERSION,
                webServer: webServer !== undefined,
                routes: registeredRoutes,
            });
        }
        catch {
            /* diagnostics must never break the mount */
        }
    })();
    log('GitHub 雷达已启动');
}
function toPromptRepo(card) {
    return {
        fullName: card.fullName,
        description: card.descriptionEn,
        topics: card.topics,
        language: card.language,
        stars: card.stars,
    };
}
