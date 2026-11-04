/**
 * Real-world corpus: detection results for pinned commits of popular repositories, kept as a vitest
 * snapshot. It catches heuristic regressions that synthetic fixtures miss. Needs network access, so it
 * is not part of `bun run test`; run it with `bun run test:corpus` (CI: weekly, on demand and on pull
 * requests that touch src/). Clones are cached in $CORPUS_DIR (default: <tmpdir>/detect-project-corpus).
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'
import { detectProject } from '../src/detect.js'
import { discoverProjects } from '../src/discover.js'

interface CorpusEntry {
  repo: string
  ref: string
  directories: string[]
  /** When set, also snapshot `discover` with this max depth from the repository root. */
  discover?: number
}

const corpus = JSON.parse(readFileSync(path.join(import.meta.dirname, 'corpus/corpus.json'), 'utf8')) as { repos: CorpusEntry[] }
const cacheDir = process.env['CORPUS_DIR'] ?? path.join(os.tmpdir(), 'detect-project-corpus')

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'pipe', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' } })
}

/** Shallow checkout of one commit (no tags, so git-tag versions stay empty and the snapshot is stable). */
async function checkout({ repo, ref }: CorpusEntry): Promise<string> {
  const dir = path.join(cacheDir, `${repo.replace('/', '__')}@${ref.slice(0, 12)}`)
  if (existsSync(path.join(dir, '.git', 'corpus-ready'))) return dir
  await fs.rm(dir, { recursive: true, force: true })
  await fs.mkdir(dir, { recursive: true })
  git(dir, 'init', '-q')
  git(dir, 'remote', 'add', 'origin', `https://github.com/${repo}.git`)
  for (let attempt = 1; ; attempt++) {
    try {
      git(dir, 'fetch', '-q', '--depth', '1', '--no-tags', 'origin', ref)
      break
    } catch (error) {
      if (attempt === 3) throw error
    }
  }
  git(dir, '-c', 'advice.detachedHead=false', 'checkout', '-q', 'FETCH_HEAD')
  await fs.writeFile(path.join(dir, '.git', 'corpus-ready'), ref)
  return dir
}

describe.each(corpus.repos)('$repo', (entry) => {
  it('matches the snapshot', { timeout: 300_000 }, async () => {
    const root = await checkout(entry)
    const results: Record<string, unknown> = {}
    for (const directory of entry.directories) {
      const { all } = await detectProject(path.join(root, directory), { workspace: root })
      results[directory] = all.length ? all : 'unknown'
    }
    if (entry.discover !== undefined) {
      const projects = await discoverProjects(root, { workspace: root, maxDepth: entry.discover })
      results[`discover (depth ${entry.discover})`] = projects.map(({ dir, result }) =>
        `${path.relative(root, dir).split(path.sep).join('/') || '.'}: ${result.all.map((d) => d.language).join(', ')}`,
      )
    }
    expect(results).toMatchSnapshot()
  })
})
