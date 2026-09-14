import * as path from 'node:path'
import type { Detection, Detector, DetectorContext, PackageManager } from '../types.js'
import { firstExisting, isFile, readJson, readText } from '../utils/fs.js'
import { miseRuntime, toolVersionsRuntime, versionFileRuntime } from '../utils/runtime.js'
import { cleanVersion } from '../utils/version.js'

type NodePackageManager = Extract<PackageManager, 'npm' | 'yarn' | 'pnpm' | 'bun'>

interface PackageJson {
  name?: unknown
  version?: unknown
  packageManager?: unknown
  engines?: Record<string, unknown>
  volta?: Record<string, unknown>
  devEngines?: { packageManager?: unknown }
}

/** Lockfiles in priority order — the first one found wins. */
const LOCKFILES: ReadonlyArray<{ file: string; pm: NodePackageManager }> = [
  { file: 'bun.lock', pm: 'bun' },
  { file: 'bun.lockb', pm: 'bun' },
  { file: 'pnpm-lock.yaml', pm: 'pnpm' },
  { file: 'yarn.lock', pm: 'yarn' },
  { file: 'package-lock.json', pm: 'npm' },
  { file: 'npm-shrinkwrap.json', pm: 'npm' },
]

const NODE_PMS: readonly NodePackageManager[] = ['npm', 'yarn', 'pnpm', 'bun']

function isNodePm(value: string): value is NodePackageManager {
  return (NODE_PMS as readonly string[]).includes(value)
}

/** Parses the `packageManager` field (`pnpm@9.1.0+sha512...`) into name and version. */
export function parsePackageManagerField(value: unknown): { pm: NodePackageManager; version: string } | undefined {
  if (typeof value !== 'string') return undefined
  const match = /^([a-z]+)@([^+\s]+)/.exec(value.trim())
  if (!match) return undefined
  const [, name, version] = match
  if (!name || !isNodePm(name)) return undefined
  return { pm: name, version: cleanVersion(version) }
}

/** Yarn Berry pins its own binary in `.yarnrc.yml` (`yarnPath: .yarn/releases/yarn-3.6.4.cjs`). */
async function yarnVersionFromRc(dir: string): Promise<string | undefined> {
  const rc = await readText(path.join(dir, '.yarnrc.yml'))
  if (!rc) return undefined
  const match = /^\s*yarnPath:\s*["']?.*yarn-(\d+\.\d+\.\d+[^"'\s/]*)\.c?js["']?\s*$/m.exec(rc)
  return match?.[1]
}

async function nodeVersion(dir: string, pkg: PackageJson): Promise<string> {
  const fromFile = await versionFileRuntime(dir, ['.nvmrc', '.node-version'])
  if (fromFile) return fromFile
  const volta = pkg.volta?.['node']
  if (typeof volta === 'string') return cleanVersion(volta)
  const engines = pkg.engines?.['node']
  if (typeof engines === 'string') return engines.trim()
  return (await toolVersionsRuntime(dir, 'node')) ?? (await miseRuntime(dir, 'node')) ?? ''
}

export const nodeDetector: Detector = {
  language: 'node',
  async detect({ dir }: DetectorContext): Promise<Detection | undefined> {
    const manifest = 'package.json'
    if (!(await isFile(path.join(dir, manifest)))) return undefined
    const pkg = (await readJson<PackageJson>(path.join(dir, manifest))) ?? {}

    let packageManager: NodePackageManager | undefined
    let packageManagerVersion = ''

    // 1. Explicit `packageManager` field (corepack) — the most authoritative source.
    const explicit = parsePackageManagerField(pkg.packageManager)
    if (explicit) {
      packageManager = explicit.pm
      packageManagerVersion = explicit.version
    }

    // 2. `devEngines.packageManager` (npm 10.9+ / Node 22 devEngines proposal).
    if (!packageManager) {
      const devEngine = pkg.devEngines?.packageManager
      const candidate = Array.isArray(devEngine) ? devEngine[0] : devEngine
      if (candidate && typeof candidate === 'object') {
        const { name, version } = candidate as { name?: unknown; version?: unknown }
        if (typeof name === 'string' && isNodePm(name)) {
          packageManager = name
          if (typeof version === 'string') packageManagerVersion = version.trim()
        }
      }
    }

    // 3. Lockfile.
    const lockfile = (await firstExisting(dir, LOCKFILES.map((l) => l.file))) ?? ''
    if (!packageManager && lockfile) {
      packageManager = LOCKFILES.find((l) => l.file === lockfile)?.pm
    }

    // 4. `volta` / `engines` entries naming a package manager.
    if (!packageManager) {
      for (const source of [pkg.volta, pkg.engines]) {
        const hit = NODE_PMS.find((pm) => typeof source?.[pm] === 'string')
        if (hit) {
          packageManager = hit
          break
        }
      }
    }

    // 5. Default.
    packageManager ??= 'npm'

    // Fill in the package manager version from secondary sources when it is still unknown.
    if (!packageManagerVersion) {
      const volta = pkg.volta?.[packageManager]
      const engines = pkg.engines?.[packageManager]
      if (typeof volta === 'string') packageManagerVersion = cleanVersion(volta)
      else if (packageManager === 'yarn') packageManagerVersion = (await yarnVersionFromRc(dir)) ?? ''
      if (!packageManagerVersion && typeof engines === 'string') packageManagerVersion = engines.trim()
    }

    const version = typeof pkg.version === 'string' ? cleanVersion(pkg.version) : ''

    return {
      language: 'node',
      name: typeof pkg.name === 'string' ? pkg.name : '',
      version,
      versionSource: version ? manifest : '',
      packageManager,
      packageManagerVersion,
      languageVersion: await nodeVersion(dir, pkg),
      manifest,
      lockfile,
    }
  },
}
