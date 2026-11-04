import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { extractAssignedVersion, gitDescribeTag, looksLikeReleaseVersion, splitVersion } from '../src/utils/version.js'
import { cleanup, git, makeGitRepo, makeProject } from './helpers.js'

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map(cleanup))
})

async function repo(files: Record<string, string> = { 'README.md': '' }): Promise<string> {
  const dir = await makeGitRepo(files)
  dirs.push(dir)
  return dir
}

describe('extractAssignedVersion', () => {
  it.each([
    ['__version__ = "1.2.3"', '__version__'],
    ["__version__: str = '1.2.3'", '__version__'],
    ['export const version: string = `1.2.3`', 'version'],
    ['var Version = "1.2.3"', 'Version'],
    // Regression: Go declarations with an explicit type were not recognised.
    ['var Version string = "1.2.3"', 'Version'],
    ['const Version string = "v1.2.3"', 'Version'],
    ['var (\n\tVersion string = "1.2.3"\n\tCommit  string = "none"\n)', 'Version'],
    ['const (\n\tAppVersion\tstring = "1.2.3"\n)', 'AppVersion'],
  ])('reads %j', (source, id) => {
    expect(extractAssignedVersion(source, [id])).toBe('1.2.3')
  })

  it.each([
    ['if Version == "1.2.3" {}', 'Version'],
    ['var Version int = 3', 'Version'],
    ['myVersion = "1.2.3"', 'Version'],
    ['var Version string', 'Version'],
  ])('ignores %j', (source, id) => {
    expect(extractAssignedVersion(source, [id])).toBeUndefined()
  })
})

describe('looksLikeReleaseVersion', () => {
  it.each(['1.2.3', '1.0', '2.0.0-rc.1', '1.2.3+build.5', '1.0.0rc1', '1.2.3.post1', '2024.10.1'])('accepts %s', (v) => {
    expect(looksLikeReleaseVersion(v)).toBe(true)
  })
  it.each(['nightly', 'latest', '1', 'v1.2.3', 'tools/v1.2.3', '1.2.3 beta', ''])('rejects %j', (v) => {
    expect(looksLikeReleaseVersion(v)).toBe(false)
  })
})

describe('gitDescribeTag', () => {
  it('returns undefined outside a repository and for a repository without tags', async () => {
    const plain = await makeProject({ 'README.md': '' })
    dirs.push(plain)
    expect(await gitDescribeTag(plain)).toBeUndefined()
    expect(await gitDescribeTag(await repo())).toBeUndefined()
  })

  // Regression: `git describe --tags` returned whatever tag was nearest, e.g. "nightly".
  it('skips tags that are not release versions', async () => {
    const dir = await repo()
    git(dir, 'tag', 'v1.4.0')
    git(dir, 'commit', '-q', '--allow-empty', '-m', 'next')
    git(dir, 'tag', 'nightly')
    git(dir, 'tag', 'latest')
    expect(await gitDescribeTag(dir)).toBe('1.4.0')
  })

  it('accepts tags without the v prefix', async () => {
    const dir = await repo()
    git(dir, 'tag', '3.1.0')
    expect(await gitDescribeTag(dir)).toBe('3.1.0')
  })

  // A floating major tag (annotated, as the release workflow creates it) must not shadow the release tag.
  it('ignores a floating major tag on the same commit', async () => {
    const dir = await repo()
    git(dir, 'tag', 'v1.2.0')
    git(dir, 'tag', '-a', 'v1', '-m', 'Point v1 at v1.2.0')
    expect(await gitDescribeTag(dir)).toBe('1.2.0')
  })

  // Regression: nested Go modules got the prefixed tag ("tools/v0.2.0") and the root module could get it too.
  it('selects and strips the tag prefix of a nested module', async () => {
    const dir = await repo({ 'go.mod': 'module example.com/repo\n', 'tools/go.mod': 'module example.com/repo/tools\n' })
    git(dir, 'tag', 'v1.4.0')
    git(dir, 'commit', '-q', '--allow-empty', '-m', 'tools release')
    git(dir, 'tag', 'tools/v0.2.0')
    expect(await gitDescribeTag(dir)).toBe('1.4.0')
    expect(await gitDescribeTag(path.join(dir, 'tools'), 'tools/')).toBe('0.2.0')
    expect(await gitDescribeTag(path.join(dir, 'tools'), 'other/')).toBeUndefined()
  })
})

describe('splitVersion', () => {
  it.each([
    ['1.2.3', { major: '1', minor: '2', patch: '3', prerelease: '', build: '', isPrerelease: false }],
    ['2.0.0-rc.1+build.5', { major: '2', minor: '0', patch: '0', prerelease: 'rc.1', build: 'build.5', isPrerelease: true }],
    ['1.2.3+45', { major: '1', minor: '2', patch: '3', prerelease: '', build: '45', isPrerelease: false }],
    ['1.4', { major: '1', minor: '4', patch: '0', prerelease: '', build: '', isPrerelease: false }],
    ['7', { major: '7', minor: '0', patch: '0', prerelease: '', build: '', isPrerelease: false }],
    ['1.0.0rc1', { major: '1', minor: '0', patch: '0', prerelease: 'rc1', isPrerelease: true }],
    ['2.0b1', { major: '2', minor: '0', patch: '0', prerelease: 'b1', isPrerelease: true }],
    ['1.2.3.dev4', { major: '1', minor: '2', patch: '3', prerelease: 'dev4', isPrerelease: true }],
    ['1.2.3.post1', { major: '1', minor: '2', patch: '3', prerelease: '', isPrerelease: false }],
    ['1.0.post2.dev1', { major: '1', minor: '0', patch: '0', prerelease: 'post2.dev1', isPrerelease: true }],
    ['1!2.3.4', { major: '2', minor: '3', patch: '4', isPrerelease: false }],
    ['1.2.3.4', { major: '1', minor: '2', patch: '3', prerelease: '', isPrerelease: false }],
    ['1.0.0+local.ubuntu', { prerelease: '', build: 'local.ubuntu', isPrerelease: false }],
    ['1.0.0-1', { prerelease: '1', isPrerelease: true }],
  ])('splits %s', (version, expected) => {
    expect(splitVersion(version)).toMatchObject(expected)
  })

  it.each(['', 'dev', 'nightly', 'lts/iron'])('returns empty parts for %j', (version) => {
    expect(splitVersion(version)).toEqual({ major: '', minor: '', patch: '', prerelease: '', build: '', isPrerelease: false })
  })
})
