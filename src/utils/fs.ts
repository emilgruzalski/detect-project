import * as fs from 'node:fs/promises'
import * as path from 'node:path'

export async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file)
    return true
  } catch {
    return false
  }
}

export async function isFile(file: string): Promise<boolean> {
  try {
    return (await fs.stat(file)).isFile()
  } catch {
    return false
  }
}

export async function readText(file: string): Promise<string | undefined> {
  try {
    return await fs.readFile(file, 'utf8')
  } catch {
    return undefined
  }
}

export async function readJson<T = unknown>(file: string): Promise<T | undefined> {
  const text = await readText(file)
  if (text === undefined) return undefined
  try {
    return JSON.parse(text) as T
  } catch {
    return undefined
  }
}

/** Returns the first entry of `candidates` that exists as a file in `dir` (relative path). */
export async function firstExisting(dir: string, candidates: readonly string[]): Promise<string | undefined> {
  for (const candidate of candidates) {
    if (await isFile(path.join(dir, candidate))) return candidate
  }
  return undefined
}

/** Reads a single-line "version file" such as `.nvmrc` or `VERSION`, ignoring comments and blank lines. */
export async function readVersionFile(file: string): Promise<string | undefined> {
  const text = await readText(file)
  if (text === undefined) return undefined
  const line = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0 && !l.startsWith('#'))
  return line
}

export interface WalkOptions {
  maxDepth: number
  /** Directory names that are never descended into. */
  ignore?: readonly string[]
}

const DEFAULT_IGNORE = [
  'node_modules',
  '.git',
  '.venv',
  'venv',
  '.tox',
  '.nox',
  '__pycache__',
  'dist',
  'build',
  'vendor',
  '.idea',
  '.vscode',
  'site-packages',
  '.mypy_cache',
  '.pytest_cache',
  '.ruff_cache',
]

/** Breadth-first walk over files under `dir`, yielding paths relative to `dir`. */
export async function walkFiles(dir: string, opts: WalkOptions): Promise<string[]> {
  const ignore = new Set(opts.ignore ?? DEFAULT_IGNORE)
  const results: string[] = []
  let frontier: string[] = ['']
  for (let depth = 0; depth <= opts.maxDepth && frontier.length > 0; depth++) {
    const next: string[] = []
    for (const rel of frontier) {
      let entries: import('node:fs').Dirent[]
      try {
        entries = await fs.readdir(path.join(dir, rel), { withFileTypes: true })
      } catch {
        continue
      }
      for (const entry of entries) {
        const entryRel = rel ? path.join(rel, entry.name) : entry.name
        if (entry.isDirectory()) {
          if (!ignore.has(entry.name)) next.push(entryRel)
        } else if (entry.isFile()) {
          results.push(entryRel)
        }
      }
    }
    frontier = next
  }
  return results
}
