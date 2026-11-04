import * as path from 'node:path'
import type { Detection, Detector, DetectorContext, PackageManager } from '../types.js'
import { ancestors, firstExisting, isFile, readJson, readText, relPosix } from '../utils/fs.js'
import { releaseToolSources } from '../utils/release-tools.js'
import { miseRuntime, resolveRuntime, runtimeFields, toolVersionsRuntime, versionFileRuntime, type RuntimeHit } from '../utils/runtime.js'
import { resolveFirst, versionHit } from '../utils/sources.js'
import { cleanVersion } from '../utils/version.js'
import { matchesWorkspacePatterns, parsePnpmWorkspacePackages } from '../utils/workspace.js'

type NodePackageManager = Extract<PackageManager, 'npm' | 'yarn' | 'pnpm' | 'bun'>

interface PackageJson {
  name?: unknown
  version?: unknown
  packageManager?: unknown
  engines?: Record<string, unknown>
  volta?: Record<string, unknown>
  devEngines?: { packageManager?: unknown; runtime?: unknown }
  workspaces?: unknown
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
const LOCKFILE_NAMES = LOCKFILES.map((l) => l.file)

const NODE_PMS: readonly NodePackageManager[] = ['npm', 'yarn', 'pnpm', 'bun']

function isNodePm(value: string): value is NodePackageManager {
  return (NODE_PMS as readonly string[]).includes(value)
}

function lockfilePm(file: string | undefined): NodePackageManager | undefined {
  return file ? LOCKFILES.find((l) => l.file === path.basename(file))?.pm : undefined
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

/** `devEngines.packageManager` / `devEngines.runtime` hold either one entry or an array of alternatives. */
function devEngineEntries(value: unknown): Array<{ name?: unknown; version?: unknown }> {
  return (Array.isArray(value) ? value : [value]).filter(
    (e): e is { name?: unknown; version?: unknown } => !!e && typeof e === 'object' && !Array.isArray(e),
  )
}

/** Package manager declared explicitly: `packageManager` (corepack), then `devEngines.packageManager`. */
function declaredPackageManager(pkg: PackageJson | undefined): { pm: NodePackageManager; version: string } | undefined {
  if (!pkg) return undefined
  const explicit = parsePackageManagerField(pkg.packageManager)
  if (explicit) return explicit
  for (const { name, version } of devEngineEntries(pkg.devEngines?.packageManager)) {
    if (typeof name === 'string' && isNodePm(name)) return { pm: name, version: typeof version === 'string' ? version.trim() : '' }
  }
  return undefined
}

/** A package manager named in `volta` or `engines` (e.g. `engines.pnpm`). */
function packageManagerNamedIn(pkg: PackageJson | undefined): NodePackageManager | undefined {
  for (const source of [pkg?.volta, pkg?.engines]) {
    const hit = NODE_PMS.find((pm) => typeof source?.[pm] === 'string')
    if (hit) return hit
  }
  return undefined
}

/** Yarn Berry pins its own binary in `.yarnrc.yml` (`yarnPath: .yarn/releases/yarn-3.6.4.cjs`). */
async function yarnVersionFromRc(dir: string): Promise<string | undefined> {
  const rc = await readText(path.join(dir, '.yarnrc.yml'))
  if (!rc) return undefined
  const match = /^\s*yarnPath:\s*["']?.*yarn-(\d+\.\d+\.\d+[^"'\s/]*)\.c?js["']?\s*$/m.exec(rc)
  return match?.[1]
}

/**
 * Major version implied by the lockfile format, used only when nothing declares the version:
 * `pnpm-lock.yaml` `lockfileVersion` 5.3 → pnpm 6, 5.4 → 7, 6.x → 8, 9.x → 9 or later (pnpm 10 still
 * writes 9.0); a Yarn v1 lockfile → Yarn 1, a Yarn Berry lockfile (`__metadata`) → Yarn 2 or later.
 */
export async function versionFromLockfileFormat(pm: NodePackageManager, lockfile: string): Promise<string> {
  const text = (await readText(lockfile)) ?? ''
  if (pm === 'pnpm') {
    const match = /^lockfileVersion:\s*['"]?(\d+)(?:\.(\d+))?/m.exec(text)
    if (!match) return ''
    const major = Number(match[1])
    const minor = Number(match[2] ?? 0)
    if (major === 9) return '>=9'
    if (major === 6) return '8'
    if (major === 5 && minor === 4) return '7'
    if (major === 5 && minor === 3) return '6'
    return ''
  }
  if (pm === 'yarn') {
    if (/^__metadata:/m.test(text)) return '>=2'
    if (/^# yarn lockfile v1\b/m.test(text)) return '1'
  }
  return ''
}

/** Yarn 2+ ("Berry") vs Yarn 1 ("Classic"): they need different frozen-install flags. */
async function isYarnBerry(root: string, version: string, lockfile: string | undefined): Promise<boolean> {
  const major = /(\d+)/.exec(version)?.[1]
  if (major) return Number(major) >= 2
  if (await isFile(path.join(root, '.yarnrc.yml'))) return true
  if (lockfile && path.basename(lockfile) === 'yarn.lock') return /^__metadata:/m.test((await readText(lockfile)) ?? '')
  return false
}

function installCommand(pm: NodePackageManager, frozen: boolean, yarnBerry: boolean): string {
  switch (pm) {
    case 'npm':
      return frozen ? 'npm ci' : 'npm install'
    case 'pnpm':
      return frozen ? 'pnpm install --frozen-lockfile' : 'pnpm install'
    case 'yarn':
      if (!frozen) return 'yarn install'
      return yarnBerry ? 'yarn install --immutable' : 'yarn install --frozen-lockfile'
    case 'bun':
      return frozen ? 'bun install --frozen-lockfile' : 'bun install'
  }
}

/** Node runtime declared in package.json, in the order setup-node reads it: volta → devEngines → engines. */
function packageJsonRuntime(dir: string, pkg: PackageJson | undefined): RuntimeHit | undefined {
  if (!pkg) return undefined
  const file = path.join(dir, 'package.json')
  const volta = pkg.volta?.['node']
  if (typeof volta === 'string' && volta.trim()) return { value: cleanVersion(volta), file, field: 'volta.node', setupReadable: true }
  const runtime = devEngineEntries(pkg.devEngines?.runtime).find(
    (e) => typeof e.name === 'string' && e.name.toLowerCase() === 'node' && typeof e.version === 'string' && e.version.trim(),
  )
  if (runtime) return { value: (runtime.version as string).trim(), file, field: 'devEngines.runtime', setupReadable: true }
  const engines = pkg.engines?.['node']
  if (typeof engines === 'string' && engines.trim()) return { value: engines.trim(), file, field: 'engines.node', setupReadable: true }
  return undefined
}

function workspacePatterns(pkg: PackageJson | undefined): string[] {
  const ws = pkg?.workspaces
  const list = Array.isArray(ws) ? ws : ws && typeof ws === 'object' ? (ws as { packages?: unknown }).packages : undefined
  return Array.isArray(list) ? list.filter((p): p is string => typeof p === 'string') : []
}

interface NodeWorkspace {
  dir: string
  pkg: PackageJson | undefined
  /** Declared through `pnpm-workspace.yaml`, which implies pnpm. */
  pnpm: boolean
}

/**
 * Nearest parent directory (within the walk boundary) whose workspace definition — `pnpm-workspace.yaml`
 * or `package.json#workspaces` (npm, Yarn, Bun) — includes `dir` as a member.
 */
async function findWorkspace({ dir, boundary }: DetectorContext): Promise<NodeWorkspace | undefined> {
  for (const level of ancestors(dir, boundary ?? dir)) {
    const rel = relPosix(level, dir)
    const pkg = await readJson<PackageJson>(path.join(level, 'package.json'))
    const pnpmWorkspace = await readText(path.join(level, 'pnpm-workspace.yaml'))
    if (pnpmWorkspace !== undefined && matchesWorkspacePatterns(parsePnpmWorkspacePackages(pnpmWorkspace), rel)) {
      return { dir: level, pkg, pnpm: true }
    }
    if (matchesWorkspacePatterns(workspacePatterns(pkg), rel)) return { dir: level, pkg, pnpm: false }
  }
  return undefined
}

export const nodeDetector: Detector = {
  language: 'node',
  async detect(ctx: DetectorContext): Promise<Detection | undefined> {
    const { dir } = ctx
    const manifest = 'package.json'
    if (!(await isFile(path.join(dir, manifest)))) return undefined
    const pkg = (await readJson<PackageJson>(path.join(dir, manifest))) ?? {}
    const workspace = await findWorkspace(ctx)
    const rootPkg = workspace?.pkg

    // Lockfile: the project's own, otherwise the workspace root's (members share the root lockfile).
    const ownLock = await firstExisting(dir, LOCKFILE_NAMES)
    const rootLock = workspace ? await firstExisting(workspace.dir, LOCKFILE_NAMES) : undefined
    const lockfilePath = ownLock ? path.join(dir, ownLock) : rootLock && workspace ? path.join(workspace.dir, rootLock) : undefined

    // Package manager: explicit declarations beat lockfiles; the project beats its workspace root.
    let packageManager: NodePackageManager | undefined
    let packageManagerVersion = ''
    const declared = declaredPackageManager(pkg)
    if (declared) ({ pm: packageManager, version: packageManagerVersion } = declared)
    packageManager ??= lockfilePm(ownLock)
    if (!packageManager && workspace) {
      const rootDeclared = declaredPackageManager(rootPkg)
      if (rootDeclared) ({ pm: packageManager, version: packageManagerVersion } = rootDeclared)
      else packageManager = lockfilePm(rootLock) ?? (workspace.pnpm ? 'pnpm' : undefined)
    }
    packageManager ??= packageManagerNamedIn(pkg) ?? packageManagerNamedIn(rootPkg) ?? 'npm'

    // Fill in the package manager version from secondary sources when it is still unknown.
    if (!packageManagerVersion) {
      const pm = packageManager
      const volta = [pkg, rootPkg].map((p) => p?.volta?.[pm]).find((v): v is string => typeof v === 'string')
      if (volta) packageManagerVersion = cleanVersion(volta)
      else if (pm === 'yarn') packageManagerVersion = (await yarnVersionFromRc(dir)) ?? (workspace ? await yarnVersionFromRc(workspace.dir) : undefined) ?? ''
      const engines = [pkg, rootPkg].map((p) => p?.engines?.[pm]).find((v): v is string => typeof v === 'string')
      if (!packageManagerVersion && engines) packageManagerVersion = engines.trim()
      if (!packageManagerVersion && lockfilePath && lockfilePm(lockfilePath) === pm) {
        packageManagerVersion = await versionFromLockfileFormat(pm, lockfilePath)
      }
    }

    const installRoot = workspace?.dir ?? dir
    const frozen = lockfilePm(lockfilePath) === packageManager
    const yarnBerry = packageManager === 'yarn' && (await isYarnBerry(installRoot, packageManagerVersion, lockfilePath))

    const runtime = await resolveRuntime(ctx, 'node runtime', (level) => [
      () => versionFileRuntime(level, ['.nvmrc', '.node-version']),
      () => packageJsonRuntime(level, level === dir ? pkg : level === workspace?.dir ? rootPkg : undefined),
      () => toolVersionsRuntime(level, 'node'),
      () => miseRuntime(level, 'node'),
    ])

    const version = await resolveFirst(ctx, 'node version', [
      { name: 'package.json:version', read: () => versionHit(typeof pkg.version === 'string' ? pkg.version : undefined, manifest) },
      ...releaseToolSources(ctx),
    ])
    const lockfile = lockfilePath ? relPosix(dir, lockfilePath) : ''

    return {
      language: 'node',
      name: typeof pkg.name === 'string' ? pkg.name : '',
      version: version?.value ?? '',
      versionSource: version?.source ?? '',
      packageManager,
      packageManagerVersion,
      ...runtimeFields(dir, runtime),
      manifest,
      lockfile,
      workspaceRoot: relPosix(dir, installRoot),
      installCommand: installCommand(packageManager, frozen, yarnBerry),
      cacheDependencyPath: lockfile,
    }
  },
}
