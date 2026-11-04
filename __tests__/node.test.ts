import * as path from 'node:path'
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

/** Detects the member at `member` with the walk boundary at the project root. */
async function detectMember(files: Record<string, string>, member: string) {
  const root = await project(files)
  return nodeDetector.detect({ dir: path.join(root, member), boundary: root })
}

describe('nodeDetector: workspaces', () => {
  // Regression: a member of a pnpm monorepo was reported as npm without lockfile or runtime.
  it('inherits package manager, lockfile and runtime from a pnpm workspace root', async () => {
    const result = await detectMember(
      {
        'package.json': '{"name":"root","private":true,"packageManager":"pnpm@9.12.0"}',
        'pnpm-workspace.yaml': "packages:\n  - 'apps/*'\n",
        'pnpm-lock.yaml': "lockfileVersion: '9.0'\n",
        '.nvmrc': '22\n',
        'apps/api/package.json': '{"name":"api","version":"0.3.0"}',
      },
      'apps/api',
    )
    expect(result).toMatchObject({
      name: 'api',
      version: '0.3.0',
      packageManager: 'pnpm',
      packageManagerVersion: '9.12.0',
      lockfile: '../../pnpm-lock.yaml',
      languageVersion: '22',
      languageVersionSource: '../../.nvmrc',
      languageVersionFile: '../../.nvmrc',
      workspaceRoot: '../..',
      installCommand: 'pnpm install --frozen-lockfile',
      cacheDependencyPath: '../../pnpm-lock.yaml',
    })
  })

  // Regression: the shape of a Bun monorepo (root bun.lock + packageManager + engines.node, apps/* members).
  it('inherits from a package.json#workspaces root (bun)', async () => {
    const result = await detectMember(
      {
        'package.json': JSON.stringify({
          name: 'tcj',
          private: true,
          workspaces: ['apps/*', 'packages/*'],
          packageManager: 'bun@1.4.2',
          engines: { node: '>=24' },
        }),
        'bun.lock': '{}',
        'apps/server/package.json': '{"name":"@tcj/server","version":"0.0.0"}',
      },
      'apps/server',
    )
    expect(result).toMatchObject({
      packageManager: 'bun',
      packageManagerVersion: '1.4.2',
      lockfile: '../../bun.lock',
      languageVersion: '>=24',
      languageVersionSource: '../../package.json:engines.node',
      languageVersionFile: '../../package.json',
      workspaceRoot: '../..',
      installCommand: 'bun install --frozen-lockfile',
    })
  })

  it('supports the object form of workspaces and negated patterns (yarn)', async () => {
    const files = {
      'package.json': JSON.stringify({ private: true, workspaces: { packages: ['packages/*', '!packages/legacy'] } }),
      'yarn.lock': '__metadata:\n  version: 8\n',
      'packages/ui/package.json': '{"name":"ui"}',
      'packages/legacy/package.json': '{"name":"legacy"}',
    }
    expect(await detectMember(files, 'packages/ui')).toMatchObject({
      packageManager: 'yarn',
      lockfile: '../../yarn.lock',
      installCommand: 'yarn install --immutable',
    })
    expect(await detectMember(files, 'packages/legacy')).toMatchObject({ packageManager: 'npm', lockfile: '', workspaceRoot: '.' })
  })

  it('does not inherit the lockfile into a nested project that is not a workspace member', async () => {
    const result = await detectMember(
      {
        'package.json': JSON.stringify({ private: true, workspaces: ['apps/*'], packageManager: 'pnpm@9.0.0' }),
        'pnpm-lock.yaml': '',
        '.node-version': '20.11.1\n',
        'tools/script/package.json': '{"name":"script"}',
      },
      'tools/script',
    )
    // Runtime files are still found by walking up, the same way nvm / fnm / asdf resolve them.
    expect(result).toMatchObject({
      packageManager: 'npm',
      lockfile: '',
      workspaceRoot: '.',
      installCommand: 'npm install',
      languageVersion: '20.11.1',
      languageVersionSource: '../../.node-version',
    })
  })

  it('treats pnpm-workspace.yaml as a pnpm signal even without lockfile or packageManager', async () => {
    const result = await detectMember(
      { 'package.json': '{"private":true}', 'pnpm-workspace.yaml': 'packages:\n  - libs/*\n', 'libs/a/package.json': '{}' },
      'libs/a',
    )
    expect(result).toMatchObject({ packageManager: 'pnpm', lockfile: '', installCommand: 'pnpm install', workspaceRoot: '../..' })
  })

  it('prefers the member’s own declarations and project-level runtime over the root', async () => {
    const result = await detectMember(
      {
        'package.json': JSON.stringify({ workspaces: ['apps/*'], packageManager: 'yarn@4.5.0', engines: { node: '>=18' } }),
        'yarn.lock': '',
        '.nvmrc': '18\n',
        'apps/web/package.json': JSON.stringify({ packageManager: 'yarn@4.6.0', engines: { node: '>=22' } }),
      },
      'apps/web',
    )
    expect(result).toMatchObject({
      packageManager: 'yarn',
      packageManagerVersion: '4.6.0',
      languageVersion: '>=22',
      languageVersionSource: 'package.json:engines.node',
      installCommand: 'yarn install --immutable',
    })
  })

  it('stops at the boundary', async () => {
    const root = await project({
      'package.json': JSON.stringify({ workspaces: ['apps/*'], packageManager: 'pnpm@9.0.0' }),
      'apps/api/package.json': '{}',
    })
    expect(await nodeDetector.detect({ dir: path.join(root, 'apps/api') })).toMatchObject({ packageManager: 'npm', workspaceRoot: '.' })
  })
})

