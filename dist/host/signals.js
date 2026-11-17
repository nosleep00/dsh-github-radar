import { CN_TECH_MAP, stableHash } from './query.js';
const STOPWORDS = new Set([
    'the', 'this', 'that', 'with', 'from', 'please', 'help', 'want', 'need',
    'code', 'file', 'files', 'line', 'error', 'errors', 'function', 'value',
    'name', 'true', 'false', 'none', 'null', 'string', 'number', 'list', 'dict',
    'object', 'should', 'would', 'could', 'using', 'use', 'used', 'make', 'made',
    'like', 'just', 'also', 'but', 'and', 'for', 'you', 'your', 'our', 'their',
    'have', 'has', 'had', 'will', 'been', 'was', 'were', 'are', 'is', 'it',
    'its', 'not', 'all', 'any', 'some', 'more', 'most', 'very', 'when', 'then',
    'than', 'there', 'here', 'what', 'which', 'who', 'how', 'why', 'does', 'did',
    'doing', 'get', 'got', 'set', 'put', 'let', 'may', 'might', 'must', 'only',
    'over', 'into', 'about', 'after', 'before', 'because', 'between', 'other',
    'same', 'such', 'take', 'them', 'these', 'those', 'too', 'under', 'until',
    'upon', 'while', 'without', 'now', 'new', 'old', 'one', 'two', 'three',
    'first', 'last', 'next', 'still', 'even', 'back', 'way', 'thing', 'things',
    'something', 'anything', 'nothing', 'work', 'works', 'working', 'problem',
    'problems', 'issue', 'issues', 'case', 'cases', 'trying', 'tried', 'try',
    'looks', 'look', 'see', 'seen', 'run', 'runs', 'running', 'ran', 'call',
    'called', 'calls', 'returns', 'return', 'returned', 'throws', 'threw',
    'throw', 'fails', 'failed', 'fail', 'failing', 'happens', 'happened',
    'output', 'input', 'result', 'results', 'part', 'parts', 'time', 'times',
    'step', 'steps', 'way', 'type', 'types', 'data', 'item', 'items', 'here',
    'check', 'change', 'changed', 'changes', 'add', 'added', 'adds', 'remove',
    'removed', 'update', 'updated', 'create', 'created', 'install', 'installed',
    'installing', 'package', 'packages', 'version', 'versions', 'command',
    'commands', 'terminal', 'console', 'script', 'scripts', 'project',
    'projects', 'module', 'modules', 'import', 'imports', 'class', 'method',
    'methods', 'param', 'params', 'argument', 'arguments', 'config', 'option',
    'options', 'default', 'defaults', 'required', 'missing', 'expected',
    'unexpected', 'invalid', 'unknown', 'supported', 'support', 'unable',
    'failed', 'cannot', 'can', 'could', 'did', 'does', 'just', 'maybe', 'also',
    'max', 'min', 'sum', 'avg', 'url', 'urls', 'path', 'paths', 'len', 'str',
    'int', 'float', 'bool', 'array', 'map', 'key', 'keys', 'index', 'value',
    // File names and boilerplate verbs that survive tokenising: `方案.md` -> `md`.
    'md', 'txt', 'json', 'yaml', 'yml', 'toml', 'cfg', 'ini', 'lock', 'license',
    'licence', 'changelog', 'gitignore', 'require', 'requires', 'ensure',
]);
/**
 * Vocabulary of the harness itself (notices, skill catalogue, policy text).
 *
 * These words leak in through runtime context and system notices; as GitHub
 * search terms they find nothing a developer wants ("approval", "skill").
 */
