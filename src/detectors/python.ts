import * as path from 'node:path'
import { parse as parseToml } from 'smol-toml'
import type { Detection, Detector, DetectorContext, PackageManager } from '../types.js'
import { firstExisting, isFile, readText, readVersionFile, walkFiles } from '../utils/fs.js'
import { parseIni } from '../utils/ini.js'
import { miseRuntime, toolVersionsRuntime, versionFileRuntime } from '../utils/runtime.js'
import { cleanVersion, extractAssignedVersion, gitDescribeTag } from '../utils/version.js'

type PythonPackageManager = Extract<PackageManager, 'pip' | 'poetry' | 'pipenv' | 'uv' | 'pdm' | 'hatch'>

type Table = Record<string, unknown>

const MANIFESTS = ['pyproject.toml', 'setup.cfg', 'setup.py', 'Pipfile', 'requirements.txt'] as const

/** Lockfiles in priority order — the first one found wins. */
const LOCKFILES: ReadonlyArray<{ file: string; pm: PythonPackageManager }> = [
  { file: 'uv.lock', pm: 'uv' },
  { file: 'poetry.lock', pm: 'poetry' },
  { file: 'pdm.lock', pm: 'pdm' },
  { file: 'Pipfile.lock', pm: 'pipenv' },
]

const VERSION_FILES = ['VERSION', 'VERSION.txt', 'version.txt']

function table(value: unknown): Table | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Table) : undefined
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
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

/** Scans conventional locations (`pkg/__init__.py`, `src/pkg/_version.py`, ...) for a `__version__` assignment. */
async function scanForDunderVersion(dir: string, projectName: string): Promise<{ version: string; source: string } | undefined> {
  const moduleNames = projectName ? [projectName.replace(/-/g, '_').toLowerCase(), projectName.toLowerCase()] : []
  const fileNames = ['__init__.py', '__about__.py', '_version.py', 'version.py', '__version__.py']
  const candidates: string[] = []
  for (const mod of moduleNames) {
    for (const root of ['src', '']) {
      for (const file of fileNames) candidates.push(path.join(root, mod, file))
    }
  }
  for (const candidate of candidates) {
    const source = await readText(path.join(dir, candidate))
    const v = source !== undefined ? extractAssignedVersion(source, ['__version__']) : undefined
    if (v) return { version: v, source: candidate }
  }
  // Generic fallback: shallow walk for any version-ish module.
  const files = (await walkFiles(dir, { maxDepth: 3 })).filter((f) => fileNames.includes(path.basename(f)))
  files.sort((a, b) => a.split(path.sep).length - b.split(path.sep).length || a.localeCompare(b))
  for (const file of files) {
    const source = await readText(path.join(dir, file))
    const v = source !== undefined ? extractAssignedVersion(source, ['__version__']) : undefined
    if (v) return { version: v, source: file }
  }
  return undefined
}

function detectPackageManager(
  pyproject: Pyproject | undefined,
  lockfile: string,
  manifests: Set<string>,
): { pm: PythonPackageManager; version: string } {
  const tool = pyproject?.tool

  const lock = LOCKFILES.find((l) => l.file === lockfile)
  if (lock) return { pm: lock.pm, version: '' }

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

async function pythonVersion(dir: string, pyproject: Pyproject | undefined, setupCfg: Record<string, Record<string, string>>): Promise<string> {
  const fromFile = await versionFileRuntime(dir, ['.python-version'])
  if (fromFile) return fromFile

  const requiresPython = str(pyproject?.project?.['requires-python'])
  if (requiresPython) return requiresPython.trim()

  const poetryPython = get(pyproject?.tool, 'poetry', 'dependencies', 'python')
  if (typeof poetryPython === 'string') return poetryPython.trim()

  const pipfile = await readText(path.join(dir, 'Pipfile'))
  if (pipfile) {
    try {
      const requires = table((parseToml(pipfile) as Table)['requires'])
      const v = str(requires?.['python_full_version']) ?? str(requires?.['python_version'])
      if (v) return v
    } catch {
      // ignore malformed Pipfile
    }
  }

  const pythonRequires = setupCfg['options']?.['python_requires']
  if (pythonRequires) return pythonRequires

  const runtimeTxt = await readVersionFile(path.join(dir, 'runtime.txt'))
  const runtimeMatch = runtimeTxt ? /^python-?(.+)$/i.exec(runtimeTxt) : null
  if (runtimeMatch?.[1]) return runtimeMatch[1]

  return (await toolVersionsRuntime(dir, 'python')) ?? (await miseRuntime(dir, 'python')) ?? ''
}

export const pythonDetector: Detector = {
  language: 'python',
  async detect({ dir }: DetectorContext): Promise<Detection | undefined> {
    const present = new Set<string>()
    for (const m of MANIFESTS) if (await isFile(path.join(dir, m))) present.add(m)
    const manifest = MANIFESTS.find((m) => present.has(m))
    if (!manifest) return undefined

    const pyproject = await readPyproject(dir)
    const setupCfgText = present.has('setup.cfg') ? await readText(path.join(dir, 'setup.cfg')) : undefined
    const setupCfg = setupCfgText ? parseIni(setupCfgText) : {}
    const setupPy = present.has('setup.py') ? await readText(path.join(dir, 'setup.py')) : undefined

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
    const lockfile = (await firstExisting(dir, LOCKFILES.map((l) => l.file))) ?? ''
    const pmInfo = detectPackageManager(pyproject, lockfile, present)
    let packageManagerVersion = pmInfo.version
    if (pmInfo.pm === 'poetry' && !packageManagerVersion) packageManagerVersion = await poetryLockVersion(dir)
    if (pmInfo.pm === 'uv' && !packageManagerVersion) packageManagerVersion = str(get(pyproject?.tool, 'uv', 'required-version')) ?? ''
    if (pmInfo.pm === 'poetry' && !packageManagerVersion) packageManagerVersion = str(get(pyproject?.tool, 'poetry', 'requires-poetry')) ?? ''

    return {
      language: 'python',
      name,
      version,
      versionSource,
      packageManager: pmInfo.pm,
      packageManagerVersion,
      languageVersion: await pythonVersion(dir, pyproject, setupCfg),
      manifest,
      lockfile,
    }
  },
}
