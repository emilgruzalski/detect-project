import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ancestors, findGitRoot, isInside, relPosix } from '../src/utils/fs.js'
import { globToRegExp, matchesWorkspacePatterns, parsePnpmWorkspacePackages } from '../src/utils/workspace.js'
import { cleanup, makeProject } from './helpers.js'

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map(cleanup))
})

describe('globToRegExp / matchesWorkspacePatterns', () => {
  it.each([
    ['apps/*', 'apps/web', true],
    ['apps/*', 'apps/web/sub', false],
    ['apps/**', 'apps/web/sub', true],
    ['**/pkg', 'pkg', true],
    ['**/pkg', 'a/b/pkg', true],
    ['./packages/*/', 'packages/ui', true],
    ['packages/ui', 'packages/ui', true],
    ['packages/ui', 'packages/ui2', false],
    ['pkg-?', 'pkg-a', true],
    ['libs/*.js', 'libs/aXjs', false],
  ])('%s vs %s → %s', (pattern, rel, expected) => {
    expect(globToRegExp(pattern).test(rel)).toBe(expected)
    expect(matchesWorkspacePatterns([pattern], rel)).toBe(expected)
  })

  it('applies negated patterns', () => {
    const patterns = ['packages/*', '!packages/legacy']
    expect(matchesWorkspacePatterns(patterns, 'packages/ui')).toBe(true)
    expect(matchesWorkspacePatterns(patterns, 'packages/legacy')).toBe(false)
  })

  it('never matches the root itself or paths outside it', () => {
    expect(matchesWorkspacePatterns(['**'], '.')).toBe(false)
    expect(matchesWorkspacePatterns(['**'], '../other')).toBe(false)
    expect(matchesWorkspacePatterns([], 'apps/web')).toBe(false)
    expect(matchesWorkspacePatterns(['', '!'], 'apps/web')).toBe(false)
  })
})

describe('parsePnpmWorkspacePackages', () => {
  it('reads the block form with quotes and comments', () => {
    const yaml = `# workspace
packages:
  - 'apps/*'
  - "packages/*"   # shared
  - tools/cli

  - '!**/test/**'
catalog:
  react: ^19
`
    expect(parsePnpmWorkspacePackages(yaml)).toEqual(['apps/*', 'packages/*', 'tools/cli', '!**/test/**'])
  })

  it('reads the flow form', () => {
    expect(parsePnpmWorkspacePackages("packages: ['apps/*', libs/*]\n")).toEqual(['apps/*', 'libs/*'])
  })

  it('returns an empty list without a packages key', () => {
    expect(parsePnpmWorkspacePackages('onlyBuiltDependencies:\n  - esbuild\n')).toEqual([])
    expect(parsePnpmWorkspacePackages('')).toEqual([])
  })
})

describe('fs helpers', () => {
  it('lists parents up to the boundary, nearest first', () => {
    const root = path.resolve('/repo')
    expect(ancestors(path.join(root, 'apps/api'), root)).toEqual([path.join(root, 'apps'), root])
    expect(ancestors(root, root)).toEqual([])
    expect(ancestors(path.resolve('/elsewhere/x'), root)).toEqual([])
  })

  it('relPosix and isInside', () => {
    const root = path.resolve('/repo')
    expect(relPosix(path.join(root, 'apps/api'), path.join(root, 'pnpm-lock.yaml'))).toBe('../../pnpm-lock.yaml')
    expect(relPosix(root, root)).toBe('.')
    expect(isInside(path.join(root, 'a'), root)).toBe(true)
    expect(isInside(root, root)).toBe(true)
    expect(isInside(path.resolve('/repository'), root)).toBe(false)
  })

  it('finds the git root from a .git directory or file', async () => {
    const dir = await makeProject({ '.git/HEAD': '', 'sub/x/.keep': '', 'wt/.git': 'gitdir: ../.git/worktrees/wt\n', 'wt/a/.keep': '' })
    dirs.push(dir)
    expect(await findGitRoot(path.join(dir, 'sub/x'))).toBe(dir)
    expect(await findGitRoot(path.join(dir, 'wt/a'))).toBe(path.join(dir, 'wt'))
  })
})
