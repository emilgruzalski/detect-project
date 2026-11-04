import * as path from 'node:path'
import type { Detection, Detector, DetectorContext } from '../types.js'
import { get, str, table } from '../utils/data.js'
import { isFile, readJson } from '../utils/fs.js'
import { releaseToolSources } from '../utils/release-tools.js'
import { miseRuntime, resolveRuntime, runtimeFields, toolVersionsRuntime, versionFileRuntime, type RuntimeCandidate, type RuntimeHit } from '../utils/runtime.js'
import { gitTagSource, resolveFirst, versionHit } from '../utils/sources.js'

function composerRuntime(file: string, doc: unknown, keys: string[]): RuntimeHit | undefined {
  const value = str(get(doc, ...keys))?.trim()
  return value ? { value, file, field: keys.join('.'), setupReadable: false } : undefined
}

export const phpDetector: Detector = {
  language: 'php',
  async detect(ctx: DetectorContext): Promise<Detection | undefined> {
    const { dir } = ctx
    const manifest = 'composer.json'
    const manifestPath = path.join(dir, manifest)
    if (!(await isFile(manifestPath))) return undefined
    const composer = table(await readJson(manifestPath)) ?? {}
    const lockPath = path.join(dir, 'composer.lock')
    const lockfile = (await isFile(lockPath)) ? 'composer.lock' : ''
    const lock = lockfile ? await readJson(lockPath) : undefined

    // Packagist versions packages by their git tags; an explicit `version` field is rare.
    const version = await resolveFirst(ctx, 'php version', [
      { name: 'composer.json:version', read: () => versionHit(str(composer['version']), 'composer.json:version') },
      ...releaseToolSources(ctx),
      gitTagSource(ctx),
    ])

    // Same order as shivammathur/setup-php: .php-version, then composer.lock platform-overrides and
    // composer.json config.platform (both read by setup-php itself when no version is given), then the
    // `require.php` constraint and asdf/mise.
    const runtime = await resolveRuntime(ctx, 'php runtime', (level): RuntimeCandidate[] => [
      () => versionFileRuntime(level, ['.php-version']),
      ...(level === dir
        ? [
            () => composerRuntime(lockPath, lock, ['platform-overrides', 'php']),
            () => composerRuntime(manifestPath, composer, ['config', 'platform', 'php']),
            () => composerRuntime(manifestPath, composer, ['require', 'php']),
          ]
        : []),
      () => toolVersionsRuntime(level, 'php'),
      () => miseRuntime(level, 'php'),
    ])

    return {
      language: 'php',
      name: str(composer['name']) ?? '',
      version: version?.value ?? '',
      versionSource: version?.source ?? '',
      packageManager: 'composer',
      packageManagerVersion: '',
      ...runtimeFields(dir, runtime),
      manifest,
      lockfile,
      workspaceRoot: '.',
      installCommand: 'composer install --no-interaction',
      cacheDependencyPath: lockfile,
    }
  },
}
