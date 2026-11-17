#!/usr/bin/env node
/**
 * 离线联调脚本：在 Node 里用假的 ctx 挂载 dist/host/index.js，
 * 直接调用 /radar/* 路由，验证「会话信号 → GitHub 搜索 → 排序 → 中文卡片」整条链路。
 *
 * 用法：
 *   node -e "require('child_process')" # 无需额外依赖
 *   node scripts/probe-host.mjs          # 会真的打 api.github.com（匿名 10 次/分钟）
 *   node scripts/probe-host.mjs --offline  # 不发请求，只验证 apply 不报错
 */
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const offline = process.argv.includes('--offline');

if (offline) {
  // 离线模式也要有独立的 DSH_HOME，避免污染真实缓存
  process.env.DSH_HOME = await mkdtemp(join(tmpdir(), 'radar-probe-'));
} else {
  process.env.DSH_HOME = await mkdtemp(join(tmpdir(), 'radar-probe-'));
}

const { default: hostModule } = { default: await import('../dist/host/index.js') };
const { apply, name, inject } = hostModule;

console.log('plugin name:', name);
console.log('inject:', JSON.stringify(inject));
console.log('DSH_HOME:', process.env.DSH_HOME);

// ---------------------------------------------------------------------------
// 假的 ctx
// ---------------------------------------------------------------------------
const routes = new Map();
const disposers = [];

const now = Date.now();
const sessionEvents = [
  {
    type: 'user/message',
    seq: 1,
    time: now - 60_000,
    data: {
      message: {
        content: [
          {
            type: 'text',
            text: '我在用 python 写一个网页爬虫，requests 老是抛 ConnectionError: Max retries exceeded，pip install 也特别慢，想找点能自动重试的库。',
          },
        ],
      },
    },
  },
  {
    type: 'assistant/message',
    seq: 2,
    time: now - 30_000,
    data: { message: { content: [{ type: 'text', text: '可以先看看 retry 相关的库。' }] } },
  },
  {
    type: 'user/message',
    seq: 3,
    time: now - 10_000,
    data: {
      message: {
        content: [
          { type: 'text', text: '顺便，日志想接一下 opentelemetry，中文文档最好。' },
        ],
      },
    },
  },
];

const sessions = {
  get(sessionId) {
    if (sessionId !== 'probe-session') return undefined;
    return { header: { cwd: process.cwd() }, snapshotEvents: () => sessionEvents };
  },
};

const connection = {
  requestRejection() {
    return undefined; // 允许
  },
};

const webServer = {
  register(options) {
    routes.set(`${options.kind}:${options.path}`, options.handler);
    const dispose = () => routes.delete(`${options.kind}:${options.path}`);
    disposers.push(dispose);
    return dispose;
  },
};

const editorCalls = []
const configEntry = { options: { name: 'dsh-github-radar' }, config: {} }
const configEditor = {
  entries() {
    return [configEntry]
  },
  async edit(entry, updater) {
    const next = updater(entry.config ?? {})
    editorCalls.push(next)
    entry.config = next
  },
}

const ctx = {
  logger: {
    info: (message) => console.log('  [log]', message),
    warn: (message) => console.log('  [warn]', message),
    error: (message) => console.log('  [error]', message),
  },
  get(service) {
    if (service === 'webServer') return webServer;
    if (service === 'sessions') return sessions;
    if (service === 'connection') return connection;
    if (service === 'configEditor') return configEditor;
    return undefined;
  },
  effect(fn) {
    const dispose = fn();
    if (typeof dispose === 'function') disposers.push(dispose);
    return dispose;
  },
  inject(keys, callback) {
    if (typeof callback !== 'function') return undefined;
    const bag = {
      configEditor,
      get: (service) => (service === 'configEditor' ? configEditor : ctx.get(service)),
    }
    return callback(bag)
  },
};

apply(ctx, {});

console.log('\nroutes:', [...routes.keys()].join(', '));

// ---------------------------------------------------------------------------
// 请求模拟
// ---------------------------------------------------------------------------
function makeReq(method, url, body) {
  const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body), 'utf8');
  const req = {
    method,
    url,
    headers: { 'content-type': 'application/json' },
    async *[Symbol.asyncIterator]() {
      if (payload !== undefined) yield payload;
    },
  };
  return req;
}

function makeRes() {
  const res = {
    statusCode: 200,
    body: '',
    headersSent: false,
    writeHead(status) {
      this.statusCode = status;
    },
    write(chunk) {
      this.body += chunk;
    },
    end(chunk) {
      if (chunk !== undefined) this.body += chunk;
      this.headersSent = true;
    },
    json() {
      try {
        return JSON.parse(this.body);
      } catch {
        return this.body;
      }
    },
  };
  return res;
}

