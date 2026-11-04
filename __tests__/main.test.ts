import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, makeProject } from './helpers.js'

// Mock the toolkit so the test can control inputs and observe outputs without a runner.
const core = vi.hoisted(() => {
  const summary = {
    addHeading: vi.fn(),
    addRaw: vi.fn(),
    addTable: vi.fn(),
    write: vi.fn(async () => summary),
  }
  summary.addHeading.mockReturnValue(summary)
  summary.addRaw.mockReturnValue(summary)
  summary.addTable.mockReturnValue(summary)
  return {
    inputs: {} as Record<string, string>,
    getInput: vi.fn((name: string) => core.inputs[name] ?? ''),
    getBooleanInput: vi.fn((name: string) => (core.inputs[name] ?? 'false').toLowerCase() === 'true'),
    setOutput: vi.fn(),
    setFailed: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
    debug: vi.fn(),
    summary,
  }
})
vi.mock('@actions/core', () => core)

import { escapeHtml, parseDepth, parseList, run } from '../src/main.js'
import { git, makeGitRepo } from './helpers.js'

const dirs: string[] = []
const project = async (files: Record<string, string>) => {
  const dir = await makeProject(files)
  dirs.push(dir)
  return dir
}

function outputs(): Record<string, string> {
  return Object.fromEntries(core.setOutput.mock.calls.map(([k, v]) => [k, v]))
}

const savedWorkspace = process.env['GITHUB_WORKSPACE']

beforeEach(() => {
  vi.clearAllMocks()
  core.inputs = {}
  process.env['GITHUB_STEP_SUMMARY'] = '/dev/null'
})
afterEach(async () => {
  if (savedWorkspace === undefined) delete process.env['GITHUB_WORKSPACE']
  else process.env['GITHUB_WORKSPACE'] = savedWorkspace
  await Promise.all(dirs.splice(0).map(cleanup))
})

