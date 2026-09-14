export type Language = 'node' | 'python' | 'go'

export type PackageManager =
  // node
  | 'npm'
  | 'yarn'
  | 'pnpm'
  | 'bun'
  // python
  | 'pip'
  | 'poetry'
  | 'pipenv'
  | 'uv'
  | 'pdm'
  | 'hatch'
  // go
  | 'go'
  | 'dep'

export interface Detection {
  language: Language
  /** Project name from the manifest (package.json name, pyproject name, go module path). */
  name: string
  /** Application version; empty string when it could not be determined. */
  version: string
  /** Where `version` came from, e.g. `package.json`, `pyproject.toml`, `VERSION`, `git-tag`. */
  versionSource: string
  packageManager: PackageManager
  /** Package manager version when declared somewhere; empty string otherwise. */
  packageManagerVersion: string
  /** Runtime version / constraint (e.g. `.nvmrc`, `requires-python`, go directive). */
  languageVersion: string
  /** Manifest path relative to the inspected directory. */
  manifest: string
  /** Lockfile path relative to the inspected directory, empty when none exists. */
  lockfile: string
}

export interface DetectorContext {
  /** Absolute path of the directory being inspected. */
  dir: string
}

export interface Detector {
  language: Language
  detect(ctx: DetectorContext): Promise<Detection | undefined>
}
