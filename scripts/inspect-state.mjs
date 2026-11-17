/**
 * Print the plugin's on-disk evidence: mount marker, file timestamps, cached
 * batches and the last requests. Read-only; safe to run any time.
 *
 * Usage: node scripts/inspect-state.mjs [pluginDataDir]
 */
import { readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const dir = process.argv[2] ?? join(home, 'plugin-data', 'dsh-github-radar')

function showBoot() {
  const boot = JSON.parse(readFileSync(join(dir, 'boot.json'), 'utf8'))
  console.log('boot at', new Date(boot.at).toISOString(), '| version', boot.version)
}

function showFiles() {
  for (const file of ['client-errors.jsonl', 'requests.jsonl', 'cache.json', 'l2.json']) {
    try {
      const stat = statSync(join(dir, file))
      console.log(file.padEnd(20), String(stat.size).padStart(7), new Date(stat.mtimeMs).toISOString())
    } catch {
      console.log(file.padEnd(20), '(missing)')
    }
  }
}

function showCache() {
  const cache = JSON.parse(readFileSync(join(dir, 'cache.json'), 'utf8'))
  for (const [key, entry] of Object.entries(cache.entries ?? {})) {
    const names = (entry.cards ?? []).map((card) => card.fullName).join(', ')
    console.log('cache', key, '| trending:', entry.trending === true, '|', names)
  }
}

function showRequests(count = 4) {
  let text = ''
  try {
    text = readFileSync(join(dir, 'requests.jsonl'), 'utf8').trim()
  } catch {
    return
  }
  if (text === '') return
  for (const line of text.split(/\r?\n/).slice(-count)) {
    const row = JSON.parse(line)
    console.log('req', new Date(row.at).toISOString(), row.status, row.method, String(row.url).slice(0, 56))
  }
}

showBoot()
showFiles()
showCache()
showRequests()
