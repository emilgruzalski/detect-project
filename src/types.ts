export type Language = 'node' | 'python' | 'go' | 'rust' | 'dart'

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
  // rust
  | 'cargo'
  // dart
  | 'dart'
  | 'flutter'

/**
 * What a detector reports. Every path is relative to the inspected directory (posix separators) and
 * may point into a parent directory (`../../pnpm-lock.yaml`) for workspace members.
 */
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
  /** Where `languageVersion` came from: file plus field, e.g. `package.json:engines.node`, `../../.nvmrc`. */
  languageVersionSource: string
  /**
   * The file `languageVersion` was read from, but only when the official setup action reads the same
   * value from it through `*-version-file`; empty otherwise (e.g. for `setup.cfg` or `runtime.txt`).
   */
  languageVersionFile: string
  /** Manifest path. */
  manifest: string
  /** Lockfile path, empty when none exists. May live in the workspace root for workspace members. */
  lockfile: string
  /** Directory dependencies are installed from: the workspace root for workspace members, otherwise `.`. */
  workspaceRoot: string
  /** Command that installs the dependencies, meant to run in `workspaceRoot`; empty when there is no safe default. */
  installCommand: string
  /** File(s) whose hash keys a dependency cache (lockfile, or `requirements.txt`/manifest for pip); may be empty. */
  cacheDependencyPath: string
}

export interface DetectorContext {
  /** Absolute path of the directory being inspected. */
  dir: string
  /**
   * Highest directory detectors may look into when searching parents for workspace roots, lockfiles
   * and runtime version files (repository / workspace root). Defaults to `dir`, i.e. no walking up.
   */
  boundary?: string
  /** Root of the git repository containing `dir`, when there is one. */
  gitRoot?: string | undefined
  /** Custom `git describe --match` patterns (the `tag-pattern` input); replaces the built-in release-tag patterns. */
  tagPatterns?: readonly string[] | undefined
  /** Receives one line per resolved value describing which sources were tried (wired to `core.debug`). */
  debug?: ((message: string) => void) | undefined
}

export interface Detector {
  language: Language
  detect(ctx: DetectorContext): Promise<Detection | undefined>
}
