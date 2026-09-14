import { afterEach, describe, expect, it } from 'vitest'
import { detectProject } from '../src/detect.js'
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
    const result = await detectProject(dir, 'go')
    expect(result.primary?.language).toBe('go')
    expect(result.all).toHaveLength(1)
  })

  it('returns no primary when the forced language is absent', async () => {
    const dir = await project({ 'package.json': '{}' })
    expect((await detectProject(dir, 'python')).primary).toBeUndefined()
  })
})
