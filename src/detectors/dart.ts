import * as path from 'node:path'
import { parse as parseYaml } from 'yaml'
import type { Detection, Detector, DetectorContext } from '../types.js'
import { ancestors, isFile, readJson, readText, relPosix } from '../utils/fs.js'
import { releaseToolSources } from '../utils/release-tools.js'
import { miseRuntime, resolveRuntime, runtimeFields, toolVersionsRuntime, type RuntimeCandidate, type RuntimeHit } from '../utils/runtime.js'
import { resolveFirst, versionHit } from '../utils/sources.js'
import { matchesWorkspacePatterns } from '../utils/workspace.js'

type Table = Record<string, unknown>

function table(value: unknown): Table | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Table) : undefined
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/**
 * Parses pubspec.yaml with the YAML failsafe schema, which keeps every scalar a string: with the core
 * schema `version: 1.10` would become the number 1.1. Malformed YAML yields an empty pubspec.
 */
export async function readPubspec(dir: string): Promise<Table | undefined> {
  const text = await readText(path.join(dir, 'pubspec.yaml'))
  if (text === undefined) return undefined
  try {
    return table(parseYaml(text, { schema: 'failsafe' })) ?? {}
  } catch {
    return {}
  }
}

/** Flutter app or package: depends on the Flutter SDK, constrains its version or has a `flutter:` section. */
export function isFlutter(pubspec: Table): boolean {
  return table(table(pubspec['dependencies'])?.['flutter'])?.['sdk'] === 'flutter' || table(pubspec['environment'])?.['flutter'] !== undefined || 'flutter' in pubspec
}

interface PubWorkspace {
  dir: string
  pubspec: Table
}

/**
 * Dart pub workspaces (Dart 3.6+): a member declares `resolution: workspace` and the nearest parent
 * pubspec whose `workspace:` list contains it is the root that owns pubspec.lock.
 */
async function findPubWorkspace({ dir, boundary }: DetectorContext, pubspec: Table): Promise<PubWorkspace | undefined> {
  if (str(pubspec['resolution']) !== 'workspace') return undefined
  for (const level of ancestors(dir, boundary ?? dir)) {
    const root = await readPubspec(level)
    const members = root?.['workspace']
    if (!root || !Array.isArray(members)) continue
    if (matchesWorkspacePatterns(members.filter((m): m is string => typeof m === 'string'), relPosix(level, dir))) return { dir: level, pubspec: root }
  }
  return undefined
}

/** An exact Flutter version, the only form subosito/flutter-action accepts from `flutter-version-file`. */
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/

function pubspecRuntime(dir: string, pubspec: Table | undefined, key: 'flutter' | 'sdk', readable: (value: string) => boolean): RuntimeHit | undefined {
  const value = str(table(pubspec?.['environment'])?.[key])?.trim()
  return value ? { value, file: path.join(dir, 'pubspec.yaml'), field: `environment.${key}`, setupReadable: readable(value) } : undefined
}

/** FVM pins: `.fvmrc` (FVM 3, `{"flutter": "3.24.0"}`) and the older `.fvm/fvm_config.json` (`flutterSdkVersion`). */
async function fvmRuntime(dir: string): Promise<RuntimeHit | undefined> {
  const rcFile = path.join(dir, '.fvmrc')
  const rc = table(await readJson(rcFile))
  const rcVersion = str(rc?.['flutter'])?.trim()
  if (rcVersion) return { value: rcVersion, file: rcFile, field: 'flutter', setupReadable: true }
  const configFile = path.join(dir, '.fvm', 'fvm_config.json')
  const config = table(await readJson(configFile))
  for (const field of ['flutterSdkVersion', 'flutter']) {
    const value = str(config?.[field])?.trim()
    if (value) return { value, file: configFile, field, setupReadable: true }
  }
  return undefined
}

export const dartDetector: Detector = {
  language: 'dart',
  async detect(ctx: DetectorContext): Promise<Detection | undefined> {
    const { dir } = ctx
    const manifest = 'pubspec.yaml'
    const pubspec = await readPubspec(dir)
    if (!pubspec) return undefined
    const flutter = isFlutter(pubspec)
    const workspace = await findPubWorkspace(ctx, pubspec)

    const version = await resolveFirst(ctx, 'dart version', [
      { name: 'pubspec.yaml:version', read: () => versionHit(str(pubspec['version']), manifest) },
      ...releaseToolSources(ctx),
    ])

    const ownLock = path.join(dir, 'pubspec.lock')
    const rootLock = workspace ? path.join(workspace.dir, 'pubspec.lock') : undefined
    const lockfilePath = (await isFile(ownLock)) ? ownLock : rootLock && (await isFile(rootLock)) ? rootLock : undefined
    const lockfile = lockfilePath ? relPosix(dir, lockfilePath) : ''

    const levelPubspec = (level: string): Table | undefined => (level === dir ? pubspec : level === workspace?.dir ? workspace.pubspec : undefined)
    // Flutter projects install the Flutter SDK (Dart comes with it), so their runtime is the Flutter version,
    // read the way subosito/flutter-action's flutter-version-file does. An FVM pin is project-wide and decides
    // what gets installed (like a rust-toolchain file), so it wins over a package's `environment.flutter`
    // constraint wherever it sits up to the repository root; asdf/mise come last as for the other languages.
    // Pure Dart projects report the Dart SDK.
    const runtime = flutter
      ? ((await resolveRuntime(ctx, 'flutter sdk (FVM)', (level) => [() => fvmRuntime(level)])) ??
        (await resolveRuntime(ctx, 'flutter sdk (pubspec)', (level): RuntimeCandidate[] => [
          () => pubspecRuntime(level, levelPubspec(level), 'flutter', (v) => EXACT_VERSION.test(v)),
        ])) ??
        (await resolveRuntime(ctx, 'flutter sdk (asdf/mise)', (level) => [() => toolVersionsRuntime(level, 'flutter'), () => miseRuntime(level, 'flutter')])))
      : await resolveRuntime(ctx, 'dart sdk', (level): RuntimeCandidate[] => [
          // dart-lang/setup-dart only takes an `sdk` input, no version file.
          () => pubspecRuntime(level, levelPubspec(level), 'sdk', () => false),
          () => toolVersionsRuntime(level, 'dart'),
          () => miseRuntime(level, 'dart'),
        ])

    const tool = flutter ? 'flutter' : 'dart'
    return {
      language: 'dart',
      name: str(pubspec['name']) ?? '',
      version: version?.value ?? '',
      versionSource: version?.source ?? '',
      packageManager: tool,
      packageManagerVersion: '',
      ...runtimeFields(dir, runtime),
      manifest,
      lockfile,
      workspaceRoot: relPosix(dir, workspace?.dir ?? dir),
      installCommand: lockfile ? `${tool} pub get --enforce-lockfile` : `${tool} pub get`,
      cacheDependencyPath: lockfile,
    }
  },
}