const HARNESS_TERMS = new Set([
    'skill', 'skills', 'user', 'users', 'approval', 'approve', 'approved', 'prompt',
    'prompts', 'reminder', 'reminders', 'available', 'catalog', 'catalogue', 'plugin',
    'plugins', 'harness', 'snapshot', 'snapshots', 'policy', 'runtime', 'directory',
    'checkout', 'tokens', 'message', 'messages', 'content', 'system', 'assistant',
    'tools', 'tool', 'agent', 'agents', 'session', 'sessions', 'follow', 'ask',
    'asked', 'disable', 'disabled', 'enable', 'enabled', 'settings', 'config',
    'web', 'gui', 'port', 'zone', 'zones', 'elapsed', 'interpret', 'otherwise',
    'unqualified', 'context', 'contexts', 'current', 'browser', 'timezone',
    // Build/CI vocabulary and English filler that survives tokenising as a
    // plausible word ("release", "objective", "self-contained", "never").
    'release', 'releases', 'objective', 'objectives', 'self-contained', 'contained',
    'never', 'maybe', 'really', 'again', 'still', 'already', 'something', 'anything',
    'everything', 'could', 'would', 'should', 'must', 'might',
]);
const CJK_STOPWORDS = new Set([
    '我们', '这个', '那个', '怎么', '为什么', '可以', '帮我', '看看', '一下',
    '问题', '现在', '需要', '应该', '如果', '但是', '然后', '还是', '已经',
    '一直', '因为', '所以', '这里', '那里', '什么', '如何', '没有', '不是',
    '就是', '可能', '有点', '时候', '东西', '觉得', '希望', '麻烦', '谢谢',
]);
/** Terms that reliably find repositories on GitHub. */
const TECH_HINTS = new Set([
    'docker', 'kubernetes', 'k8s', 'python', 'typescript', 'javascript', 'rust',
    'golang', 'java', 'kotlin', 'swift', 'ruby', 'php', 'react', 'vue',
    'svelte', 'nextjs', 'nuxt', 'node', 'deno', 'bun', 'pnpm', 'npm', 'yarn',
    'vite', 'webpack', 'rollup', 'esbuild', 'pydantic', 'fastapi', 'django',
    'flask', 'numpy', 'pandas', 'polars', 'pytest', 'poetry', 'uv', 'pip',
    'conda', 'postgres', 'postgresql', 'mysql', 'sqlite', 'redis', 'mongodb',
    'clickhouse', 'kafka', 'rabbitmq', 'nats', 'grpc', 'graphql', 'rest',
    'openapi', 'llm', 'rag', 'agent', 'agents', 'mcp', 'embedding', 'vector',
    'transformer', 'ollama', 'llama', 'openai', 'langchain', 'langgraph',
    'ffmpeg', 'playwright', 'puppeteer', 'selenium', 'git', 'github', 'gitea',
    'tmux', 'neovim', 'vscode', 'emacs', 'ripgrep', 'fzf', 'bat', 'fd', 'jq',
    'yq', 'curl', 'wget', 'ssh', 'nginx', 'caddy', 'traefik', 'terraform',
    'ansible', 'prometheus', 'grafana', 'loki', 'opentelemetry', 'sentry',
    'tauri', 'electron', 'flutter', 'swiftui', 'jetpack', 'cmake', 'bazel',
    'zig', 'wasm', 'webassembly', 'opencv', 'pytorch', 'tensorflow', 'jax',
    'huggingface', 'whisper', 'stable-diffusion', 'comfyui', 'obsidian',
    'markdown', 'latex', 'pandoc', 'excel', 'csv', 'parquet', 'arrow',
]);
/**
 * Words that appear in every second conversation. They are technically valid
 * GitHub search terms, but `sort=stars` turns them into "the biggest repos in
 * the world", which is exactly the noise this panel must avoid. They are only
 * kept when nothing more specific was said (see `extractKeywords`).
 */
