import { afterEach, describe, expect, it } from 'vitest'
import { nodeDetector, parsePackageManagerField } from '../src/detectors/node.js'
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

describe('nodeDetector', () => {
  it('returns undefined without package.json', async () => {
    const dir = await project({ 'README.md': '# hi' })
    expect(await nodeDetector.detect({ dir })).toBeUndefined()
  })

  it('defaults to npm and reads version from package.json', async () => {
    const dir = await project({ 'package.json': JSON.stringify({ name: 'app', version: 'v1.2.3' }) })
    const result = await nodeDetector.detect({ dir })
    expect(result).toMatchObject({
      language: 'node',
      name: 'app',
      version: '1.2.3',
      versionSource: 'package.json',
      packageManager: 'npm',
      packageManagerVersion: '',
      manifest: 'package.json',
      lockfile: '',
    })
  })

  it('prefers the packageManager field over lockfiles', async () => {
    const dir = await project({
      'package.json': JSON.stringify({ name: 'app', version: '2.0.0', packageManager: 'pnpm@9.1.0+sha512.abc' }),
      'yarn.lock': '',
    })
    const result = await nodeDetector.detect({ dir })
    expect(result?.packageManager).toBe('pnpm')
    expect(result?.packageManagerVersion).toBe('9.1.0')
    expect(result?.lockfile).toBe('yarn.lock')
  })

  it.each([
    ['bun.lockb', 'bun'],
    ['bun.lock', 'bun'],
    ['pnpm-lock.yaml', 'pnpm'],
    ['yarn.lock', 'yarn'],
    ['package-lock.json', 'npm'],
    ['npm-shrinkwrap.json', 'npm'],
  ])('detects %s → %s', async (lockfile, pm) => {
    const dir = await project({ 'package.json': '{"version":"0.0.1"}', [lockfile]: '' })
    const result = await nodeDetector.detect({ dir })
    expect(result?.packageManager).toBe(pm)
    expect(result?.lockfile).toBe(lockfile)
  })

  it('reads yarn berry version from .yarnrc.yml', async () => {
    const dir = await project({
      'package.json': '{"version":"1.0.0"}',
      'yarn.lock': '__metadata:\n  version: 6\n',
      '.yarnrc.yml': 'nodeLinker: node-modules\nyarnPath: .yarn/releases/yarn-3.6.4.cjs\n',
    })
    const result = await nodeDetector.detect({ dir })
    expect(result?.packageManager).toBe('yarn')
    expect(result?.packageManagerVersion).toBe('3.6.4')
  })

  it('falls back to engines for both package manager and its version', async () => {
    const dir = await project({
      'package.json': JSON.stringify({ version: '1.0.0', engines: { node: '>=20', pnpm: '^9' } }),
    })
    const result = await nodeDetector.detect({ dir })
    expect(result?.packageManager).toBe('pnpm')
    expect(result?.packageManagerVersion).toBe('^9')
    expect(result?.languageVersion).toBe('>=20')
  })

  it('reads devEngines.packageManager', async () => {
    const dir = await project({
      'package.json': JSON.stringify({ version: '1.0.0', devEngines: { packageManager: { name: 'yarn', version: '4.5.0' } } }),
    })
    const result = await nodeDetector.detect({ dir })
    expect(result?.packageManager).toBe('yarn')
    expect(result?.packageManagerVersion).toBe('4.5.0')
  })

  it('prefers .nvmrc over engines.node and strips the v prefix', async () => {
    const dir = await project({
      'package.json': JSON.stringify({ version: '1.0.0', engines: { node: '>=18' } }),
      '.nvmrc': '# pinned\nv20.11.1\n',
    })
    expect((await nodeDetector.detect({ dir }))?.languageVersion).toBe('20.11.1')
  })

  it('reads node version from volta and .tool-versions', async () => {
    const volta = await project({ 'package.json': JSON.stringify({ version: '1.0.0', volta: { node: '18.19.0', npm: '10.2.4' } }) })
    expect(await nodeDetector.detect({ dir: volta })).toMatchObject({ languageVersion: '18.19.0', packageManager: 'npm', packageManagerVersion: '10.2.4' })

    const asdf = await project({ 'package.json': '{}', '.tool-versions': 'python 3.12.0\nnodejs 20.10.0 # comment\n' })
    expect((await nodeDetector.detect({ dir: asdf }))?.languageVersion).toBe('20.10.0')
  })

  it('survives a malformed package.json', async () => {
    const dir = await project({ 'package.json': '{not json', 'pnpm-lock.yaml': '' })
    const result = await nodeDetector.detect({ dir })
    expect(result).toMatchObject({ language: 'node', version: '', packageManager: 'pnpm' })
  })
})

describe('parsePackageManagerField', () => {
  it('parses name and version', () => {
    expect(parsePackageManagerField('yarn@4.1.0')).toEqual({ pm: 'yarn', version: '4.1.0' })
    expect(parsePackageManagerField('npm@10.2.0+sha256.deadbeef')).toEqual({ pm: 'npm', version: '10.2.0' })
  })
  it('rejects unknown managers and bad input', () => {
    expect(parsePackageManagerField('cargo@1.0.0')).toBeUndefined()
    expect(parsePackageManagerField(42)).toBeUndefined()
    expect(parsePackageManagerField('pnpm')).toBeUndefined()
  })
})
