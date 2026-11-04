import { AsyncLocalStorage } from 'node:async_hooks'
import type { Dirent, Stats } from 'node:fs'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'

/**
 * Per-run memo of file system reads. Detection of one directory — and even more so `discover`, which
 * inspects many directories sharing the same parents — reads the same package.json, lockfiles and
 * runtime files repeatedly; within `withFileCache` every path is read from disk at most once.
 */
interface FileCache {
  text: Map<string, Promise<string | undefined>>
  stat: Map<string, Promise<Stats | undefined>>
  lstat: Map<string, Promise<Stats | undefined>>
  dir: Map<string, Promise<Dirent[] | undefined>>
}

const cacheStore = new AsyncLocalStorage<FileCache>()

/** Runs `fn` with a file read cache (reusing the surrounding one when already inside a cached run). */
export function withFileCache<T>(fn: () => Promise<T>): Promise<T> {
  if (cacheStore.getStore()) return fn()
  return cacheStore.run({ text: new Map(), stat: new Map(), lstat: new Map(), dir: new Map() }, fn)
}

function cached<T>(pick: (cache: FileCache) => Map<string, Promise<T>>, key: string, load: () => Promise<T>): Promise<T> {
  const cache = cacheStore.getStore()
  if (!cache) return load()
  const map = pick(cache)
  let value = map.get(key)
  if (!value) {
    value = load()
    map.set(key, value)
  }
  return value
}

const statOf = (file: string) => cached((c) => c.stat, file, () => fs.stat(file).catch(() => undefined))

/** True when `file` exists as any kind of entry (file, directory, symlink). */
export async function exists(file: string): Promise<boolean> {
  return (await cached((c) => c.lstat, file, () => fs.lstat(file).catch(() => undefined))) !== undefined
}

export async function isFile(file: string): Promise<boolean> {
  return (await statOf(file))?.isFile() ?? false
}

export async function isDirectory(file: string): Promise<boolean> {
  return (await statOf(file))?.isDirectory() ?? false
}

export async function readText(file: string): Promise<string | undefined> {
  return cached((c) => c.text, file, () => fs.readFile(file, 'utf8').catch(() => undefined))
}

/** Directory entries, or undefined when `dir` cannot be read. */
export async function listDir(dir: string): Promise<Dirent[] | undefined> {
  return cached((c) => c.dir, dir, () => fs.readdir(dir, { withFileTypes: true }).catch(() => undefined))
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

/** `path.relative` with forward slashes; `.` when both paths are the same directory. */
export function relPosix(from: string, to: string): string {
  return path.relative(from, to).split(path.sep).join('/') || '.'
}

/** True when `child` is `parent` itself or lies somewhere below it. */
export function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

/**
 * Parent directories of `dir`, nearest first, up to and including `boundary`.
 * Empty when `dir` is the boundary or does not lie inside it.
 */
export function ancestors(dir: string, boundary: string): string[] {
  if (!isInside(dir, boundary)) return []
  const result: string[] = []
  let current = dir
  while (path.relative(boundary, current) !== '') {
    const parent = path.dirname(current)
    if (parent === current) break
    result.push(parent)
    current = parent
  }
  return result
}

/** Nearest directory at or above `dir` that contains a `.git` entry (directory, or file for worktrees/submodules). */
export async function findGitRoot(dir: string): Promise<string | undefined> {
  let current = path.resolve(dir)
  for (;;) {
    if (await exists(path.join(current, '.git'))) return current
    const parent = path.dirname(current)
    if (parent === current) return undefined
    current = parent
  }
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
      const entries = await listDir(path.join(dir, rel))
      if (!entries) continue
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
