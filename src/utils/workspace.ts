/**
 * Helpers for recognising workspace (monorepo) membership: glob patterns as used by
 * `package.json#workspaces`, `pnpm-workspace.yaml` and `[tool.uv.workspace]`.
 */

function normalizePattern(pattern: string): string {
  return pattern.trim().replace(/^\.\//, '').replace(/\/+$/, '')
}

/** Converts a workspace glob (`*`, `**`, `?`) into an anchored regular expression over posix paths. */
export function globToRegExp(pattern: string): RegExp {
  const glob = normalizePattern(pattern)
  let re = ''
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i]!
    if (char === '*') {
      if (glob[i + 1] === '*') {
        // `**/` matches zero or more directories, a trailing `**` matches everything below.
        if (glob[i + 2] === '/') {
          re += '(?:.*/)?'
          i += 2
        } else {
          re += '.*'
          i += 1
        }
      } else {
        re += '[^/]*'
      }
    } else if (char === '?') {
      re += '[^/]'
    } else {
      re += char.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    }
  }
  return new RegExp(`^${re}$`)
}

/**
 * True when `relPath` (posix, relative to the workspace root) is matched by at least one positive
 * pattern and by no negated (`!pattern`) one.
 */
export function matchesWorkspacePatterns(patterns: readonly string[], relPath: string): boolean {
  const target = normalizePattern(relPath)
  if (!target || target === '.' || target.startsWith('../')) return false
  let included = false
  for (const raw of patterns) {
    const negated = raw.trim().startsWith('!')
    const pattern = negated ? raw.trim().slice(1) : raw
    if (!normalizePattern(pattern)) continue
    if (globToRegExp(pattern).test(target)) {
      if (negated) return false
      included = true
    }
  }
  return included
}

function unquote(value: string): string {
  const v = value.trim()
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) return v.slice(1, -1)
  return v
}

/**
 * Reads the `packages:` list from `pnpm-workspace.yaml`. Supports the block form
 * (`packages:\n  - 'apps/*'`) and the flow form (`packages: [apps/*, libs/*]`), which covers
 * what pnpm documents; anything else yields an empty list.
 */
export function parsePnpmWorkspacePackages(text: string): string[] {
  const lines = text.split(/\r?\n/)
  const start = lines.findIndex((l) => /^packages\s*:/.test(l))
  if (start < 0) return []
  const inline = /^packages\s*:\s*(.*)$/.exec(lines[start]!)?.[1]?.replace(/\s+#.*$/, '').trim() ?? ''
  if (inline.startsWith('[')) {
    return inline
      .replace(/^\[|\]$/g, '')
      .split(',')
      .map(unquote)
      .filter(Boolean)
  }
  const result: string[] = []
  for (const line of lines.slice(start + 1)) {
    if (/^\s*(#.*)?$/.test(line)) continue
    if (!/^\s/.test(line)) break // next top-level key
    const item = /^\s+-\s*(.+?)\s*(?:\s#.*)?$/.exec(line)?.[1]
    if (item) result.push(unquote(item))
  }
  return result
}