async function call(method, url, body, waitMs = 40_000) {
  const pathname = url.split('?')[0];
  const handler = routes.get(`exact:${pathname}`);
  if (handler === undefined) throw new Error(`no route for ${pathname}`);
  const res = makeRes();
  const started = Date.now();
  await handler(makeReq(method, url, body), res);
  // 路由包装器不 await 内部 promise，真实的 res.end 会稍后才到达
  while (!res.headersSent && Date.now() - started < waitMs) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return { status: res.statusCode, payload: res.json() };
}

/** 面板是「先返回状态、后台刷新」的模型，这里模拟轮询直到稳定。 */
async function pollState(sessionId, waitMs = 40_000) {
  const started = Date.now();
  let last;
  while (Date.now() - started < waitMs) {
    const result = await call('GET', `/radar/state?sessionId=${encodeURIComponent(sessionId)}`);
    last = result.payload;
    if (last?.status !== 'loading' && last?.status !== 'idle') return result;
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  return { status: 200, payload: last };
}

function summarizeState(state) {
  return {
    status: state.status,
    keywords: state.keywords,
    errorText: state.errorText,
    cards: Array.isArray(state.cards) ? state.cards.length : 0,
    quota: state.quota,
    notice: state.notice,
    errorMessage: state.errorMessage,
    retryAfterMs: state.retryAfterMs,
    anonymous: state.anonymous,
    cached: state.cached,
    first: Array.isArray(state.cards) && state.cards[0]
      ? {
          fullName: state.cards[0].fullName,
          zh: state.cards[0].zh,
          zhSource: state.cards[0].zhSource,
          why: state.cards[0].why,
          stars: state.cards[0].stars,
          language: state.cards[0].language,
          install: state.cards[0].install,
        }
      : null,
  };
}

const settings = await call('GET', '/radar/settings');
console.log('\nGET /radar/settings ->', settings.status, JSON.stringify(settings.payload));

if (offline) {
  const saved = await call('POST', '/radar/settings', { minStars: 77, chineseOnly: true })
  console.log('POST /radar/settings ->', saved.status, JSON.stringify(saved.payload))
  console.log('configEditor edit calls ->', JSON.stringify(editorCalls))
  for (const dispose of disposers) dispose();
  process.exit(0);
}

const badState = await call('GET', '/radar/state');
console.log('GET /radar/state (no sessionId) ->', badState.status, JSON.stringify(badState.payload));

if (offline) {
  console.log('\n--offline: 跳过真实网络请求');
  for (const dispose of disposers) dispose();
  process.exit(0);
}

const first = await pollState('probe-session');
console.log('\nGET /radar/state (poll) ->', first.status, JSON.stringify(summarizeState(first.payload), null, 2));

const forced = await call('POST', '/radar/refresh', { sessionId: 'probe-session', force: true });
console.log('\nPOST /radar/refresh (force) ->', forced.status, JSON.stringify(summarizeState(forced.payload), null, 2));

// Hand-edited keywords: the panel lets the user replace what was extracted from
// the conversation, so the route must win over extraction and survive a reset.
const manual = await call('POST', '/radar/keywords', {
  sessionId: 'probe-session',
  keywords: ['crawler', 'scrapy'],
});
console.log(
  '\nPOST /radar/keywords (manual) ->',
  manual.status,
  'keywords:', JSON.stringify(manual.payload?.state?.keywords),
  'manual:', manual.payload?.state?.keywordsManual,
  'status:', manual.payload?.state?.status,
);

const badMethod = await call('GET', '/radar/keywords');
console.log('GET /radar/keywords (method guard) ->', badMethod.status, JSON.stringify(badMethod.payload));

const resetSignal = await call('POST', '/radar/keywords', { sessionId: 'probe-session', reset: true });
console.log(
  'POST /radar/keywords (reset) ->',
  resetSignal.status,
  'keywords:', JSON.stringify(resetSignal.payload?.state?.keywords),
  'manual:', resetSignal.payload?.state?.keywordsManual,
);

const target = forced.payload?.cards?.[0]?.fullName;
if (typeof target === 'string' && target !== '') {
  const dismissed = await call('POST', '/radar/dismiss', { sessionId: 'probe-session', fullName: target });
  const stillThere = (dismissed.payload?.cards ?? []).some((card) => card.fullName === target);
  console.log('\nPOST /radar/dismiss ->', dismissed.status, 'removed:', !stillThere);

  const again = await call('POST', '/radar/refresh', { sessionId: 'probe-session', force: true });
  const backAgain = (again.payload?.cards ?? []).some((card) => card.fullName === target);
  console.log('after dismiss + force refresh, dismissed repo back?', backAgain);
}

const clicked = await call('POST', '/radar/click', { fullName: 'psf/requests' });
console.log('\nPOST /radar/click ->', clicked.status, JSON.stringify(clicked.payload));

const tokenCheck = await call('POST', '/radar/token-check', { token: '' });
console.log('POST /radar/token-check ->', tokenCheck.status, JSON.stringify(tokenCheck.payload));

for (const dispose of disposers) dispose();
console.log('\ndone.');