describe('nodeDetector: runtime', () => {
  // Regression: devEngines.runtime was ignored.
  it.each([
    [{ runtime: { name: 'node', version: '>=22' } }, '>=22'],
    [{ runtime: [{ name: 'deno', version: '2' }, { name: 'Node', version: '^24.1.0' }] }, '^24.1.0'],
  ])('reads devEngines.runtime %j', async (devEngines, expected) => {
    const dir = await project({ 'package.json': JSON.stringify({ devEngines }) })
    expect(await nodeDetector.detect({ dir })).toMatchObject({
      languageVersion: expected,
      languageVersionSource: 'package.json:devEngines.runtime',
      languageVersionFile: 'package.json',
    })
  })

  it('reads package.json in the same order as setup-node: volta → devEngines → engines', async () => {
    const devEngines = { runtime: { name: 'node', version: '>=21' } }
    const all = await project({ 'package.json': JSON.stringify({ volta: { node: '20.1.0' }, devEngines, engines: { node: '>=18' } }) })
    expect((await nodeDetector.detect({ dir: all }))?.languageVersionSource).toBe('package.json:volta.node')
    const noVolta = await project({ 'package.json': JSON.stringify({ devEngines, engines: { node: '>=18' } }) })
    expect((await nodeDetector.detect({ dir: noVolta }))?.languageVersionSource).toBe('package.json:devEngines.runtime')
  })

  it.each([
    [{ '.nvmrc': 'lts/iron\n' }, 'lts/iron', '.nvmrc', '.nvmrc'],
    [{ '.tool-versions': 'nodejs 22.1.0\n' }, '22.1.0', '.tool-versions', '.tool-versions'],
    [{ 'mise.toml': '[tools]\nnode = "22.2.0"\n' }, '22.2.0', 'mise.toml:tools.node', 'mise.toml'],
    // setup-node only reads `tools.node` (string or { version }), not asdf's `nodejs` key or version arrays.
    [{ 'mise.toml': '[tools]\nnodejs = "22.3.0"\n' }, '22.3.0', 'mise.toml:tools.nodejs', ''],
    [{ 'mise.toml': '[tools]\nnode = ["22.4.0", "20"]\n' }, '22.4.0', 'mise.toml:tools.node', ''],
  ])('reports the source of %j', async (files, version, source, file) => {
    const dir = await project({ 'package.json': '{}', ...files })
    expect(await nodeDetector.detect({ dir })).toMatchObject({ languageVersion: version, languageVersionSource: source, languageVersionFile: file })
  })

  it('leaves the runtime fields empty when nothing declares a version', async () => {
    const dir = await project({ 'package.json': '{}' })
    expect(await nodeDetector.detect({ dir })).toMatchObject({ languageVersion: '', languageVersionSource: '', languageVersionFile: '' })
  })
})

describe('nodeDetector: install command', () => {
  it.each([
    [{ 'package-lock.json': '{}' }, 'npm ci'],
    [{ 'npm-shrinkwrap.json': '{}' }, 'npm ci'],
    [{}, 'npm install'],
    [{ 'pnpm-lock.yaml': '' }, 'pnpm install --frozen-lockfile'],
    [{ 'bun.lockb': '' }, 'bun install --frozen-lockfile'],
    [{ 'yarn.lock': '# yarn lockfile v1\n' }, 'yarn install --frozen-lockfile'],
    [{ 'yarn.lock': '__metadata:\n  version: 8\n' }, 'yarn install --immutable'],
    [{ 'yarn.lock': '', '.yarnrc.yml': 'nodeLinker: node-modules\n' }, 'yarn install --immutable'],
  ])('%j → %s', async (files, command) => {
    const dir = await project({ 'package.json': '{}', ...files })
    expect((await nodeDetector.detect({ dir }))?.installCommand).toBe(command)
  })

  it('uses the declared yarn major version', async () => {
    const classic = await project({ 'package.json': '{"packageManager":"yarn@1.22.22"}', 'yarn.lock': '', '.yarnrc.yml': '' })
    expect((await nodeDetector.detect({ dir: classic }))?.installCommand).toBe('yarn install --frozen-lockfile')
    const berry = await project({ 'package.json': '{"packageManager":"yarn@4.5.0"}', 'yarn.lock': '' })
    expect((await nodeDetector.detect({ dir: berry }))?.installCommand).toBe('yarn install --immutable')
  })

  it('does not freeze against a lockfile of another package manager', async () => {
    const dir = await project({ 'package.json': '{"packageManager":"pnpm@9.0.0"}', 'package-lock.json': '{}' })
    expect(await nodeDetector.detect({ dir })).toMatchObject({ installCommand: 'pnpm install', cacheDependencyPath: 'package-lock.json' })
  })
})
