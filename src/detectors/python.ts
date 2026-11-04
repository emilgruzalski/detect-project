import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { parse as parseToml } from 'smol-toml'
import type { Detection, Detector, DetectorContext, PackageManager } from '../types.js'
import { ancestors, firstExisting, isFile, readText, readVersionFile, relPosix } from '../utils/fs.js'
import { parseIni } from '../utils/ini.js'
import { miseRuntime, resolveRuntime, runtimeFields, toolVersionsRuntime, versionFileRuntime, type RuntimeCandidate, type RuntimeHit } from '../utils/runtime.js'
import { cleanVersion, extractAssignedVersion, gitDescribeTag } from '../utils/version.js'
import { matchesWorkspacePatterns } from '../utils/workspace.js'

type PythonPackageManager = Extract<PackageManager, 'pip' | 'poetry' | 'pipenv' | 'uv' | 'pdm' | 'hatch'>

type Table = Record<string, unknown>

const MANIFESTS = ['pyproject.toml', 'setup.cfg', 'setup.py', 'Pipfile', 'requirements.txt'] as const

/** Lockfiles in priority order — the first one found wins. `pylock.toml` (PEP 751) is tool-agnostic. */
const LOCKFILES: ReadonlyArray<{ file: string; pm?: PythonPackageManager }> = [
  { file: 'uv.lock', pm: 'uv' },
  { file: 'poetry.lock', pm: 'poetry' },
  { file: 'pdm.lock', pm: 'pdm' },
  { file: 'Pipfile.lock', pm: 'pipenv' },
  { file: 'pylock.toml' },
]

/** PEP 751 named lock files: `pylock.<name>.toml` (the name contains no dots). */
const NAMED_PYLOCK = /^pylock\.[^.]+\.toml$/

const VERSION_FILES = ['VERSION', 'VERSION.txt', 'version.txt']

/** Version-module file names checked inside a package directory. */
const VERSION_MODULES = ['__init__.py', '__about__.py', '_version.py', 'version.py', '__version__.py']

/** Top-level directories that are never the project's own package (tests, docs, vendored code, ...). */
const NON_PROJECT_DIRS = new Set([
  'src',
  'test',
  'tests',
  'testing',
  'doc',
  'docs',
  'example',
  'examples',
  'script',
  'scripts',
  'tools',
  'benchmark',
  'benchmarks',
  'third_party',
  'thirdparty',
  'vendor',
  'vendored',
  '_vendor',
  'external',
  'build',
  'dist',
  'site-packages',
  'node_modules',
  'migrations',
])

function table(value: unknown): Table | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Table) : undefined
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
}

function get(root: Table | undefined, ...keys: string[]): unknown {
  let current: unknown = root
  for (const key of keys) {
    current = table(current)?.[key]
    if (current === undefined) return undefined
  }
  return current
}

interface Pyproject {
  raw: Table
  project?: Table
  tool?: Table
  buildSystem?: Table
}

async function readPyproject(dir: string): Promise<Pyproject | undefined> {
  const text = await readText(path.join(dir, 'pyproject.toml'))
  if (text === undefined) return undefined
  let raw: Table
  try {
    raw = parseToml(text) as Table
  } catch {
    raw = {}
  }
  return {
    raw,
    project: table(raw['project']),
    tool: table(raw['tool']),
    buildSystem: table(raw['build-system']),
  }
}

/** Resolves `pkg.sub.__version__` (setuptools `attr:`) to the file that defines it and reads the version. */
async function versionFromAttr(dir: string, attr: string, pyproject?: Pyproject): Promise<string | undefined> {
  const parts = attr.split('.')
  const identifier = parts.pop()
  if (!identifier || parts.length === 0) return undefined
  const modulePath = parts.join('/')
  const roots = ['', 'src']
  const packageDir = table(get(pyproject?.tool, 'setuptools', 'package-dir'))
  const mappedRoot = str(packageDir?.[''])
  if (mappedRoot) roots.unshift(mappedRoot)
  for (const root of roots) {
    for (const candidate of [`${modulePath}.py`, `${modulePath}/__init__.py`]) {
      const source = await readText(path.join(dir, root, candidate))
      if (source === undefined) continue
      const found = extractAssignedVersion(source, [identifier])
      if (found) return found
    }
  }
  return undefined
}

