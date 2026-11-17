import { describe, expect, it } from 'vitest'
import { guessInstall, rankRepos, type Candidate } from '../src/host/rank.js'
import type { FeedbackFile, GitHubRepo } from '../src/host/types.js'

const NOW = Date.UTC(2026, 0, 1)

function repo(over: Partial<GitHubRepo> & { full_name: string }): GitHubRepo {
  return {
    html_url: `https://github.com/${over.full_name}`,
    description: 'A useful open source project',
    topics: [],
    language: 'Python',
    stargazers_count: 1_000,
    pushed_at: new Date(NOW - 5 * 86_400_000).toISOString(),
    archived: false,
    fork: false,
    ...over,
  }
}

function candidate(full_name: string, over: Partial<GitHubRepo> = {}, sources: string[] = ['keyword:fastapi']): Candidate {
  return { repo: repo({ full_name, ...over }), sources }
}

const context = {
  signal: { keywords: ['fastapi'], languages: [], errorText: undefined },
  settings: { maxCards: 5, minStars: 0, languages: [], chineseOnly: false },
  feedback: { dismissed: {}, clicked: {}, stars: {} } as FeedbackFile,
  now: NOW,
}

describe('rankRepos', () => {
  it('prefers the more popular, more recently pushed repository', () => {
    const result = rankRepos(
      [candidate('small/old', { stargazers_count: 900 }), candidate('big/new', { stargazers_count: 40_000 })],
      context,
    )
    expect(result.cards.map((card) => card.fullName)).toEqual(['big/new', 'small/old'])
  })

  it('orders a batch of tiny repositories by their stars', () => {
    // The "刚起步" fallback returns 1★–14★ repos; against the global 200k
    // baseline every star score was ~0, so the order looked random.
    const result = rankRepos(
      [
        candidate('a/tiny', { stargazers_count: 1 }),
        candidate('b/tiny', { stargazers_count: 14 }),
        candidate('c/tiny', { stargazers_count: 2 }),
      ],
      { ...context, settings: { ...context.settings, minStars: 30 } },
    )
    expect(result.cards.map((card) => card.fullName)).toEqual(['b/tiny', 'c/tiny', 'a/tiny'])
  })

  it('prefers mid-size active projects over evergreen mega repos when trending', () => {
    // 500k-star lists are "famous", not "trending": they are active by
    // definition, so a star-maximising score would always surface them first.
    const result = rankRepos(
      [
        candidate('giant/list', { stargazers_count: 563_190, pushed_at: new Date(NOW - 86_400_000).toISOString() }, [
          'trending',
        ]),
        candidate('fresh/tool', { stargazers_count: 9_000, pushed_at: new Date(NOW - 86_400_000).toISOString() }, [
          'trending',
        ]),
      ],
      {
        ...context,
        signal: { keywords: [], languages: [], errorText: undefined },
        trending: true,
      },
    )
    expect(result.cards.map((card) => card.fullName)).toEqual(['fresh/tool', 'giant/list'])
  })

  it('spreads trending cards across the star bands', () => {
    // Every band's best card sits on its ceiling, so a plain score order would
    // fill the panel with same-sized repos: round-robin instead.
    const result = rankRepos(
      [
        candidate('a/small', { stargazers_count: 900 }, ['trending:0']),
        candidate('b/mid', { stargazers_count: 6_000 }, ['trending:1']),
        candidate('c/new', { stargazers_count: 3_000 }, ['trending:2']),
        candidate('d/small', { stargazers_count: 800 }, ['trending:0']),
      ],
      { ...context, signal: { keywords: [], languages: [], errorText: undefined }, trending: true },
    )
    expect(result.cards.slice(0, 3).map((card) => card.fullName)).toEqual(['b/mid', 'c/new', 'a/small'])
  })

  it('explains a trending card without inventing a keyword match', () => {
    const result = rankRepos([candidate('hot/repo', {}, ['trending'])], {
      ...context,
      signal: { keywords: [], languages: [], errorText: undefined },
      trending: true,
    })
    expect(result.cards[0].why).toContain('近期热门')
  })

  it('drops archived repositories', () => {
    const result = rankRepos([candidate('dead/old', { archived: true })], context)
    expect(result.cards).toHaveLength(0)
  })

  it('drops dismissed repositories for 30 days', () => {
    const result = rankRepos([candidate('noisy/repo')], {
      ...context,
      feedback: { dismissed: { 'noisy/repo': NOW - 86_400_000 }, clicked: {}, stars: {} },
    })
    expect(result.cards).toHaveLength(0)
    const later = rankRepos([candidate('noisy/repo')], {
      ...context,
      feedback: { dismissed: { 'noisy/repo': NOW - 40 * 86_400_000 }, clicked: {}, stars: {} },
    })
    expect(later.cards).toHaveLength(1)
  })

  it('never repeats a repository already shown in this session', () => {
    const result = rankRepos([candidate('seen/repo')], { ...context, seen: ['seen/repo'] })
    expect(result.cards).toHaveLength(0)
  })

  it('keeps at most one repository per owner', () => {
    const result = rankRepos(
      [candidate('acme/one'), candidate('acme/two'), candidate('other/three')],
      context,
    )
    expect(result.cards.map((card) => card.fullName)).toEqual(['acme/one', 'other/three'])
  })

  it('respects maxCards', () => {
    const candidates = Array.from({ length: 9 }, (_, index) => candidate(`o${index}/r${index}`))
    const result = rankRepos(candidates, { ...context, settings: { ...context.settings, maxCards: 3 } })
    expect(result.cards).toHaveLength(3)
  })

  it('fills the card fields the panel renders', () => {
    const [card] = rankRepos([candidate('tiangolo/fastapi', { stargazers_count: 80_000, topics: ['api', 'llm'] })], context).cards
    expect(card.fullName).toBe('tiangolo/fastapi')
    expect(card.htmlUrl).toBe('https://github.com/tiangolo/fastapi')
    expect(card.zh.length).toBeGreaterThan(0)
    expect(card.zhSource).toBe('template')
    expect(card.why.length).toBeGreaterThan(0)
    expect(card.install[0]).toContain('install')
  })

  it('explains an error-sourced card with the error text', () => {
    const result = rankRepos(
      [candidate('someone/fix', {}, ['error'])],
      {
        ...context,
        signal: {
          keywords: ['fastapi'],
          languages: [],
          errorText: 'ConnectionError: Max retries exceeded with url: /api/users',
        },
      },
    )
    expect(result.cards[0].why).toContain('Max retries exceeded')
  })

  it('filters to Chinese projects when chineseOnly is on', () => {
    const english = candidate('eng/only', { description: 'A fast web framework', topics: ['web'] })
    const chinese = candidate('zh/only', { description: '一个非常好用的中文项目', topics: ['chinese'] })
    const result = rankRepos([english, chinese], {
      ...context,
      settings: { ...context.settings, chineseOnly: true },
    })
    expect(result.cards.map((card) => card.fullName)).toEqual(['zh/only'])
  })

  it('reports how much it filtered away', () => {
    const result = rankRepos([candidate('a/b'), candidate('c/d', { archived: true })], context)
    expect(result.consideredCount).toBe(2)
    expect(result.filtered).toBeGreaterThan(0)
  })
})

