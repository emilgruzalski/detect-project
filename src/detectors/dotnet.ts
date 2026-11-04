import * as path from 'node:path'
import type { Detection, Detector, DetectorContext } from '../types.js'
import { get, str, table } from '../utils/data.js'
import { ancestors, isFile, isInside, listDir, readJson, readText, relPosix } from '../utils/fs.js'
import { releaseToolSources } from '../utils/release-tools.js'
import { miseRuntime, resolveRuntime, runtimeFields, toolVersionsRuntime, type RuntimeHit } from '../utils/runtime.js'
import { gitTagSource, resolveFirst, type SourceHit, versionHit } from '../utils/sources.js'
import { msbuildProperty, stripXmlComments } from '../utils/xml.js'

const SOLUTION_EXTENSIONS = ['.sln', '.slnx']
const PROJECT_EXTENSIONS = ['.csproj', '.fsproj', '.vbproj']

interface MsbuildFile {
  /** Absolute path. */
  file: string
  xml: string
}

async function readMsbuild(file: string): Promise<MsbuildFile | undefined> {
  const text = await readText(file)
  return text === undefined ? undefined : { file, xml: stripXmlComments(text) }
}

/**
 * `source` followed by the local files it imports (`<Import Project="$(MSBuildThisFileDirectory)Version.props" />`,
 * `<Import Project="..\eng\Versions.props" />`), one level deep and within the walk boundary. Imports that use
 * any other MSBuild property are skipped.
 */
async function withImports(source: MsbuildFile | undefined, boundary: string): Promise<MsbuildFile[]> {
  if (!source) return []
  const dir = path.dirname(source.file)
  const files = [source]
  for (const [, raw] of source.xml.matchAll(/<Import\s[^>]*?\bProject\s*=\s*"([^"]+)"/g)) {
    const relative = raw!.replace(/\$\(MSBuildThisFileDirectory\)/g, '').replace(/\\/g, '/')
    if (relative.includes('$(')) continue
    const file = path.resolve(dir, relative)
    if (!isInside(file, boundary)) continue
    const imported = await readMsbuild(file)
    if (imported) files.push(imported)
  }
  return files
}

/** `<Version>`, or `<VersionPrefix>` plus an optional `-<VersionSuffix>`, from the first file that declares one. */
function msbuildVersion(dir: string, sources: readonly MsbuildFile[]): SourceHit | undefined {
  for (const source of sources) {
    const label = relPosix(dir, source.file)
    const version = msbuildProperty(source.xml, 'Version')
    if (version) return versionHit(version, `${label}:Version`)
    const prefix = msbuildProperty(source.xml, 'VersionPrefix')
    if (!prefix) continue
    const suffix = msbuildProperty(source.xml, 'VersionSuffix')
    return versionHit(suffix ? `${prefix}-${suffix}` : prefix, `${label}:VersionPrefix`)
  }
  return undefined
}

/**
 * The .NET version a target framework needs: `net8.0` → `8.0`, `netcoreapp3.1` → `3.1`; the highest one of
 * `<TargetFrameworks>`. .NET Framework (`net48`) and `netstandard` say nothing about the SDK and are skipped.
 */
export function dotnetVersionFromTargetFrameworks(value: string): string | undefined {
  const versions = value
    .split(';')
    .map((tfm) => tfm.trim().toLowerCase())
    .map((tfm) => /^net(\d+\.\d+)(?:-.*)?$/.exec(tfm)?.[1] ?? /^netcoreapp(\d+\.\d+)$/.exec(tfm)?.[1])
    .filter((v): v is string => !!v && (Number(v.split('.')[0]) >= 5 || /^[123]\./.test(v)))
  return versions.sort((a, b) => {
    const [am, an] = a.split('.').map(Number)
    const [bm, bn] = b.split('.').map(Number)
    return bm! - am! || bn! - an!
  })[0]
}

function targetFrameworkRuntime(sources: readonly MsbuildFile[]): RuntimeHit | undefined {
  for (const source of sources) {
    for (const field of ['TargetFramework', 'TargetFrameworks']) {
      const raw = msbuildProperty(source.xml, field)
      const value = raw ? dotnetVersionFromTargetFrameworks(raw) : undefined
      if (value) return { value, file: source.file, field, setupReadable: false }
    }
  }
  return undefined
}

