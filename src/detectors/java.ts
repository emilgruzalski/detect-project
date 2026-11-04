import * as path from 'node:path'
import type { Detection, Detector, DetectorContext } from '../types.js'
import { ancestors, firstExisting, isFile, isInside, readText, readVersionFile, relPosix } from '../utils/fs.js'
import { releaseToolSources } from '../utils/release-tools.js'
import { miseRuntime, resolveRuntime, runtimeFields, toolVersionsRuntime, type RuntimeCandidate, type RuntimeHit } from '../utils/runtime.js'
import { gitTagSource, resolveFirst, type Source, versionHit } from '../utils/sources.js'
import { removeXmlBlocks, stripXmlComments, xmlList, xmlText } from '../utils/xml.js'

/** Java version as setup-java expects it: the old `1.8` notation becomes `8`. */
export function normalizeJavaVersion(value: string): string {
  return value.trim().replace(/^1\.(\d+)$/, '$1')
}

// ---------------------------------------------------------------------------------------------------
// Shared runtime sources (all three files are read by actions/setup-java's java-version-file)

async function sdkmanrcRuntime(dir: string): Promise<RuntimeHit | undefined> {
  const file = path.join(dir, '.sdkmanrc')
  const match = /^\s*java\s*=\s*([^\s#]+)/m.exec((await readText(file)) ?? '')
  // `21.0.2-tem`: version, then the SDKMAN distribution identifier.
  const value = match?.[1]?.replace(/-[a-z0-9]+$/i, '')
  return value ? { value, file, field: 'java', setupReadable: true } : undefined
}

async function javaToolVersions(dir: string): Promise<RuntimeHit | undefined> {
  const hit = await toolVersionsRuntime(dir, 'java')
  // asdf-java names carry the vendor: `temurin-21.0.2+13.0.LTS` → `21.0.2+13.0.LTS`.
  return hit ? { ...hit, value: hit.value.replace(/^(?:[a-z][a-z0-9.]*-)+(?=\d)/i, '') } : undefined
}

async function javaVersionFile(dir: string): Promise<RuntimeHit | undefined> {
  const file = path.join(dir, '.java-version')
  const value = await readVersionFile(file)
  return value ? { value: normalizeJavaVersion(value), file, field: '', setupReadable: true } : undefined
}

function javaRuntimeChain(level: string, buildSources: RuntimeCandidate[]): RuntimeCandidate[] {
  return [() => javaVersionFile(level), () => sdkmanrcRuntime(level), ...buildSources, () => javaToolVersions(level), () => miseRuntime(level, 'java')]
}

/** Nearest `<root>/<relative>` file walking up from `dir` within the boundary (wrappers live in the build root). */
async function nearestFile(ctx: DetectorContext, relative: string): Promise<string | undefined> {
  for (const level of [ctx.dir, ...ancestors(ctx.dir, ctx.boundary ?? ctx.dir)]) {
    const file = path.join(level, relative)
    if (await isFile(file)) return file
  }
  return undefined
}

// ---------------------------------------------------------------------------------------------------
// Maven

interface Pom {
  dir: string
  artifactId: string | undefined
  version: string | undefined
  parentVersion: string | undefined
  modules: string[]
  properties: Record<string, string>
}

const NON_PROJECT_BLOCKS = [
  'parent',
  'dependencies',
  'dependencyManagement',
  'build',
  'profiles',
  'reporting',
  'modules',
  'properties',
  'distributionManagement',
  'repositories',
  'pluginRepositories',
  'developers',
  'contributors',
  'licenses',
  'scm',
  'issueManagement',
  'ciManagement',
  'mailingLists',
  'organization',
  'prerequisites',
]

export async function readPom(dir: string): Promise<Pom | undefined> {
  const text = await readText(path.join(dir, 'pom.xml'))
  if (text === undefined) return undefined
  const xml = stripXmlComments(text)
  const top = removeXmlBlocks(xml, NON_PROJECT_BLOCKS)
  const parent = /<parent(?:\s[^>]*)?>([\s\S]*?)<\/parent\s*>/.exec(xml)?.[1]
  const withoutProfiles = removeXmlBlocks(xml, ['profiles', 'build', 'dependencies', 'dependencyManagement'])
  const propertiesBlock = /<properties(?:\s[^>]*)?>([\s\S]*?)<\/properties\s*>/.exec(withoutProfiles)?.[1] ?? ''
  const properties: Record<string, string> = {}
  for (const [, key, value] of propertiesBlock.matchAll(/<([\w.-]+)(?:\s[^>]*)?>([^<]*)<\/\1\s*>/g)) properties[key!] = value!.trim()
  return {
    dir,
    artifactId: xmlText(top, 'artifactId'),
    version: xmlText(top, 'version'),
    parentVersion: parent ? xmlText(parent, 'version') : undefined,
    modules: xmlList(removeXmlBlocks(xml, ['profiles']), 'modules', 'module'),
    properties,
  }
}

/** `-Drevision=1.2.3` style properties from `.mvn/maven.config` (CI-friendly versions). */
async function mavenConfigProperties(ctx: DetectorContext): Promise<Record<string, string>> {
  const file = await nearestFile(ctx, '.mvn/maven.config')
  const properties: Record<string, string> = {}
  // Empty values are common for releases: `-Drevision=1.2.0 -Dchangelist=`.
  for (const [, key, value] of ((file && (await readText(file))) || '').matchAll(/-D([\w.-]+)=(\S*)/g)) properties[key!] = value!.replace(/^["']|["']$/g, '')
  return properties
}

/** Replaces `${name}` references; undefined when any reference stays unresolved. */
export function interpolate(value: string | undefined, properties: Record<string, string>, depth = 0): string | undefined {
  if (!value) return undefined
  const resolved = value.replace(/\$\{([\w.-]+)\}/g, (whole, key: string) => properties[key] ?? whole)
  if (!resolved.includes('${')) return resolved
  return depth < 5 && resolved !== value ? interpolate(resolved, properties, depth + 1) : undefined
}

/**
 * The aggregator chain above `dir`: each step is the nearest parent pom.xml whose `<modules>` lists the
 * previous directory, nearest first. The last element is the top-level build root.
 */
async function mavenAggregators(ctx: DetectorContext): Promise<Pom[]> {
  const chain: Pom[] = []
  let current = ctx.dir
  for (const level of ancestors(ctx.dir, ctx.boundary ?? ctx.dir)) {
    const pom = await readPom(level)
    if (!pom) continue
    const rel = relPosix(level, current)
    if (pom.modules.some((m) => m.replace(/^\.\//, '').replace(/\/+$/, '').replace(/\/pom\.xml$/, '') === rel)) {
      chain.push(pom)
      current = level
    }
  }
  return chain
}

function mavenJavaRuntime(dir: string, pom: Pom | undefined, properties: Record<string, string>): RuntimeHit | undefined {
  if (!pom) return undefined
  for (const key of ['maven.compiler.release', 'java.version', 'maven.compiler.target', 'maven.compiler.source']) {
    const value = interpolate(pom.properties[key], properties)
    if (value && /^\d/.test(value)) return { value: normalizeJavaVersion(value), file: path.join(dir, 'pom.xml'), field: `properties.${key}`, setupReadable: false }
  }
  return undefined
}

async function detectMaven(ctx: DetectorContext, pom: Pom): Promise<Detection> {
  const { dir } = ctx
  const chain = await mavenAggregators(ctx)
  const root = chain.at(-1)
  // Properties are inherited down the chain; the project's own win, .mvn/maven.config overrides all.
  const properties = Object.assign({}, ...[...chain].reverse().map((p) => p.properties), pom.properties, await mavenConfigProperties(ctx)) as Record<string, string>
  const inRepoParent = chain.length > 0 || (await isFile(path.join(dir, '..', 'pom.xml')) && isInside(path.join(dir, '..'), ctx.boundary ?? dir))

  const version = await resolveFirst(ctx, 'java version', [
    { name: 'pom.xml:version', read: () => versionHit(interpolate(pom.version, properties), 'pom.xml:version') },
    // Without its own <version> a module inherits its parent's — only meaningful for a parent in this repository.
    { name: 'pom.xml:parent.version', read: () => (inRepoParent ? versionHit(interpolate(pom.parentVersion, properties), 'pom.xml:parent.version') : undefined) },
    ...releaseToolSources(ctx),
    gitTagSource(ctx),
  ])

  const wrapper = await nearestFile(ctx, '.mvn/wrapper/maven-wrapper.properties')
  const mavenVersion = wrapper ? /apache-maven-(\d[\w.-]*?)-bin\.(?:zip|tar\.gz)/.exec((await readText(wrapper)) ?? '')?.[1] : undefined

  const runtime = await resolveRuntime(ctx, 'java runtime (maven)', (level) =>
    javaRuntimeChain(level, level === dir ? [() => mavenJavaRuntime(dir, pom, properties)] : [() => mavenJavaRuntime(level, chain.find((p) => p.dir === level), properties)]),
  )

  const installRoot = root?.dir ?? dir
  // dependency:go-offline cannot resolve sibling modules of a reactor build that were never installed,
  // so multi-module builds get no install command.
  const multiModule = !!root || pom.modules.length > 0
  const mvn = (await isFile(path.join(installRoot, 'mvnw'))) ? './mvnw' : 'mvn'

  return {
    language: 'java',
    name: pom.artifactId ?? '',
    version: version?.value ?? '',
    versionSource: version?.source ?? '',
    packageManager: 'maven',
    packageManagerVersion: mavenVersion ?? '',
    ...runtimeFields(dir, runtime),
    manifest: 'pom.xml',
    lockfile: '',
    workspaceRoot: relPosix(dir, installRoot),
    installCommand: multiModule ? '' : `${mvn} -B dependency:go-offline`,
    cacheDependencyPath: '',
  }
}

// ---------------------------------------------------------------------------------------------------
// Gradle

const BUILD_FILES = ['build.gradle.kts', 'build.gradle']
const SETTINGS_FILES = ['settings.gradle.kts', 'settings.gradle']

/** Project paths of `include(...)` / `include ':a', ':b'` in a settings file: `:core:data` → `core/data`. */
export function parseGradleIncludes(settings: string): string[] {
  const text = settings.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
  const result: string[] = []
  for (const match of text.matchAll(/\binclude\s*\(([^)]*)\)|\binclude\s+((?:["'][^"'\n]+["']\s*,?\s*)+)/g)) {
    for (const [, item] of (match[1] ?? match[2] ?? '').matchAll(/["']([^"']+)["']/g)) {
      result.push(item!.replace(/^:/, '').replace(/:/g, '/'))
    }
  }
  return result
}

interface GradleRoot {
  dir: string
  settings: string
}

/** The Gradle build root: this directory when it has a settings file, else the nearest parent whose settings include it. */
async function findGradleRoot(ctx: DetectorContext): Promise<GradleRoot | undefined> {
  for (const level of [ctx.dir, ...ancestors(ctx.dir, ctx.boundary ?? ctx.dir)]) {
    const file = await firstExisting(level, SETTINGS_FILES)
    if (!file) continue
    const settings = (await readText(path.join(level, file))) ?? ''
    if (level === ctx.dir || parseGradleIncludes(settings).includes(relPosix(level, ctx.dir))) return { dir: level, settings }
  }
  return undefined
}

function propertiesVersion(text: string | undefined): string | undefined {
  return text ? /^\s*version\s*[=:]\s*(\S.*?)\s*$/m.exec(text)?.[1] : undefined
}

/** `version = "1.2.3"` (Kotlin DSL) or `version '1.2.3'` / `version = '1.2.3'` (Groovy) as the first token on a line. */
function buildFileVersion(text: string | undefined): string | undefined {
  return text ? /^\s*version\s*(?:=\s*)?["']([^"'\n]+)["']/m.exec(text)?.[1] : undefined
}

/** Android `versionName "1.2.3"` + `versionCode 27` → `1.2.3+27` (the same shape as a Flutter version). */
function androidVersion(text: string | undefined): string | undefined {
  const name = text ? /\bversionName\s*(?:=\s*)?["']([^"'\n]+)["']/.exec(text)?.[1] : undefined
  if (!name) return undefined
  const code = /\bversionCode\s*(?:=\s*)?(\d+)\b/.exec(text!)?.[1]
  return code ? `${name}+${code}` : name
}

function gradleJavaRuntime(file: string, text: string | undefined): RuntimeHit | undefined {
  if (!text) return undefined
  const patterns: Array<[RegExp, string]> = [
    [/JavaLanguageVersion\.of\(\s*"?(\d+)"?\s*\)/, 'toolchain'],
    [/\bjvmToolchain\(\s*(\d+)\s*\)/, 'jvmToolchain'],
    [/\bsourceCompatibility\s*=?\s*JavaVersion\.VERSION_(\d+(?:_\d+)?)/, 'sourceCompatibility'],
    [/\bsourceCompatibility\s*=\s*["']?(\d+(?:\.\d+)?)["']?/, 'sourceCompatibility'],
  ]
  for (const [pattern, field] of patterns) {
    const raw = pattern.exec(text)?.[1]
    if (raw) return { value: normalizeJavaVersion(raw.replace(/_/g, '.')), file, field, setupReadable: false }
  }
  return undefined
}

async function detectGradle(ctx: DetectorContext): Promise<Detection> {
  const { dir } = ctx
  const buildFile = await firstExisting(dir, BUILD_FILES)
  const settingsFile = await firstExisting(dir, SETTINGS_FILES)
  const build = buildFile ? await readText(path.join(dir, buildFile)) : undefined
  const root = await findGradleRoot(ctx)
  const rootDir = root?.dir ?? dir
  const rootBuildFile = rootDir === dir ? undefined : await firstExisting(rootDir, BUILD_FILES)
  const rootBuild = rootBuildFile ? await readText(path.join(rootDir, rootBuildFile)) : undefined
  const rootLabel = (file: string) => relPosix(dir, path.join(rootDir, file))

  const rootName = root?.dir === dir ? /rootProject\.name\s*=\s*["']([^"']+)["']/.exec(root.settings)?.[1] : undefined
  const name = rootName ?? path.basename(dir)

  const sources: Source[] = [
    { name: 'gradle.properties:version', read: async () => versionHit(propertiesVersion(await readText(path.join(dir, 'gradle.properties'))), 'gradle.properties:version') },
    { name: `${buildFile ?? 'build file'}:version`, read: () => (buildFile ? versionHit(buildFileVersion(build), `${buildFile}:version`) : undefined) },
    { name: `${buildFile ?? 'build file'}:versionName`, read: () => (buildFile ? versionHit(androidVersion(build), `${buildFile}:versionName`) : undefined) },
  ]
  if (rootDir !== dir) {
    sources.push(
      {
        name: 'root gradle.properties:version',
        read: async () => versionHit(propertiesVersion(await readText(path.join(rootDir, 'gradle.properties'))), `${rootLabel('gradle.properties')}:version`),
      },
      { name: 'root build file version', read: () => (rootBuildFile ? versionHit(buildFileVersion(rootBuild), `${rootLabel(rootBuildFile)}:version`) : undefined) },
    )
  }
  const version = await resolveFirst(ctx, 'java version', [...sources, ...releaseToolSources(ctx), gitTagSource(ctx)])

  const wrapper = await nearestFile(ctx, 'gradle/wrapper/gradle-wrapper.properties')
  const gradleVersion = wrapper ? /gradle-(\d[\w.-]*?)-(?:bin|all)\.zip/.exec((await readText(wrapper)) ?? '')?.[1] : undefined

  const runtime = await resolveRuntime(ctx, 'java runtime (gradle)', (level) =>
    javaRuntimeChain(
      level,
      level === dir
        ? [() => (buildFile ? gradleJavaRuntime(path.join(dir, buildFile), build) : undefined)]
        : level === rootDir && rootBuildFile
          ? [() => gradleJavaRuntime(path.join(rootDir, rootBuildFile), rootBuild)]
          : [],
    ),
  )

  const lockfilePath = [path.join(dir, 'gradle.lockfile'), path.join(rootDir, 'gradle.lockfile')]
  let lockfile = ''
  for (const file of lockfilePath) {
    if (await isFile(file)) {
      lockfile = relPosix(dir, file)
      break
    }
  }

  return {
    language: 'java',
    name,
    version: version?.value ?? '',
    versionSource: version?.source ?? '',
    packageManager: 'gradle',
    packageManagerVersion: gradleVersion ?? '',
    ...runtimeFields(dir, runtime),
    manifest: buildFile ?? settingsFile!,
    lockfile,
    workspaceRoot: relPosix(dir, rootDir),
    // Gradle resolves dependencies as part of the build; there is no separate, reliable install step.
    installCommand: '',
    cacheDependencyPath: '',
  }
}

// ---------------------------------------------------------------------------------------------------

/** JVM builds (Java, Kotlin, Groovy, Scala on Maven or Gradle). A directory with both is reported as Maven. */
export const javaDetector: Detector = {
  language: 'java',
  async detect(ctx: DetectorContext): Promise<Detection | undefined> {
    const pom = await readPom(ctx.dir)
    if (pom) return detectMaven(ctx, pom)
    if (await firstExisting(ctx.dir, [...BUILD_FILES, ...SETTINGS_FILES])) return detectGradle(ctx)
    return undefined
  },
}