describe('guessInstall', () => {
  it('guesses per language', () => {
    expect(guessInstall(repo({ full_name: 'psf/requests', language: 'Python' }))[0]).toBe('pip install requests')
    expect(guessInstall(repo({ full_name: 'vitejs/vite', language: 'TypeScript' }))[0]).toBe('npm install vite')
    expect(guessInstall(repo({ full_name: 'BurntSushi/ripgrep', language: 'Rust' }))[0]).toBe('cargo install ripgrep')
  })

  it('falls back to a clone command for ambiguous names', () => {
    const [command] = guessInstall(repo({ full_name: 'some/Weird Name!', language: 'Python' }))
    expect(command).toContain('git clone')
  })

  it('clones resource collections instead of inventing a package', () => {
    // `pip install public-apis` / `npm install freeCodeCamp` are nonsense:
    // curated lists are not published packages.
    const [command] = guessInstall(
      repo({ full_name: 'public-apis/public-apis', language: 'Python', topics: ['api', 'list', 'resources'] }),
    )
    expect(command).toContain('git clone')
  })

  it('clones instead of guessing a package for tiny repos', () => {
    const [command] = guessInstall(repo({ full_name: 'yanxi-H/github-radar', language: 'Python', stargazers_count: 1 }))
    expect(command).toBe('git clone https://github.com/yanxi-H/github-radar.git')
  })

  it('still guesses a package once the repo has real adoption', () => {
    const [command] = guessInstall(repo({ full_name: 'psf/requests', language: 'Python', stargazers_count: 50 }))
    expect(command).toBe('pip install requests')
  })
})