async function versionFromFileSetting(dir: string, file: unknown): Promise<string | undefined> {
  const files = Array.isArray(file) ? file.filter((f): f is string => typeof f === 'string') : str(file) ? [file as string] : []
  for (const f of files) {
    const value = await readVersionFile(path.join(dir, f))
    if (value) return cleanVersion(value)
  }
  return undefined
}

/** Handles `[project] dynamic = ["version"]` by inspecting the build backend's configuration. */
async function dynamicVersion(
  dir: string,
  pyproject: Pyproject,
): Promise<{ version: string; source: string } | undefined> {
  const tool = pyproject.tool

  // setuptools: [tool.setuptools.dynamic] version = {attr = "pkg.__version__"} | {file = "VERSION"}
  const setuptoolsDynamic = table(get(tool, 'setuptools', 'dynamic', 'version'))
  if (setuptoolsDynamic) {
    const attr = str(setuptoolsDynamic['attr'])
    if (attr) {
      const v = await versionFromAttr(dir, attr, pyproject)
      if (v) return { version: v, source: `pyproject.toml:tool.setuptools.dynamic (${attr})` }
    }
    const v = await versionFromFileSetting(dir, setuptoolsDynamic['file'])
    if (v) return { version: v, source: 'pyproject.toml:tool.setuptools.dynamic (file)' }
  }

  // hatch: [tool.hatch.version] path = "src/pkg/__about__.py" (source = "vcs" → git)
  const hatchVersion = table(get(tool, 'hatch', 'version'))
  if (hatchVersion) {
    const file = str(hatchVersion['path'])
    if (file) {
      const source = await readText(path.join(dir, file))
      const v = source !== undefined ? extractAssignedVersion(source, ['__version__', 'VERSION', 'version']) : undefined
      if (v) return { version: v, source: file }
    }
  }

  // pdm: [tool.pdm.version] source = "file", path = "pkg/__init__.py" (source = "scm" → git)
  const pdmVersion = table(get(tool, 'pdm', 'version'))
  if (pdmVersion && str(pdmVersion['source']) === 'file') {
    const file = str(pdmVersion['path'])
    const source = file ? await readText(path.join(dir, file)) : undefined
    const v = source !== undefined ? extractAssignedVersion(source, ['__version__']) : undefined
    if (v && file) return { version: v, source: file }
  }

  // flit: [tool.flit.module] name = "pkg" → reads pkg/__init__.py __version__
  const flitModule = str(get(tool, 'flit', 'module', 'name'))
  if (flitModule) {
    const v = await versionFromAttr(dir, `${flitModule}.__version__`, pyproject)
    if (v) return { version: v, source: `${flitModule}/__init__.py` }
  }

  return undefined
}

/** True when the project derives its version from git (setuptools-scm, hatch-vcs, pdm scm, poetry-dynamic-versioning). */
function usesScmVersioning(pyproject: Pyproject | undefined): boolean {
  if (!pyproject) return false
  const tool = pyproject.tool
  if (get(tool, 'setuptools_scm') !== undefined) return true
  if (get(tool, 'poetry-dynamic-versioning') !== undefined) return true
  if (str(get(tool, 'hatch', 'version', 'source')) === 'vcs') return true
  if (str(get(tool, 'pdm', 'version', 'source')) === 'scm') return true
  const requires = pyproject.buildSystem?.['requires']
  if (Array.isArray(requires)) {
    return requires.some((r) => typeof r === 'string' && /^(setuptools[-_]scm|hatch-vcs|versioningit)\b/i.test(r))
  }
  return false
}

