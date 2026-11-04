import { detectors } from './detectors/index.js'
import type { Detection, Detector, Language } from './types.js'
import { findGitRoot, isInside, relPosix, withFileCache } from './utils/fs.js'

export interface DetectResult {
  /** The language the outputs are based on, or undefined when nothing matched. */
  primary: Detection | undefined
  /** Every language detected in the directory, in priority order. */
  all: Detection[]
}

export interface DetectOptions {
  /** Only run this language's detector. */
  language?: Language | undefined
  /** Languages to prefer as primary, in order; unlisted languages follow in the default order. */
  priority?: readonly Language[] | undefined
  /**
   * Workspace root (`GITHUB_WORKSPACE`). Detectors may look into parent directories of `dir` for
   * workspace roots, lockfiles and runtime files, but never above the nearest of this directory and
   * the git repository root that contains `dir`.
   */
  workspace?: string | undefined
  /** Custom `git describe --match` patterns for the git-tag version fallback (`tag-pattern` input). */
  tagPatterns?: readonly string[] | undefined
  /** Receives debug lines describing which sources were tried for every value. */
  debug?: ((message: string) => void) | undefined
}

/** Detectors in priority order: the `priority` languages first, then the rest in registry order. */
export function orderDetectors(priority: readonly Language[] = []): Detector[] {
  const preferred = priority
    .map((language) => detectors.find((d) => d.language === language))
    .filter((d): d is Detector => d !== undefined)
  return [...new Set([...preferred, ...detectors])]
}

/** Highest directory the detectors may walk up to: the nearest enclosing repository / workspace root. */
function walkBoundary(dir: string, gitRoot: string | undefined, workspace: string | undefined): string {
  const roots = [gitRoot, workspace].filter((root): root is string => !!root && isInside(dir, root))
  return roots.sort((a, b) => b.length - a.length)[0] ?? dir
}

/**
 * Runs every detector against `dir`.
 *
 * When `language` is given only that detector is considered. Otherwise the first detector (in
 * priority order) that matches becomes the primary result and the rest are still reported in `all`.
 */
export function detectProject(dir: string, options: DetectOptions = {}): Promise<DetectResult> {
  return withFileCache(async () => {
    const ordered = orderDetectors(options.priority)
    const selected = options.language ? ordered.filter((d) => d.language === options.language) : ordered
    const gitRoot = await findGitRoot(dir)
    const boundary = walkBoundary(dir, gitRoot, options.workspace)
    const all: Detection[] = []
    for (const detector of selected) {
      const debug = options.debug && ((message: string) => options.debug!(`[${relPosix(options.workspace ?? dir, dir)}] ${message}`))
      const result = await detector.detect({ dir, gitRoot, boundary, tagPatterns: options.tagPatterns, debug })
      if (result) all.push(result)
    }
    return { primary: all[0], all }
  })
}
