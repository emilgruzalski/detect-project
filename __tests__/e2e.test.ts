import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup } from './helpers.js'

// Runs the bundled dist/index.js the same way the runner does (fresh node process, inputs via
// INPUT_* env vars, outputs via $GITHUB_OUTPUT), so a broken build is caught locally and not only
// by the e2e workflow.
const root = path.resolve(import.meta.dirname, '..')
const entry = path.join(root, 'dist/index.js')

const dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(cleanup))
})

/** Parses the `name<<delimiter\nvalue\ndelimiter` blocks that @actions/core writes to $GITHUB_OUTPUT. */
function parseOutputs(text: string): Record<string, string> {
  const outputs: Record<string, string> = {}
  const re = /^(.+?)<<(\S+)\n([\s\S]*?)\n?\2$/gm
  for (const [, name, , value] of text.matchAll(re)) outputs[name!] = value!
  return outputs
}

async function runAction(inputs: Record<string, string>) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'detect-project-e2e-'))
  dirs.push(tmp)
  const outputFile = path.join(tmp, 'output')
  const summaryFile = path.join(tmp, 'summary')
  await Promise.all([fs.writeFile(outputFile, ''), fs.writeFile(summaryFile, '')])

  const env: NodeJS.ProcessEnv = {
    PATH: process.env['PATH'],
    GITHUB_WORKSPACE: root,
    GITHUB_OUTPUT: outputFile,
    GITHUB_STEP_SUMMARY: summaryFile,
  }
  // The runner fills omitted inputs with the defaults from action.yml.
  const withDefaults = { 'working-directory': '.', language: 'auto', 'fail-on-unknown': 'false', ...inputs }
  for (const [name, value] of Object.entries(withDefaults)) env[`INPUT_${name.toUpperCase()}`] = value

  const result = spawnSync(process.execPath, [entry], { cwd: root, env, encoding: 'utf8' })
  return {
    status: result.status,
    stdout: result.stdout,
    outputs: parseOutputs(await fs.readFile(outputFile, 'utf8')),
    summary: await fs.readFile(summaryFile, 'utf8'),
  }
}

describe('e2e: dist/index.js', () => {
  it.each([
    {
      fixture: 'node-pnpm',
      expected: {
        language: 'node',
        version: '1.2.3',
        'package-manager': 'pnpm',
        'package-manager-version': '9.12.0',
        'language-version': '20.18.0',
      },
    },
    {
      fixture: 'python-poetry',
      expected: {
        language: 'python',
        version: '4.5.6',
        'package-manager': 'poetry',
        'package-manager-version': '1.8.4',
        'language-version': '^3.11',
      },
    },
    {
      fixture: 'go-module',
      expected: {
        language: 'go',
        version: '7.8.9',
        'package-manager': 'go',
        'package-manager-version': '1.22.7',
        'language-version': '1.22.0',
      },
    },
  ])('detects the $fixture fixture', async ({ fixture, expected }) => {
    const res = await runAction({ 'working-directory': `__tests__/fixtures/${fixture}`, 'fail-on-unknown': 'true' })

    expect(res.status).toBe(0)
    expect(res.outputs).toMatchObject(expected)
    expect(res.summary).toContain('Project detection')
  })

  it('picks the primary language of a mixed project and reports all of them', async () => {
    const res = await runAction({ 'working-directory': '__tests__/fixtures/mixed' })

    expect(res.status).toBe(0)
    expect(res.outputs['language']).toBe('node')
    expect(JSON.parse(res.outputs['languages']!)).toHaveLength(2)
  })

  it('honours a forced language', async () => {
    const res = await runAction({ 'working-directory': '__tests__/fixtures/mixed', language: 'go' })

    expect(res.status).toBe(0)
    expect(res.outputs).toMatchObject({ language: 'go', name: 'example.com/mixed' })
  })

  it('reports unknown without failing by default', async () => {
    const res = await runAction({ 'working-directory': '.github' })

    expect(res.status).toBe(0)
    expect(res.outputs['language']).toBe('unknown')
  })

  it('fails the step on an unknown project when fail-on-unknown is set', async () => {
    const res = await runAction({ 'working-directory': '.github', 'fail-on-unknown': 'true' })

    expect(res.status).toBe(1)
    expect(res.stdout).toContain('::error::')
  })
})
