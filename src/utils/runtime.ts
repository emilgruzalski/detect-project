import * as path from 'node:path'
import { parse as parseToml } from 'smol-toml'
import type { DetectorContext } from '../types.js'
import { ancestors, readText, readVersionFile, relPosix } from './fs.js'
import { cleanVersion } from './version.js'

export type Runtime = 'node' | 'python' | 'go' | 'rust' | 'dart' | 'flutter'

/** A runtime version together with where it was found. */
export interface RuntimeHit {
  value: string
  /** Absolute path of the file the value was read from. */
  file: string
  /** Field inside `file` (e.g. `engines.node`); empty for single-value files such as `.nvmrc`. */
  field: string
  /**
   * Whether the official setup action for the runtime (`actions/setup-node`, `setup-python`, `setup-go`)
   * reads this very value when given `file` through its `*-version-file` input.
   */
  setupReadable: boolean
}

/** Runtime names as they appear in `.tool-versions` (asdf) and `mise.toml`. */
const ASDF_NAMES: Record<Runtime, readonly string[]> = {
  node: ['nodejs', 'node'],
  python: ['python'],
  go: ['golang', 'go'],
  rust: ['rust'],
  dart: ['dart'],
  flutter: ['flutter'],
}

/**
 * `.tool-versions` names the setup actions understand (setup-go only matches `golang`); the Rust, Dart
 * and Flutter setup actions do not read `.tool-versions` at all.
 */
const TOOL_VERSIONS_READABLE: Record<Runtime, readonly string[]> = {
  node: ['nodejs', 'node'],
  python: ['python'],
  go: ['golang'],
  rust: [],
  dart: [],
  flutter: [],
}

/** Looks up a runtime version in asdf's `.tool-versions` in `dir`. */
export async function toolVersionsRuntime(dir: string, runtime: Runtime): Promise<RuntimeHit | undefined> {
  const file = path.join(dir, '.tool-versions')
  const text = await readText(file)
  if (!text) return undefined
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.replace(/#.*$/, '').trim()
    if (!trimmed) continue
    const [name, ...versions] = trimmed.split(/\s+/)
    if (name && ASDF_NAMES[runtime].includes(name) && versions[0]) {
      return { value: cleanVersion(versions[0]), file, field: '', setupReadable: TOOL_VERSIONS_READABLE[runtime].includes(name) }
    }
  }
  return undefined
}

/**
 * Looks up a runtime version in `mise.toml` / `.mise.toml` / `.mise/config.toml` (`[tools]` table) in `dir`.
 * Only setup-node reads mise files, and only `tools.node` given as a string or `{ version = … }`.
 */
export async function miseRuntime(dir: string, runtime: Runtime): Promise<RuntimeHit | undefined> {
  for (const name of ['mise.toml', '.mise.toml', '.mise/config.toml']) {
    const file = path.join(dir, name)
    const text = await readText(file)
    if (!text) continue
    let parsed: Record<string, unknown>
    try {
      parsed = parseToml(text) as Record<string, unknown>
    } catch {
      continue
    }
    const tools = parsed['tools']
    if (!tools || typeof tools !== 'object') continue
    for (const tool of ASDF_NAMES[runtime]) {
      const value = (tools as Record<string, unknown>)[tool]
      const readable = runtime === 'node' && tool === 'node'
      const hit = (v: string, setupReadable: boolean): RuntimeHit => ({ value: cleanVersion(v), file, field: `tools.${tool}`, setupReadable })
      if (typeof value === 'string') return hit(value, readable)
      if (Array.isArray(value) && typeof value[0] === 'string') return hit(value[0], false)
      if (value && typeof value === 'object' && typeof (value as { version?: unknown }).version === 'string') {
        return hit((value as { version: string }).version, readable)
      }
    }
  }
  return undefined
}

/** Reads the first existing single-line version file (`.nvmrc`, `.python-version`, …) in `dir`. */
export async function versionFileRuntime(
  dir: string,
  files: readonly string[],
  setupReadable = true,
): Promise<RuntimeHit | undefined> {
  for (const name of files) {
    const file = path.join(dir, name)
    const value = await readVersionFile(file)
    if (value) return { value: cleanVersion(value), file, field: '', setupReadable }
  }
  return undefined
}

export type RuntimeCandidate = () => Promise<RuntimeHit | undefined> | RuntimeHit | undefined

/**
 * Resolves the runtime version the way version managers do: sources in the project directory first
 * (in the order `chain` returns them), then the same for every parent directory up to the walk
 * boundary (repository / workspace root), nearest first. `chain` receives each directory and returns
 * the sources to try there, so a detector can consult manifest fields only at specific levels.
 */
export async function resolveRuntime(
  ctx: DetectorContext,
  label: string,
  chain: (level: string) => readonly RuntimeCandidate[],
): Promise<RuntimeHit | undefined> {
  const levels = [ctx.dir, ...ancestors(ctx.dir, ctx.boundary ?? ctx.dir)]
  for (const level of levels) {
    for (const candidate of chain(level)) {
      const hit = await candidate()
      if (hit?.value) {
        const source = relPosix(ctx.dir, hit.file) + (hit.field ? `:${hit.field}` : '')
        ctx.debug?.(`${label}: "${hit.value}" from ${source}${hit.setupReadable ? '' : ' (not readable by the setup action)'}`)
        return hit
      }
    }
  }
  ctx.debug?.(`${label}: not found in ${levels.map((l) => relPosix(ctx.dir, l)).join(', ')}`)
  return undefined
}

/** Maps a runtime hit onto the `languageVersion*` fields of a detection, paths relative to `dir`. */
export function runtimeFields(
  dir: string,
  hit: RuntimeHit | undefined,
): { languageVersion: string; languageVersionSource: string; languageVersionFile: string } {
  if (!hit) return { languageVersion: '', languageVersionSource: '', languageVersionFile: '' }
  const file = relPosix(dir, hit.file)
  return {
    languageVersion: hit.value,
    languageVersionSource: hit.field ? `${file}:${hit.field}` : file,
    languageVersionFile: hit.setupReadable ? file : '',
  }
}
