import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup } from './helpers.js'

// Runs the bundled dist/index.js the same way the runner does (fresh node process, inputs via
// INPUT_* env vars with the defaults from action.yml, outputs via $GITHUB_OUTPUT), so a broken build
// is caught locally and not only by the e2e workflow. The scenarios are shared with the CI matrix.
const root = path.resolve(import.meta.dirname, '..')
const entry = path.join(root, 'dist/index.js')

interface Scenario {
  name: string
  'working-directory': string
  'expect-failure'?: boolean
  expected: Record<string, string>
  [input: string]: unknown
}

const scenarios = (JSON.parse(readFileSync(path.join(root, '__tests__/e2e-scenarios.json'), 'utf8')) as { include: Scenario[] }).include

/** Input defaults from action.yml, as the runner applies them. */
function actionDefaults(): Record<string, string> {
  const defaults: Record<string, string> = {}
  let section = ''
  let input = ''
  for (const line of readFileSync(path.join(root, 'action.yml'), 'utf8').split(/\r?\n/)) {
    if (/^\S/.test(line)) section = line.replace(/:.*$/, '')
    else if (section === 'inputs' && /^ {2}\S/.test(line)) input = line.trim().replace(/:$/, '')
    else if (section === 'inputs' && /^ {4}default:/.test(line)) defaults[input] = line.replace(/^ {4}default:\s*/, '').replace(/^'(.*)'$/, '$1')
  }
  return defaults
}

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
  for (const [name, value] of Object.entries({ ...actionDefaults(), ...inputs })) env[`INPUT_${name.toUpperCase()}`] = value

  const result = spawnSync(process.execPath, [entry], { cwd: root, env, encoding: 'utf8' })
  return {
    status: result.status,
    stdout: result.stdout,
    outputs: parseOutputs(await fs.readFile(outputFile, 'utf8')),
    summary: await fs.readFile(summaryFile, 'utf8'),
  }
}

/** Same normalisation as the CI assertion step: list outputs are compared by language / directory. */
function normalise(key: string, value: string | undefined): string | undefined {
  if (value === undefined || value === '') return value
  if (key === 'languages') return JSON.stringify((JSON.parse(value) as Array<{ language: string }>).map((d) => d.language))
  if (key === 'projects') return JSON.stringify((JSON.parse(value) as Array<{ directory: string }>).map((d) => d.directory))
  return value
}

const RESERVED = new Set(['name', 'expected', 'expect-failure'])

describe('e2e: dist/index.js', () => {
  it.each(scenarios)('$name', async (scenario) => {
    const inputs = Object.fromEntries(
      Object.entries(scenario)
        .filter(([key]) => !RESERVED.has(key))
        .map(([key, value]) => [key, String(value)]),
    )
    const res = await runAction(inputs)

    expect(res.status, res.stdout).toBe(scenario['expect-failure'] ? 1 : 0)
    for (const [key, expected] of Object.entries(scenario.expected)) {
      expect(normalise(key, res.outputs[key]), `output ${key}`).toBe(expected)
    }
  })

  it('writes the job summary', async () => {
    const res = await runAction({ 'working-directory': '__tests__/fixtures/node-workspace', discover: 'true' })
    expect(res.summary).toContain('Project detection')
    expect(res.summary).toContain('Discovered projects (2)')
  })

  it('reports a missing working-directory as an error annotation', async () => {
    const res = await runAction({ 'working-directory': 'does-not-exist' })
    expect(res.stdout).toContain('::error::working-directory "does-not-exist" does not exist')
  })
})