describe('run', () => {
  it('sets every output for a detected project', async () => {
    const dir = await project({ 'package.json': '{"name":"web","version":"1.0.0","packageManager":"pnpm@9.0.0"}' })
    process.env['GITHUB_WORKSPACE'] = dir
    await run()

    expect(outputs()).toMatchObject({
      language: 'node',
      name: 'web',
      version: '1.0.0',
      'version-source': 'package.json',
      'package-manager': 'pnpm',
      'package-manager-version': '9.0.0',
      manifest: 'package.json',
      lockfile: '',
    })
    expect(JSON.parse(outputs()['languages'] ?? '[]')).toHaveLength(1)
    expect(core.summary.write).toHaveBeenCalled()
    expect(core.warning).not.toHaveBeenCalled()
  })

  it('resolves working-directory relative to GITHUB_WORKSPACE', async () => {
    const dir = await project({ 'api/go.mod': 'module example.com/api\n\ngo 1.24\n' })
    process.env['GITHUB_WORKSPACE'] = dir
    core.inputs = { 'working-directory': path.join('api') }
    await run()
    expect(outputs()).toMatchObject({ language: 'go', name: 'example.com/api', 'language-version': '1.24' })
  })

  it('warns on mixed repositories and honours the language input', async () => {
    const dir = await project({ 'package.json': '{"version":"1.0.0"}', 'pyproject.toml': '[project]\nname="x"\nversion="2.0.0"\n' })
    process.env['GITHUB_WORKSPACE'] = dir
    await run()
    expect(core.warning).toHaveBeenCalledWith(expect.stringContaining('Multiple languages detected'))
    expect(outputs()['language']).toBe('node')

    vi.clearAllMocks()
    core.inputs = { language: 'Python' }
    await run()
    expect(outputs()).toMatchObject({ language: 'python', version: '2.0.0' })
    expect(core.warning).not.toHaveBeenCalled()
  })

  it('reports unknown with empty outputs and warns by default', async () => {
    const dir = await project({ 'README.md': '' })
    process.env['GITHUB_WORKSPACE'] = dir
    await run()
    expect(outputs()).toMatchObject({ language: 'unknown', version: '', 'package-manager': '', languages: '[]' })
    expect(core.warning).toHaveBeenCalledWith(expect.stringContaining('No supported project'))
  })

  it('skips the summary when GITHUB_STEP_SUMMARY is not set', async () => {
    delete process.env['GITHUB_STEP_SUMMARY']
    process.env['GITHUB_WORKSPACE'] = await project({ 'go.mod': 'module x\n' })
    await run()
    expect(core.summary.write).not.toHaveBeenCalled()
    expect(outputs()['language']).toBe('go')
  })

  it('throws when fail-on-unknown is set, after writing the summary', async () => {
    const dir = await project({})
    process.env['GITHUB_WORKSPACE'] = dir
    core.inputs = { 'fail-on-unknown': 'true' }
    await expect(run()).rejects.toThrow('No supported project')
    expect(core.summary.write).toHaveBeenCalled()
  })

  it('rejects an unsupported language input', async () => {
    process.env['GITHUB_WORKSPACE'] = await project({})
    core.inputs = { language: 'rust' }
    await expect(run()).rejects.toThrow('Unsupported language "rust"')
  })

  // Regression: a mistyped working-directory only produced a "no supported project" warning.
  it.each([
    ['does-not-exist', 'does not exist'],
    ['file.txt', 'is not a directory'],
  ])('fails for working-directory %j even without fail-on-unknown', async (workingDirectory, message) => {
    process.env['GITHUB_WORKSPACE'] = await project({ 'file.txt': '' })
    core.inputs = { 'working-directory': workingDirectory }
    await expect(run()).rejects.toThrow(`working-directory "${workingDirectory}" ${message}`)
    expect(core.setOutput).not.toHaveBeenCalled()
  })

  // Regression: the primary language of a mixed project could not be chosen without excluding the others.
  it('honours language-priority and keeps reporting every language', async () => {
    process.env['GITHUB_WORKSPACE'] = await project({
      'package.json': '{"private":true}',
      'pyproject.toml': '[project]\nname="api"\nversion="2.0.0"\n',
    })
    core.inputs = { 'language-priority': 'Python, go' }
    await run()
    expect(outputs()).toMatchObject({ language: 'python', version: '2.0.0' })
    expect(JSON.parse(outputs()['languages'] ?? '[]').map((d: { language: string }) => d.language)).toEqual(['python', 'node'])
    expect(core.warning).toHaveBeenCalledWith(expect.stringContaining('"language-priority"'))
  })

  it('rejects an unsupported language in language-priority', async () => {
    process.env['GITHUB_WORKSPACE'] = await project({ 'package.json': '{}' })
    core.inputs = { 'language-priority': 'python,rust' }
    await expect(run()).rejects.toThrow('Unsupported language "rust" in language-priority')
  })

  it('sets the version components, runtime source and install outputs', async () => {
    process.env['GITHUB_WORKSPACE'] = await project({
      'package.json': '{"name":"web","version":"v2.1.0-rc.1+build.7","engines":{"node":">=22"}}',
      'package-lock.json': '{}',
    })
    await run()
    expect(outputs()).toMatchObject({
      version: '2.1.0-rc.1+build.7',
      'version-major': '2',
      'version-minor': '1',
      'version-patch': '0',
      'version-prerelease': 'rc.1',
      'version-build': 'build.7',
      'is-prerelease': 'true',
      'language-version': '>=22',
      'language-version-source': 'package.json:engines.node',
      'language-version-file': 'package.json',
      'workspace-root': '.',
      'install-command': 'npm ci',
      'cache-dependency-path': 'package-lock.json',
    })
  })

  it('rebases setup-facing paths onto the workspace root for a workspace member', async () => {
    process.env['GITHUB_WORKSPACE'] = await project({
      'package.json': '{"private":true,"packageManager":"pnpm@9.12.0"}',
      'pnpm-workspace.yaml': 'packages:\n  - apps/*\n',
      'pnpm-lock.yaml': '',
      '.nvmrc': '22.11.0\n',
      'apps/api/package.json': '{"name":"api","version":"1.0.0"}',
    })
    core.inputs = { 'working-directory': 'apps/api' }
    await run()
    expect(outputs()).toMatchObject({
      'package-manager': 'pnpm',
      'package-manager-version': '9.12.0',
      manifest: 'package.json',
      // manifest / lockfile stay relative to working-directory …
      lockfile: '../../pnpm-lock.yaml',
      'language-version-source': '../../.nvmrc',
      // … the setup-facing paths are relative to the workspace root.
      'workspace-root': '.',
      'language-version-file': '.nvmrc',
      'cache-dependency-path': 'pnpm-lock.yaml',
      'install-command': 'pnpm install --frozen-lockfile',
      'is-prerelease': 'false',
    })
    const [entry] = JSON.parse(outputs()['languages'] ?? '[]')
    expect(entry).toMatchObject({ workspaceRoot: '.', languageVersionFile: '.nvmrc', cacheDependencyPath: 'pnpm-lock.yaml', versionMajor: '1', isPrerelease: false })
  })

  it('reports workspace-root as the project directory outside a workspace', async () => {
    process.env['GITHUB_WORKSPACE'] = await project({ 'svc/go.mod': 'module x\n\ngo 1.22\n', 'svc/go.sum': '' })
    core.inputs = { 'working-directory': 'svc' }
    await run()
    expect(outputs()).toMatchObject({
      'workspace-root': 'svc',
      'language-version-file': 'svc/go.mod',
      'cache-dependency-path': 'svc/go.sum',
      'install-command': 'go mod download',
    })
  })

  it('sets every new output to its empty value for an unknown project', async () => {
    process.env['GITHUB_WORKSPACE'] = await project({ 'README.md': '' })
    await run()
    expect(outputs()).toMatchObject({
      'version-major': '',
      'version-prerelease': '',
      'is-prerelease': 'false',
      'language-version-source': '',
      'language-version-file': '',
      'workspace-root': '',
      'install-command': '',
      'cache-dependency-path': '',
      projects: '[]',
    })
  })

  it('wires the detectors to core.debug', async () => {
    process.env['GITHUB_WORKSPACE'] = await project({ 'package.json': '{"version":"1.0.0"}' })
    await run()
    expect(core.debug).toHaveBeenCalledWith('[.] node version: "1.0.0" from package.json:version')
  })

  it('passes tag-pattern to the git-tag fallback', async () => {
    const repo = await makeGitRepo({ 'go.mod': 'module x\n' })
    dirs.push(repo)
    git(repo, 'tag', 'release-2.4.0')
    process.env['GITHUB_WORKSPACE'] = repo
    await run()
    expect(outputs()['version']).toBe('')

    vi.clearAllMocks()
    core.inputs = { 'tag-pattern': 'release-*' }
    await run()
    expect(outputs()).toMatchObject({ version: '2.4.0', 'version-source': 'git-tag' })
  })

  it('escapes repository-controlled values in the job summary', async () => {
    process.env['GITHUB_WORKSPACE'] = await project({ 'package.json': '{"name":"<img src=x onerror=alert(1)>","version":"1.0.0"}' })
    await run()
    const rows = core.summary.addTable.mock.calls[0]![0] as string[][]
    expect(rows[1]![1]).toBe('&lt;img src=x onerror=alert(1)&gt;')
  })
})

