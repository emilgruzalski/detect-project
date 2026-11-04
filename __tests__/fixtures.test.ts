import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'

// A fixture file matched by .gitignore exists locally but never reaches CI, so local e2e runs pass while
// the CI matrix fails (it happened with __tests__/fixtures/ruby-gem/lib/ and a root-level `lib/` rule).
const root = path.resolve(import.meta.dirname, '..')

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(path.join(dir, e.name)) : [path.join(dir, e.name)]))
}

describe('fixtures', () => {
  it('are not ignored by git', () => {
    const all = files(path.join(root, '__tests__/fixtures')).map((f) => path.relative(root, f))
    const result = spawnSync('git', ['check-ignore', '--no-index', '--stdin'], { cwd: root, input: all.join('\n'), encoding: 'utf8' })
    expect(result.error).toBeUndefined()
    expect(result.stdout.trim().split('\n').filter(Boolean)).toEqual([])
  })
})
