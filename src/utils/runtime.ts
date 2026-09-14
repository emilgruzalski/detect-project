import * as path from 'node:path'
import { parse as parseToml } from 'smol-toml'
import { readText, readVersionFile } from './fs.js'
import { cleanVersion } from './version.js'

/** Runtime names as they appear in `.tool-versions` (asdf) and `mise.toml`. */
const ASDF_NAMES: Record<string, readonly string[]> = {
  node: ['nodejs', 'node'],
  python: ['python'],
  go: ['golang', 'go'],
}

/** Looks up a runtime version in asdf's `.tool-versions`. */
export async function toolVersionsRuntime(dir: string, runtime: keyof typeof ASDF_NAMES): Promise<string | undefined> {
  const text = await readText(path.join(dir, '.tool-versions'))
  if (!text) return undefined
  const names = ASDF_NAMES[runtime] ?? []
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.replace(/#.*$/, '').trim()
    if (!trimmed) continue
    const [name, ...versions] = trimmed.split(/\s+/)
    if (name && names.includes(name) && versions[0]) return cleanVersion(versions[0])
  }
  return undefined
}

/** Looks up a runtime version in `mise.toml` / `.mise.toml` (`[tools]` table). */
export async function miseRuntime(dir: string, runtime: keyof typeof ASDF_NAMES): Promise<string | undefined> {
  for (const file of ['mise.toml', '.mise.toml', '.mise/config.toml']) {
    const text = await readText(path.join(dir, file))
    if (!text) continue
    let parsed: Record<string, unknown>
    try {
      parsed = parseToml(text) as Record<string, unknown>
    } catch {
      continue
    }
    const tools = parsed['tools']
    if (!tools || typeof tools !== 'object') continue
    for (const name of ASDF_NAMES[runtime] ?? []) {
      const value = (tools as Record<string, unknown>)[name]
      if (typeof value === 'string') return cleanVersion(value)
      if (Array.isArray(value) && typeof value[0] === 'string') return cleanVersion(value[0])
      if (value && typeof value === 'object' && typeof (value as { version?: unknown }).version === 'string') {
        return cleanVersion((value as { version: string }).version)
      }
    }
  }
  return undefined
}

/** Reads a single-line version file such as `.nvmrc` or `.python-version`. */
export async function versionFileRuntime(dir: string, files: readonly string[]): Promise<string | undefined> {
  for (const file of files) {
    const value = await readVersionFile(path.join(dir, file))
    if (value) return cleanVersion(value)
  }
  return undefined
}
