import { afterEach, describe, expect, it } from 'vitest'
import { goDetector, parseGoMod } from '../src/detectors/go.js'
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
})
