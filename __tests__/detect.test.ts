import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { detectProject, orderDetectors } from '../src/detect.js'
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

/** A pnpm monorepo with one member in apps/api; `extra` adds files (e.g. a `.git` marker). */
const monorepo = (extra: Record<string, string> = {}) =>
  project({
    'package.json': '{"name":"root","private":true,"packageManager":"pnpm@9.12.0"}',
    'pnpm-workspace.yaml': "packages:\n  - 'apps/*'\n",
    'pnpm-lock.yaml': "lockfileVersion: '9.0'\n",
    '.nvmrc': '22\n',
    'apps/api/package.json': '{"name":"api","version":"0.3.0"}',
    ...extra,
  })

describe('detectProject', () => {
  it('returns no primary for an empty directory', async () => {
    const dir = await project({})
    const result = await detectProject(dir)
    expect(result.primary).toBeUndefined()
    expect(result.all).toEqual([])
  })

  it('reports every language and picks the first in registry order as primary', async () => {
    const dir = await project({
      'package.json': '{"name":"web","version":"1.0.0"}',
      'pyproject.toml': '[project]\nname="api"\nversion="2.0.0"\n',
      'go.mod': 'module example.com/cli\n\ngo 1.22\n',
    })
    const result = await detectProject(dir)
    expect(result.all.map((d) => d.language)).toEqual(['node', 'python', 'go'])
    expect(result.primary?.language).toBe('node')
  })

  it('honours a forced language', async () => {
    const dir = await project({
      'package.json': '{"name":"web","version":"1.0.0"}',
      'go.mod': 'module example.com/cli\n\ngo 1.22\n',
    })
    const result = await detectProject(dir, { language: 'go' })
    expect(result.primary?.language).toBe('go')
    expect(result.all).toHaveLength(1)
  })

  it('returns no primary when the forced language is absent', async () => {
    const dir = await project({ 'package.json': '{}' })
    expect((await detectProject(dir, { language: 'python' })).primary).toBeUndefined()
  })

  // Regression: a Django app with a Tailwind-only package.json was always reported as node.
  it('lets a language priority pick the primary language of a mixed project', async () => {
    const dir = await project({
      'pyproject.toml': '[project]\nname="django-app"\nversion="2.0.0"\n',
      'uv.lock': '',
      'package.json': '{"private":true,"devDependencies":{"tailwindcss":"^4"}}',
    })
    expect((await detectProject(dir)).primary?.language).toBe('node')
    const preferred = await detectProject(dir, { priority: ['python'] })
    expect(preferred.primary?.language).toBe('python')
    expect(preferred.all.map((d) => d.language)).toEqual(['python', 'node'])
  })

  // Regression: workspace members lost the root lockfile, packageManager and .nvmrc (pm fell back to npm).
  it('walks up to the git root to resolve a workspace member', async () => {
    const root = await monorepo({ '.git/HEAD': 'ref: refs/heads/main\n' })
    const result = await detectProject(path.join(root, 'apps/api'))
    expect(result.primary).toMatchObject({
      packageManager: 'pnpm',
      packageManagerVersion: '9.12.0',
      lockfile: '../../pnpm-lock.yaml',
      languageVersion: '22',
      languageVersionSource: '../../.nvmrc',
      workspaceRoot: '../..',
      installCommand: 'pnpm install --frozen-lockfile',
    })
  })

  it('treats a .git file (worktree / submodule) as the repository root', async () => {
    const root = await monorepo({ '.git': 'gitdir: /somewhere/else\n' })
    expect((await detectProject(path.join(root, 'apps/api'))).primary?.packageManager).toBe('pnpm')
  })

  it('walks up to the workspace root when there is no git repository', async () => {
    const root = await monorepo()
    expect((await detectProject(path.join(root, 'apps/api'), { workspace: root })).primary?.packageManager).toBe('pnpm')
  })

  it('never walks above the inspected directory without a repository or workspace root', async () => {
    const root = await monorepo()
    expect((await detectProject(path.join(root, 'apps/api'))).primary).toMatchObject({
      packageManager: 'npm',
      lockfile: '',
      languageVersion: '',
      workspaceRoot: '.',
    })
  })

  it('never walks above the nearest enclosing root', async () => {
    // The git repository lives in apps/, so the monorepo root above it must not be consulted.
    const root = await monorepo({ 'apps/.git/HEAD': 'ref: refs/heads/main\n' })
    const result = await detectProject(path.join(root, 'apps/api'), { workspace: root })
    expect(result.primary).toMatchObject({ packageManager: 'npm', lockfile: '' })
  })
})

describe('orderDetectors', () => {
  it('puts preferred languages first and keeps the rest in registry order', () => {
    expect(orderDetectors(['go']).map((d) => d.language)).toEqual(['go', 'node', 'python'])
    expect(orderDetectors(['python', 'go']).map((d) => d.language)).toEqual(['python', 'go', 'node'])
    expect(orderDetectors().map((d) => d.language)).toEqual(['node', 'python', 'go'])
  })
})
