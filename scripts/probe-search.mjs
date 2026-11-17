#!/usr/bin/env node
/** 手工探测：给定查询，打印 GitHub 搜索结果前 10 名，用来校准查询构造与排序。 */
const queries = process.argv.slice(2);
const headers = {
  accept: 'application/vnd.github+json',
  'x-github-api-version': '2022-11-28',
  'user-agent': 'dsh-github-radar/0.1.0',
};

for (const q of queries) {
  const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(q)}&sort=stars&order=desc&per_page=20`;
  const response = await fetch(url, { headers });
  const payload = await response.json();
  console.log(`\n=== ${q} -> HTTP ${response.status} ${payload.total_count ?? ''} ===`);
  for (const repo of payload.items ?? []) {
    const topics = (repo.topics ?? []).slice(0, 3).join(',');
    console.log(
      `${String(repo.stargazers_count).padStart(8)}  ${repo.full_name}  [${repo.language ?? '-'}]  ${topics}`,
    );
  }
  if (payload.message) console.log('message:', payload.message);
  await new Promise((resolve) => setTimeout(resolve, 2200));
}