/** Importable package directories directly in the project root or in `src/`, minus tests, docs, vendored code, .... */
async function topLevelPackages(dir: string): Promise<string[]> {
  const found: string[] = []
  for (const root of ['src', '']) {
    let entries: import('node:fs').Dirent[]
    try {
      entries = await fs.readdir(path.join(dir, root), { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(entry.name)) continue
      if (NON_PROJECT_DIRS.has(entry.name.toLowerCase())) continue
      if (await isFile(path.join(dir, root, entry.name, '__init__.py'))) found.push(root ? `${root}/${entry.name}` : entry.name)
    }
  }
  return found.sort()
}

/**
 * Looks for a `__version__` assignment in the project's own package: the module named after the project
 * (`my-app` → `my_app`), otherwise the only top-level package in the root or `src/`. Several candidate
 * packages make the guess ambiguous, so nothing is reported then — better no version than another
 * package's (e.g. a vendored library's) version.
 */
async function scanForDunderVersion(dir: string, projectName: string): Promise<{ version: string; source: string } | undefined> {
  const named = projectName ? [...new Set([projectName.replace(/[-.]/g, '_').toLowerCase(), projectName.toLowerCase()])] : []
  const packageDirs: string[] = []
  for (const mod of named) for (const root of ['src', '']) packageDirs.push(root ? `${root}/${mod}` : mod)
  const packages = await topLevelPackages(dir)
  if (packages.length === 1) packageDirs.push(packages[0]!)

  for (const pkgDir of packageDirs) {
    for (const file of VERSION_MODULES) {
      const candidate = `${pkgDir}/${file}`
      const source = await readText(path.join(dir, candidate))
      const v = source !== undefined ? extractAssignedVersion(source, ['__version__']) : undefined
      if (v) return { version: v, source: candidate }
    }
  }
  return undefined
}

async function findLockfile(dir: string): Promise<string | undefined> {
  const fixed = await firstExisting(dir, LOCKFILES.map((l) => l.file))
  if (fixed) return fixed
  let entries: string[]
  try {
    entries = await fs.readdir(dir)
  } catch {
    return undefined
  }
  for (const entry of entries.filter((e) => NAMED_PYLOCK.test(e)).sort()) {
    if (await isFile(path.join(dir, entry))) return entry
  }
  return undefined
}

interface UvWorkspace {
  dir: string
  pyproject: Pyproject
}

/** Nearest parent directory whose `[tool.uv.workspace]` lists `dir` in `members` (and not in `exclude`). */
async function findUvWorkspace({ dir, boundary }: DetectorContext): Promise<UvWorkspace | undefined> {
  for (const level of ancestors(dir, boundary ?? dir)) {
    const pyproject = await readPyproject(level)
    const workspace = table(get(pyproject?.tool, 'uv', 'workspace'))
    if (!pyproject || !workspace) continue
    const rel = relPosix(level, dir)
    if (matchesWorkspacePatterns(strings(workspace['members']), rel) && !matchesWorkspacePatterns(strings(workspace['exclude']), rel)) {
      return { dir: level, pyproject }
    }
  }
  return undefined
}

function detectPackageManager(
  pyproject: Pyproject | undefined,
  lockfile: string,
  manifests: Set<string>,
  uvWorkspace: UvWorkspace | undefined,
): { pm: PythonPackageManager; version: string } {
  const tool = pyproject?.tool

  const lock = LOCKFILES.find((l) => l.file === path.posix.basename(lockfile))
  if (lock?.pm) return { pm: lock.pm, version: '' }
  if (uvWorkspace) return { pm: 'uv', version: '' }

  if (get(tool, 'uv') !== undefined) return { pm: 'uv', version: str(get(tool, 'uv', 'required-version')) ?? '' }
  if (get(tool, 'poetry') !== undefined) return { pm: 'poetry', version: str(get(tool, 'poetry', 'requires-poetry')) ?? '' }
  if (get(tool, 'pdm') !== undefined) return { pm: 'pdm', version: '' }
  if (get(tool, 'hatch', 'envs') !== undefined) return { pm: 'hatch', version: '' }

  const backend = str(pyproject?.buildSystem?.['build-backend']) ?? ''
  if (/^poetry(\.core)?\.masonry/.test(backend) || backend === 'poetry.core.masonry.api') return { pm: 'poetry', version: '' }
  if (/^pdm\./.test(backend)) return { pm: 'pdm', version: '' }

  if (manifests.has('Pipfile')) return { pm: 'pipenv', version: '' }
  return { pm: 'pip', version: '' }
}

async function poetryLockVersion(dir: string): Promise<string> {
  const text = await readText(path.join(dir, 'poetry.lock'))
  const match = text ? /@generated by Poetry (\S+?)(?:\s|$)/.exec(text) : null
  return match?.[1] ?? ''
}

/** PEP 508 project name. Anything else is not put into a shell command. */
const VALID_PROJECT_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/

function installCommand(pm: PythonPackageManager, lockfile: string, manifests: Set<string>, uvMember: string | undefined): string {
  const lock = path.posix.basename(lockfile)
  switch (pm) {
    case 'uv': {
      const base = lock === 'uv.lock' ? 'uv sync --locked' : 'uv sync'
      return uvMember && VALID_PROJECT_NAME.test(uvMember) ? `${base} --package ${uvMember}` : base
    }
    case 'poetry':
      return 'poetry install'
    case 'pdm':
      return lock === 'pdm.lock' ? 'pdm sync' : 'pdm install'
    case 'hatch':
      return 'hatch env create'
    case 'pipenv':
      return lock === 'Pipfile.lock' ? 'pipenv install --deploy' : 'pipenv install'
    case 'pip':
      if (manifests.has('requirements.txt')) return 'pip install -r requirements.txt'
      return manifests.has('pyproject.toml') || manifests.has('setup.py') || manifests.has('setup.cfg') ? 'pip install .' : ''
  }
}

/**
 * Python version declared in pyproject.toml. setup-python reads `project.requires-python` when a
 * `[project]` table exists and Poetry's `python` dependency only when it does not.
 */
function pyprojectRuntime(dir: string, pyproject: Pyproject | undefined): RuntimeHit | undefined {
  if (!pyproject) return undefined
  const file = path.join(dir, 'pyproject.toml')
  const requiresPython = str(pyproject.project?.['requires-python'])?.trim()
  if (requiresPython) return { value: requiresPython, file, field: 'project.requires-python', setupReadable: true }
  const poetryPython = str(get(pyproject.tool, 'poetry', 'dependencies', 'python'))?.trim()
  if (poetryPython) {
    return { value: poetryPython, file, field: 'tool.poetry.dependencies.python', setupReadable: !('project' in pyproject.raw) }
  }
  return undefined
}

async function pipfileRuntime(dir: string): Promise<RuntimeHit | undefined> {
  const file = path.join(dir, 'Pipfile')
  const pipfile = await readText(file)
  if (!pipfile) return undefined
  try {
    const requires = table((parseToml(pipfile) as Table)['requires'])
    for (const key of ['python_full_version', 'python_version']) {
      const v = str(requires?.[key])
      if (v) return { value: v, file, field: `requires.${key}`, setupReadable: true }
    }
  } catch {
    // ignore malformed Pipfile
  }
  return undefined
}

async function runtimeTxt(dir: string): Promise<RuntimeHit | undefined> {
  const file = path.join(dir, 'runtime.txt')
  const value = await readVersionFile(file)
  const match = value ? /^python-?(.+)$/i.exec(value) : null
  return match?.[1] ? { value: match[1], file, field: '', setupReadable: false } : undefined
}

export const pythonDetector: Detector = {
  language: 'python',
  async detect(ctx: DetectorContext): Promise<Detection | undefined> {
    const { dir } = ctx
    const present = new Set<string>()
    for (const m of MANIFESTS) if (await isFile(path.join(dir, m))) present.add(m)
    const manifest = MANIFESTS.find((m) => present.has(m))
    if (!manifest) return undefined

    const pyproject = await readPyproject(dir)
    const setupCfgText = present.has('setup.cfg') ? await readText(path.join(dir, 'setup.cfg')) : undefined
    const setupCfg = setupCfgText ? parseIni(setupCfgText) : {}
    const setupPy = present.has('setup.py') ? await readText(path.join(dir, 'setup.py')) : undefined
    const uvWorkspace = await findUvWorkspace(ctx)

    // --- name ---
    const name =
      str(pyproject?.project?.['name']) ??
      str(get(pyproject?.tool, 'poetry', 'name')) ??
      setupCfg['metadata']?.['name'] ??
      (setupPy ? /\bname\s*=\s*["']([^"']+)["']/.exec(setupPy)?.[1] : undefined) ??
      ''

    // --- version ---
    let version = ''
    let versionSource = ''
    const setVersion = (v: string | undefined, source: string): boolean => {
      if (!v) return false
      version = cleanVersion(v)
      versionSource = source
      return true
    }

    const projectVersion = str(pyproject?.project?.['version'])
    const dynamic = pyproject?.project?.['dynamic']
    const isDynamic = Array.isArray(dynamic) && dynamic.includes('version')

    if (projectVersion) {
      setVersion(projectVersion, 'pyproject.toml:project.version')
    } else if (setVersion(str(get(pyproject?.tool, 'poetry', 'version')), 'pyproject.toml:tool.poetry.version')) {
      // poetry
    } else if (pyproject && isDynamic) {
      const dyn = await dynamicVersion(dir, pyproject)
      if (dyn) setVersion(dyn.version, dyn.source)
    }

    if (!version && setupCfg['metadata']?.['version']) {
      const raw = setupCfg['metadata']['version']
      const attr = /^attr:\s*(.+)$/.exec(raw)?.[1]?.trim()
      const file = /^file:\s*(.+)$/.exec(raw)?.[1]?.trim()
      if (attr) setVersion(await versionFromAttr(dir, attr, pyproject), `setup.cfg:metadata.version (${attr})`)
      else if (file) setVersion(await versionFromFileSetting(dir, file.split(/\s*,\s*/)), `setup.cfg:metadata.version (${file})`)
      else setVersion(raw, 'setup.cfg:metadata.version')
    }

    if (!version && setupPy) {
      setVersion(/\bversion\s*=\s*["']([^"']+)["']/.exec(setupPy)?.[1], 'setup.py')
    }

    if (!version) {
      const versionFile = await firstExisting(dir, VERSION_FILES)
      if (versionFile) setVersion(await readVersionFile(path.join(dir, versionFile)), versionFile)
    }

    if (!version) {
      const scanned = await scanForDunderVersion(dir, name)
      if (scanned) setVersion(scanned.version, scanned.source)
    }

    if (!version && (usesScmVersioning(pyproject) || isDynamic)) {
      setVersion(await gitDescribeTag(dir), 'git-tag')
    }

    // --- package manager ---
    // Workspace members share the workspace root's lockfile.
    const ownLock = await findLockfile(dir)
    const rootLock = !ownLock && uvWorkspace && (await isFile(path.join(uvWorkspace.dir, 'uv.lock'))) ? path.join(uvWorkspace.dir, 'uv.lock') : undefined
    const lockfile = ownLock ?? (rootLock ? relPosix(dir, rootLock) : '')
    const pmInfo = detectPackageManager(pyproject, lockfile, present, uvWorkspace)
    let packageManagerVersion = pmInfo.version
    if (pmInfo.pm === 'poetry' && !packageManagerVersion) packageManagerVersion = await poetryLockVersion(dir)
    if (pmInfo.pm === 'uv' && !packageManagerVersion) {
      packageManagerVersion =
        str(get(pyproject?.tool, 'uv', 'required-version')) ?? str(get(uvWorkspace?.pyproject.tool, 'uv', 'required-version')) ?? ''
    }
    if (pmInfo.pm === 'poetry' && !packageManagerVersion) packageManagerVersion = str(get(pyproject?.tool, 'poetry', 'requires-poetry')) ?? ''

    // --- runtime ---
    const runtime = await resolveRuntime(ctx, (level): RuntimeCandidate[] =>
      level === dir
        ? [
            () => versionFileRuntime(level, ['.python-version']),
            () => pyprojectRuntime(level, pyproject),
            () => pipfileRuntime(level),
            () => {
              const v = setupCfg['options']?.['python_requires']
              return v ? { value: v, file: path.join(level, 'setup.cfg'), field: 'options.python_requires', setupReadable: false } : undefined
            },
            () => runtimeTxt(level),
            () => toolVersionsRuntime(level, 'python'),
            () => miseRuntime(level, 'python'),
          ]
        : [
            () => versionFileRuntime(level, ['.python-version']),
            () => (level === uvWorkspace?.dir ? pyprojectRuntime(level, uvWorkspace.pyproject) : undefined),
            () => toolVersionsRuntime(level, 'python'),
            () => miseRuntime(level, 'python'),
          ],
    )

    const installRoot = uvWorkspace?.dir ?? dir
    const cacheDependencyPath = lockfile || (present.has('requirements.txt') ? 'requirements.txt' : manifest)

    return {
      language: 'python',
      name,
      version,
      versionSource,
      packageManager: pmInfo.pm,
      packageManagerVersion,
      ...runtimeFields(dir, runtime),
      manifest,
      lockfile,
      workspaceRoot: relPosix(dir, installRoot),
      installCommand: installCommand(pmInfo.pm, lockfile, present, uvWorkspace && name ? name : undefined),
      cacheDependencyPath,
    }
  },
}
