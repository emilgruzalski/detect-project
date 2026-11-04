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
    summary,
  }
})
vi.mock('@actions/core', () => core)

import { run } from '../src/main.js'

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
    })
  })
})
