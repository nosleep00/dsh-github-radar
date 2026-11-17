import { chineseRatio, looksChinese, templateSummary, whyText, zhLanguage } from './zh.js';
import { errorExcerpt } from './query.js';
const DISMISS_DAYS = 30;
const CLICK_BOOST_CAP = 0.1;
const DISMISS_MS = DISMISS_DAYS * 86_400_000;
/** Topics that mark a repository as a Chinese-community project (S20 rule 1). */
export const CHINESE_TOPICS = new Set([
    'chinese',
    'chinese-language',
    '中文',
    'chinese-translation',
    'zh-cn',
    'chinese-translations',
]);
/** S20 rules 1–2 (rule 3 would need the readme; v1 stays offline-cheap). */
export function isChineseProject(repo) {
    const topics = Array.isArray(repo.topics) ? repo.topics : [];
    for (const topic of topics) {
        if (typeof topic === 'string' && CHINESE_TOPICS.has(topic.trim().toLowerCase()))
            return true;
    }
    return looksChinese(repo.description ?? '', 0.3);
}
/** True when the repository is inside the 30-day dismissal window. */
export function isDismissed(fullName, feedback, now = Date.now()) {
    const at = feedback.dismissed[fullName];
    if (typeof at !== 'number')
        return false;
    return now - at < DISMISS_MS;
}
function clamp01(value) {
    if (!Number.isFinite(value))
        return 0;
    return value < 0 ? 0 : value > 1 ? 1 : value;
}
function normStars(stars, baseline = 200_000) {
    const safe = Number.isFinite(stars) && stars > 0 ? stars : 0;
    return clamp01(Math.log1p(safe) / Math.log1p(Math.max(1_000, baseline)));
}
/**
 * Popularity for the trending fallback: a bell curve peaking around 10k stars.
 *
 * "Trending" is not "most starred" — the 300k–600k star repos are decade-old
 * evergreen lists that are active by definition. A bell curve keeps them out of
 * the top slots without any blocklist.
 */
function trendPopularity(stars) {
    const safe = Number.isFinite(stars) && stars > 0 ? stars : 0;
    if (safe < 50)
        return 0;
    const spread = Math.abs(Math.log10(safe / 10_000));
    return clamp01(1 - spread / 1.6);
}
function recency(pushedAt, now) {
    if (pushedAt === null || pushedAt === undefined || pushedAt === '')
        return 0;
    const at = Date.parse(pushedAt);
    if (Number.isNaN(at))
        return 0;
    const days = Math.max(0, (now - at) / 86_400_000);
    return clamp01(Math.exp(-days / 120));
}
function haystack(repo) {
    const topics = Array.isArray(repo.topics) ? repo.topics.join(' ') : '';
    return `${repo.full_name} ${repo.description ?? ''} ${topics}`.toLowerCase();
}
/** How many of the signal keywords the repository text actually mentions. */
export function matchedKeywords(repo, keywords) {
    const text = haystack(repo);
    return keywords.filter((keyword) => {
        const needle = keyword.trim().toLowerCase();
        if (needle.length < 2)
            return false;
        if (text.includes(needle))
            return true;
        // `retry` must also hit `retrying` / `retries`, `telemetry` -> `telemetries`.
        const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        return new RegExp(`(?:^|[^a-z0-9])${escaped}`, 'i').test(text);
    });
}
/** Click-driven nudge: same owner or overlap in topics (cap +0.1). */
function clickBoost(repo, clicked) {
    const names = Object.keys(clicked);
    if (names.length === 0)
        return 0;
    const owner = repo.full_name.split('/')[0] ?? '';
    const topics = new Set((repo.topics ?? []).map((t) => String(t).toLowerCase()));
    let boost = 0;
    for (const name of names) {
        const other = name.split('/')[0] ?? '';
        if (other !== '' && other === owner)
            boost += 0.05;
        const otherTopics = name.split('#')[1];
        if (otherTopics !== undefined && topics.has(otherTopics.toLowerCase()))
            boost += 0.05;
        if (boost >= CLICK_BOOST_CAP)
            break;
    }
    return Math.min(boost, CLICK_BOOST_CAP);
}
function shortName(fullName) {
    const parts = fullName.split('/');
    return parts[1] ?? fullName;
}
/**
 * Below this, treat the repo as unpublished: a 1-star hobby project almost never
 * has a PyPI/npm/crates package, so guessing `pip install <repo>` hands the user
 * a command that does not exist. `git clone` always works, and a wrong command
 * is worse than a plain one.
 */
