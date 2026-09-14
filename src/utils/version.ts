import { exec } from '@actions/exec'

/** Normalises things like `v1.2.3`, `"1.2.3"`, `== 1.2.3` into `1.2.3`. Returns empty string for empty input. */
export function cleanVersion(raw: string | undefined | null): string {
  if (!raw) return ''
  let v = raw.trim()
  v = v.replace(/^["']|["']$/g, '').trim()
  v = v.replace(/^==\s*/, '')
  v = v.replace(/^v(?=\d)/i, '')
  return v
}

/** Extracts `__version__ = "1.2.3"` / `Version = "1.2.3"` style assignments from source code. */
export function extractAssignedVersion(source: string, identifiers: readonly string[]): string | undefined {
  for (const id of identifiers) {
    const re = new RegExp(`(?:^|[\\s(,])${id}\\s*(?::\\s*(?:str|string))?\\s*=\\s*["'\`]([^"'\`\\n]+)["'\`]`, 'm')
    const match = re.exec(source)
    if (match?.[1]) return cleanVersion(match[1])
  }
  return undefined
}

/** Latest reachable git tag (via `git describe`), or undefined when the repo has no tags / is not a repo. */
export async function gitDescribeTag(cwd: string): Promise<string | undefined> {
  let out = ''
  try {
    const code = await exec('git', ['describe', '--tags', '--abbrev=0'], {
      cwd,
      silent: true,
      ignoreReturnCode: true,
      listeners: { stdout: (d) => (out += d.toString()) },
    })
    if (code !== 0) return undefined
  } catch {
    return undefined
  }
  const tag = out.trim()
  return tag ? cleanVersion(tag) : undefined
}
