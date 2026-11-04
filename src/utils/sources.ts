import * as path from 'node:path'
import type { DetectorContext } from '../types.js'
import { firstExisting, readVersionFile } from './fs.js'
import { cleanVersion, gitDescribeTag } from './version.js'

/** A value together with where it was found, e.g. `{ value: '1.2.3', source: 'package.json' }`. */
export interface SourceHit {
  value: string
  source: string
}

/** One place a value may come from; `resolveFirst` tries them in order. */
export interface Source<T extends { value: string } = SourceHit> {
  /** Short description for debug output, e.g. `pyproject.toml:project.version`. */
  name: string
  read: () => Promise<T | undefined> | T | undefined
}

/**
 * Returns the first source that yields a non-empty value. One line per call goes to `ctx.debug` with the
 * winning source and the sources that were tried before it, so `ACTIONS_STEP_DEBUG` shows why a value
 * was (or was not) found.
 */
export async function resolveFirst<T extends { value: string }>(
  ctx: DetectorContext,
  label: string,
  sources: readonly Source<T>[],
): Promise<T | undefined> {
  const tried: string[] = []
  for (const source of sources) {
    const hit = await source.read()
    if (hit?.value) {
      ctx.debug?.(`${label}: "${hit.value}" from ${source.name}${tried.length ? ` (nothing in: ${tried.join(', ')})` : ''}`)
      return hit
    }
    tried.push(source.name)
  }
  ctx.debug?.(`${label}: not found (tried: ${tried.join(', ') || 'no sources'})`)
  return undefined
}

/** Builds a hit from a raw version string (normalised with `cleanVersion`), or undefined when empty. */
export function versionHit(raw: string | undefined, source: string): SourceHit | undefined {
  const value = cleanVersion(raw)
  return value ? { value, source } : undefined
}

const VERSION_FILES = ['VERSION', 'VERSION.txt', 'version.txt']

/** A plain `VERSION` / `VERSION.txt` / `version.txt` file in the project directory. */
export function versionFileSource(dir: string): Source {
  return {
    name: 'VERSION file',
    read: async () => {
      const file = await firstExisting(dir, VERSION_FILES)
      return file ? versionHit(await readVersionFile(path.join(dir, file)), file) : undefined
    },
  }
}

/** The latest release tag (see `gitDescribeTag`), honouring the `tag-pattern` input. */
export function gitTagSource(ctx: DetectorContext, prefix = ''): Source {
  return {
    name: ctx.tagPatterns?.length ? `git tag (${ctx.tagPatterns.join(', ')})` : 'git tag',
    read: async () => versionHit(await gitDescribeTag(ctx.dir, { prefix, patterns: ctx.tagPatterns }), 'git-tag'),
  }
}
