/**
 * GitHub 雷达 · 右侧栏面板（client half）
 *
 * 经典脚本形态：由宿主 __ModuleLoader__ 加载，只 require('react')。
 * 所有数据都走同源 HTTP：/radar/*（host 半部分注册的路由）。
 */
window.__ModuleLoader__.load({
  id: 'dsh-github-radar',
  factory: function (require) {
    const React = require('react')
    const h = React.createElement
    const useState = React.useState
    const useEffect = React.useEffect
    const useRef = React.useRef
    const useMemo = React.useMemo

    const TAB_ID = 'plugin:github-radar'
    const TAB_KIND = 'radar'
    const PLUGIN_ID = 'dsh-github-radar'
    const POLL_MS = 2500
    const POLL_LIMIT = 24
    const STALL_MS = 10000

    /* ------------------------------------------------------------------ i18n */

    const ZH = {
      'radar.title': 'GitHub 雷达',
      'radar.guide.description': '从当前会话的关键词推荐相关开源项目',
      'radar.refresh': '换一批',
      'radar.settings': '设置',
      'radar.signals': '当前信号 · 从会话提取',
      'radar.signals.empty': '还没有可用信号',
      'radar.signal.add': '加关键词',
      'radar.signal.addError': '粘贴报错',
      'radar.signal.placeholder': '输入关键词，回车添加',
      'radar.signal.errorPlaceholder': '粘贴一段报错，回车保存',
      'radar.signal.apply': '添加',
      'radar.signal.remove': '从搜索里去掉',
      'radar.signal.reset': '恢复自动提取',
      'radar.signal.manual': '手动编辑',
      'radar.signal.limit': '最多 5 个关键词',
      'common.cancel': '取消',
      'radar.error.label': '报错',
      'radar.trending.chip': '近期热门',
      'radar.trending.hint': '会话里还没有足够的线索，先看最近热门的项目；点 ⟳ 换一批，或「＋ 加关键词」按你的方向找',
      'radar.loading.title': '正在从 GitHub 找相关项目',
      'radar.loading.hint': '首次刷新大约需要 2–4 秒；之后会从本地缓存秒开',
      'radar.loading.stalled': '面板请求没有响应，请点「重试」或刷新页面',
      'radar.empty.title': '还没有可用的上下文',
      'radar.empty.hint': '聊几轮、或者直接告诉我你在做什么，这里会自动出现相关的开源项目。',
      'radar.rateLimited': 'GitHub 暂时限速',
      'radar.offline': '连不上 GitHub',
      'radar.error': '刷新失败',
      'radar.retry': '重试',
      'radar.why.error': '因为你在会话里遇到了「{x}」这类问题',
      'radar.why.keyword': '因为你在会话里提到「{x}」',
      'radar.why.language': '因为你最近在用 {x}',
      'radar.why.fallback': '和你正在做的事相关',
      'radar.card.open': '打开',
      'radar.card.copy': '复制安装命令',
      'radar.card.copied': '已复制',
      'radar.card.dismiss': '不感兴趣',
  'radar.card.ask': '问问 AI',
  'radar.ask.inserted': '已加进输入框，按 Enter 发送',
  'radar.ask.failed': '没能写入输入框，请手动复制项目地址',
  'radar.ask.full': '输入框里已有内容，先发出去或清空再试',
      'radar.card.ai': 'AI',
      'radar.card.english': '英文原文',
      'radar.quota': '额度 {remaining}/{limit} 每分钟',
      'radar.quota.token': '令牌额度 {remaining}/{limit} 每分钟',
      'radar.quota.none': '额度未知',
      'radar.privacy': '面板只会读取当前会话的文字摘要，不会上传你的代码或聊天记录。',
      'setting.title': '雷达设置',
      'setting.githubToken': 'GitHub 只读令牌',
      'setting.githubToken.hint': '可选。配置后搜索额度从每分钟 10 次提升到 30 次。',
      'setting.testToken': '测试',
      'setting.enableAiSummary': 'AI 摘要',
      'setting.enableAiSummary.hint': '用当前会话的模型把英文简介翻成一句中文，失败时自动退回模板。',
      'setting.enableAiSummary.unavailable': '当前宿主里模型接口不可用，卡片会先用模板摘要。',
      'setting.languages': '偏好语言',
      'setting.languages.hint': '逗号分隔，例如 Python, TypeScript。留空表示不限。',
      'setting.chineseOnly': '只看中文项目',
      'setting.chineseOnly.hint': '只保留中文社区维护或有中文说明的项目，范围会明显变小。',
      'setting.minStars': '最低星数',
      'setting.maxCards': '卡片数量',
      'setting.allowNetwork': '允许联网',
      'setting.allowNetwork.hint': '关掉后只读本地缓存，不会再请求 GitHub。',
      'setting.proxyUrl': '代理地址',
      'setting.proxyUrl.hint': '例如 http://127.0.0.1:8080，留空则使用系统环境变量。',
      'setting.save': '保存',
      'setting.saved': '已保存',
      'setting.cancel': '关闭',
      'setting.reset': '恢复默认',
      'action.close': '关闭',
    }

    const EN = {
      'radar.title': 'GitHub Radar',
      'radar.guide.description': 'Suggests related open-source projects from this session',
      'radar.refresh': 'Shuffle',
      'radar.settings': 'Settings',
      'radar.signals': 'Signals · from this conversation',
      'radar.signals.empty': 'No signals yet',
      'radar.signal.add': 'Add keyword',
      'radar.signal.addError': 'Paste an error',
      'radar.signal.placeholder': 'Keyword, then Enter',
      'radar.signal.errorPlaceholder': 'Paste an error line, then Enter',
      'radar.signal.apply': 'Add',
      'radar.signal.remove': 'Drop from the search',
      'radar.signal.reset': 'Back to automatic',
      'radar.signal.manual': 'edited',
      'radar.signal.limit': 'Up to 5 keywords',
      'common.cancel': 'Cancel',
      'radar.error.label': 'error',
      'radar.trending.chip': 'Trending now',
      'radar.trending.hint':
        'Nothing specific in this session yet — here is what is hot right now. Use 「＋ Add keyword」 to steer it.',
      'radar.loading.title': 'Searching GitHub for related projects',
      'radar.loading.hint': 'The first refresh takes 2–4 seconds; after that the cache opens instantly.',
      'radar.loading.stalled': 'The panel got no response. Try again or reload the page.',
      'radar.empty.title': 'Nothing to search for yet',
      'radar.empty.hint': 'Chat a few turns, or just tell me what you are building — related projects will show up here.',
      'radar.rateLimited': 'GitHub is rate limiting',
      'radar.offline': 'GitHub is unreachable',
      'radar.error': 'Refresh failed',
      'radar.retry': 'Retry',
      'radar.why.error': 'Because you ran into "{x}"',
      'radar.why.keyword': 'Because you mentioned "{x}"',
      'radar.why.language': 'Because you work with {x}',
      'radar.why.fallback': 'Related to what you are doing',
      'radar.card.open': 'Open',
      'radar.card.copy': 'Copy install',
      'radar.card.copied': 'Copied',
      'radar.card.dismiss': 'Not interested',
  'radar.card.ask': 'Ask AI',
  'radar.ask.inserted': 'Added to the composer — press Enter to send',
  'radar.ask.failed': 'Could not write to the composer; copy the URL instead',
  'radar.ask.full': 'The composer already has text — send or clear it first',
      'radar.card.ai': 'AI',
      'radar.card.english': 'Original',
      'radar.quota': 'Quota {remaining}/{limit} per minute',
      'radar.quota.token': 'Token quota {remaining}/{limit} per minute',
      'radar.quota.none': 'Quota unknown',
      'radar.privacy': 'This panel only reads a short text digest of the current session; it never uploads your code or chat log.',
      'setting.title': 'Radar settings',
      'setting.githubToken': 'GitHub read-only token',
      'setting.githubToken.hint': 'Optional. A token raises the search quota from 10 to 30 requests per minute.',
      'setting.testToken': 'Test',
      'setting.enableAiSummary': 'AI summaries',
      'setting.enableAiSummary.hint': 'Use the session model for one Chinese line per card; falls back to the template.',
      'setting.enableAiSummary.unavailable': 'The model is not reachable in this host — cards fall back to template summaries.',
      'setting.languages': 'Preferred languages',
      'setting.languages.hint': 'Comma separated, e.g. Python, TypeScript. Empty means any language.',
      'setting.chineseOnly': 'Chinese projects only',
      'setting.chineseOnly.hint': 'Keeps only projects with Chinese maintainers or descriptions; this narrows results a lot.',
      'setting.minStars': 'Minimum stars',
      'setting.maxCards': 'Cards per refresh',
      'setting.allowNetwork': 'Allow network',
      'setting.allowNetwork.hint': 'When off, the panel only replays the local cache.',
      'setting.proxyUrl': 'Proxy URL',
      'setting.proxyUrl.hint': 'e.g. http://127.0.0.1:8080. Empty uses the system environment.',
      'setting.save': 'Save',
      'setting.saved': 'Saved',
      'setting.cancel': 'Close',
      'setting.reset': 'Restore defaults',
      'action.close': 'Close',
    }

    function translator(dict) {
      return function (key, vars) {
        let text = dict[key]
        if (typeof text !== 'string') text = key
        if (vars) {
          for (const name of Object.keys(vars)) text = text.split('{' + name + '}').join(String(vars[name]))
        }
        return text
      }
    }

    // The host injects `t` from the slot's `locale` namespace. During first
    // paint (or when the namespace is not live yet) it hands the key straight
    // back, which would render `radar.title` in the UI. Every seat therefore
    // goes through this wrapper, which falls back to the dictionary shipped in
    // this file.
    function seatTranslator(seat, fallback) {
      const backup = typeof fallback === 'function' ? fallback : translator(ZH)
      return function (key, vars) {
        if (typeof seat === 'function') {
          try {
            const value = vars === undefined ? seat(key) : seat(key, vars)
            if (typeof value === 'string' && value !== '' && value !== key) return value
          } catch (_) {
            /* fall through to the dictionary */
          }
        }
        return backup(key, vars)
      }
    }

    /* ------------------------------------------------------------------ http */

    async function request(path, init) {
      const options = Object.assign({ credentials: 'same-origin' }, init || {})
      options.headers = Object.assign({ accept: 'application/json' }, (init && init.headers) || {})
      if (options.body !== undefined) options.headers['content-type'] = 'application/json'
      const response = await fetch(path, options)
      let payload = null
      try {
        payload = await response.json()
      } catch (_) {
        payload = null
      }
      if (!response.ok) {
        const message = payload && payload.message ? payload.message : 'HTTP ' + response.status
        throw new Error(message)
      }
      return payload
    }

    const api = {
      state: function (sessionId) {
        // An empty session id is not fatal: the host falls back to the newest
        // session and reports which one it used.
        return request(sessionId ? '/radar/state?sessionId=' + encodeURIComponent(sessionId) : '/radar/state')
      },
      refresh: (sessionId, force) =>
        request('/radar/refresh', {
          method: 'POST',
          body: JSON.stringify({ sessionId: sessionId, force: force === true }),
        }),
      dismiss: (sessionId, fullName) =>
        request('/radar/dismiss', { method: 'POST', body: JSON.stringify({ sessionId: sessionId, fullName: fullName }) }),
      click: (fullName) => request('/radar/click', { method: 'POST', body: JSON.stringify({ fullName: fullName }) }),
      settings: () => request('/radar/settings'),
      saveSettings: (patch) => request('/radar/settings', { method: 'POST', body: JSON.stringify(patch) }),
      tokenCheck: (token) => request('/radar/token-check', { method: 'POST', body: JSON.stringify({ token: token }) }),
    }

    /* ---------------------------------------------------------------- format */

    function starText(stars) {
      const value = typeof stars === 'number' && isFinite(stars) ? Math.max(0, stars) : 0
      if (value >= 100000000) return (value / 100000000).toFixed(1).replace(/\.0$/, '') + ' 亿星'
      if (value >= 10000) return (value / 10000).toFixed(1).replace(/\.0$/, '') + ' 万星'
      if (value >= 1000) return (value / 1000).toFixed(1).replace(/\.0$/, '') + ' 千星'
      return value + ' 星'
    }

    function recencyText(pushedAt) {
      if (typeof pushedAt !== 'string' || pushedAt === '') return ''
      const time = Date.parse(pushedAt)
      if (!isFinite(time)) return ''
      const days = Math.floor(Math.max(0, Date.now() - time) / 86400000)
      if (days <= 0) return '今天有更新'
      if (days === 1) return '昨天更新'
      if (days < 30) return days + ' 天前更新'
      const months = Math.floor(days / 30)
      if (months < 12) return months + ' 个月前更新'
      const years = Math.floor(days / 365)
      return years <= 1 ? '一年前更新' : years + ' 年前更新'
    }

    const LANGUAGE_COLORS = {
      Python: '#4b8bbe',
      TypeScript: '#3178c6',
      JavaScript: '#f1e05a',
      Rust: '#dea584',
      Go: '#00add8',
      Java: '#b07219',
      C: '#555555',
      'C++': '#f34b7d',
      'C#': '#178600',
      Ruby: '#701516',
      PHP: '#4f5d95',
      Swift: '#ffac45',
      Kotlin: '#a97bff',
      Shell: '#89e051',
      Vue: '#41b883',
      Dart: '#00b4ab',
      Zig: '#ec915c',
      Lua: '#000080',
      HTML: '#e34c26',
      CSS: '#563d7c',
    }

    function languageColor(language) {
      return LANGUAGE_COLORS[language] || 'var(--dsw-alias-label-secondary)'
    }

    /* ----------------------------------------------------------------- hooks */

    function mergeState(previous, next) {
      if (!next) return previous
      if (previous && previous.updatedAt && next.updatedAt && next.updatedAt < previous.updatedAt && next.status === 'ready') {
        return previous
      }
      return next
    }

    /**
     * True while the host may still replace template summaries with model ones.
     * The first render is template-only by design (AI never blocks the panel),
     * so without this the badge and the real Chinese line never show up.
     */
    function pendingAi(payload) {
      const cards = payload && payload.cards
      if (!cards || cards.length === 0) return false
      for (const card of cards) {
        if (card.zhSource !== 'llm') return true
      }
      return false
    }

    /**
     * Loads /radar/state for one session and keeps polling while the host is
     * still working. The panel never blocks on the network: a failed fetch
     * keeps whatever it already had.
     */
    function useRadar(sessionId) {
      const [state, setState] = useState(null)
      const [error, setError] = useState(null)
      const [stalled, setStalled] = useState(false)
      const [busy, setBusy] = useState(false)
      const alive = useRef(true)
      const polls = useRef(0)
      const aiPolls = useRef(0)
      const timer = useRef(null)
      const guard = useRef(null)

      const stopPolling = function () {
        if (timer.current !== null) {
          clearTimeout(timer.current)
          timer.current = null
        }
      }

      const schedule = function (delay) {
        stopPolling()
        if (!alive.current) return
        if (polls.current >= POLL_LIMIT) return
        polls.current += 1
        timer.current = setTimeout(load, delay === undefined ? POLL_MS : delay)
      }

      const load = function () {
        if (!alive.current) return
        api.state(sessionId)
          .then(function (payload) {
            if (!alive.current) return
            setStalled(false)
            setState(function (previous) {
              return mergeState(previous, payload)
            })
            setError(null)
            const status = payload && payload.status
            if (status === 'loading' || status === 'idle') schedule(POLL_MS)
            else if (status === 'rateLimited') schedule(Math.min(Math.max(payload.retryAfterMs || 5000, 1500), 60000))
            else if (status === 'ready' && pendingAi(payload) && aiPolls.current < 4) {
              // Four extra looks (~10s) is enough for the model batch; after
              // that the card keeps its template line instead of polling on.
              aiPolls.current += 1
              schedule(POLL_MS)
            }
          })
          .catch(function (reason) {
            if (!alive.current) return
            setError(reason && reason.message ? reason.message : '加载失败')
            schedule(POLL_MS * 2)
          })
      }

      useEffect(
        function () {
          alive.current = true
          polls.current = 0
          aiPolls.current = 0
          setState(null)
          setError(null)
          setStalled(false)
          load()
          // A panel that never gets an answer must say so instead of showing
          // skeletons forever — the skeleton is indistinguishable from a hang.
          if (guard.current !== null) clearTimeout(guard.current)
          guard.current = setTimeout(function () {
            guard.current = null
            if (alive.current) setStalled(true)
          }, STALL_MS)
          return function () {
            alive.current = false
            if (guard.current !== null) {
              clearTimeout(guard.current)
              guard.current = null
            }
            stopPolling()
          }
        },
        [sessionId],
      )

      const refresh = function (force) {
        if (!alive.current) return
        setBusy(true)
        polls.current = 0
        request('/radar/refresh', {
          method: 'POST',
          body: JSON.stringify({ sessionId: sessionId, force: force !== false }),
        })
          .then(function (payload) {
            if (!alive.current) return
            setState(function (previous) {
              return mergeState(previous, payload)
            })
            setError(null)
            if (payload && (payload.status === 'loading' || payload.status === 'idle')) schedule(1200)
          })
          .catch(function (reason) {
            if (!alive.current) return
            setError(reason && reason.message ? reason.message : '刷新失败')
          })
          .then(function () {
            setBusy(false)
          })
      }

      // The chips are editable: keywords replace extraction for this session,
      // a pasted error replaces the error chip, `reset` goes back to automatic.
      const setSignal = function (patch) {
        if (!alive.current) return Promise.resolve()
        setBusy(true)
        polls.current = 0
        const body = Object.assign({ sessionId: sessionId }, patch)
        return request('/radar/keywords', { method: 'POST', body: JSON.stringify(body) })
          .then(function (payload) {
            if (!alive.current) return
            const next = payload && payload.state ? payload.state : payload
            setState(function (previous) {
              return mergeState(previous, next)
            })
            setError(null)
            const status = next && next.status
            if (status === 'loading' || status === 'idle') schedule(POLL_MS)
            else if (status === 'ready' && pendingAi(next) && aiPolls.current < 4) {
              aiPolls.current += 1
              schedule(POLL_MS)
            }
          })
          .catch(function (reason) {
            if (!alive.current) return
            setError(reason && reason.message ? reason.message : '更新关键词失败')
          })
          .then(function () {
            setBusy(false)
          })
      }

      const dismiss = function (fullName) {
        setState(function (previous) {
          if (!previous || !previous.cards) return previous
          return Object.assign({}, previous, {
            cards: previous.cards.filter(function (card) {
              return card.fullName !== fullName
            }),
          })
        })
        api.dismiss(sessionId, fullName).catch(function () {})
      }

      return {
        state: state,
        error: error,
        stalled: stalled,
        busy: busy,
        refresh: refresh,
        dismiss: dismiss,
        setSignal: setSignal,
        reload: load,
      }
    }

    /* ------------------------------------------------------- conversation draft */

// A recommendation is useless if it cannot be handed to the model. The proven
// path (the one the native @-reference button uses) is the conversation draft
// face: ctx.sessions.scope(sessionId) + ctx.get('conversation').input.for(scope).
// There is no submit method on that face, so we fill the composer and let the
// user press Enter — silent auto-send would also throw away the review step.
function draftLead(draft) {
  if (draft.trim() === '') return ''
  return /\s$/.test(draft) ? '' : ' '
}

// Fold a clipboard-projection offset to the editor projection: every chip
// occupies one placeholder character there instead of its whole text.
function foldDraftOffset(draft, occurrences, offset) {
  const target = Math.max(0, Math.min(offset, draft.length))
  let shrink = 0
  for (const occurrence of occurrences) {
    const end = occurrence.offset + occurrence.length
    if (target >= end) {
      shrink += occurrence.length - 1
      continue
    }
    if (target > occurrence.offset) return occurrence.offset - shrink + 1
    break
  }
  return target - shrink
}

function appendOffsetOf(snapshot) {
  const draft = typeof snapshot.draft === 'string' ? snapshot.draft : ''
  const occurrences = Array.isArray(snapshot.occurrences) ? snapshot.occurrences : []
  const token =
    snapshot.phase === 'claimed' && snapshot.claim && draft.indexOf(snapshot.claim.token) === 0
      ? snapshot.claim.token
      : ''
  if (token === '') return foldDraftOffset(draft, occurrences, draft.length)
  const rest = draft.slice(token.length)
  const inner = occurrences
    .filter(function (item) {
      return item.offset >= token.length
    })
    .map(function (item) {
      return { offset: item.offset - token.length, length: item.length }
    })
  return 1 + foldDraftOffset(rest, inner, rest.length)
}

// Append text to the current session's composer. Returns true when the draft
// changed. Everything is guarded: a missing service degrades to false, never to
// a thrown render.
function appendToDraft(ctx, sessionId, text) {
  try {
    if (!ctx || typeof text !== 'string' || text === '') return false
    const sessions = ctx.get('sessions')
    const scope = sessions && typeof sessions.scope === 'function' ? sessions.scope(sessionId) : undefined
    if (!scope) return false
    const conversation = ctx.get('conversation')
    if (!conversation || !conversation.input || typeof conversation.input.for !== 'function') return false
    const input = conversation.input.for(scope)
    if (!input || !input.state || typeof input.state.getSnapshot !== 'function') return false
    const snapshot = input.state.getSnapshot()
    const draft = typeof snapshot.draft === 'string' ? snapshot.draft : ''
    const occurrences = Array.isArray(snapshot.occurrences) ? snapshot.occurrences : []
    const hasChips = occurrences.length > 0 || snapshot.phase === 'claimed'
    if (hasChips) {
      // setDraft rebuilds the document from a string and would flatten every
      // chip, so chip drafts go through the host's span channel instead.
      const at = appendOffsetOf(snapshot)
      if (snapshot.draftRev === undefined || at === undefined) return false
      if (typeof scope.emit !== 'function') return false
      scope.emit('slash/input-insert-text', {
        text: draftLead(draft) + text,
        span: { draftRev: snapshot.draftRev, start: at, end: at },
      })
      const after = input.state.getSnapshot()
      return after.draftRev !== snapshot.draftRev
    }
    if (typeof input.setDraft !== 'function') return false
    input.setDraft(draft + draftLead(draft) + text)
    return true
  } catch (error) {
    reportClientError('draft', error)
    return false
  }
}

// The message the model receives. Kept short but specific: a deep analysis
// needs the URL (it can fetch the README) plus what to answer.
function analysisPrompt(card, lang) {
  const url = card.htmlUrl || ''
  const meta = []
  if (card.language) meta.push(card.language)
  if (typeof card.stars === 'number') meta.push('★ ' + starText(card.stars))
  const english = card.descriptionEn ? String(card.descriptionEn).slice(0, 280) : ''
  if (lang === 'en') {
    return [
      'Please analyze this open-source project for me: ' + card.fullName,
      url,
      meta.length > 0 ? '(' + meta.join(' · ') + ')' : '',
      english !== '' ? 'Description: ' + english : '',
      '',
      'Cover: 1) what it solves and its core features; 2) architecture / key modules;',
      '3) how to get started (install + smallest useful example); 4) pitfalls and alternatives;',
      '5) whether it fits what I am working on right now.',
    ]
      .filter(function (line) {
        return line !== ''
      })
      .join('\n')
  }
  return [
    '帮我深度分析这个开源项目：' + card.fullName,
    url,
    meta.length > 0 ? '（' + meta.join(' · ') + '）' : '',
    english !== '' ? '简介：' + english : '',
    '',
    '请说明：1) 它解决什么问题、核心能力；2) 大致架构与关键模块；',
    '3) 怎么快速上手（安装 + 最小可用示例）；4) 有什么坑或替代方案；',
    '5) 适合引入到我现在做的事情里吗？',
  ]
    .filter(function (line) {
      return line !== ''
    })
    .join('\n')
}

/* -------------------------------------------------------------- primitives */

    function Icon(props) {
      const paths = {
        refresh: 'M13.65 2.35A8 8 0 1 0 16 8h-2a6 6 0 1 1-1.76-4.24L10 6h5V1l-1.35 1.35z',
        gear: 'M10 6.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7zM8.7 1.5h2.6l.4 2.1 1.5.9 2-.8 1.3 2.3-1.6 1.4v1.7l1.6 1.4-1.3 2.3-2-.8-1.5.9-.4 2.1H8.7l-.4-2.1-1.5-.9-2 .8-1.3-2.3 1.6-1.4V7.4L3.5 6l1.3-2.3 2 .8 1.5-.9.4-2.1z',
        external: 'M9 2h9v9h-2V5.4l-8.3 8.3-1.4-1.4L14.6 4H9V2zM3 4h5v2H5v9h9v-3h2v5H3V4z',
        copy: 'M6 2h10v12h-3v4H2V6h4V2zm2 2v2H4v10h7v-2H6V4zm1 0v10h7V4H9z',
        close: 'M4.2 2.8 10 8.6l5.8-5.8 1.4 1.4L11.4 10l5.8 5.8-1.4 1.4L10 11.4l-5.8 5.8-1.4-1.4L8.6 10 2.8 4.2l1.4-1.4z',
        dot: 'M10 3a7 7 0 1 0 0 14 7 7 0 0 0 0-14z',
        empty: 'M10 1.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17zm0 2a6.5 6.5 0 1 1 0 13 6.5 6.5 0 0 1 0-13zm0 2a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9z',
        plus: 'M9 3h2v6h6v2h-6v6H9v-6H3V9h6V3z',
        spark: 'M10 1.5l1.9 4.7 4.6 1.9-4.6 1.9L10 14.7l-1.9-4.7L3.5 8.1l4.6-1.9L10 1.5zm5.6 9.4l.9 2.2 2.2.9-2.2.9-.9 2.2-.9-2.2-2.2-.9 2.2-.9.9-2.2z',
      }
      return h(
        'svg',
        { viewBox: '0 0 20 20', width: props.size || 14, height: props.size || 14, 'aria-hidden': 'true', className: 'radar-icon' },
        h('path', { d: paths[props.name] || paths.dot, fill: 'currentColor' }),
      )
    }

    function IconButton(props) {
      return h(
        'button',
        {
          type: 'button',
          className: 'radar-icon-btn' + (props.active ? ' is-active' : ''),
          title: props.label,
          'aria-label': props.label,
          onClick: props.onClick,
          disabled: props.disabled,
        },
        h(Icon, { name: props.name }),
      )
    }

    function Skeleton() {
      return h(
        'div',
        { className: 'radar-skeleton' },
        h('div', { className: 'radar-skeleton-line w-40' }),
        h('div', { className: 'radar-skeleton-line w-70' }),
        h('div', { className: 'radar-skeleton-line w-90' }),
        h('div', { className: 'radar-skeleton-line w-50' }),
      )
    }

    /* ------------------------------------------------------------------ cards */

    function RadarCard(props) {
      const card = props.card
      const t = seatTranslator(props.t, props.translate || translator(ZH))
      const [copied, setCopied] = useState(false)
      const copiedTimer = useRef(null)

      useEffect(function () {
        return function () {
          if (copiedTimer.current !== null) clearTimeout(copiedTimer.current)
        }
      }, [])

      const install = card.install && card.install.length > 0 ? card.install[0] : ''
      const owner = card.fullName.indexOf('/') > 0 ? card.fullName.slice(0, card.fullName.indexOf('/')) : ''
      const name = owner === '' ? card.fullName : card.fullName.slice(owner.length + 1)

      const copy = function () {
        if (install === '') return
        const done = function () {
          setCopied(true)
          if (copiedTimer.current !== null) clearTimeout(copiedTimer.current)
          copiedTimer.current = setTimeout(function () {
            setCopied(false)
          }, 1600)
        }
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(install).then(done, function () {})
        }
      }

      return h(
        'article',
        { className: 'radar-card' },
        h(
          'div',
          { className: 'radar-card-name' },
          owner !== '' ? h('span', { className: 'radar-card-owner' }, owner + ' /') : null,
          h('span', { className: 'radar-card-repo' }, name),
          card.zhSource === 'llm' ? h('span', { className: 'radar-badge-ai' }, t('radar.card.ai')) : null,
        ),
        h(
          'div',
          { className: 'radar-card-meta' },
          card.language
            ? h(
                'span',
                { className: 'radar-lang' },
                h('i', { className: 'radar-lang-dot', style: { background: languageColor(card.language) } }),
                card.language,
              )
            : null,
          h('span', { className: 'radar-meta-item' }, '★ ' + starText(card.stars)),
          recencyText(card.pushedAt) !== ''
            ? h('span', { className: 'radar-meta-item' }, recencyText(card.pushedAt))
            : null,
        ),
        h('p', { className: 'radar-card-zh' }, card.zh),
        card.descriptionEn
          ? h('p', { className: 'radar-card-en', title: card.descriptionEn }, card.descriptionEn)
          : null,
        h('p', { className: 'radar-card-why' }, card.why),
        h(
          'div',
          { className: 'radar-card-foot' },
          h(
            'button',
            {
              type: 'button',
              className: 'radar-link',
              onClick: function () {
                props.onOpen(card)
              },
            },
            h(Icon, { name: 'external', size: 12 }),
            t('radar.card.open'),
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'radar-link radar-link-ask',
              onClick: function () {
                props.onAsk(card)
              },
            },
            h(Icon, { name: 'spark', size: 12 }),
            t('radar.card.ask'),
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'radar-link',
              onClick: copy,
              disabled: install === '',
              // The command is a guess from the repo's language, so show exactly
              // what will be copied before the click.
              title: install,
            },
            h(Icon, { name: 'copy', size: 12 }),
            copied ? t('radar.card.copied') : t('radar.card.copy'),
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'radar-link radar-link-quiet',
              onClick: function () {
                props.onDismiss(card)
              },
            },
            t('radar.card.dismiss'),
          ),
        ),
      )
    }

    /* --------------------------------------------------------------- settings */

    function Toggle(props) {
      return h(
        'button',
        {
          type: 'button',
          role: 'switch',
          'aria-checked': props.checked ? 'true' : 'false',
          className: 'radar-switch' + (props.checked ? ' is-on' : ''),
          onClick: function () {
            props.onChange(!props.checked)
          },
        },
        h('span', { className: 'radar-switch-knob' }),
      )
    }

    function Field(props) {
      return h(
        'label',
        { className: 'radar-field' },
        h('span', { className: 'radar-field-label' }, props.label),
        props.children,
        props.hint ? h('span', { className: 'radar-field-hint' }, props.hint) : null,
      )
    }

    function SettingsPanel(props) {
      const t = seatTranslator(props.t, props.translate || translator(ZH))
      // `initialDraft` lets the render smoke test (scripts/probe-client.mjs)
      // paint the form without a live host; production always starts empty.
      const [draft, setDraft] = useState(props.initialDraft || null)
      const [error, setError] = useState(null)
      const [saved, setSaved] = useState(false)
      const [testing, setTesting] = useState(false)
      const [testResult, setTestResult] = useState(null)
      const [loading, setLoading] = useState(props.initialDraft ? false : true)

      useEffect(function () {
        let alive = true
        api
          .settings()
          .then(function (payload) {
            if (!alive) return
            setDraft(payload)
            setLoading(false)
          })
          .catch(function (reason) {
            if (!alive) return
            setError(reason && reason.message ? reason.message : '读取设置失败')
            setLoading(false)
          })
        return function () {
          alive = false
        }
      }, [])

      const update = function (key, value) {
        setDraft(function (previous) {
          if (!previous) return previous
          const next = Object.assign({}, previous)
          next[key] = value
          return next
        })
        setSaved(false)
      }

      const save = function () {
        if (!draft) return
        setError(null)
        api
          .saveSettings({
            enableAiSummary: draft.enableAiSummary,
            minStars: Number(draft.minStars) || 0,
            maxCards: Number(draft.maxCards) || 5,
            languages: draft.languages || [],
            chineseOnly: draft.chineseOnly,
            allowNetwork: draft.allowNetwork,
            proxyUrl: draft.proxyUrl || '',
          })
          .then(function (payload) {
            setDraft(payload)
            setSaved(true)
          })
          .catch(function (reason) {
            setError(reason && reason.message ? reason.message : '保存失败')
          })
      }

      const saveToken = function () {
        if (!draft) return
        const token = draft.tokenInput || ''
        setError(null)
        api
          .saveSettings({ githubToken: token })
          .then(function (payload) {
            setDraft(Object.assign({}, payload, { tokenInput: '' }))
            setSaved(true)
          })
          .catch(function (reason) {
            setError(reason && reason.message ? reason.message : '令牌保存失败')
          })
      }

      const clearToken = function () {
        api
          .saveSettings({ clearToken: true })
          .then(function (payload) {
            setDraft(Object.assign({}, payload, { tokenInput: '' }))
            setTestResult(null)
          })
          .catch(function (reason) {
            setError(reason && reason.message ? reason.message : '令牌清除失败')
          })
      }

      const testToken = function () {
        if (!draft) return
        setTesting(true)
        setTestResult(null)
        api
          .tokenCheck(draft.tokenInput || '')
          .then(function (payload) {
            setTestResult(payload)
          })
          .catch(function (reason) {
            setTestResult({ ok: false, message: reason && reason.message ? reason.message : '测试失败' })
          })
          .then(function () {
            setTesting(false)
          })
      }

      if (loading) {
        return h('div', { className: 'radar-settings' }, h(Skeleton, null))
      }

      if (!draft) {
        return h('div', { className: 'radar-settings' }, h('p', { className: 'radar-hint' }, error || '读取设置失败'))
      }

      return h(
        'div',
        { className: 'radar-settings' },
        h('div', { className: 'radar-settings-head' }, t('setting.title'), h(IconButton, { name: 'close', label: t('setting.cancel'), onClick: props.onClose })),

        h(
          Field,
          { label: t('setting.githubToken'), hint: t('setting.githubToken.hint') },
          h(
            'div',
            { className: 'radar-row' },
            h('input', {
              type: 'password',
              className: 'radar-input',
              placeholder: draft.hasToken ? '已配置 · 输入新令牌可替换' : 'ghp_...',
              value: draft.tokenInput || '',
              onChange: function (event) {
                update('tokenInput', event.target.value)
              },
            }),
            h('button', { type: 'button', className: 'radar-btn', disabled: testing, onClick: testToken }, testing ? '…' : t('setting.testToken')),
          ),
          h(
            'div',
            { className: 'radar-row' },
            h('button', { type: 'button', className: 'radar-btn', onClick: saveToken, disabled: (draft.tokenInput || '').trim() === '' }, t('setting.save')),
            draft.hasToken ? h('button', { type: 'button', className: 'radar-btn radar-btn-quiet', onClick: clearToken }, '清除令牌') : null,
            testResult
              ? h('span', { className: 'radar-hint' }, testResult.ok ? '连接正常 · 搜索额度 ' + (testResult.quota ? testResult.quota.remaining + '/' + testResult.quota.limit : '未知') : testResult.message || '连接失败')
              : null,
          ),
        ),

        h(
          'div',
          { className: 'radar-setting-row' },
          h('div', null, h('div', { className: 'radar-field-label' }, t('setting.enableAiSummary')), h('div', { className: 'radar-field-hint' }, t('setting.enableAiSummary.hint'))),
          h(Toggle, { checked: draft.enableAiSummary, onChange: (value) => update('enableAiSummary', value) }),
        ),
        draft.aiReady === false && draft.enableAiSummary
          ? h('div', { className: 'radar-warn-line' }, t('setting.enableAiSummary.unavailable'))
          : null,
        h(
          'div',
          { className: 'radar-setting-row' },
          h('div', null, h('div', { className: 'radar-field-label' }, t('setting.chineseOnly')), h('div', { className: 'radar-field-hint' }, t('setting.chineseOnly.hint'))),
          h(Toggle, { checked: draft.chineseOnly, onChange: (value) => update('chineseOnly', value) }),
        ),
        h(
          'div',
          { className: 'radar-setting-row' },
          h('div', null, h('div', { className: 'radar-field-label' }, t('setting.allowNetwork')), h('div', { className: 'radar-field-hint' }, t('setting.allowNetwork.hint'))),
          h(Toggle, { checked: draft.allowNetwork, onChange: (value) => update('allowNetwork', value) }),
        ),

        h(
          Field,
          { label: t('setting.languages'), hint: t('setting.languages.hint') },
          h('input', {
            type: 'text',
            className: 'radar-input',
            value: (draft.languages || []).join(', '),
            onChange: function (event) {
              const parts = event.target.value
                .split(',')
                .map(function (item) {
                  return item.trim()
                })
                .filter(function (item) {
                  return item !== ''
                })
              update('languages', parts)
            },
          }),
        ),
        h(
          'div',
          { className: 'radar-row' },
          h(Field, { label: t('setting.minStars') }, h('input', {
            type: 'number',
            min: 0,
            className: 'radar-input radar-input-sm',
            value: draft.minStars,
            onChange: function (event) {
              update('minStars', Number(event.target.value))
            },
          })),
          h(Field, { label: t('setting.maxCards') }, h('input', {
            type: 'number',
            min: 1,
            max: 12,
            className: 'radar-input radar-input-sm',
            value: draft.maxCards,
            onChange: function (event) {
              update('maxCards', Number(event.target.value))
            },
          })),
        ),
        h(
          Field,
          { label: t('setting.proxyUrl'), hint: t('setting.proxyUrl.hint') },
          h('input', {
            type: 'text',
            className: 'radar-input',
            placeholder: 'http://127.0.0.1:8080',
            value: draft.proxyUrl || '',
            onChange: function (event) {
              update('proxyUrl', event.target.value)
            },
          }),
        ),

        error ? h('p', { className: 'radar-error' }, error) : null,
        h(
          'div',
          { className: 'radar-row' },
          h('button', { type: 'button', className: 'radar-btn radar-btn-primary', onClick: save }, saved ? t('setting.saved') : t('setting.save')),
          h('button', { type: 'button', className: 'radar-btn radar-btn-quiet', onClick: props.onClose }, t('setting.cancel')),
        ),
      )
    }

    /* ------------------------------------------------------------------- pane */

    function RadarPane(props) {
      const t = seatTranslator(props.t, props.translate || translator(ZH))
      const sessionId = props.sessionId || ''
      // Tab bodies get `useTabInfo` injected as a prop (framework hook); its
      // `tab.actions.openTab` is what opens the built-in browser pane.
      const tabInfo = typeof props.useTabInfo === 'function' ? props.useTabInfo() : null
      const tab = props.tab || (tabInfo && tabInfo.tab) || (props.tabInfo && props.tabInfo.tab)
      const radar = useRadar(sessionId)
      const [showSettings, setShowSettings] = useState(false)
      const [hint, setHint] = useState('')
      const hintTimer = useRef(null)
      // Chip editor: null (closed) | 'keyword' | 'error'. `draft` is the
      // half-typed keyword or pasted error line.
      const [editing, setEditing] = useState(null)
      const [draft, setDraft] = useState('')
      const state = radar.state

      // Hand a repo to the model: the prompt lands in the composer so the user
      // can still edit or cancel it before sending.
      const ask = function (card) {
        const wrote = typeof props.askAboutCard === 'function' ? props.askAboutCard(card) : false
        setHint(wrote ? t('radar.ask.inserted') : t('radar.ask.failed'))
        if (hintTimer.current !== null) clearTimeout(hintTimer.current)
        hintTimer.current = setTimeout(function () {
          setHint('')
        }, 4000)
        return wrote
      }

      const openCard = function (card) {
        api.click(card.fullName).catch(function () {})
        const actions = tab && tab.actions
        if (actions && typeof actions.openTab === 'function') {
          try {
            actions.openTab('browser', { params: { url: card.htmlUrl } })
            return
          } catch (_) {
            /* fall through to window.open */
          }
        }
        try {
          window.open(card.htmlUrl, '_blank', 'noopener')
        } catch (_) {
          /* ignore */
        }
      }

      // A transport failure or a request that never answers must surface as an
      // error block, not as an endless skeleton (status stays 'idle' otherwise).
      const failing = radar.error !== null || radar.stalled === true
      const status = state && state.status ? state.status : failing ? 'error' : 'loading'
      const failureText = state && state.errorMessage
        ? state.errorMessage
        : radar.error !== null
          ? String(radar.error)
          : radar.stalled === true
            ? t('radar.loading.stalled')
            : ''
      const cards = state && state.cards ? state.cards : []
      const keywords = state && state.keywords ? state.keywords : []
      const quota = state && state.quota ? state.quota : null
      const notice = state ? state.notice : null
      const retryAfterMs = state && state.retryAfterMs ? state.retryAfterMs : 0

      const chips = []
      for (const keyword of keywords.slice(0, 5)) chips.push(keyword)
      const errorText = state && state.errorText ? state.errorText : ''

      // Commit the chip editor. A new keyword goes to the front and the oldest
      // one falls off, so adding a 6th keyword is not a silent no-op.
      const commit = function () {
        const value = draft.trim()
        if (value === '') return
        if (editing === 'error') {
          radar.setSignal({ errorText: value })
        } else {
          const rest = chips.filter(function (item) {
            return item.toLowerCase() !== value.toLowerCase()
          })
          radar.setSignal({ keywords: [value].concat(rest).slice(0, 5) })
        }
        setEditing(null)
        setDraft('')
      }

      return h(
        'div',
        { className: 'radar-pane', 'data-plugin': PLUGIN_ID },
        h(
          'header',
          { className: 'radar-head' },
          h('span', { className: 'radar-head-dot' }),
          h('span', { className: 'radar-head-title' }, t('radar.title')),
          h('span', { className: 'radar-head-spacer' }),
          h(IconButton, {
            name: 'refresh',
            label: t('radar.refresh'),
            onClick: function () {
              radar.refresh(true)
            },
            disabled: radar.busy || sessionId === '',
          }),
          h(IconButton, {
            name: 'gear',
            label: t('radar.settings'),
            active: showSettings,
            onClick: function () {
              setShowSettings(!showSettings)
            },
          }),
        ),

        showSettings
          ? h(SettingsPanel, {
              t: t,
              onClose: function () {
                setShowSettings(false)
                radar.refresh(false)
              },
            })
          : null,

        !showSettings
          ? h(
              'section',
              { className: 'radar-signals' },
              h(
                'div',
                { className: 'radar-signals-head' },
                h('span', null, t('radar.signals')),
                h('span', { className: 'radar-signals-spacer' }),
                state && (state.keywordsManual === true || state.errorManual === true)
                  ? h(
                      'button',
                      {
                        className: 'radar-link',
                        disabled: radar.busy,
                        onClick: function () {
                          setEditing(null)
                          setDraft('')
                          radar.setSignal({ reset: true })
                        },
                      },
                      t('radar.signal.reset'),
                    )
                  : null,
              ),
              h(
                'div',
                { className: 'radar-chips' },
                chips.map(function (keyword) {
                  return h(
                    'span',
                    { key: 'kw-' + keyword, className: 'radar-chip' },
                    h('b', null, keyword),
                    h(
                      'button',
                      {
                        className: 'radar-chip-x',
                        title: t('radar.signal.remove'),
                        disabled: radar.busy,
                        onClick: function () {
                          radar.setSignal({
                            keywords: chips.filter(function (item) {
                              return item !== keyword
                            }),
                          })
                        },
                      },
                      '×',
                    ),
                  )
                }),
                errorText !== ''
                  ? h(
                      'span',
                      { className: 'radar-chip radar-chip-error' },
                      t('radar.error.label') + ' · ' + errorText.slice(0, 60),
                      h(
                        'button',
                        {
                          className: 'radar-chip-x',
                          title: t('radar.signal.remove'),
                          disabled: radar.busy,
                          onClick: function () {
                            radar.setSignal({ errorText: null })
                          },
                        },
                        '×',
                      ),
                    )
                  : null,
                state && state.trending === true && chips.length === 0
                  ? h(
                      'span',
                      { className: 'radar-chip radar-chip-add', title: t('radar.trending.hint') },
                      t('radar.trending.chip'),
                    )
                  : null,
                editing === null
                  ? h(
                      'span',
                      { className: 'radar-chip radar-chip-add' },
                      h(
                        'button',
                        {
                          className: 'radar-link',
                          disabled: radar.busy,
                          onClick: function () {
                            setEditing('keyword')
                            setDraft('')
                          },
                        },
                        '＋ ' + t('radar.signal.add'),
                      ),
                      h(
                        'button',
                        {
                          className: 'radar-link',
                          disabled: radar.busy,
                          onClick: function () {
                            setEditing('error')
                            setDraft(errorText)
                          },
                        },
                        '＋ ' + t('radar.signal.addError'),
                      ),
                    )
                  : null,
              ),
              editing === null
                ? null
                : h(
                    'div',
                    { className: 'radar-chip-editor' },
                    h('input', {
                      className: 'radar-input',
                      value: draft,
                      maxLength: editing === 'error' ? 200 : 24,
                      placeholder:
                        editing === 'error' ? t('radar.signal.errorPlaceholder') : t('radar.signal.placeholder'),
                      onChange: function (event) {
                        setDraft(event.target.value)
                      },
                      onKeyDown: function (event) {
                        if (event.key === 'Enter') {
                          event.preventDefault()
                          commit()
                        } else if (event.key === 'Escape') {
                          setEditing(null)
                          setDraft('')
                        }
                      },
                    }),
                    h(
                      'button',
                      { className: 'radar-btn', disabled: radar.busy || draft.trim() === '', onClick: commit },
                      t('radar.signal.apply'),
                    ),
                    h(
                      'button',
                      {
                        className: 'radar-btn radar-btn-quiet',
                        onClick: function () {
                          setEditing(null)
                          setDraft('')
                        },
                      },
                      t('common.cancel'),
                    ),
                    chips.length >= 5 && editing === 'keyword'
                      ? h('span', { className: 'radar-field-hint' }, t('radar.signal.limit'))
                      : null,
                  ),
            )
          : null,

        notice !== '' && notice !== null && notice !== undefined
          ? h('div', { className: 'radar-notice' }, notice)
          : null,

        h(
          'div',
          { className: 'radar-body' },
          status === 'loading'
            ? h(
                'div',
                { className: 'radar-loading' },
                h(Skeleton, null),
                h(Skeleton, null),
                h('p', { className: 'radar-hint radar-center' }, t('radar.loading.title')),
                h('p', { className: 'radar-hint radar-center radar-hint-dim' }, t('radar.loading.hint')),
              )
            : null,

          status === 'empty'
            ? h(
                'div',
                { className: 'radar-empty' },
                h('div', { className: 'radar-empty-icon' }, h(Icon, { name: 'empty', size: 28 })),
                h('p', { className: 'radar-empty-title' }, t('radar.empty.title')),
                h('p', { className: 'radar-hint radar-center' }, t('radar.empty.hint')),
                h('p', { className: 'radar-hint radar-center radar-hint-dim' }, t('radar.privacy')),
              )
            : null,

          status === 'rateLimited'
            ? h(
                'div',
                { className: 'radar-empty' },
                h('div', { className: 'radar-empty-icon' }, h(Icon, { name: 'dot', size: 26 })),
                h('p', { className: 'radar-empty-title' }, t('radar.rateLimited')),
                h('p', { className: 'radar-hint radar-center' }, retryAfterMs > 0 ? Math.round(retryAfterMs / 1000) + ' 秒后自动重试' : '稍后自动重试'),
                h('button', { type: 'button', className: 'radar-btn', onClick: function () { setShowSettings(true) } }, '配置令牌'),
              )
            : null,

          status === 'offline'
            ? h(
                'div',
                { className: 'radar-empty' },
                h('div', { className: 'radar-empty-icon' }, h(Icon, { name: 'dot', size: 26 })),
                h('p', { className: 'radar-empty-title' }, t('radar.offline')),
                h('p', { className: 'radar-hint radar-center' }, state && state.errorMessage ? state.errorMessage : '检查网络或代理设置。'),
                h('button', { type: 'button', className: 'radar-btn', onClick: function () { radar.refresh(true) } }, t('radar.retry')),
              )
            : null,

          status === 'error'
            ? h(
                'div',
                { className: 'radar-empty' },
                h('p', { className: 'radar-empty-title' }, t('radar.error')),
                h('p', { className: 'radar-hint radar-center' }, failureText !== '' ? failureText : '未知错误'),
                h('button', { type: 'button', className: 'radar-btn', onClick: function () { radar.refresh(true) } }, t('radar.retry')),
              )
            : null,

          cards.length > 0
            ? h(
                'div',
                { className: 'radar-cards' },
                cards.map(function (card) {
                  return h(RadarCard, {
                    key: card.fullName,
                    card: card,
                    t: t,
                    onOpen: openCard,
                    onAsk: ask,
                    onDismiss: function (item) {
                      radar.dismiss(item.fullName)
                    },
                  })
                }),
              )
            : null,
        ),

        hint !== '' ? h('div', { className: 'radar-notice radar-notice-ok' }, hint) : null,

        h(
          'footer',
          { className: 'radar-foot' },
          h(
            'span',
            { className: 'radar-quota' },
            quota
              ? (state && state.anonymous === false ? t('radar.quota.token') : t('radar.quota'))
                  .split('{remaining}')
                  .join(String(quota.remaining))
                  .split('{limit}')
                  .join(String(quota.limit))
              : t('radar.quota.none'),
          ),
          h('span', { className: 'radar-head-spacer' }),
          h(
            'button',
            {
              type: 'button',
              className: 'radar-link radar-link-quiet',
              onClick: function () {
                setShowSettings(!showSettings)
              },
            },
            t('radar.settings'),
          ),
        ),
      )
    }

    /* ------------------------------------------------------------------ style */

    // Only the tokens reported by the client `Theme` inspect provider exist in
    // this runtime: bg-base / bg-layer-1 / bg-layer-2 / bg-overlay /
    // border-l1 / border-l2 / brand-primary / label-primary / label-secondary /
    // state-{error,idle,success,warn}-primary / specific-sidebar-fill.
    // Anything else silently falls back, which is how the off-state switch used
    // to become invisible in the light theme (translucent white on white).
    const CSS = `
.radar-pane{display:flex;flex-direction:column;height:100%;min-height:0;font-size:13px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1,#1b1d22);}
.radar-head{display:flex;align-items:center;gap:8px;padding:10px 12px 8px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.22));}
.radar-head-dot{width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-brand-primary,#5b8def);box-shadow:0 0 0 3px rgba(91,141,239,.16);}
.radar-head-title{font-weight:600;letter-spacing:.2px;}
.radar-head-spacer{flex:1;}
.radar-icon-btn{display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;}
.radar-icon-btn:hover{background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.16));color:var(--dsw-alias-label-primary);}
.radar-icon-btn:disabled{opacity:.4;cursor:default;}
.radar-icon-btn.is-active{background:rgba(91,141,239,.16);color:var(--dsw-alias-brand-primary,#5b8def);}
.radar-signals{padding:8px 12px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.2));}
.radar-signals-head{font-size:11px;color:var(--dsw-alias-label-secondary);opacity:.85;margin-bottom:6px;display:flex;align-items:center;gap:8px;}
.radar-signals-spacer{flex:1;}
.radar-link{background:none;border:none;padding:0;margin:0;color:var(--dsw-alias-brand-primary,#5b8def);font-size:11px;cursor:pointer;opacity:.9;}
.radar-link:hover{opacity:1;text-decoration:underline;}
.radar-link:disabled{opacity:.45;cursor:default;text-decoration:none;}
.radar-link-ask{color:var(--dsw-alias-brand-primary,#5b8def);font-weight:600;}
.radar-notice-ok{background:rgba(91,141,239,.12);color:var(--dsw-alias-brand-primary,#5b8def);}
.radar-chips{display:flex;flex-wrap:wrap;gap:6px;}
.radar-chip{display:inline-flex;align-items:center;gap:4px;padding:2px 7px;border-radius:999px;background:rgba(91,141,239,.13);color:var(--dsw-alias-label-secondary);font-size:11px;}
.radar-chip b{font-weight:600;color:var(--dsw-alias-label-primary);}
.radar-chip-x{background:none;border:none;padding:0 0 0 2px;margin:0;line-height:1;font-size:13px;color:var(--dsw-alias-label-secondary);cursor:pointer;opacity:.75;}
.radar-chip-x:hover{opacity:1;color:var(--dsw-alias-state-error-primary,#e26d6d);}
.radar-chip-x:disabled{opacity:.35;cursor:default;}
.radar-chip-add{background:transparent;border:1px dashed var(--dsw-alias-border-l2,rgba(127,127,127,.4));gap:10px;padding:2px 8px;}
.radar-chip-editor{display:flex;align-items:center;gap:6px;margin-top:8px;}
.radar-chip-error{background:rgba(240,120,120,.14);color:var(--dsw-alias-label-secondary);max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.radar-notice{margin:8px 12px 0;padding:6px 9px;border-radius:6px;background:rgba(214,173,84,.14);color:var(--dsw-alias-state-warn-primary,#c99a3b);font-size:12px;line-height:1.45;}
.radar-body{flex:1;min-height:0;overflow:auto;padding:10px 12px;display:flex;flex-direction:column;gap:10px;}
.radar-cards{display:flex;flex-direction:column;gap:10px;}
.radar-card{border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.22));border-radius:10px;padding:10px 11px;background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.07));transition:border-color .15s ease;}
.radar-card:hover{border-color:var(--dsw-alias-brand-primary,#5b8def);}
.radar-card-name{display:flex;align-items:baseline;gap:5px;flex-wrap:wrap;font-size:13px;}
.radar-card-owner{color:var(--dsw-alias-label-secondary);opacity:.8;}
.radar-card-repo{font-weight:600;color:var(--dsw-alias-label-primary);word-break:break-all;}
.radar-badge-ai{margin-left:2px;padding:0 5px;border-radius:4px;font-size:10px;line-height:15px;background:rgba(91,141,239,.18);color:var(--dsw-alias-brand-primary,#5b8def);}
.radar-card-meta{display:flex;align-items:center;gap:10px;margin-top:4px;font-size:11px;color:var(--dsw-alias-label-secondary);opacity:.9;flex-wrap:wrap;}
.radar-lang{display:inline-flex;align-items:center;gap:4px;}
.radar-lang-dot{width:7px;height:7px;border-radius:50%;display:inline-block;}
.radar-meta-item{white-space:nowrap;}
.radar-card-zh{margin:7px 0 0;line-height:1.5;font-size:12.5px;}
.radar-card-en{margin:4px 0 0;font-size:11px;line-height:1.45;color:var(--dsw-alias-label-secondary);opacity:.78;display:-webkit-box;-webkit-line-clamp:1;-webkit-box-orient:vertical;overflow:hidden;}
.radar-card-why{margin:6px 0 0;padding-left:7px;border-left:2px solid var(--dsw-alias-brand-primary,#5b8def);font-size:11.5px;line-height:1.45;color:var(--dsw-alias-label-secondary);}
.radar-card-foot{display:flex;align-items:center;gap:12px;margin-top:8px;}
.radar-link{display:inline-flex;align-items:center;gap:4px;border:0;background:transparent;padding:0;font-size:11.5px;color:var(--dsw-alias-brand-primary,#5b8def);cursor:pointer;}
.radar-link:hover{text-decoration:underline;}
.radar-link:disabled{opacity:.4;cursor:default;text-decoration:none;}
.radar-link-quiet{color:var(--dsw-alias-label-secondary);margin-left:auto;}
.radar-foot{display:flex;align-items:center;gap:10px;padding:7px 12px;border-top:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.22));font-size:11px;color:var(--dsw-alias-label-secondary);}
.radar-quota{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.radar-empty{display:flex;flex-direction:column;align-items:center;gap:6px;padding:18px 8px;}
.radar-empty-icon{color:var(--dsw-alias-label-secondary);opacity:.7;}
.radar-empty-title{font-weight:600;font-size:13px;margin:2px 0;}
.radar-hint{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.5;margin:0;}
.radar-hint-dim{color:var(--dsw-alias-label-secondary);opacity:.75;font-size:11px;}
.radar-center{text-align:center;}
.radar-error{color:var(--dsw-alias-state-error-primary,#d9534f);font-size:12px;margin:0;}
.radar-loading{display:flex;flex-direction:column;gap:10px;}
.radar-skeleton{border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.22));border-radius:10px;padding:12px;display:flex;flex-direction:column;gap:8px;}
.radar-skeleton-line{height:9px;border-radius:5px;background:linear-gradient(90deg,var(--dsw-alias-bg-layer-2,rgba(127,127,127,.12)),var(--dsw-alias-border-l1,rgba(127,127,127,.26)),var(--dsw-alias-bg-layer-2,rgba(127,127,127,.12)));background-size:200% 100%;animation:radar-shimmer 1.4s ease-in-out infinite;}
.radar-skeleton-line.w-40{width:40%;}
.radar-skeleton-line.w-50{width:50%;}
.radar-skeleton-line.w-70{width:70%;}
.radar-skeleton-line.w-90{width:90%;}
@keyframes radar-shimmer{0%{background-position:200% 0;}100%{background-position:-200% 0;}}
.radar-pane{position:relative;}
.radar-settings{position:absolute;left:0;right:0;top:39px;bottom:31px;overflow:auto;padding:12px;background:var(--dsw-alias-bg-layer-1,#1b1d22);border-bottom:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.22));z-index:5;display:flex;flex-direction:column;gap:12px;}
.radar-settings-head{display:flex;align-items:center;font-weight:600;font-size:13px;}
.radar-settings-head .radar-icon-btn{margin-left:auto;}
.radar-setting-row{display:flex;align-items:flex-start;gap:10px;}
.radar-setting-row>div:first-child{flex:1;min-width:0;}
.radar-switch{position:relative;width:34px;height:19px;border-radius:999px;border:0;background:var(--dsw-alias-border-l2,rgba(127,127,127,.5));cursor:pointer;padding:0;flex:none;transition:background .15s ease;}
.radar-switch.is-on{background:var(--dsw-alias-brand-primary,#5b8def);}
.radar-switch-knob{position:absolute;top:2px;left:2px;width:15px;height:15px;border-radius:50%;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.32);transition:transform .15s ease;}
.radar-switch.is-on .radar-switch-knob{transform:translateX(15px);}
.radar-field{display:flex;flex-direction:column;gap:4px;flex:1;min-width:0;}
.radar-field-label{font-size:12px;color:var(--dsw-alias-label-primary);}
.radar-field-hint{font-size:11px;color:var(--dsw-alias-label-secondary);opacity:.8;line-height:1.45;}
.radar-warn-line{font-size:11px;color:var(--dsw-alias-state-warn-primary,#c99a3b);line-height:1.45;margin:-2px 0 2px 2px;}
.radar-input{width:100%;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.35));border-radius:6px;background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.1));color:var(--dsw-alias-label-primary);font-size:12px;padding:5px 8px;outline:none;}
.radar-input:focus{border-color:var(--dsw-alias-brand-primary,#5b8def);box-shadow:0 0 0 2px rgba(91,141,239,.18);}
.radar-input-sm{width:84px;}
.radar-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}
.radar-btn{border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.35));border-radius:6px;background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.1));color:var(--dsw-alias-label-primary);font-size:12px;padding:4px 10px;cursor:pointer;}
.radar-btn:hover{border-color:var(--dsw-alias-brand-primary,#5b8def);}
.radar-btn:disabled{opacity:.45;cursor:default;}
.radar-btn-primary{background:var(--dsw-alias-brand-primary,#5b8def);border-color:transparent;color:#fff;}
.radar-btn-quiet{background:transparent;color:var(--dsw-alias-label-secondary);}
`

    // Failures inside a dynamic client half are silent in the browser: a thrown
    // `apply` or a crashing render leaves a tab with no body and no message.
    // Everything reports to the Host, which appends it to client-errors.jsonl.
    function reportClientError(kind, error) {
      try {
        const payload = {
          kind: kind,
          message: error && error.message ? String(error.message) : String(error),
          stack: error && error.stack ? String(error.stack) : '',
          url: typeof location === 'object' && location ? String(location.href) : '',
          agent: typeof navigator === 'object' && navigator ? String(navigator.userAgent || '') : '',
        }
        fetch('/radar/client-error', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        }).catch(function () {})
      } catch (_) {
        /* reporting must never break the plugin */
      }
    }

    // A crashing body component would otherwise be replaced by the sidebar's
    // generic "nothing can view this" notice, which is impossible to diagnose.
    function RadarPaneSafe(props) {
      try {
        return RadarPane(props)
      } catch (error) {
        reportClientError('render', error)
        return h(
          'div',
          { className: 'radar-pane' },
          h('p', { className: 'radar-error' }, '面板渲染失败：' + (error && error.message ? error.message : String(error))),
          h('p', { className: 'radar-hint' }, '已把错误写入 plugin-data/dsh-github-radar/client-errors.jsonl。'),
        )
      }
    }

    function injectStyle() {
      const existing = document.querySelector('style[data-plugin="' + PLUGIN_ID + '"]')
      if (existing !== null) return function () {}
      const style = document.createElement('style')
      style.setAttribute('data-plugin', PLUGIN_ID)
      style.textContent = CSS
      document.head.appendChild(style)
      return function () {
        style.remove()
      }
    }

    /* ------------------------------------------------------------------- apply */

    return {
      inject: ['slots', 'locale'],
      // Exposed for `scripts/probe-client.mjs`: rendering the pieces in Node
      // catches crashes that would otherwise only show up in a browser.
      __components: {
        RadarPane: RadarPane,
        RadarCard: RadarCard,
        SettingsPanel: SettingsPanel,
        Toggle: Toggle,
        Field: Field,
      },
      // Same reason: the conversation-draft bridge touches host services that
      // do not exist in Node, so its edge cases are checked from a probe.
      __internals: {
        appendToDraft: appendToDraft,
        analysisPrompt: analysisPrompt,
        foldDraftOffset: foldDraftOffset,
        appendOffsetOf: appendOffsetOf,
        draftLead: draftLead,
      },
      apply: function (ctx) {
        // One failing step must not take the whole half down: each effect is
        // isolated and reports instead of throwing into the loader.
        const safeEffect = function (label, fn) {
          try {
            ctx.effect(function () {
              try {
                return fn()
              } catch (error) {
                reportClientError('effect:' + label, error)
                return undefined
              }
            }, 'radar-' + label)
          } catch (error) {
            reportClientError('effect:' + label, error)
          }
        }

        safeEffect('styles', injectStyle)

        if (ctx.locale && typeof ctx.locale.register === 'function') {
          safeEffect('locale', function () {
            return ctx.locale.register('githubRadar', { zh: ZH, en: EN })
          })
        }

        // Tab titles and guide cards are rendered outside our components, so
        // they cannot use the injected `t` seat. `locale.bind(ns)` returns a
        // stable translate function that reads the active locale at call time.
        // It is only a helper though: the sidebar guide renders our titles in a
        // place where the namespace is not guaranteed to be live yet, which
        // shows up as a raw `radar.title` label. So every lookup falls back to
        // the dictionary shipped inside this file.
        const localTranslate = function (key) {
          let active = 'zh-CN'
          try {
            if (ctx.locale && typeof ctx.locale.getLocale === 'function') {
              active = String(ctx.locale.getLocale().active || 'zh-CN')
            }
          } catch (_) {
            /* keep the default */
          }
          const dict = active.toLowerCase().indexOf('en') === 0 ? EN : ZH
          if (typeof dict[key] === 'string') return dict[key]
          if (typeof ZH[key] === 'string') return ZH[key]
          return key
        }
        const bound = (function () {
          try {
            if (ctx.locale && typeof ctx.locale.bind === 'function') {
              return ctx.locale.bind('githubRadar')
            }
          } catch (_) {
            /* fall through to the local dictionary */
          }
          return null
        })()
        const t = function (key) {
          if (typeof bound === 'function') {
            try {
              const value = bound(key)
              if (typeof value === 'string' && value !== '' && value !== key) return value
            } catch (_) {
              /* fall through to the local dictionary */
            }
          }
          return localTranslate(key)
        }
        t.local = localTranslate

        // Body and title first: a tab type registered without a body would be
        // dispatched to "nothing can view this", which is exactly the state a
        // half-applied plugin produces.
        safeEffect('pane', function () {
          return ctx.slots.inject('sidebar.right.pane.tab', function () {
            return ctx.slots.register(
              {
                name: 'sidebar.right.pane.tab',
                key: TAB_ID,
                locale: 'githubRadar',
                inject: function (sessionId) {
                  return {
                    sessionId: sessionId,
                    translate: t,
                    askAboutCard: function (card) {
                      let lang = 'zh'
                      try {
                        const active = String(ctx.locale.getLocale().active || 'zh-CN').toLowerCase()
                        lang = active.indexOf('en') === 0 ? 'en' : 'zh'
                      } catch (_) {
                        /* default to Chinese */
                      }
                      return appendToDraft(ctx, sessionId, analysisPrompt(card, lang))
                    },
                  }
                },
              },
              RadarPaneSafe,
            )
          })
        })

        safeEffect('pane-title', function () {
          return ctx.slots.inject('sidebar.right.pane.tab.title', function () {
            return ctx.slots.register(
              {
                name: 'sidebar.right.pane.tab.title',
                key: TAB_ID,
                locale: 'githubRadar',
              },
              function (props) {
                // `props.t` comes from the slot's `locale` namespace and is
                // normally live; when it is not (first paint, namespace not
                // registered yet) it hands back the key, so prefer our own
                // dictionary-backed translator.
                const fallback = typeof t === 'function' ? t : translator(ZH)
                const seat = props.t
                const translate = function (key) {
                  if (typeof seat === 'function') {
                    try {
                      const value = seat(key)
                      if (typeof value === 'string' && value !== '' && value !== key) return value
                    } catch (_) {
                      /* fall through */
                    }
                  }
                  return fallback(key)
                }
                return h('span', { className: 'radar-tab-title' }, translate('radar.title'))
              },
            )
          })
        })

        // The registry rejects a duplicate id, and this effect re-runs whenever a
        // reactive read inside it changes, so registration has to be idempotent:
        // keep one disposer, skip re-registration, and release it on cleanup.
        let tabDisposer
        let tabRegistered = false
        const register = function (tabs) {
          if (!tabs || typeof tabs.register !== 'function') return undefined
          if (tabRegistered) return undefined
          tabRegistered = true
          const definition = {
            id: TAB_ID,
            kind: TAB_KIND,
            keepMounted: true,
            priority: 'extension',
            title: function () {
              return t('radar.title')
            },
            guide: [
              {
                id: TAB_ID,
                order: 100,
                title: function () {
                  return t('radar.title')
                },
                description: function () {
                  return t('radar.guide.description')
                },
              },
            ],
          }
          try {
            tabDisposer = tabs.register(definition)
          } catch (error) {
            // A previous instance of the module can still hold the id while the
            // host swaps bundles; that is a stale registration, not our failure.
            if (/already registered/.test(String((error && error.message) || error))) {
              tabDisposer = undefined
              return undefined
            }
            tabRegistered = false
            throw error
          }
          return undefined
        }
        const release = function () {
          const disposer = tabDisposer
          tabDisposer = undefined
          tabRegistered = false
          if (typeof disposer === 'function') {
            try {
              disposer()
            } catch {
              /* the registry may already be gone during shutdown */
            }
          }
        }
        safeEffect('tab', function () {
          // `sidebarRightTabs` may not exist yet when the module runs with
          // `immediately: true`; wait for the service when the host can tell us.
          let inner
          if (typeof ctx.inject === 'function') {
            try {
              inner = ctx.inject(['sidebarRightTabs'], function (injected) {
                const tabs =
                  injected && typeof injected.get === 'function'
                    ? injected.get('sidebarRightTabs')
                    : ctx.get('sidebarRightTabs')
                register(tabs)
              })
            } catch (error) {
              inner = undefined
              reportClientError('tab-inject', error)
            }
          } else {
            register(ctx.get ? ctx.get('sidebarRightTabs') : undefined)
          }
          register(ctx.get ? ctx.get('sidebarRightTabs') : undefined)
          return function cleanup() {
            if (typeof inner === 'function') {
              try {
                inner()
              } catch {
                /* ignore */
              }
            }
            release()
          }
        })
      },
    }
  },
})