const GENERIC_TERMS = new Set([
    'python', 'python3', 'py', 'javascript', 'js', 'typescript', 'ts', 'java',
    'golang', 'go', 'rust', 'ruby', 'php', 'kotlin', 'swift', 'html', 'css',
    'sql', 'bash', 'powershell', 'shell',
    'pip', 'pip3', 'npm', 'npx', 'yarn', 'pnpm', 'conda', 'poetry', 'uv', 'brew',
    'apt', 'install', 'uninstall', 'upgrade', 'setup', 'requirement',
    'requirements', 'dependency', 'dependencies', 'environment', 'venv',
    'logging', 'log', 'logs', 'logger', 'debug', 'verbose',
    'documentation', 'document', 'docs', 'doc', 'readme', 'tutorial', 'example',
    'examples', 'guide', 'reference', 'chinese', 'english', 'translation',
    'slow', 'fast', 'speed', 'timeout', 'wait', 'waiting', 'download', 'upload',
    'server', 'client', 'backend', 'frontend', 'web', 'http', 'https', 'api',
    'sdk', 'cli', 'tool', 'tools', 'library', 'libraries', 'framework', 'package',
    'code', 'app', 'application', 'project', 'program', 'software', 'open',
    'source', 'opensource', 'free', 'library', 'implementation',
    'testing', 'test', 'tests', 'tested', 'unit', 'e2e',
    'demo', 'sample', 'samples', 'example', 'examples',
]);
/** Three letters minimum, unless the term is a known two-letter technology. */
const SHORT_OK = new Set(['ai', 'ml', 'js', 'ts', 'go', 'os', 'ui', 'ux', 'cv', 'nlp', 'db', 'io', 'vm', 'ci', '3d', '2d']);
/** `ModuleNotFoundError` -> keep; `2024-05-01T10:00:00Z` -> drop. */
const NOISE_PATTERNS = [
    /^[0-9a-f]{8,}$/i,
    /^\d+$/,
    /^\d{4}-\d{2}-\d{2}/,
    /^[A-Za-z]:$/,
    /^https?$/i,
    /^www$/i,
];
function isNoise(token) {
    if (token.length < 2 || token.length > 32)
        return true;
    const lower = token.toLowerCase();
    if (STOPWORDS.has(lower))
        return true;
    if (HARNESS_TERMS.has(lower))
        return true;
    // A path or file name leaves two-letter crumbs behind (`执行方案.md` -> `md`,
    // `pip install` -> `in`). They are worthless as repository search terms.
    if (/^[a-z]{2}$/.test(lower) && !SHORT_OK.has(lower))
        return true;
    // Release artefacts and version strings are the other half of the junk:
    // `SandianshuiLauncher-1.1.0-win-x64.zip` contributed three "keywords" at once.
    if (/\d+(?:\.\d+)+/.test(lower))
        return true;
    // Dotted type names (`System.Text.UTF8Encoding`) are not search terms; a
    // single dot still allows `next.js` and friends.
    if ((lower.match(/\./g) ?? []).length >= 2)
        return true;
    if ((lower.match(/-/g) ?? []).length >= 2)
        return true;
    if (/(?:^|-)(?:x64|x86|win(?:32|64)?|amd64|linux|macos|darwin|arm64)$/.test(lower))
        return true;
    // Hex-ish identifiers (`B0-10`) carry a digit on both sides of the hyphen;
    // `gpt-4o` or `claude-3` do not.
    if (/\d[^-]*-[^-]*\d/.test(lower))
        return true;
    if (/\.(?:zip|exe|msi|dll|pdb|png|jpe?g|gif|svg|pdf|log|csv|md|json|txt|yml|yaml|toml|lock)$/.test(lower))
        return true;
    if (lower.startsWith('http'))
        return true;
    for (const pattern of NOISE_PATTERNS) {
        if (pattern.test(token))
            return true;
    }
    return false;
}
/** Drop fenced code blocks, URLs, absolute paths and long digests. */
export function stripNoise(text) {
    return text
        .replace(/```[\s\S]*?```/g, ' ')
        .replace(/~~~[\s\S]*?~~~/g, ' ')
        .replace(/https?:\/\/\S+/g, ' ')
        .replace(/(?:[A-Za-z]:\\|\/)[^\s"'`]{3,}/g, ' ')
        .replace(/\b[0-9a-f]{16,}\b/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}
/** Messages shorter than this are acknowledgements, not descriptions of work. */
const MIN_MESSAGE_CHARS = 8;
/**
 * Harness-injected runtime context rides along inside user messages ("Current
 * runtime context", "Time sampled while preparing turn 3", the file policy, the
 * GUI URL, the skill catalogue). That text is metadata about the harness, not
 * about the user's work, so keywords mined from it are pure noise: in the first
 * live run they produced searches for "Asia", "zone" and "Current".
 */
const HARNESS_NOISE_LINE = /^(?:Current runtime context|Current working directory|Current DSH file policy|Current DeepSeek Harness|Approval prompts|The user changed the approval policy|Time sampled while preparing|Browser time zone for this request|Interpret otherwise-unqualified|Elapsed since|This snapshot supersedes|A skill is a reusable set of|Available skills|<\/?system-reminder>)/i;
/** Remove the harness boilerplate that is prepended/appended to user messages. */
export function stripHarnessNoise(text) {
    const cleaned = text
        // The skill catalogue and other injected blocks are pure instructions.
        .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, ' ')
        .replace(/<available_skills>[\s\S]*?<\/available_skills>/gi, ' ');
    const kept = [];
    for (const rawLine of cleaned.split(/\r?\n/)) {
        // The acp tags wrap the real message: drop the tags, keep their content.
        const line = rawLine
            .replace(/<\/?acp\b[^>]*>/gi, ' ')
            .replace(/\s+/g, ' ')
            .trim();
        if (line === '')
            continue;
        if (HARNESS_NOISE_LINE.test(line))
            continue;
        // Rows of the injected skill catalogue: "- `name`: description".
        if (/^-\s+`[a-z0-9-]+`\s*:/.test(line))
            continue;
        kept.push(line);
    }
    return kept.join('\n').trim();
}
/** Pull readable text out of a message-like value (structural, defensive). */
export function messageText(value, depth = 0) {
    if (depth > 6 || value === null || value === undefined)
        return '';
    if (typeof value === 'string')
        return value;
    if (Array.isArray(value)) {
        const parts = [];
        for (const item of value) {
            const text = messageText(item, depth + 1);
            if (text !== '')
                parts.push(text);
        }
        return parts.join('\n');
    }
    if (typeof value !== 'object')
        return '';
    const record = value;
    const type = typeof record.type === 'string' ? record.type : '';
    if (type === 'tool_use' || type === 'tool_result' || type === 'thinking' || type === 'image') {
        return '';
    }
    if (typeof record.text === 'string')
        return record.text;
    const nested = record.message ?? record.content ?? record.parts ?? record.value;
    return nested === undefined ? '' : messageText(nested, depth + 1);
}
/** Extract up to `maxKeywords` technical keywords, best first. */
export function extractKeywords(texts, maxKeywords = 5, 
/** Text that deserves extra weight — the extracted error line. */
emphasis) {
    const score = new Map();
    let order = 0;
    const consider = (raw, weight) => {
        const token = raw.replace(/^[._#-]+|[._#-]+$/g, '').trim();
        if (isNoise(token))
            return;
        const key = token.toLowerCase();
        const existing = score.get(key);
        if (existing !== undefined) {
            existing.score += weight;
            return;
        }
        let bonus = 0;
        if (TECH_HINTS.has(key))
            bonus += 6;
        if (/[.+#-]/.test(token))
            bonus += 3;
        if (/(?:js|ts|py|db|cli|api|sdk|ml|ai|ql|os)$/.test(key))
            bonus += 2;
        // A capitalised word that is not all-caps is usually a product name.
        if (token.length >= 5 && /^[A-Z]/.test(token) && /[a-z]/.test(token))
            bonus += 2;
        if (GENERIC_TERMS.has(key))
            bonus -= 8;
        score.set(key, { display: token, score: weight + bonus, order: order++ });
    };
    for (const text of texts) {
        const clean = stripNoise(text);
        // Chinese requirement words first: they map to a precise English term.
        for (const [cn, en] of Object.entries(CN_TECH_MAP)) {
            if (clean.includes(cn))
                consider(en, 6);
        }
        for (const match of clean.matchAll(/`([^`\n]{2,40})`/g)) {
            const inner = match[1];
            if (inner !== undefined) {
                for (const token of inner.match(/[A-Za-z][A-Za-z0-9.+#_-]{1,30}/g) ?? [])
                    consider(token, 3);
            }
        }
        for (const token of clean.match(/[A-Za-z][A-Za-z0-9.+#_-]{1,30}/g) ?? [])
            consider(token, 1);
        for (const [cn] of Object.entries(CN_TECH_MAP)) {
            if (clean.includes(cn) && !CJK_STOPWORDS.has(cn))
                consider(cn, 1);
        }
    }
    if (emphasis !== undefined && emphasis.trim() !== '') {
        // The error line is the most actionable sentence in the message: repeat its
        // tokens with extra weight so `retry`, `ConnectionError`, … rank up.
        for (const token of emphasis.match(/[A-Za-z][A-Za-z0-9.+#_-]{1,30}/g) ?? []) {
            consider(token, /(?:Error|Exception)$/.test(token) ? 4 : 3);
        }
    }
    const candidates = [...score.values()].filter((entry) => entry.score > 2.5)
        .sort((a, b) => b.score - a.score || a.order - b.order);
    // Specific terms win; generic ones only fill the remaining slots (and only
    // when the conversation really said nothing more useful).
    const specific = candidates.filter((entry) => !GENERIC_TERMS.has(entry.display.toLowerCase()));
    const generic = candidates.filter((entry) => GENERIC_TERMS.has(entry.display.toLowerCase()));
    const limit = Math.max(0, Math.min(maxKeywords, 5));
    const ordered = [...specific, ...(specific.length >= 2 ? [] : generic)];
    return ordered.slice(0, limit).map((entry) => entry.display);
}
const ERROR_LINE = /(?:\b[A-Z][A-Za-z]*(?:Error|Exception)\b|\bError\b|\bException\b|\bTraceback\b|\berror:|\bERROR\b|\bpanic:|\bfatal:)[^\n]{0,180}/;
/** The first error-looking line, truncated to 200 characters. */
export function extractErrorText(texts) {
    for (const text of texts) {
        const match = ERROR_LINE.exec(text);
        if (match === null || match[0].trim() === '')
            continue;
        let line = match[0].replace(/\s+/g, ' ').trim();
        // A pasted traceback is usually followed by the question in Chinese
        // (`ConnectionError: Max retries exceeded，pip install 也特别慢`). Keep the
        // machine-readable head and drop the prose tail.
        const sentenceEnd = line.search(/[，。；]/);
        if (sentenceEnd >= 8) {
            line = line.slice(0, sentenceEnd);
        }
        else {
            const cjkIndex = line.search(/[\u4e00-\u9fff]/);
            if (cjkIndex >= 8)
                line = line.slice(0, cjkIndex);
        }
        line = line.replace(/[。；，、,;:\s]+$/u, '').trim();
        if (line !== '')
            return line.slice(0, 200);
    }
    return undefined;
}
/**
 * Build the signal for one session from its event log.
 *
 * A signal with no keywords and no error text is the `empty` state: there is
 * nothing to search for yet.
 */
export function extractSignal(sessionId, events, options = {}) {
    const window = Math.max(1, options.messageWindow ?? 3);
    const texts = [];
    let turnedAt = 0;
    for (let i = events.length - 1; i >= 0; i -= 1) {
        const event = events[i];
        if (event === undefined || event.type !== 'user/message')
            continue;
        const text = stripHarnessNoise(messageText(event.data?.message ?? event.data?.content ?? event.data));
        // Empty after cleaning means the message was harness bookkeeping, and a two
        // character reply ("好了") carries no search intent. Skipping both lets the
        // window reach the message that actually described the work.
        if (text.length < MIN_MESSAGE_CHARS)
            continue;
        texts.push(text);
        const time = typeof event.time === 'number' ? event.time : 0;
        if (time > turnedAt)
            turnedAt = time;
        if (texts.length >= window)
            break;
    }
    const errorText = extractErrorText(texts);
    const keywords = extractKeywords(texts, options.maxKeywords ?? 5, errorText);
    return {
        sessionId,
        keywords,
        ...(errorText === undefined ? {} : { errorText }),
        languages: Array.isArray(options.languages) ? [...options.languages] : [],
        turnedAt: turnedAt === 0 ? (options.now ?? Date.now()) : turnedAt,
    };
}
/** True when the signal carries nothing worth a search. */
export function isSignalEmpty(signal) {
    return signal.keywords.length === 0 && (signal.errorText ?? '') === '';
}
/** Content hash used for the refresh debounce (S09). */
export function signalHash(signal) {
    return stableHash(JSON.stringify({
        keywords: [...signal.keywords].sort(),
        error: signal.errorText ?? '',
        languages: [...signal.languages].sort(),
    }));
}
