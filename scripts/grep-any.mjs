/**
 * Tiny recursive grep for this repo's dev workflow.
 *
 * Windows' rg/grep are not always on PATH here, and `Select-String` mangles
 * UTF-8, so a 40-line Node script is the reliable option.
 *
 * Usage: node scripts/grep-any.mjs <dir> <regex> [maxDepth]
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(process.argv[2] ?? '.')
const pattern = new RegExp(process.argv[3] ?? '', 'i')
const maxDepth = Number(process.argv[4] ?? 3)
const SKIP = new Set(['node_modules', '.git', 'dist', 'coverage'])
const MAX_BYTES = 8 * 1024 * 1024

let files = 0
let hits = 0

function walk(dir, depth) {
  if (depth > maxDepth) return
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (SKIP.has(entry.name)) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      walk(full, depth + 1)
      continue
    }
    if (!entry.isFile()) continue
    let size = 0
    try {
      size = statSync(full).size
    } catch {
      continue
    }
    if (size > MAX_BYTES) continue
    let text
    try {
      text = readFileSync(full, 'utf8')
    } catch {
      continue
    }
    files += 1
    const lines = text.split(/\r?\n/)
    for (const [index, line] of lines.entries()) {
      if (!pattern.test(line)) continue
      hits += 1
      console.log(`${full}:${index + 1}: ${line.trim().slice(0, 200)}`)
    }
  }
}

walk(root, 0)
console.log(`\n${hits} hit(s) in ${files} file(s) under ${root}`)
