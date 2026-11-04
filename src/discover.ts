import * as path from 'node:path'
import { type DetectOptions, type DetectResult, detectProject } from './detect.js'
import { listDir, relPosix, withFileCache } from './utils/fs.js'
import { matchesWorkspacePatterns } from './utils/workspace.js'

/** Directory names never descended into while discovering projects. */
export const DISCOVER_IGNORE: ReadonlySet<string> = new Set([
  'node_modules',
  'bower_components',
  'jspm_packages',
  'vendor',
  'third_party',
  'dist',
  'build',
  'out',
  'target',
  'coverage',
  'venv',
  'env',
  '__pycache__',
  'site-packages',
  'testdata',
  'fixtures',
  '__fixtures__',
])

export interface DiscoverOptions extends DetectOptions {
  /** How many directory levels below the root to inspect (0 = the root only). */
  maxDepth: number
  /** Globs relative to the root (`examples/**`, `legacy`) whose directories are skipped together with everything below. */
  exclude?: readonly string[] | undefined
}

export interface DiscoveredProject {
  /** Absolute path of the project directory. */
  dir: string
  result: DetectResult
}

/**
 * Finds every directory at most `maxDepth` levels below `root` (including `root` itself) that contains a
 * supported project, in breadth-first, alphabetical order. Hidden directories (`.git`, `.venv`, `.github`,
 * …), dependency/build output directories (see `DISCOVER_IGNORE`) and excluded globs are not descended into.
 */
export function discoverProjects(root: string, options: DiscoverOptions): Promise<DiscoveredProject[]> {
  return withFileCache(async () => {
    const exclude = options.exclude ?? []
    const found: DiscoveredProject[] = []
    let frontier = [root]
    for (let depth = 0; depth <= options.maxDepth && frontier.length > 0; depth++) {
      const next: string[] = []
      for (const dir of frontier) {
        const result = await detectProject(dir, options)
        if (result.primary) found.push({ dir, result })
        if (depth === options.maxDepth) continue
        const entries = ((await listDir(dir)) ?? []).filter((e) => e.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))
        for (const entry of entries) {
          if (entry.name.startsWith('.') || DISCOVER_IGNORE.has(entry.name)) continue
          const child = path.join(dir, entry.name)
          if (exclude.length && matchesWorkspacePatterns(exclude, relPosix(root, child))) continue
          next.push(child)
        }
      }
      frontier = next
    }
    return found
  })
}
