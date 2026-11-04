import { existsSync, readFileSync } from 'node:fs'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

// Keeps action.yml publishable on the GitHub Marketplace and in sync with the code and the README.
const root = path.resolve(import.meta.dirname, '..')
const action = parse(readFileSync(path.join(root, 'action.yml'), 'utf8')) as {
  name: string
  description: string
  branding: { icon: string; color: string }
  inputs: Record<string, { description?: string; default?: string }>
  outputs: Record<string, { description?: string }>
}
const main = readFileSync(path.join(root, 'src/main.ts'), 'utf8')
const readme = readFileSync(path.join(root, 'README.md'), 'utf8')

const inputsInCode = [...main.matchAll(/core\.get(?:Boolean)?Input\('([\w-]+)'\)/g)].map((m) => m[1]!)
const outputsInCode = [
  ...[...main.matchAll(/^\s*\['([\w-]+)', '\w+'\],$/gm)].map((m) => m[1]!),
  ...[...main.matchAll(/core\.setOutput\('([\w-]+)'/g)].map((m) => m[1]!),
]

describe('action.yml', () => {
  // The Marketplace rejects a release whose action description is 125 characters or longer.
  it('has a Marketplace-compatible name, description and branding', () => {
    expect(action.name).toBeTruthy()
    expect(action.description.length).toBeLessThan(125)
    expect(action.branding.icon).toBeTruthy()
    expect(action.branding.color).toBeTruthy()
  })

  it('declares exactly the inputs the code reads, each with a description and a default', () => {
    expect(new Set(inputsInCode)).toEqual(new Set(Object.keys(action.inputs)))
    for (const [name, input] of Object.entries(action.inputs)) {
      expect(input.description, name).toBeTruthy()
      expect(input.default, name).toBeTypeOf('string')
    }
  })

  it('declares exactly the outputs the code sets, each with a description', () => {
    expect(new Set(outputsInCode)).toEqual(new Set(Object.keys(action.outputs)))
    for (const [name, output] of Object.entries(action.outputs)) expect(output.description, name).toBeTruthy()
  })
})

describe('README.md', () => {
  // The README is the Marketplace listing: contributor documentation lives in CONTRIBUTING.md and docs/.
  it('holds user documentation only', () => {
    expect(readme).not.toMatch(/^## (Development|Releasing|Contributing)\b/m)
    for (const file of ['CONTRIBUTING.md', 'docs/troubleshooting.md']) expect(existsSync(path.join(root, file)), file).toBe(true)
  })

  it.each([...Object.keys(action.inputs).map((n) => ['input', n]), ...Object.keys(action.outputs).map((n) => ['output', n])])(
    'documents %s %s',
    (_, name) => {
      expect(readme).toContain(`\`${name}\``)
    },
  )
})