const PUBLISHED_MIN_STARS = 50;
/** Topics of resource collections — cloning is the only sane "install" there. */
const NOT_A_PACKAGE = new Set([
    'awesome',
    'awesome-list',
    'awesome-lists',
    'list',
    'lists',
    'collection',
    'curated',
    'resources',
    'learning',
    'tutorial',
    'tutorials',
    'book',
    'books',
    'course',
    'courses',
    'roadmap',
    'cheatsheet',
    'interview',
    'examples',
    'papers',
    'dataset',
]);
/** Copy-pasteable install commands guessed from language + name (S14). */
export function guessInstall(repo) {
    const packageName = shortName(repo.full_name);
    const packageLike = /^[a-z0-9][a-z0-9._-]*$/i.test(packageName) && !packageName.includes('..');
    const language = (repo.language ?? '').toLowerCase();
    const clone = `git clone ${repo.html_url}.git`;
    const stars = typeof repo.stargazers_count === 'number' ? repo.stargazers_count : 0;
    const topics = Array.isArray(repo.topics) ? repo.topics : [];
    const isCollection = topics.some((topic) => NOT_A_PACKAGE.has(String(topic).trim().toLowerCase()));
    if (!packageLike || stars < PUBLISHED_MIN_STARS || isCollection)
        return [clone];
    if (language === 'python')
        return [`pip install ${packageName}`];
    if (language === 'typescript' || language === 'javascript')
        return [`npm install ${packageName}`];
    if (language === 'rust')
        return [`cargo install ${packageName}`];
    if (language === 'go')
        return [`go install github.com/${repo.full_name}@latest`];
    if (language === 'ruby')
        return [`gem install ${packageName}`];
    if (language === 'php')
        return [`composer require ${repo.full_name}`];
    if (language === 'shell')
        return [`brew install ${packageName}`];
    return [clone];
}
/**
 * Round-robin a score-sorted list over its source groups.
 *
 * Keeps the best card of every group in the top slots while preserving each
 * group's internal order.
 */
