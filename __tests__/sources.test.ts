import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { detectProject } from '../src/detect.js'
import { goDetector } from '../src/detectors/go.js'
import { nodeDetector } from '../src/detectors/node.js'
import { pythonDetector } from '../src/detectors/python.js'
import { isFile, listDir, readText, withFileCache } from '../src/utils/fs.js'
import { bumpversionSource, commitizenSource, releasePleaseSource } from '../src/utils/release-tools.js'
import { resolveFirst } from '../src/utils/sources.js'
import { cleanup, makeProject } from './helpers.js'

const dirs: string[] = []
const project = async (files: Record<string, string>) => {
  const dir = await makeProject(files)
  dirs.push(dir)
  return dir
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map(cleanup))
})

describe('resolveFirst', () => {
  it('returns the first non-empty value and reports what was tried', async () => {
    const lines: string[] = []
    const hit = await resolveFirst({ dir: '/x', debug: (m) => lines.push(m) }, 'node version', [
      { name: 'a', read: () => undefined },
      { name: 'b', read: async () => ({ value: '', source: 'b' }) },
      { name: 'c', read: () => ({ value: '1.0.0', source: 'c-file' }) },
      { name: 'd', read: () => ({ value: '9.9.9', source: 'd-file' }) },
    ])
    expect(hit).toEqual({ value: '1.0.0', source: 'c-file' })
    expect(lines).toEqual(['node version: "1.0.0" from c (nothing in: a, b)'])
  })

  it('reports when nothing was found', async () => {
    const lines: string[] = []
    expect(await resolveFirst({ dir: '/x', debug: (m) => lines.push(m) }, 'go version', [{ name: 'a', read: () => undefined }])).toBeUndefined()
    expect(lines).toEqual(['go version: not found (tried: a)'])
  })

  it('logs every resolved value of a real detection through the debug callback', async () => {
    const dir = await project({ 'package.json': '{"version":"1.2.3"}', '.nvmrc': '22\n' })
    const lines: string[] = []
    await detectProject(dir, { debug: (m) => lines.push(m) })
    expect(lines).toContain('[.] node version: "1.2.3" from package.json:version')
    expect(lines).toContain('[.] node runtime: "22" from .nvmrc')
  })
})

describe('withFileCache', () => {
  it('reads every path at most once inside a cached run', async () => {
    const dir = await project({ 'a.txt': 'one' })
    const file = path.join(dir, 'a.txt')
    await withFileCache(async () => {
      expect(await readText(file)).toBe('one')
      expect((await listDir(dir))?.map((e) => e.name)).toEqual(['a.txt'])
      await fs.writeFile(file, 'two')
      await fs.writeFile(path.join(dir, 'b.txt'), '')
      expect(await readText(file)).toBe('one')
      expect((await listDir(dir))?.map((e) => e.name)).toEqual(['a.txt'])
      expect(await isFile(path.join(dir, 'missing'))).toBe(false)
      await fs.writeFile(path.join(dir, 'missing'), '')
      expect(await isFile(path.join(dir, 'missing'))).toBe(false)
    })
    // Outside the run the disk is read again.
    expect(await readText(file)).toBe('two')
    expect(await isFile(path.join(dir, 'missing'))).toBe(true)
  })

  it('isolates concurrent runs and reuses an enclosing cache', async () => {
    const dir = await project({ 'a.txt': 'one' })
    const file = path.join(dir, 'a.txt')
    await withFileCache(async () => {
      await readText(file)
      await fs.writeFile(file, 'two')
      expect(await withFileCache(() => readText(file))).toBe('one')
    })
    const [first, second] = await Promise.all([withFileCache(() => readText(file)), withFileCache(() => readText(file))])
    expect([first, second]).toEqual(['two', 'two'])
  })
})

describe('release-please', () => {
  const files = {
    '.git/HEAD': '',
    '.release-please-manifest.json': JSON.stringify({ '.': '3.0.0', 'apps/api': '1.4.0', 'packages/ui/': '0.2.0' }),
    'apps/api/package.json': '{"name":"api","private":true}',
    'apps/web/package.json': '{"name":"web","private":true}',
    'packages/ui/package.json': '{"name":"ui"}',
    'go.mod': 'module example.com/root\n',
  }

  it('reads the entry of the directory from the nearest manifest', async () => {
    const root = await project(files)
    const read = (rel: string) => releasePleaseSource({ dir: path.join(root, rel), boundary: root }).read()
    expect(await read('apps/api')).toEqual({ value: '1.4.0', source: '../../.release-please-manifest.json:apps/api' })
    expect(await read('packages/ui')).toEqual({ value: '0.2.0', source: '../../.release-please-manifest.json:packages/ui' })
    expect(await read('.')).toEqual({ value: '3.0.0', source: '.release-please-manifest.json:.' })
    expect(await read('apps/web')).toBeUndefined()
  })

  it('versions a private Node app and a Go module without other sources', async () => {
    const root = await project(files)
    expect((await detectProject(path.join(root, 'apps/api'))).primary).toMatchObject({
      version: '1.4.0',
      versionSource: '../../.release-please-manifest.json:apps/api',
    })
    expect(await goDetector.detect({ dir: root, boundary: root })).toMatchObject({ version: '3.0.0', versionSource: '.release-please-manifest.json:.' })
  })

  it('never overrides the version in the manifest', async () => {
    const root = await project({ ...files, 'apps/api/package.json': '{"version":"1.3.9"}' })
    expect(await nodeDetector.detect({ dir: path.join(root, 'apps/api'), boundary: root })).toMatchObject({ version: '1.3.9', versionSource: 'package.json' })
  })

  it('does not look above the walk boundary or into a malformed manifest', async () => {
    const root = await project(files)
    expect(await releasePleaseSource({ dir: path.join(root, 'apps/api') }).read()).toBeUndefined()
    const broken = await project({ '.release-please-manifest.json': '{not json', 'go.mod': 'module x\n' })
    expect(await releasePleaseSource({ dir: broken }).read()).toBeUndefined()
  })
})

