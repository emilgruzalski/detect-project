import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as core from '@actions/core'
import { detectProject } from './detect.js'
import { isLanguage, languages } from './detectors/index.js'
import { discoverProjects } from './discover.js'
import type { Detection, Language } from './types.js'
import { relPosix } from './utils/fs.js'
import { splitVersion } from './utils/version.js'

/**
 * One detection as exposed by the action (step outputs and the `languages` JSON).
 *
 * `manifest` and `lockfile` stay relative to `working-directory`; `workspaceRoot`, `languageVersionFile`
 * and `cacheDependencyPath` are relative to the workspace (repository) root, so they can be passed
 * straight to `working-directory:` / `*-version-file:` / `cache-dependency-path:` of later steps.
 */
export interface Result extends Detection {
  versionMajor: string
  versionMinor: string
  versionPatch: string
  versionPrerelease: string
  versionBuild: string
  isPrerelease: boolean
}

const OUTPUT_KEYS: ReadonlyArray<[output: string, key: keyof Result]> = [
  ['language', 'language'],
  ['name', 'name'],
  ['version', 'version'],
  ['version-source', 'versionSource'],
  ['version-major', 'versionMajor'],
  ['version-minor', 'versionMinor'],
  ['version-patch', 'versionPatch'],
  ['version-prerelease', 'versionPrerelease'],
  ['version-build', 'versionBuild'],
  ['is-prerelease', 'isPrerelease'],
  ['package-manager', 'packageManager'],
  ['package-manager-version', 'packageManagerVersion'],
  ['language-version', 'languageVersion'],
  ['language-version-source', 'languageVersionSource'],
  ['language-version-file', 'languageVersionFile'],
  ['manifest', 'manifest'],
  ['lockfile', 'lockfile'],
  ['workspace-root', 'workspaceRoot'],
  ['install-command', 'installCommand'],
  ['cache-dependency-path', 'cacheDependencyPath'],
]

function emptyOutputs(): Record<keyof Result, string> {
  return {
    language: 'unknown',
    name: '',
    version: '',
    versionSource: '',
    versionMajor: '',
    versionMinor: '',
    versionPatch: '',
    versionPrerelease: '',
    versionBuild: '',
    isPrerelease: 'false',
    packageManager: '',
    packageManagerVersion: '',
    languageVersion: '',
    languageVersionSource: '',
    languageVersionFile: '',
    manifest: '',
    lockfile: '',
    workspaceRoot: '',
    installCommand: '',
    cacheDependencyPath: '',
  }
}

/** Adds the version components and rebases the setup-facing paths onto the workspace root. */
export function toResult(detection: Detection, dir: string, workspace: string): Result {
  const rebase = (rel: string): string => (rel ? relPosix(workspace, path.resolve(dir, rel)) : '')
  const parts = splitVersion(detection.version)
  return {
    ...detection,
    workspaceRoot: rebase(detection.workspaceRoot || '.'),
    languageVersionFile: rebase(detection.languageVersionFile),
    cacheDependencyPath: rebase(detection.cacheDependencyPath),
    versionMajor: parts.major,
    versionMinor: parts.minor,
    versionPatch: parts.patch,
    versionPrerelease: parts.prerelease,
    versionBuild: parts.build,
    isPrerelease: parts.isPrerelease,
  }
}

/** Parses `language-priority` (comma, space or newline separated). Unknown names are an error. */
export function parseLanguageList(raw: string, input: string): Language[] {
  const items = raw
    .split(/[\s,]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
  for (const item of items) {
    if (!isLanguage(item)) throw new Error(`Unsupported language "${item}" in ${input}. Expected: ${languages.join(', ')}`)
  }
  return [...new Set(items)] as Language[]
}

/** One entry of the `projects` output: the primary result of a discovered directory. */
export interface ProjectEntry extends Result {
  /** Project directory relative to the workspace root (`.` for the root), usable as `working-directory`. */
  directory: string
  /** Every language detected in the directory, primary first. */
  languages: Language[]
}

/** Escapes text for the HTML job summary; names and versions come from files in the repository. */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
}

/** Splits a comma / newline separated input into trimmed, non-empty items. */
export function parseList(raw: string): string[] {
  return raw
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean)
}

const MAX_DISCOVER_DEPTH = 10

/** Parses `discover-max-depth`: an integer between 0 and 10, 3 when empty. */
export function parseDepth(raw: string): number {
  const value = raw.trim()
  if (!value) return 3
  if (!/^\d+$/.test(value) || Number(value) > MAX_DISCOVER_DEPTH) {
    throw new Error(`discover-max-depth must be an integer between 0 and ${MAX_DISCOVER_DEPTH}, got "${raw}"`)
  }
  return Number(value)
}