/** `global.json` `sdk.version` — `dotnet` resolves it by walking up, setup-dotnet reads it via `global-json-file`. */
async function globalJsonRuntime(dir: string): Promise<RuntimeHit | undefined> {
  const file = path.join(dir, 'global.json')
  const value = str(get(await readJson(file), 'sdk', 'version'))?.trim()
  return value ? { value, file, field: 'sdk.version', setupReadable: true } : undefined
}

/** Nerdbank.GitVersioning `version.json` (nearest up to the boundary): the declared version base. */
async function nerdbankVersion(ctx: DetectorContext): Promise<SourceHit | undefined> {
  for (const level of [ctx.dir, ...ancestors(ctx.dir, ctx.boundary ?? ctx.dir)]) {
    const file = path.join(level, 'version.json')
    const doc = table(await readJson(file))
    if (!doc) continue
    return versionHit(str(doc['version']), `${relPosix(ctx.dir, file)}:version`)
  }
  return undefined
}

export const dotnetDetector: Detector = {
  language: 'dotnet',
  async detect(ctx: DetectorContext): Promise<Detection | undefined> {
    const { dir } = ctx
    const files = ((await listDir(dir)) ?? []).filter((e) => e.isFile()).map((e) => e.name).sort()
    const solutions = files.filter((f) => SOLUTION_EXTENSIONS.includes(path.extname(f).toLowerCase()))
    const projects = files.filter((f) => PROJECT_EXTENSIONS.includes(path.extname(f).toLowerCase()))
    const manifest = solutions[0] ?? projects[0]
    if (!manifest) return undefined

    const boundary = ctx.boundary ?? dir
    const project = solutions.length ? undefined : await readMsbuild(path.join(dir, manifest))
    // MSBuild imports the nearest Directory.Build.props above the project.
    let props: MsbuildFile | undefined
    for (const level of [dir, ...ancestors(dir, boundary)]) {
      props = await readMsbuild(path.join(level, 'Directory.Build.props'))
      if (props) break
    }
    const projectFiles = await withImports(project, boundary)
    const propsFiles = await withImports(props, boundary)

    const stem = path.basename(manifest, path.extname(manifest))
    const name = (project && (msbuildProperty(project.xml, 'PackageId') ?? msbuildProperty(project.xml, 'AssemblyName'))) || stem

    const version = await resolveFirst(ctx, 'dotnet version', [
      { name: `${manifest} Version/VersionPrefix`, read: () => msbuildVersion(dir, projectFiles) },
      { name: 'Directory.Build.props Version/VersionPrefix (and its imports)', read: () => msbuildVersion(dir, propsFiles) },
      { name: 'version.json (Nerdbank.GitVersioning)', read: () => nerdbankVersion(ctx) },
      ...releaseToolSources(ctx),
      gitTagSource(ctx),
    ])

    const runtime =
      (await resolveRuntime(ctx, 'dotnet sdk (global.json)', (level) => [() => globalJsonRuntime(level)])) ??
      (await resolveRuntime(ctx, 'dotnet target framework', (level) =>
        level === dir ? [() => targetFrameworkRuntime(projectFiles), () => targetFrameworkRuntime(propsFiles)] : [],
      )) ??
      (await resolveRuntime(ctx, 'dotnet runtime (asdf/mise)', (level) => [() => toolVersionsRuntime(level, 'dotnet'), () => miseRuntime(level, 'dotnet')]))

    const lockfile = (await isFile(path.join(dir, 'packages.lock.json'))) ? 'packages.lock.json' : ''
    // `dotnet restore` needs the file when the directory holds more than one solution/project.
    const ambiguous = solutions.length + projects.length > 1
    const restore = ambiguous ? (/\s/.test(manifest) ? '' : `dotnet restore ${manifest}`) : 'dotnet restore'
    const installCommand = restore && lockfile ? `${restore} --locked-mode` : restore

    return {
      language: 'dotnet',
      name,
      version: version?.value ?? '',
      versionSource: version?.source ?? '',
      packageManager: 'dotnet',
      packageManagerVersion: '',
      ...runtimeFields(dir, runtime),
      manifest,
      lockfile,
      workspaceRoot: '.',
      installCommand,
      cacheDependencyPath: lockfile,
    }
  },
}
