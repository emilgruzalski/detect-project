import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { detectProject } from '../src/detect.js'
import { goDetector, moduleTagPrefix, parseGoMod } from '../src/detectors/go.js'
import { cleanup, git, makeGitRepo, makeProject } from './helpers.js'

const dirs: string[] = []
const project = async (files: Record<string, string>) => {
  const dir = await makeProject(files)
  dirs.push(dir)
  return dir
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map(cleanup))
})

describe('parseGoMod', () => {
  it('extracts module, go and toolchain directives', () => {
    expect(
      parseGoMod('module github.com/acme/svc // comment\n\ngo 1.22.0\n\ntoolchain go1.22.5\n\nrequire (\n\tgithub.com/x/y v1.0.0\n)\n'),
    ).toEqual({ module: 'github.com/acme/svc', go: '1.22.0', toolchain: '1.22.5' })
  })
})

describe('goDetector', () => {
  it('returns undefined without go.mod', async () => {
    const dir = await project({ 'main.go': 'package main' })
    expect(await goDetector.detect({ dir })).toBeUndefined()
  })

  it('reads module and versions from go.mod / go.sum', async () => {
    const dir = await project({
      'go.mod': 'module example.com/app\n\ngo 1.21\n',
      'go.sum': '',
      'internal/version/version.go': 'package version\n\n// Version is the app version.\nconst Version = "1.4.0"\n',
    })
    expect(await goDetector.detect({ dir })).toMatchObject({
      language: 'go',
      name: 'example.com/app',
      version: '1.4.0',
      versionSource: 'internal/version/version.go',
      packageManager: 'go',
      packageManagerVersion: '',
      languageVersion: '1.21',
      manifest: 'go.mod',
      lockfile: 'go.sum',
    })
  })

  it('prefers a VERSION file and reports the toolchain as package manager version', async () => {
    const dir = await project({
      'go.mod': 'module example.com/app\n\ngo 1.22.0\ntoolchain go1.22.5\n',
      VERSION: '2.0.0-rc.1\n',
      'version.go': 'package main\nvar Version = "dev"\n',
    })
    expect(await goDetector.detect({ dir })).toMatchObject({ version: '2.0.0-rc.1', versionSource: 'VERSION', packageManagerVersion: '1.22.5', languageVersion: '1.22.0' })
  })

  it('ignores ldflags placeholders like "dev" and finds Version in nested cmd packages', async () => {
    const dir = await project({
      'go.mod': 'module example.com/app\n\ngo 1.22\n',
      'version.go': 'package main\nvar Version = "dev"\n',
      'cmd/app/version.go': 'package main\n\nvar (\n\tversion = "v0.3.1"\n\tcommit  = "none"\n)\n',
    })
    expect(await goDetector.detect({ dir })).toMatchObject({ version: '0.3.1', versionSource: 'cmd/app/version.go' })
  })

  it('reports empty version when nothing declares it and there are no git tags', async () => {
    const dir = await project({ 'go.mod': 'module x\n\ngo 1.20\n' })
    expect(await goDetector.detect({ dir })).toMatchObject({ version: '', versionSource: '' })
  })

  it('detects dep projects', async () => {
    const dir = await project({ 'Gopkg.toml': '', 'Gopkg.lock': '' })
    expect(await goDetector.detect({ dir })).toMatchObject({ packageManager: 'dep', manifest: 'Gopkg.toml', lockfile: 'Gopkg.lock' })
  })

  it('falls back to .tool-versions for the go version', async () => {
    const dir = await project({ 'go.mod': 'module x\n', '.tool-versions': 'golang 1.23.1\n' })
    expect((await goDetector.detect({ dir }))?.languageVersion).toBe('1.23.1')
  })

  // Regression: `var Version string = "…"` (a declaration with an explicit type) was not recognised.
  it.each([
    'var Version string = "1.2.3"',
    'const Version string = "1.2.3"',
    'var (\n\tVersion   string = "1.2.3"\n\tGitCommit string = ""\n)',
  ])('reads a typed declaration: %j', async (decl) => {
    const dir = await project({ 'go.mod': 'module x\n\ngo 1.22\n', 'internal/version/version.go': `package version\n\n${decl}\n` })
    expect(await goDetector.detect({ dir })).toMatchObject({ version: '1.2.3', versionSource: 'internal/version/version.go' })
  })

  it('still ignores a typed placeholder', async () => {
    const dir = await project({ 'go.mod': 'module x\n', 'version.go': 'package main\n\nvar Version string = "dev"\n' })
    expect((await goDetector.detect({ dir }))?.version).toBe('')
  })
})

