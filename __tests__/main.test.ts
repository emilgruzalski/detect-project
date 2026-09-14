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
})