function interleaveBySource(items, sourceOf) {
    const groups = new Map();
    for (const item of items) {
        const key = sourceOf(item);
        const bucket = groups.get(key);
        if (bucket === undefined)
            groups.set(key, [item]);
        else
            bucket.push(item);
    }
    const queues = [...groups.values()];
    const out = [];
    let index = 0;
    while (out.length < items.length) {
        let pushed = false;
        for (const queue of queues) {
            const next = queue[index];
            if (next === undefined)
                continue;
            out.push(next);
            pushed = true;
        }
        if (!pushed)
            break;
        index += 1;
    }
    return out;
}
function whyFor(candidate, matched, languageMatch, errorTokens, errorText, trending = false) {
    if (trending)
        return whyText('trending');
    const fromErrorQuery = candidate.sources.includes('error');
    const errorHit = fromErrorQuery ||
        (errorTokens.length > 0 &&
            errorTokens.some((token) => haystack(candidate.repo).includes(token.toLowerCase())));
    if (errorHit && (errorText !== undefined || fromErrorQuery)) {
        return whyText('error', errorExcerpt(errorText) || '报错');
    }
    const fromKeyword = candidate.sources.find((source) => source.startsWith('keyword:'));
    const keyword = fromKeyword?.slice('keyword:'.length) ?? matched[0];
    if (keyword !== undefined && keyword !== '')
        return whyText('keyword', keyword);
    if (languageMatch)
        return whyText('language', zhLanguage(candidate.repo.language) || '这种语言');
    return whyText('fallback');
}
/** Score, filter and materialise the final cards. */
export function rankRepos(candidates, context) {
    const now = context.now ?? Date.now();
    const { feedback, settings, signal } = context;
    const seen = new Set(context.seen ?? []);
    const keywords = (signal.keywords ?? []).filter((k) => typeof k === 'string' && k.trim() !== '');
    const errorTokens = errorExcerpt(signal.errorText)
        .split(' ')
        .filter((token) => token.length >= 3);
    const maxCards = Math.max(1, Math.min(settings.maxCards, 12));
    const scored = [];
    const owners = new Set();
    // Highest score first so the same-owner rule keeps the best one.
    const survivors = candidates.filter((candidate) => {
        const repo = candidate.repo;
        if (typeof repo.full_name !== 'string' || repo.full_name === '')
            return false;
        if (repo.archived === true)
            return false;
        if (seen.has(repo.full_name))
            return false;
        if (isDismissed(repo.full_name, feedback, now))
            return false;
        if (settings.chineseOnly && !isChineseProject(repo))
            return false;
        return true;
    });
    let filtered = candidates.length - survivors.length;
    // Normalise stars inside the batch. Against the global 200k baseline a batch
    // of 1★–14★ repositories all score ~0, which made the order of the "刚起步"
    // fallback cards look random.
    const starTop = survivors.reduce((max, candidate) => {
        const stars = candidate.repo.stargazers_count;
        const safe = Number.isFinite(stars) ? Math.max(0, stars ?? 0) : 0;
        return safe > max ? safe : max;
    }, 0);
    const starBaseline = Math.max(starTop, 250);
    const ranked = survivors
        .map((candidate) => {
        const repo = candidate.repo;
        const stars = Number.isFinite(repo.stargazers_count) ? Math.max(0, repo.stargazers_count ?? 0) : 0;
        const language = typeof repo.language === 'string' ? repo.language : '';
        const languageMatch = settings.languages.length === 0
            ? false
            : settings.languages.some((pref) => pref.toLowerCase() === language.toLowerCase());
        const matched = matchedKeywords(repo, keywords);
        const topicMatch = keywords.length === 0 ? 0 : clamp01(matched.length / keywords.length);
        let score = 0.45 * (context.trending === true ? trendPopularity(stars) : normStars(stars, starBaseline)) +
            0.25 * recency(repo.pushed_at, now) +
            0.2 * (languageMatch ? 1 : settings.languages.length === 0 ? 0.5 : 0) +
            0.1 * topicMatch;
        // `sort=stars` means a huge repo that merely mentions a word in its readme
        // can outrank the small library the user actually needs. Reward repos that
        // really talk about the signal and penalise the ones that do not.
        if (keywords.length > 0) {
            if (matched.length > 0)
                score += Math.min(0.12, 0.06 * matched.length);
            else if (!candidate.sources.includes('error') && !languageMatch)
                score -= 0.18;
        }
        if (repo.fork === true)
            score -= 0.08;
        if (!repo.description)
            score -= 0.03;
        if (stars < settings.minStars)
            score -= 0.15;
        score += clickBoost(repo, feedback.clicked);
        return { candidate, repo, stars, language, languageMatch, matched, score };
    })
        .sort((a, b) => b.score - a.score || b.stars - a.stars);
    // Trending batches come from several star bands; `sort=stars` makes every
    // band's ceiling the best card, so a plain score order returns five repos
    // with the same star count. Round-robin across bands instead.
    const ordered = context.trending === true
        ? interleaveBySource(ranked, (item) => item.candidate.sources[0] ?? 'trending')
        : ranked;
    for (const item of ordered) {
        if (scored.length >= maxCards)
            break;
        const owner = item.repo.full_name.split('/')[0] ?? '';
        if (owner !== '' && owners.has(owner)) {
            filtered += 1;
            continue;
        }
        if (owner !== '')
            owners.add(owner);
        const topics = Array.isArray(item.repo.topics)
            ? item.repo.topics.filter((t) => typeof t === 'string').slice(0, 8)
            : [];
        scored.push({
            score: item.score,
            card: {
                fullName: item.repo.full_name,
                htmlUrl: item.repo.html_url,
                descriptionEn: (item.repo.description ?? '').trim(),
                topics,
                language: item.language === '' ? null : item.language,
                stars: item.stars,
                pushedAt: typeof item.repo.pushed_at === 'string' ? item.repo.pushed_at : '',
                archived: item.repo.archived === true,
                zh: templateSummary(item.repo, now),
                zhSource: 'template',
                why: whyFor(item.candidate, item.matched, item.languageMatch, errorTokens, signal.errorText, context.trending === true),
                install: guessInstall(item.repo),
            },
        });
    }
    return { cards: scored.map((entry) => entry.card), consideredCount: candidates.length, filtered };
}
export { chineseRatio };
