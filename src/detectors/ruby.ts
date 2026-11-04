import * as path from 'node:path'
import type { Detection, Detector, DetectorContext } from '../types.js'
import { firstExisting, listDir, readText, readVersionFile } from '../utils/fs.js'
import { releaseToolSources } from '../utils/release-tools.js'
import { miseRuntime, resolveRuntime, runtimeFields, toolVersionsRuntime, versionFileRuntime, type RuntimeCandidate, type RuntimeHit } from '../utils/runtime.js'
import { resolveFirst, type SourceHit, versionFileSource, versionHit } from '../utils/sources.js'
import { extractAssignedVersion } from '../utils/version.js'

const GEMFILES = ['Gemfile', 'gems.rb']
const LOCKFILES = ['Gemfile.lock', 'gems.locked']

async function findGemspec(dir: string): Promise<string | undefined> {
  return ((await listDir(dir)) ?? [])
    .filter((e) => e.isFile() && e.name.endsWith('.gemspec'))
    .map((e) => e.name)
    .sort()[0]
}

/** `spec.version = Foo::VERSION` lives in `lib/<name>/version.rb` (`foo-bar` → `lib/foo/bar` or `lib/foo_bar`). */
async function versionFromVersionRb(dir: string, gemName: string): Promise<SourceHit | undefined> {
  const candidates = gemName ? [...new Set([gemName, gemName.replace(/-/g, '/'), gemName.replace(/-/g, '_')])].map((n) => `lib/${n}/version.rb`) : []
  // Without a match by name, a single lib/*/version.rb is unambiguous.
  const libDirs = ((await listDir(path.join(dir, 'lib'))) ?? []).filter((e) => e.isDirectory()).map((e) => `lib/${e.name}/version.rb`)
  const existing: string[] = []
  for (const file of libDirs) if ((await readText(path.join(dir, file))) !== undefined) existing.push(file)
  if (existing.length === 1) candidates.push(existing[0]!)
  for (const file of candidates) {
    const source = await readText(path.join(dir, file))
    const version = source ? extractAssignedVersion(source, ['VERSION']) : undefined
    if (version && /\d/.test(version)) return { value: version, source: file }
  }
  return undefined
}

/** `ruby "3.3.0"` / `ruby "~> 3.2"` or `ruby file: ".ruby-version"` in the Gemfile. */
async function gemfileRuby(dir: string, gemfile: string | undefined): Promise<RuntimeHit | undefined> {
  if (!gemfile) return undefined
  const text = (await readText(path.join(dir, gemfile))) ?? ''
  const direct = /^\s*ruby\s*\(?\s*["']([^"']+)["']/m.exec(text)?.[1]
  if (direct) return { value: direct.trim(), file: path.join(dir, gemfile), field: 'ruby', setupReadable: false }
  const fromFile = /^\s*ruby\s*\(?\s*file:\s*["']([^"']+)["']/m.exec(text)?.[1]
  if (fromFile) {
    const file = path.join(dir, fromFile)
    const value = await readVersionFile(file)
    if (value) return { value, file, field: '', setupReadable: path.basename(file) === '.ruby-version' }
  }
  return undefined
}

/** `RUBY VERSION` section of Gemfile.lock (`ruby 3.3.0p0` → `3.3.0`). */
async function lockfileRuby(dir: string, lockfile: string | undefined): Promise<RuntimeHit | undefined> {
  if (!lockfile) return undefined
  const text = (await readText(path.join(dir, lockfile))) ?? ''
  const value = /^RUBY VERSION\r?\n\s+ruby\s+(\S+)/m.exec(text)?.[1]?.replace(/p\d+$/, '')
  return value ? { value, file: path.join(dir, lockfile), field: 'RUBY VERSION', setupReadable: false } : undefined
}

export const rubyDetector: Detector = {
  language: 'ruby',
  async detect(ctx: DetectorContext): Promise<Detection | undefined> {
    const { dir } = ctx
    const gemfile = await firstExisting(dir, GEMFILES)
    const gemspec = await findGemspec(dir)
    const manifest = gemfile ?? gemspec
    if (!manifest) return undefined

    const spec = gemspec ? ((await readText(path.join(dir, gemspec))) ?? '') : ''
    // `spec.name = "x"`, or the positional form `Gem::Specification.new 'x', '1.0.0' do |s|` (sinatra).
    const positional = /Gem::Specification\.new\s*\(?\s*["']([^"']+)["'](?:\s*,\s*(?:["']([^"']+)["'])?)?/.exec(spec)
    const name = /\.name\s*=\s*["']([^"']+)["']/.exec(spec)?.[1] ?? positional?.[1] ?? ''
    const literalVersion = /\.version\s*=\s*["']([^"']+)["']/.exec(spec)?.[1] ?? positional?.[2]
    const lockfile = (await firstExisting(dir, LOCKFILES)) ?? ''

    const version = await resolveFirst(ctx, 'ruby version', [
      { name: 'gemspec version', read: () => (gemspec ? versionHit(literalVersion, `${gemspec}:version`) : undefined) },
      { name: 'VERSION in lib/*/version.rb', read: () => versionFromVersionRb(dir, name) },
      versionFileSource(dir),
      ...releaseToolSources(ctx),
    ])

    const bundler = lockfile ? /^BUNDLED WITH\r?\n\s+(\S+)/m.exec((await readText(path.join(dir, lockfile))) ?? '')?.[1] : undefined

    // setup-ruby reads .ruby-version, .tool-versions and mise.toml (in its working-directory) by itself.
    const runtime = await resolveRuntime(ctx, 'ruby runtime', (level): RuntimeCandidate[] => [
      () => versionFileRuntime(level, ['.ruby-version']),
      ...(level === dir ? [() => gemfileRuby(dir, gemfile), () => lockfileRuby(dir, lockfile || undefined)] : []),
      () => toolVersionsRuntime(level, 'ruby'),
      () => miseRuntime(level, 'ruby'),
    ])

    return {
      language: 'ruby',
      name,
      version: version?.value ?? '',
      versionSource: version?.source ?? '',
      packageManager: 'bundler',
      packageManagerVersion: bundler ?? '',
      ...runtimeFields(dir, runtime),
      manifest,
      lockfile,
      workspaceRoot: '.',
      // Bundler needs a Gemfile; a bare gemspec has nothing to install from.
      installCommand: gemfile ? 'bundle install' : '',
      cacheDependencyPath: lockfile,
    }
  },
}
