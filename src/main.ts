import * as path from 'node:path'
import * as core from '@actions/core'
import { detectProject } from './detect.js'
import { isLanguage, languages } from './detectors/index.js'
import type { Detection } from './types.js'

const OUTPUT_KEYS: ReadonlyArray<[output: string, key: keyof Detection]> = [
  ['language', 'language'],
  ['name', 'name'],
  ['version', 'version'],
  ['version-source', 'versionSource'],
  ['package-manager', 'packageManager'],
  ['package-manager-version', 'packageManagerVersion'],
  ['language-version', 'languageVersion'],
  ['manifest', 'manifest'],
  ['lockfile', 'lockfile'],
]

function emptyDetection(): Record<keyof Detection, string> {
  return {
    language: 'unknown',
    name: '',
    version: '',
    versionSource: '',
    packageManager: '',
    packageManagerVersion: '',
    languageVersion: '',
    manifest: '',
    lockfile: '',
  }
}

async function writeSummary(all: Detection[], primary: Detection | undefined, dir: string): Promise<void> {
  const summary = core.summary.addHeading('Project detection', 2).addRaw(`Inspected directory: <code>${dir}</code>\n\n`)
  if (all.length === 0) {
    summary.addRaw('No supported project (Node.js, Python, Go) was found.\n')
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
      ...all.map((d) => [
        d === primary ? `<strong>${d.language}</strong> (primary)` : d.language,
        d.name || '—',
        d.version || '—',
        d.versionSource || '—',
        d.packageManagerVersion ? `${d.packageManager} ${d.packageManagerVersion}` : d.packageManager,
        d.languageVersion || '—',
        d.manifest,
        d.lockfile || '—',
      ]),
    ])
  }
  await summary.write()
}

export async function run(): Promise<void> {
  const workingDirectory = core.getInput('working-directory') || '.'
  const languageInput = (core.getInput('language') || 'auto').trim().toLowerCase()
  const failOnUnknown = core.getBooleanInput('fail-on-unknown')

  const dir = path.resolve(process.env['GITHUB_WORKSPACE'] ?? process.cwd(), workingDirectory)

  let forced: (typeof languages)[number] | undefined
  if (languageInput !== 'auto') {
    if (!isLanguage(languageInput)) {
      throw new Error(`Unsupported language "${languageInput}". Expected one of: auto, ${languages.join(', ')}`)
    }
    forced = languageInput
  }

  core.info(`Inspecting ${dir}${forced ? ` (language forced to ${forced})` : ''}`)
  const { primary, all } = await detectProject(dir, forced)

  if (all.length > 1) {
    core.warning(
      `Multiple languages detected (${all.map((d) => d.language).join(', ')}); using "${primary?.language}" as primary. ` +
        'Set the "language" input to choose explicitly.',
    )
  }

  const values: Record<keyof Detection, string> = primary ? { ...primary } : emptyDetection()
  for (const [output, key] of OUTPUT_KEYS) core.setOutput(output, values[key])
  core.setOutput('languages', JSON.stringify(all))

  if (primary) {
    core.info(
      `Detected ${primary.language} project "${primary.name || '(unnamed)'}" ` +
        `version ${primary.version || '(unknown)'} using ${primary.packageManager}` +
        `${primary.packageManagerVersion ? ` ${primary.packageManagerVersion}` : ''}` +
        `${primary.languageVersion ? ` (runtime ${primary.languageVersion})` : ''}`,
    )
    if (!primary.version) core.warning(`Could not determine the application version for ${primary.manifest}`)
  }

  await writeSummary(all, primary, dir)

  if (!primary) {
    const message = `No supported project found in ${dir} (looked for Node.js, Python and Go manifests)`
    if (failOnUnknown) throw new Error(message)
    core.warning(message)
  }
}

run().catch((error: unknown) => {
  core.setFailed(error instanceof Error ? error.message : String(error))
})