describe('run: discover', () => {
  const monorepo = {
    'package.json': '{"name":"root","private":true,"workspaces":["apps/*","packages/*"],"packageManager":"pnpm@9.12.0"}',
    'pnpm-lock.yaml': "lockfileVersion: '9.0'\n",
    'apps/web/package.json': '{"name":"web","version":"1.0.0"}',
    'apps/api/go.mod': 'module example.com/api\n\ngo 1.24\n',
    'apps/api/package.json': '{"name":"api-tools","private":true}',
    'packages/ui/package.json': '{"name":"ui","version":"0.1.0"}',
    'packages/ui/node_modules/dep/package.json': '{"name":"dep","version":"9.9.9"}',
    'services/worker/pyproject.toml': '[project]\nname="worker"\nversion="0.5.0"\n',
    'services/worker/uv.lock': '',
    '.github/actions/local/package.json': '{"name":"hidden"}',
    'examples/demo/package.json': '{"name":"demo"}',
    'testdata/fake/go.mod': 'module fake\n',
    'deep/a/b/c/package.json': '{"name":"too-deep"}',
  }

  const projects = () => JSON.parse(outputs()['projects'] ?? '[]') as Array<Record<string, unknown>>

  it('reports every project below working-directory as a JSON matrix', async () => {
    process.env['GITHUB_WORKSPACE'] = await project(monorepo)
    core.inputs = { discover: 'true' }
    await run()
    expect(projects().map((p) => [p['directory'], p['language'], p['languages']])).toEqual([
      ['.', 'node', ['node']],
      ['apps/api', 'node', ['node', 'go']],
      ['apps/web', 'node', ['node']],
      ['examples/demo', 'node', ['node']],
      ['packages/ui', 'node', ['node']],
      ['services/worker', 'python', ['python']],
    ])
    expect(projects().find((p) => p['directory'] === 'apps/web')).toMatchObject({
      name: 'web',
      version: '1.0.0',
      packageManager: 'pnpm',
      lockfile: '../../pnpm-lock.yaml',
      workspaceRoot: '.',
      installCommand: 'pnpm install --frozen-lockfile',
      cacheDependencyPath: 'pnpm-lock.yaml',
    })
    expect(projects().find((p) => p['directory'] === 'services/worker')).toMatchObject({ installCommand: 'uv sync --locked', workspaceRoot: 'services/worker' })
    // The regular outputs still describe working-directory itself.
    expect(outputs()).toMatchObject({ language: 'node', name: 'root' })
    expect(core.summary.addHeading).toHaveBeenCalledWith('Discovered projects (6)', 3)
  })

  it('honours discover-max-depth, discover-exclude, language and language-priority', async () => {
    process.env['GITHUB_WORKSPACE'] = await project(monorepo)
    core.inputs = { discover: 'true', 'discover-max-depth': '1' }
    await run()
    expect(projects().map((p) => p['directory'])).toEqual(['.'])

    vi.clearAllMocks()
    core.inputs = { discover: 'true', 'discover-max-depth': '4', 'discover-exclude': 'examples, packages/*' }
    await run()
    expect(projects().map((p) => p['directory'])).toEqual(['.', 'apps/api', 'apps/web', 'services/worker', 'deep/a/b/c'])

    vi.clearAllMocks()
    core.inputs = { discover: 'true', language: 'go' }
    await run()
    expect(projects().map((p) => p['directory'])).toEqual(['apps/api'])

    vi.clearAllMocks()
    core.inputs = { discover: 'true', 'language-priority': 'go' }
    await run()
    expect(projects().find((p) => p['directory'] === 'apps/api')).toMatchObject({ language: 'go', languages: ['go', 'node'] })
  })

  it('discovers relative to working-directory and reports directories relative to the workspace', async () => {
    process.env['GITHUB_WORKSPACE'] = await project(monorepo)
    core.inputs = { discover: 'true', 'working-directory': 'apps' }
    await run()
    expect(projects().map((p) => p['directory'])).toEqual(['apps/api', 'apps/web'])
    // apps/ itself is no project, but discovered projects mean the step does not warn or fail.
    expect(outputs()['language']).toBe('unknown')
    expect(core.warning).not.toHaveBeenCalledWith(expect.stringContaining('No supported project'))
  })

  it('fails with fail-on-unknown only when nothing is found at any depth', async () => {
    process.env['GITHUB_WORKSPACE'] = await project({ 'README.md': '', 'docs/index.md': '' })
    core.inputs = { discover: 'true', 'fail-on-unknown': 'true' }
    await expect(run()).rejects.toThrow('or up to 3 level(s) below it')
    expect(outputs()['projects']).toBe('[]')
  })

  it.each(['-1', '11', '2.5', 'deep'])('rejects discover-max-depth %j', async (depth) => {
    process.env['GITHUB_WORKSPACE'] = await project({})
    core.inputs = { discover: 'true', 'discover-max-depth': depth }
    await expect(run()).rejects.toThrow('discover-max-depth must be an integer between 0 and 10')
  })
})

describe('input helpers', () => {
  it('parseList splits on commas and newlines', () => {
    expect(parseList('a, b\nc,,\n  ')).toEqual(['a', 'b', 'c'])
    expect(parseList('')).toEqual([])
  })

  it('parseDepth defaults to 3 and accepts 0..10', () => {
    expect(parseDepth('')).toBe(3)
    expect(parseDepth(' 0 ')).toBe(0)
    expect(parseDepth('10')).toBe(10)
  })

  it('escapeHtml escapes markup characters', () => {
    expect(escapeHtml(`<a href="x">&'</a>`)).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;')
  })
})
