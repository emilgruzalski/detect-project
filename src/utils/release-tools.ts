/**
 * Versions recorded by release tooling, independent of the language: release-please's manifest,
 * bump-my-version / bump2version and commitizen. They matter most for projects whose manifest carries
 * no version (Go modules, private Node apps, requirements.txt-only Python apps).
 */
import * as path from 'node:path'
import { parse as parseToml } from 'smol-toml'
import type { DetectorContext } from '../types.js'
import { ancestors, readJson, readText, relPosix } from './fs.js'
import { parseIni } from './ini.js'
import { type Source, versionHit } from './sources.js'

type Table = Record<string, unknown>

function table(value: unknown): Table | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Table) : undefined
}

function tomlTable(text: string | undefined, ...keys: string[]): Table | undefined {
  if (!text) return undefined
  let current: unknown
  try {
    current = parseToml(text)
  } catch {
    return undefined
  }
  for (const key of keys) current = table(current)?.[key]
  return table(current)
}

function normalizeKey(key: string): string {
  return key.trim().replace(/^\.\//, '').replace(/\/+$/, '') || '.'
}

/**
 * release-please: `.release-please-manifest.json` maps package paths (relative to the repository root,
 * `.` for the root package) to their current version. The nearest manifest in `dir` or a parent
 * directory (within the walk boundary) is used; a manifest without an entry for `dir` yields nothing.
 */
export function releasePleaseSource(ctx: DetectorContext): Source {
  return {
    name: '.release-please-manifest.json',
    read: async () => {
      for (const level of [ctx.dir, ...ancestors(ctx.dir, ctx.boundary ?? ctx.dir)]) {
        const file = path.join(level, '.release-please-manifest.json')
        const manifest = table(await readJson(file))
        if (!manifest) continue
        const key = relPosix(level, ctx.dir)
        const entry = Object.entries(manifest).find(([k]) => normalizeKey(k) === key)?.[1]
        return typeof entry === 'string' ? versionHit(entry, `${relPosix(ctx.dir, file)}:${key}`) : undefined
      }
      return undefined
    },
  }
}

/**
 * bump-my-version / bump2version `current_version`, read from the project directory in the order the
 * tools search for their configuration.
 */
export function bumpversionSource(dir: string): Source {
  return {
    name: 'bumpversion current_version',
    read: async () => {
      const fromToml = async (file: string) => tomlTable(await readText(path.join(dir, file)), 'tool', 'bumpversion')?.['current_version']
      const fromIni = async (file: string) => {
        const text = await readText(path.join(dir, file))
        return text ? parseIni(text)['bumpversion']?.['current_version'] : undefined
      }
      const candidates: Array<[file: string, field: string, read: () => Promise<unknown>]> = [
        ['.bumpversion.toml', 'tool.bumpversion.current_version', () => fromToml('.bumpversion.toml')],
        ['.bumpversion.cfg', 'bumpversion.current_version', () => fromIni('.bumpversion.cfg')],
        ['pyproject.toml', 'tool.bumpversion.current_version', () => fromToml('pyproject.toml')],
        ['setup.cfg', 'bumpversion.current_version', () => fromIni('setup.cfg')],
      ]
      for (const [file, field, read] of candidates) {
        const value = await read()
        if (typeof value === 'string') {
          const hit = versionHit(value, `${file}:${field}`)
          if (hit) return hit
        }
      }
      return undefined
    },
  }
}

/** Minimal reader for the `commitizen:` mapping of `.cz.yaml` / `cz.yaml` (top-level scalar keys only). */
function commitizenYaml(text: string): Table | undefined {
  const lines = text.split(/\r?\n/)
  const start = lines.findIndex((l) => /^commitizen\s*:\s*(#.*)?$/.test(l))
  if (start < 0) return undefined
  const result: Table = {}
  let indent: number | undefined
  for (const line of lines.slice(start + 1)) {
    if (/^\s*(#.*)?$/.test(line)) continue
    const lineIndent = /^\s*/.exec(line)?.[0].length ?? 0
    if (lineIndent === 0) break
    indent ??= lineIndent
    if (lineIndent !== indent) continue
    const kv = /^\s*([\w-]+)\s*:\s*(.*?)\s*(?:\s#.*)?$/.exec(line)
    if (kv?.[1]) result[kv[1]] = kv[2]?.replace(/^(["'])(.*)\1$/, '$2')
  }
  return result
}

/**
 * commitizen `version` (only with the default `commitizen` version provider — other providers keep the
 * version in pyproject/package.json/git, which the detectors read anyway). Files are checked in
 * commitizen's own lookup order.
 */
export function commitizenSource(dir: string): Source {
  return {
    name: 'commitizen version',
    read: async () => {
      const files: Array<[file: string, field: string, load: (text: string) => Table | undefined]> = [
        ['pyproject.toml', 'tool.commitizen.version', (t) => tomlTable(t, 'tool', 'commitizen')],
        ['.cz.toml', 'tool.commitizen.version', (t) => tomlTable(t, 'tool', 'commitizen')],
        ['.cz.json', 'commitizen.version', (t) => jsonTable(t, 'commitizen')],
        ['cz.json', 'commitizen.version', (t) => jsonTable(t, 'commitizen')],
        ['.cz.yaml', 'commitizen.version', commitizenYaml],
        ['cz.yaml', 'commitizen.version', commitizenYaml],
        ['cz.toml', 'tool.commitizen.version', (t) => tomlTable(t, 'tool', 'commitizen')],
      ]
      for (const [file, field, load] of files) {
        const text = await readText(path.join(dir, file))
        const config = text ? load(text) : undefined
        if (!config) continue
        // The first configuration file found is the one commitizen uses.
        const provider = config['version_provider']
        if (provider !== undefined && provider !== 'commitizen') return undefined
        return typeof config['version'] === 'string' ? versionHit(config['version'], `${file}:${field}`) : undefined
      }
      return undefined
    },
  }
}

function jsonTable(text: string, key: string): Table | undefined {
  try {
    return table(table(JSON.parse(text))?.[key])
  } catch {
    return undefined
  }
}

/** All release-tool sources, in priority order. */
export function releaseToolSources(ctx: DetectorContext): Source[] {
  return [releasePleaseSource(ctx), bumpversionSource(ctx.dir), commitizenSource(ctx.dir)]
}
