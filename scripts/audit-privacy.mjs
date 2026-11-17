/**
 * Privacy audit before open-sourcing: scan every tracked file for anything that
 * could identify the author or their machine (paths, emails, session ids,
 * ports, tokens). Prints file:line hits so they can be scrubbed.
 *
 * Usage: node scripts/audit-privacy.mjs [--fix-report]
 */
import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const PATTERNS = [
  ['home dir', /C:\\+Users\\+[A-Za-z0-9._-]+/g],
  ['workspace path', /E:\\+[\u4e00-\u9fa5A-Za-z0-9._-]+/g],
  ['email', /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g],
  ['session id', /session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g],
  ['loopback url with port', /(?:127\.0\.0\.1|localhost):\d{2,5}/g],
  ['api key', /\b(?:ghp_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9]{16,}|AKIA[0-9A-Z]{16})\b/g],
  ['env key value', /DEEPSEEK_API_KEY\s*[=:]\s*\S+/g],
  ['absolute tmp path', /[A-Z]:\\+[A-Za-z0-9._-]*\\+Temp\\+/g],
  ['private ip', /\b(?:10|192\.168|172\.(?:1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}\b/g],
]

const files = execSync('git ls-files', { encoding: 'utf8' })
  .trim()
  .split(/\r?\n/)
  .filter((file) => file !== '')

let hits = 0
const byFile = new Map()

for (const file of files) {
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    continue
  }
  const lines = text.split(/\r?\n/)
  lines.forEach((line, index) => {
    for (const [label, pattern] of PATTERNS) {
      pattern.lastIndex = 0
      const matches = line.match(pattern)
      if (matches === null) continue
      hits += matches.length
      const list = byFile.get(file) ?? []
      list.push(`${index + 1}: [${label}] ${matches.slice(0, 3).join(', ')} :: ${line.trim().slice(0, 110)}`)
      byFile.set(file, list)
    }
  })
}

for (const [file, list] of [...byFile.entries()].sort()) {
  console.log(`\n${file}  (${list.length})`)
  for (const entry of list.slice(0, 40)) console.log('  ' + entry)
  if (list.length > 40) console.log(`  … ${list.length - 40} more`)
}

console.log(`\nTOTAL HITS: ${hits} across ${byFile.size} files (${files.length} tracked files)`)
