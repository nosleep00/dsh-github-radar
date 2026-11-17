/**
 * Query construction (S11).
 *
 * Hard limits: at most 3 GitHub queries per refresh, at most 60 candidates
 * collected. Every query is derivable from the de-identified signal only, so
 * the builder is pure and unit-testable.
 */
/** Chinese requirement words -> the English term that actually finds repos. */
export const CN_TECH_MAP = {
    爬虫: 'crawler',
    抓取: 'scraper',
    命令行: 'cli',
    终端: 'terminal',
    界面: 'ui',
    前端: 'frontend',
    后端: 'backend',
    数据库: 'database',
    缓存: 'cache',
    消息队列: 'queue',
    机器学习: 'machine learning',
    大模型: 'llm',
    大语言模型: 'llm',
    智能体: 'agent',
    提示词: 'prompt',
    知识库: 'rag',
    检索增强: 'rag',
    向量: 'vector',
    微服务: 'microservice',
    容器: 'docker',
    容器编排: 'kubernetes',
    部署: 'deploy',
    监控: 'monitoring',
    日志: 'logging',
    代理: 'proxy',
    反向代理: 'reverse proxy',
    自动化: 'automation',
    测试: 'testing',
    文档: 'documentation',
    图片: 'image',
    视频: 'video',
    音频: 'audio',
    游戏: 'game',
    编译器: 'compiler',
    解析器: 'parser',
    打包: 'bundler',
    构建: 'build',
    代码检查: 'linter',
    格式化: 'formatter',
    插件: 'plugin',
    爬取: 'crawler',
    下载: 'downloader',
    压缩: 'compression',
    加密: 'encryption',
    图表: 'chart',
    可视化: 'visualization',
    数据处理: 'data processing',
    并发: 'concurrency',
    高性能: 'high performance',
    跨平台: 'cross-platform',
    桌面: 'desktop',
    移动端: 'mobile',
    重试: 'retry',
    重试机制: 'retry',
    限流: 'rate limit',
    定时任务: 'scheduler',
    队列: 'queue',
    链路追踪: 'tracing',
    打点: 'telemetry',
    验证码: 'captcha',
    截图: 'screenshot',
    断点续传: 'resume download',
    反爬: 'anti-crawler',
    代理池: 'proxy pool',
    全文搜索: 'full text search',
    搜索引擎: 'search engine',
    代码补全: 'code completion',
    语音识别: 'speech recognition',
    文字转语音: 'text to speech',
    电子表格: 'spreadsheet',
    幻灯片: 'slides',
    思维导图: 'mindmap',
};
const MAX_QUERY_LENGTH = 256;
const QUOTABLE = /[\s"+\-:/]/;
/** Map a Chinese keyword to English; returns the input when unknown. */
export function mapKeyword(keyword) {
    const trimmed = keyword.trim();
    if (!/[\u4e00-\u9fff]/.test(trimmed))
        return trimmed;
    return CN_TECH_MAP[trimmed] ?? trimmed;
}
function cleanKeyword(keyword) {
    return mapKeyword(keyword)
        .replace(/["\\]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}
function quote(term) {
    return QUOTABLE.test(term) && !term.startsWith('"') ? `"${term}"` : term;
}
/**
 * Reduce an error line to the few words worth searching the readme for.
 *
 * `ConnectionError: Max retries exceeded` -> `Max retries exceeded`, because the
 * message head is what a README usually quotes verbatim; the exception class is
 * the fallback for lines that carry no message.
 */
export function errorExcerpt(errorText) {
    if (errorText === undefined || errorText.trim() === '')
        return '';
    const line = errorText.split(/\r?\n/).find((l) => /\S/.test(l)) ?? errorText;
    const noisy = new Set([
        'error', 'errors', 'exception', 'traceback', 'file', 'line', 'at', 'in',
        'the', 'a', 'an', 'of', 'to', 'for', 'on', 'is', 'not', 'no', 'and',
        'most', 'recent', 'call', 'last', 'during', 'handling', 'above', 'this',
        'while', 'occurred', 'raised', 'caused', 'by', 'was', 'with', 'from',
        'module', 'package', 'statement', 'syntax', 'usermodule',
        'pip', 'pip3', 'npm', 'yarn', 'pnpm', 'install', 'installed', 'version',
        'cmd', 'command', 'run', 'running', 'true', 'false', 'none', 'null',
    ]);
    const head = line.replace(/^[^:]{0,60}:\s*/, '');
    const words = head.match(/[A-Za-z][A-Za-z0-9_.+#-]{2,}/g) ?? [];
    const headWords = [];
    for (const word of words) {
        if (noisy.has(word.toLowerCase()))
            continue;
        if (headWords.some((p) => p.toLowerCase() === word.toLowerCase()))
            continue;
        headWords.push(word);
        if (headWords.length >= 4)
            break;
    }
    if (headWords.length >= 2) {
        const phrase = headWords.slice(0, 3).join(' ').slice(0, 80);
        if (phrase.length >= 8)
            return phrase;
    }
    // Fall back to the exception class name (`ModuleNotFoundError`, `ECONNRESET`).
    const classes = line.match(/\b[A-Za-z_][A-Za-z0-9_.]*(?:Error|Exception)\b/g) ?? [];
    const className = classes[0];
    if (className !== undefined)
        return className.slice(0, 80);
    return headWords[0]?.slice(0, 80) ?? '';
}
function languageClause(languages) {
    const first = languages.find((l) => typeof l === 'string' && l.trim() !== '');
    return first === undefined ? '' : ` language:${first.trim()}`;
}
/** Error shape -> the library category that actually solves it. */
const ERROR_CONCEPTS = [
    {
        test: /(?:ECONNRESET|ECONNREFUSED|ConnectionError|Max retries|retries exceeded|timed out|timeout|ETIMEDOUT|ReadTimeout|ConnectTimeout|URLError|socket hang up)/i,
        terms: ['retry', 'backoff'],
    },
    { test: /(?:rate limit|429|too many requests|secondary rate)/i, terms: ['rate limit', 'throttle'] },
    { test: /(?:CORS|Access-Control-Allow|cross-origin)/i, terms: ['cors'] },
    { test: /(?:JSONDecode|JSONParse|Unexpected token|Expecting value|invalid json)/i, terms: ['json parser'] },
    { test: /(?:UnicodeDecodeError|UnicodeEncodeError|codec can't|charset)/i, terms: ['encoding', 'charset'] },
    { test: /(?:PermissionError|EACCES|EPERM|permission denied)/i, terms: ['permissions'] },
    { test: /(?:ENOSPC|No space left)/i, terms: ['disk usage'] },
    { test: /(?:certificate|SSL|CERT_|TLS)/i, terms: ['ssl certificate'] },
    { test: /(?:MemoryError|out of memory|OOM|heap out of memory)/i, terms: ['memory'] },
    { test: /(?:Segmentation fault|SIGSEGV|segfault)/i, terms: ['debugger'] },
    { test: /(?:No module named|ModuleNotFoundError|Cannot find module|module not found|could not import)/i, terms: [] },
];
/** Package names quoted by an import error — the best possible search term. */
const PACKAGE_PATTERNS = [
    /No module named ['"`]([A-Za-z0-9_.-]{2,40})['"`]/i,
    /Cannot find module ['"`]([@A-Za-z0-9_./-]{2,60})['"`]/i,
    /(?:pip|npm|pnpm|yarn|cargo|go get|gem|composer|brew)\s+(?:install|add|get|require)\s+(?:-{1,2}[\w-]+\s+)*([A-Za-z0-9@_./:-]{2,60})/i,
    /module ['"`]?([A-Za-z0-9_./-]{2,40})['"`]? not found/i,
];
/**
 * Turn an error into up to two *concept* queries (S11 refinement).
 *
 * A readme phrase search sorted by stars matches multi-million-star repos whose
 * readme happens to contain the words — it never surfaces the small library that
 * solves the problem. The category term (`retry`, `cors`, `encoding`) plus an
 * explicit package name, when the error quotes one, is what actually works.
 */
export function errorQueries(errorText) {
    if (errorText === undefined || errorText.trim() === '')
        return [];
    const terms = [];
    const push = (term) => {
        const value = term.trim();
        if (value === '' || value.length < 2)
            return;
        if (terms.some((t) => t.toLowerCase() === value.toLowerCase()))
            return;
        terms.push(value);
    };
    for (const pattern of PACKAGE_PATTERNS) {
        const match = pattern.exec(errorText);
        const name = match?.[1];
        if (name !== undefined)
            push(name);
    }
    for (const concept of ERROR_CONCEPTS) {
        if (concept.test.test(errorText)) {
            for (const term of concept.terms)
                push(term);
        }
    }
    return terms.slice(0, 2);
}
/** Build the query list for one refresh: at most `maxQueries` entries. */
export function buildQueries(signal, options) {
    const maxQueries = Math.max(1, Math.min(options.maxQueries ?? 3, 3));
    const minStars = Number.isFinite(options.minStars) ? Math.max(0, Math.floor(options.minStars)) : 0;
    const languages = Array.isArray(options.languages) ? options.languages : [];
    const keywords = [];
    const excerpt = errorExcerpt(signal.errorText);
    const excerptLower = excerpt.toLowerCase();
    for (const raw of Array.isArray(signal.keywords) ? signal.keywords : []) {
        if (typeof raw !== 'string')
            continue;
        const keyword = cleanKeyword(raw);
        if (keyword === '' || keyword.length < 2)
            continue;
        // The error gets its own dedicated query; repeating its tokens in a
        // name/description query only finds libraries that mention the exception.
        if (/(?:error|exception)$/i.test(keyword))
            continue;
        if (excerptLower !== '' && excerptLower.includes(keyword.toLowerCase()))
            continue;
        if (!keywords.some((k) => k.toLowerCase() === keyword.toLowerCase()))
            keywords.push(keyword);
        if (keywords.length >= 5)
            break;
    }
    if (keywords.length === 0 && excerpt === '')
        return [];
    // One language only: push it into the query for precision. Several: leave it
    // to the ranker, otherwise the query count explodes.
    const langSuffix = languages.length === 1 ? languageClause(languages) : '';
    const starSuffix = minStars > 0 ? ` stars:>=${minStars}` : '';
    const queries = [];
    const add = (query) => {
        const value = query.replace(/\s+/g, ' ').trim().slice(0, MAX_QUERY_LENGTH);
        if (value === '')
            return;
        if (queries.some((q) => q.toLowerCase() === value.toLowerCase()))
            return;
        queries.push(value);
    };
    // The error gets the first slots: concept query, then the readme phrase only
    // when the error carries no recognisable category or package.
    const concepts = errorQueries(signal.errorText).slice(0, keywords.length === 0 ? 2 : 1);
    for (const concept of concepts) {
        if (queries.length >= maxQueries)
            break;
        add(`${quote(concept)} in:name,description,topics${starSuffix}`);
    }
    if (concepts.length === 0 && excerpt !== '')
        add(`"${excerpt}" in:readme`);
    for (const keyword of keywords) {
        if (queries.length >= maxQueries)
            break;
        add(`${quote(keyword)} in:name,description,topics${starSuffix}${langSuffix}`);
    }
    // chineseOnly recall compensation: keep one slot for a Chinese-topic query.
    if (options.chineseOnly) {
        const anchor = keywords[0] ?? '';
        const compensation = anchor === '' ? 'topic:chinese' : `topic:chinese ${quote(anchor)}`;
        if (queries.length >= maxQueries)
            queries.pop();
        add(compensation);
    }
    return queries.slice(0, maxQueries);
}
function isoDay(ms, daysAgo) {
    const date = new Date(ms - daysAgo * 86_400_000);
    return date.toISOString().slice(0, 10);
}
/**
 * What to show when the session said nothing useful yet.
 *
 * "Hot right now" = pushed recently + real traction. Three star *bands*, each
 * with its own recency window: an open-ended `sort=stars` query only ever
 * returns the 300k–600k star evergreen lists (freeCodeCamp, public-apis), and a
 * `created:` window mostly surfaces hype repos. The bands also give the ranker
 * three groups to interleave, so the panel is not five repos of the same size.
 * Everything is stable for a day, so the cache key is simply the day.
 */
export function buildTrendingQueries(options) {
    const now = Number.isFinite(options.now) ? options.now : Date.now();
    const minStars = Number.isFinite(options.minStars) ? Math.max(0, Math.floor(options.minStars)) : 0;
    const languages = Array.isArray(options.languages) ? options.languages : [];
    const language = languages.length === 1 ? languageClause(languages) : '';
    const chinese = options.chineseOnly ? ' topic:chinese' : '';
    // Below ~1k stars a "popular" list is just dust; raising `minStars` pushes the
    // whole ladder up so the bands still mean something.
    const base = Math.max(1_000, minStars * 10);
    const high = Math.max(base * 60, 60_000);
    const queries = [];
    queries.push(`stars:${base}..${base * 3 - 1} pushed:>=${isoDay(now, 14)}${language}${chinese}`);
    queries.push(`stars:${base * 3}..${base * 10 - 1} pushed:>=${isoDay(now, 10)}${language}${chinese}`);
    queries.push(`stars:${base * 10}..${high} pushed:>=${isoDay(now, 7)}${language}${chinese}`);
    return queries.map((query) => query.replace(/\s+/g, ' ').trim().slice(0, MAX_QUERY_LENGTH));
}
/** A cache hash that rolls over once a day, for the trending fallback. */
export function trendingHash(options) {
    return stableHash(`trend:${isoDay(options.now ?? Date.now(), 0)}:${JSON.stringify(buildTrendingQueries(options))}`);
}
/** djb2 — short, dependency free and stable across runs. */
export function stableHash(payload) {
    let hash = 5381;
    for (let i = 0; i < payload.length; i += 1) {
        hash = ((hash << 5) + hash + payload.charCodeAt(i)) | 0;
    }
    return (hash >>> 0).toString(36);
}
/** Stable hash of everything that influences the result set (S15 cache key). */
export function queryHash(signal, options) {
    const queries = buildQueries(signal, options);
    const payload = JSON.stringify({
        queries,
        languages: [...(options.languages ?? [])].sort(),
        chineseOnly: options.chineseOnly === true,
        minStars: options.minStars,
    });
    return `q${stableHash(payload)}`;
}