describe('goDetector: git tags', () => {
  // Regression: `git describe --tags` returned the nearest tag of any shape ("nightly") and nested
  // modules got their prefixed tag ("tools/v0.2.0") verbatim.
  it('uses release tags only and the module-path prefix for nested modules', async () => {
    const root = await makeGitRepo({ 'go.mod': 'module example.com/repo\n\ngo 1.22\n', 'tools/go.mod': 'module example.com/repo/tools\n\ngo 1.22\n' })
    dirs.push(root)
    git(root, 'tag', 'v1.4.0')
    git(root, 'commit', '-q', '--allow-empty', '-m', 'tools release')
    git(root, 'tag', 'tools/v0.2.0')
    git(root, 'tag', 'nightly')

    expect((await detectProject(root)).primary).toMatchObject({ version: '1.4.0', versionSource: 'git-tag' })
    expect((await detectProject(path.join(root, 'tools'))).primary).toMatchObject({ version: '0.2.0', versionSource: 'git-tag' })
  })

  it('computes the tag prefix from the git root', () => {
    const root = path.resolve('/repo')
    expect(moduleTagPrefix(root, root)).toBe('')
    expect(moduleTagPrefix(path.join(root, 'sdk/go'), root)).toBe('sdk/go/')
    expect(moduleTagPrefix(path.join(root, 'x'), undefined)).toBe('')
  })
})

describe('goDetector: runtime, install command and cache path', () => {
  it('reports go.mod as the setup-go readable version file', async () => {
    const dir = await project({ 'go.mod': 'module x\n\ngo 1.22.0\ntoolchain go1.22.5\n', 'go.sum': '' })
    expect(await goDetector.detect({ dir })).toMatchObject({
      languageVersion: '1.22.0',
      languageVersionSource: 'go.mod:go',
      languageVersionFile: 'go.mod',
      installCommand: 'go mod download',
      cacheDependencyPath: 'go.sum',
      workspaceRoot: '.',
    })
  })

  it('falls back to the toolchain directive', async () => {
    const dir = await project({ 'go.mod': 'module x\n\ntoolchain go1.23.2\n' })
    expect(await goDetector.detect({ dir })).toMatchObject({ languageVersion: '1.23.2', languageVersionSource: 'go.mod:toolchain' })
  })

  it.each([
    ['golang 1.23.1', '.tool-versions'],
    // setup-go only reads the `golang` entry of .tool-versions.
    ['go 1.23.1', ''],
  ])('.tool-versions %j → version file %j', async (line, file) => {
    const dir = await project({ 'go.mod': 'module x\n', '.tool-versions': `${line}\n` })
    expect(await goDetector.detect({ dir })).toMatchObject({ languageVersion: '1.23.1', languageVersionSource: '.tool-versions', languageVersionFile: file })
  })

  it('finds .tool-versions in a parent directory within the boundary', async () => {
    const root = await project({ '.tool-versions': 'golang 1.24.0\n', 'svc/go.mod': 'module x\n' })
    expect(await goDetector.detect({ dir: path.join(root, 'svc'), boundary: root })).toMatchObject({
      languageVersion: '1.24.0',
      languageVersionSource: '../.tool-versions',
      languageVersionFile: '../.tool-versions',
    })
  })

  it.each([
    [{ 'Gopkg.toml': '' }, 'dep ensure'],
    [{ 'go.work': 'go 1.22\n\nuse ./a\n' }, ''],
  ])('%j → install command %j', async (files, command) => {
    const dir = await project(files)
    expect((await goDetector.detect({ dir }))?.installCommand).toBe(command)
  })
})