async function writeSummary(all: Result[], dir: string, projects: ProjectEntry[] | undefined): Promise<void> {
  // Job summaries are always available on GitHub runners; skip gracefully elsewhere (e.g. @github/local-action).
  if (!process.env['GITHUB_STEP_SUMMARY']) return
  const summary = core.summary.addHeading('Project detection', 2).addRaw(`Inspected directory: <code>${escapeHtml(dir)}</code>\n\n`)
  const cell = (value: string) => (value ? escapeHtml(value) : '—')
  if (all.length === 0) {
    summary.addRaw('No supported project (Node.js, Python, Go) was found in this directory.\n')
  } else {
    summary.addTable([
      [
        { data: 'Language', header: true },
        { data: 'Name', header: true },
        { data: 'Version', header: true },
        { data: 'Version source', header: true },
        { data: 'Package manager', header: true },
        { data: 'Runtime', header: true },
        { data: 'Manifest', header: true },
        { data: 'Lockfile', header: true },
      ],
      ...all.map((d, i) => [
        i === 0 ? `<strong>${d.language}</strong> (primary)` : d.language,
        cell(d.name),
        cell(d.version),
        cell(d.versionSource),
        cell(d.packageManagerVersion ? `${d.packageManager} ${d.packageManagerVersion}` : d.packageManager),
        cell(d.languageVersion ? `${d.languageVersion} (${d.languageVersionSource})` : ''),
        cell(d.manifest),
        cell(d.lockfile),
      ]),
    ])
  }
  if (projects) {
    summary.addHeading(`Discovered projects (${projects.length})`, 3)
    if (projects.length === 0) summary.addRaw('No supported project was found below the inspected directory.\n')
    else
      summary.addTable([
        [
          { data: 'Directory', header: true },
          { data: 'Language', header: true },
          { data: 'Name', header: true },
          { data: 'Version', header: true },
          { data: 'Package manager', header: true },
          { data: 'Install', header: true },
        ],
        ...projects.map((p) => [
          `<code>${escapeHtml(p.directory)}</code>`,
          escapeHtml(p.languages.join(', ')),
          cell(p.name),
          cell(p.version),
          cell(p.packageManagerVersion ? `${p.packageManager} ${p.packageManagerVersion}` : p.packageManager),
          p.installCommand ? `<code>${escapeHtml(p.installCommand)}</code> in <code>${escapeHtml(p.workspaceRoot)}</code>` : '—',
        ]),
      ])
  }
  await summary.write()
}

export async function run(): Promise<void> {
  const workingDirectory = core.getInput('working-directory') || '.'
  const languageInput = (core.getInput('language') || 'auto').trim().toLowerCase()
  const priority = parseLanguageList(core.getInput('language-priority'), 'language-priority')
  const tagPatterns = parseList(core.getInput('tag-pattern'))
  const discover = core.getBooleanInput('discover')
  const maxDepth = parseDepth(core.getInput('discover-max-depth'))
  const exclude = parseList(core.getInput('discover-exclude'))
  const failOnUnknown = core.getBooleanInput('fail-on-unknown')

  const workspace = path.resolve(process.env['GITHUB_WORKSPACE'] ?? process.cwd())
  const dir = path.resolve(workspace, workingDirectory)

  let forced: Language | undefined
  if (languageInput !== 'auto') {
    if (!isLanguage(languageInput)) {
      throw new Error(`Unsupported language "${languageInput}". Expected one of: auto, ${languages.join(', ')}`)
    }
    forced = languageInput
  }

  // A mistyped working-directory must fail loudly, not look like "no project here".
  const stat = await fs.stat(dir).catch(() => undefined)
  if (!stat) throw new Error(`working-directory "${workingDirectory}" does not exist (resolved to ${dir})`)
  if (!stat.isDirectory()) throw new Error(`working-directory "${workingDirectory}" is not a directory (resolved to ${dir})`)

  core.info(`Inspecting ${dir}${forced ? ` (language forced to ${forced})` : ''}`)
  const options = { language: forced, priority, workspace, tagPatterns, debug: (message: string) => core.debug(message) }
  const detected = await detectProject(dir, options)
  const all = detected.all.map((d) => toResult(d, dir, workspace))
  const primary = all[0]

  let projects: ProjectEntry[] | undefined
  if (discover) {
    const found = await discoverProjects(dir, { ...options, maxDepth, exclude })
    projects = found.map(({ dir: projectDir, result }) => ({
      ...toResult(result.primary!, projectDir, workspace),
      directory: relPosix(workspace, projectDir),
      languages: result.all.map((d) => d.language),
    }))
    core.info(`Discovered ${projects.length} project(s) up to ${maxDepth} level(s) below ${dir}: ${projects.map((p) => `${p.directory} (${p.language})`).join(', ') || 'none'}`)
  }
  core.setOutput('projects', JSON.stringify(projects ?? []))

  if (all.length > 1) {
    core.warning(
      `Multiple languages detected (${all.map((d) => d.language).join(', ')}); using "${primary?.language}" as primary. ` +
        'Set the "language" or "language-priority" input to choose explicitly.',
    )
  }

  const values: Record<keyof Result, string> = emptyOutputs()
  if (primary) for (const key of Object.keys(values) as Array<keyof Result>) values[key] = String(primary[key])
  for (const [output, key] of OUTPUT_KEYS) core.setOutput(output, values[key])
  core.setOutput('languages', JSON.stringify(all))

  if (primary) {
    core.info(
      `Detected ${primary.language} project "${primary.name || '(unnamed)'}" ` +
        `version ${primary.version || '(unknown)'} using ${primary.packageManager}` +
        `${primary.packageManagerVersion ? ` ${primary.packageManagerVersion}` : ''}` +
        `${primary.languageVersion ? ` (runtime ${primary.languageVersion} from ${primary.languageVersionSource})` : ''}`,
    )
    if (!primary.version) core.warning(`Could not determine the application version for ${primary.manifest}`)
  }

  await writeSummary(all, dir, projects)

  if (!primary) {
    // With discover, projects below the inspected directory count as "something was found".
    if (projects?.length) {
      core.info(`No supported project in ${dir} itself; see the "projects" output for the ${projects.length} discovered below it`)
      return
    }
    const message = `No supported project found in ${dir}${discover ? ` or up to ${maxDepth} level(s) below it` : ''} (looked for Node.js, Python and Go manifests)`
    if (failOnUnknown) throw new Error(message)
    core.warning(message)
  }
}