describe('bumpversion', () => {
  it.each([
    [{ '.bumpversion.toml': '[tool.bumpversion]\ncurrent_version = "2.0.1"\n' }, '.bumpversion.toml:tool.bumpversion.current_version'],
    [{ '.bumpversion.cfg': '[bumpversion]\ncurrent_version = 2.0.1\ncommit = True\n' }, '.bumpversion.cfg:bumpversion.current_version'],
    [{ 'pyproject.toml': '[tool.bumpversion]\ncurrent_version = "2.0.1"\n' }, 'pyproject.toml:tool.bumpversion.current_version'],
    [{ 'setup.cfg': '[bumpversion]\ncurrent_version = 2.0.1\n' }, 'setup.cfg:bumpversion.current_version'],
  ])('reads %j', async (files, source) => {
    const dir = await project(files)
    expect(await bumpversionSource(dir).read()).toEqual({ value: '2.0.1', source })
  })

  it('prefers .bumpversion.toml over the other files', async () => {
    const dir = await project({
      '.bumpversion.toml': '[tool.bumpversion]\ncurrent_version = "1.0.0"\n',
      '.bumpversion.cfg': '[bumpversion]\ncurrent_version = 9.0.0\n',
    })
    expect((await bumpversionSource(dir).read())?.value).toBe('1.0.0')
  })

  it('versions a requirements.txt-only Python app', async () => {
    const dir = await project({ 'requirements.txt': 'flask\n', '.bumpversion.cfg': '[bumpversion]\ncurrent_version = 0.4.2\n' })
    expect(await pythonDetector.detect({ dir })).toMatchObject({ version: '0.4.2', versionSource: '.bumpversion.cfg:bumpversion.current_version' })
  })
})

describe('commitizen', () => {
  it.each([
    [{ 'pyproject.toml': '[tool.commitizen]\nversion = "0.7.0"\n' }, 'pyproject.toml:tool.commitizen.version'],
    [{ '.cz.toml': '[tool.commitizen]\nversion = "0.7.0"\n' }, '.cz.toml:tool.commitizen.version'],
    [{ '.cz.json': '{"commitizen":{"name":"cz_conventional_commits","version":"0.7.0"}}' }, '.cz.json:commitizen.version'],
    [{ 'cz.yaml': 'commitizen:\n  name: cz_conventional_commits\n  version: "0.7.0"  # managed\n  tag_format: v$version\n' }, 'cz.yaml:commitizen.version'],
  ])('reads %j', async (files, source) => {
    const dir = await project(files)
    expect(await commitizenSource(dir).read()).toEqual({ value: '0.7.0', source })
  })

  it('ignores the version when another version provider owns it', async () => {
    const dir = await project({ '.cz.toml': '[tool.commitizen]\nversion_provider = "scm"\nversion = "0.0.1"\n' })
    expect(await commitizenSource(dir).read()).toBeUndefined()
  })

  it('uses only the first configuration file found, in commitizen’s order', async () => {
    const dir = await project({
      'pyproject.toml': '[project]\nname="x"\n[tool.commitizen]\nversion_provider = "pep621"\n',
      '.cz.toml': '[tool.commitizen]\nversion = "5.0.0"\n',
    })
    expect(await commitizenSource(dir).read()).toBeUndefined()
  })

  it('skips pyproject.toml without a commitizen table', async () => {
    const dir = await project({ 'pyproject.toml': '[project]\nname="x"\n', '.cz.json': '{"commitizen":{"version":"1.1.0"}}' })
    expect((await commitizenSource(dir).read())?.value).toBe('1.1.0')
  })

  it('reads nothing from a YAML file without a commitizen mapping', async () => {
    const dir = await project({ 'cz.yaml': 'other:\n  version: 1.0.0\n' })
    expect(await commitizenSource(dir).read()).toBeUndefined()
  })
})

describe('release tools in the version chain', () => {
  it('rank after the manifest and the VERSION file but before source scanning (Go)', async () => {
    const withConstant = await project({
      'go.mod': 'module x\n',
      '.cz.toml': '[tool.commitizen]\nversion = "2.0.0"\n',
      'version.go': 'package main\nvar Version = "1.0.0"\n',
    })
    expect(await goDetector.detect({ dir: withConstant })).toMatchObject({ version: '2.0.0', versionSource: '.cz.toml:tool.commitizen.version' })

    const withFile = await project({ 'go.mod': 'module x\n', VERSION: '3.0.0\n', '.cz.toml': '[tool.commitizen]\nversion = "2.0.0"\n' })
    expect((await goDetector.detect({ dir: withFile }))?.version).toBe('3.0.0')
  })

  it('rank before the __version__ scan (Python)', async () => {
    const dir = await project({
      'pyproject.toml': '[project]\nname="app"\ndynamic=["version"]\n[tool.commitizen]\nversion = "4.0.0"\n',
      'app/__init__.py': '__version__ = "3.9.0"\n',
    })
    expect(await pythonDetector.detect({ dir })).toMatchObject({ version: '4.0.0', versionSource: 'pyproject.toml:tool.commitizen.version' })
  })
})
