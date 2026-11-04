import * as path from 'node:path'
import type { Detection, Detector, DetectorContext } from '../types.js'
import { firstExisting, isFile, readText, relPosix, walkFiles } from '../utils/fs.js'
import { releaseToolSources } from '../utils/release-tools.js'
import { miseRuntime, resolveRuntime, runtimeFields, toolVersionsRuntime, type RuntimeHit } from '../utils/runtime.js'
import { gitTagSource, resolveFirst, type SourceHit, versionFileSource } from '../utils/sources.js'
import { extractAssignedVersion } from '../utils/version.js'

/** Conventional locations of a `Version` constant, checked before falling back to a directory walk. */
const VERSION_GO_CANDIDATES = [
  'version.go',
  'version/version.go',
  'internal/version/version.go',
  'pkg/version/version.go',
  'internal/build/version.go',
  'cmd/version.go',
]

interface GoMod {
  module: string
  go: string
  toolchain: string
}

export function parseGoMod(text: string): GoMod {
  const result: GoMod = { module: '', go: '', toolchain: '' }
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/\/\/.*$/, '').trim()
    let match: RegExpExecArray | null
    if ((match = /^module\s+("?)(\S+?)\1$/.exec(line))) result.module ||= match[2] ?? ''
    else if ((match = /^go\s+(\S+)$/.exec(line))) result.go ||= match[1] ?? ''
    else if ((match = /^toolchain\s+go(\S+)$/.exec(line))) result.toolchain ||= match[1] ?? ''
  }
  return result
}

/** `var Version = "dev"` is an ldflags placeholder, not a version — only accept values containing a digit. */
function looksLikeVersion(value: string | undefined): value is string {
  return !!value && /\d/.test(value)
}

async function versionFromGoSource(dir: string): Promise<SourceHit | undefined> {
  const identifiers = ['Version', 'version', 'AppVersion', 'BuildVersion', 'VERSION']
  const tryFile = async (file: string): Promise<SourceHit | undefined> => {
    const source = await readText(path.join(dir, file))
    if (source === undefined) return undefined
    const v = extractAssignedVersion(source, identifiers)
    return looksLikeVersion(v) ? { value: v, source: file.split(path.sep).join('/') } : undefined
  }

  for (const candidate of VERSION_GO_CANDIDATES) {
    const hit = await tryFile(candidate)
    if (hit) return hit
  }

  const files = (await walkFiles(dir, { maxDepth: 3 })).filter(
    (f) => f.endsWith('.go') && !f.endsWith('_test.go') && /version/i.test(f),
  )
  files.sort((a, b) => a.split(path.sep).length - b.split(path.sep).length || a.localeCompare(b))
  for (const file of files) {
    const hit = await tryFile(file)
    if (hit) return hit
  }
  return undefined
}

/**
 * Go tags nested modules with their directory: the module in `tools/` is released as `tools/v1.2.3`.
 * Returns that prefix (`tools/`) for `dir`, or an empty string for the repository root module.
 */
export function moduleTagPrefix(dir: string, gitRoot: string | undefined): string {
  if (!gitRoot) return ''
  const rel = relPosix(gitRoot, dir)
  return rel === '.' || rel.startsWith('../') ? '' : `${rel}/`
}

export const goDetector: Detector = {
  language: 'go',
  async detect(ctx: DetectorContext): Promise<Detection | undefined> {
    const { dir } = ctx
    const manifest = await firstExisting(dir, ['go.mod', 'go.work', 'Gopkg.toml'])
    if (!manifest) return undefined

    const isDep = manifest === 'Gopkg.toml'
    const goMod = isDep ? { module: '', go: '', toolchain: '' } : parseGoMod((await readText(path.join(dir, manifest))) ?? '')

    const lockfile = isDep
      ? (await isFile(path.join(dir, 'Gopkg.lock'))) ? 'Gopkg.lock' : ''
      : (await firstExisting(dir, ['go.sum', 'go.work.sum'])) ?? ''

    const version = await resolveFirst(ctx, 'go version', [
      versionFileSource(dir),
      ...releaseToolSources(ctx),
      { name: 'Version constant in version*.go', read: () => versionFromGoSource(dir) },
      // Go modules are versioned by git tags, so this is the canonical last resort.
      gitTagSource(ctx, moduleTagPrefix(dir, ctx.gitRoot)),
    ])

    // setup-go reads go.mod / go.work itself (toolchain directive first, then go), so both are readable.
    const manifestPath = path.join(dir, manifest)
    const directive = (value: string, field: string): RuntimeHit | undefined =>
      value ? { value, file: manifestPath, field, setupReadable: true } : undefined
    const runtime = await resolveRuntime(ctx, 'go runtime', (level) => [
      ...(level === dir ? [() => directive(goMod.go, 'go'), () => directive(goMod.toolchain, 'toolchain')] : []),
      () => toolVersionsRuntime(level, 'go'),
      () => miseRuntime(level, 'go'),
    ])

    return {
      language: 'go',
      name: goMod.module,
      version: version?.value ?? '',
      versionSource: version?.source ?? '',
      packageManager: isDep ? 'dep' : 'go',
      packageManagerVersion: goMod.toolchain,
      ...runtimeFields(dir, runtime),
      manifest,
      lockfile,
      workspaceRoot: '.',
      // A bare go.work has no module of its own to download for; run the detection on a member module instead.
      installCommand: isDep ? 'dep ensure' : manifest === 'go.mod' ? 'go mod download' : '',
      cacheDependencyPath: lockfile,
    }
  },
}
