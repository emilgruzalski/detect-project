import * as path from 'node:path'
import { parse as parseToml } from 'smol-toml'
import type { Detection, Detector, DetectorContext } from '../types.js'
import { ancestors, isFile, isInside, readText, readVersionFile, relPosix } from '../utils/fs.js'
import { releaseToolSources } from '../utils/release-tools.js'
import { miseRuntime, resolveRuntime, runtimeFields, toolVersionsRuntime, type RuntimeHit } from '../utils/runtime.js'
import { gitTagSource, resolveFirst, versionHit } from '../utils/sources.js'
import { matchesWorkspacePatterns } from '../utils/workspace.js'

type Table = Record<string, unknown>

function table(value: unknown): Table | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Table) : undefined
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
}

interface CargoManifest {
  /** Directory containing the Cargo.toml. */
  dir: string
  package: Table | undefined
  workspace: Table | undefined
}

async function readCargo(dir: string): Promise<CargoManifest | undefined> {
  const text = await readText(path.join(dir, 'Cargo.toml'))
  if (text === undefined) return undefined
  let raw: Table
  try {
    raw = parseToml(text) as Table
  } catch {
    raw = {}
  }
  return { dir, package: table(raw['package']), workspace: table(raw['workspace']) }
}

/** `version.workspace = true` style inheritance from `[workspace.package]`. */
function inherits(pkg: Table | undefined, key: string): boolean {
  return table(pkg?.[key])?.['workspace'] === true
}

/**
 * The cargo workspace `dir` belongs to: its own Cargo.toml when that has a `[workspace]` table, the
 * explicit `package.workspace` path, or else the nearest parent (within the walk boundary) whose
 * `[workspace]` does not `exclude` it — cargo refuses to build a package below a workspace it is not a
 * member of, so membership via `members` globs or path dependencies need not be re-checked.
 */
async function findCargoWorkspace(ctx: DetectorContext, own: CargoManifest): Promise<CargoManifest | undefined> {
  if (own.workspace) return own
  const boundary = ctx.boundary ?? ctx.dir
  const explicit = str(own.package?.['workspace'])
  if (explicit) {
    const dir = path.resolve(ctx.dir, explicit)
    if (!isInside(dir, boundary)) return undefined
    const cargo = await readCargo(dir)
    return cargo?.workspace ? cargo : undefined
  }
  for (const level of ancestors(ctx.dir, boundary)) {
    const cargo = await readCargo(level)
    if (!cargo?.workspace) continue
    const rel = relPosix(level, ctx.dir)
    const excluded = strings(cargo.workspace['exclude']).some((e) => {
      const entry = e.replace(/^\.\//, '').replace(/\/+$/, '')
      return rel === entry || rel.startsWith(`${entry}/`) || matchesWorkspacePatterns([entry], rel)
    })
    return excluded ? undefined : cargo
  }
  return undefined
}

/**
 * rustup's toolchain override files: `rust-toolchain.toml` (`[toolchain] channel`) or the legacy
 * `rust-toolchain` (a bare channel or the same TOML). rustup — and actions-rust-lang/setup-rust-toolchain
 * without a `toolchain` input — reads them by itself.
 */
async function rustToolchainFile(dir: string): Promise<RuntimeHit | undefined> {
  for (const name of ['rust-toolchain.toml', 'rust-toolchain']) {
    const file = path.join(dir, name)
    const text = await readText(file)
    if (text === undefined) continue
    let channel: string | undefined
    try {
      channel = str(table((parseToml(text) as Table)['toolchain'])?.['channel'])
    } catch {
      // not TOML: the legacy single-line format
    }
    if (channel === undefined && name === 'rust-toolchain' && !/^\s*\[/m.test(text)) channel = await readVersionFile(file)
    if (channel?.trim()) return { value: channel.trim(), file, field: channel === text.trim() ? '' : 'toolchain.channel', setupReadable: true }
  }
  return undefined
}

export const rustDetector: Detector = {
  language: 'rust',
  async detect(ctx: DetectorContext): Promise<Detection | undefined> {
    const { dir } = ctx
    const manifest = 'Cargo.toml'
    const cargo = await readCargo(dir)
    if (!cargo) return undefined
    const pkg = cargo.package
    const workspace = await findCargoWorkspace(ctx, cargo)
    const workspacePackage = table(workspace?.workspace?.['package'])
    const workspaceManifest = workspace ? relPosix(dir, path.join(workspace.dir, 'Cargo.toml')) : ''

    const version = await resolveFirst(ctx, 'rust version', [
      { name: 'Cargo.toml:package.version', read: () => versionHit(str(pkg?.['version']), 'Cargo.toml:package.version') },
      {
        // `version.workspace = true`, or a virtual workspace root without [package].
        name: 'workspace.package.version',
        read: () =>
          inherits(pkg, 'version') || !pkg ? versionHit(str(workspacePackage?.['version']), `${workspaceManifest}:workspace.package.version`) : undefined,
      },
      ...releaseToolSources(ctx),
      gitTagSource(ctx),
    ])

    const ownLock = path.join(dir, 'Cargo.lock')
    const rootLock = workspace ? path.join(workspace.dir, 'Cargo.lock') : undefined
    const lockfilePath = (await isFile(ownLock)) ? ownLock : rootLock && (await isFile(rootLock)) ? rootLock : undefined
    const lockfile = lockfilePath ? relPosix(dir, lockfilePath) : ''

    // MSRV: the project's own `rust-version`, or the inherited `[workspace.package] rust-version`.
    const msrv = (): RuntimeHit | undefined => {
      const own = str(pkg?.['rust-version'])
      if (own?.trim()) return { value: own.trim(), file: path.join(dir, manifest), field: 'package.rust-version', setupReadable: false }
      const shared = str(workspacePackage?.['rust-version'])
      if ((inherits(pkg, 'rust-version') || !pkg) && workspace && shared?.trim()) {
        return { value: shared.trim(), file: path.join(workspace.dir, 'Cargo.toml'), field: 'workspace.package.rust-version', setupReadable: false }
      }
      return undefined
    }
    // A toolchain file decides what rustup installs, wherever it sits up to the repository root;
    // the MSRV is only a lower bound, and asdf/mise come last as for the other languages.
    const runtime =
      (await resolveRuntime(ctx, 'rust toolchain file', (level) => [() => rustToolchainFile(level)])) ??
      (await resolveRuntime(ctx, 'rust-version (MSRV)', (level) => (level === dir ? [msrv] : []))) ??
      (await resolveRuntime(ctx, 'rust runtime (asdf/mise)', (level) => [() => toolVersionsRuntime(level, 'rust'), () => miseRuntime(level, 'rust')]))

    return {
      language: 'rust',
      name: str(pkg?.['name']) ?? '',
      version: version?.value ?? '',
      versionSource: version?.source ?? '',
      packageManager: 'cargo',
      packageManagerVersion: '',
      ...runtimeFields(dir, runtime),
      manifest,
      lockfile,
      workspaceRoot: relPosix(dir, workspace?.dir ?? dir),
      installCommand: lockfile ? 'cargo fetch --locked' : 'cargo fetch',
      cacheDependencyPath: lockfile,
    }
  },
}
